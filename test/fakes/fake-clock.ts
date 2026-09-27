import type { ClockPort } from '../../src/ports/clock-port.ts';

export type FakeClockOptions = {
  /** The start time, in epoch milliseconds or as an ISO 8601 string. */
  readonly now: number | string;
  /** Default `Etc/UTC`. */
  readonly timeZone?: string;
};

/** A controllable clock. `sleep` advances time instead of waiting. */
export class FakeClock implements ClockPort {
  /** Every `sleep(ms)`, in order. */
  readonly sleeps: number[] = [];
  private current: number;
  private zone: string;

  constructor(options: FakeClockOptions) {
    this.current = toEpochMs(options.now);
    this.zone = options.timeZone ?? 'Etc/UTC';
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): void {
    assertDuration('sleep', ms);
    this.sleeps.push(ms);
    this.current += ms;
  }

  timeZone(): string {
    return this.zone;
  }

  /** Moves time forward by `ms` without recording a sleep. */
  advance(ms: number): void {
    assertDuration('advance', ms);
    this.current += ms;
  }

  set(time: number | string): void {
    this.current = toEpochMs(time);
  }

  setTimeZone(zone: string): void {
    this.zone = zone;
  }
}

function toEpochMs(time: number | string): number {
  const ms = typeof time === 'number' ? time : Date.parse(time);
  if (!Number.isFinite(ms)) {
    throw new Error(`FakeClock: not a valid time: ${String(time)}`);
  }
  return ms;
}

function assertDuration(method: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `FakeClock.${method}: needs a finite, non-negative number of ms, got ${String(ms)}`,
    );
  }
}
