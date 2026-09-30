/**
 * The per-execution time budget (SD §10.3, ADR-0008).
 *
 * One `Deadline` per execution, created from the entry's start time. The
 * **soft limit** is how long new work may start (ingest pages, chunks, Jev
 * batches, retry rounds). The **reserve** is the time after the soft limit for
 * finishing work already paid for: applying outcomes and saving state. The
 * reserve is a planning figure: nothing here enforces it.
 *
 * Pure: it takes a `now` function instead of a clock port. The methods are
 * closures, so they work detached (`const r = deadline.remaining; r()`).
 */
import { InvalidArgumentError } from './errors.ts';

export type DeadlineLimits = {
  /** No new work starts after this many ms from the start. Finite, >= 0. */
  readonly softLimitMs: number;
  /** Time after the soft limit for finishing work already paid for. Finite, >= 0. */
  readonly reserveMs: number;
};

export type Deadline = {
  /** `now()` at creation, epoch ms. */
  readonly startedAt: number;
  /** ms since `startedAt`, never < 0. */
  readonly elapsed: () => number;
  /** ms left to the soft limit, never < 0. Start new work only while this is > 0. */
  readonly remaining: () => number;
  /** ms left to the soft limit plus the reserve, never < 0. */
  readonly remainingWithReserve: () => number;
  /** `true` once `elapsed() >= softLimitMs` (the same as `remaining() === 0`). */
  readonly pastSoftLimit: () => boolean;
};

function checkLimit(name: 'softLimitMs' | 'reserveMs', value: number): void {
  if (!Number.isFinite(value)) {
    throw new InvalidArgumentError(`${name} must be a finite number`, {
      argument: name,
      reason: 'not_finite',
    });
  }
  if (value < 0) {
    throw new InvalidArgumentError(`${name} must not be negative`, {
      argument: name,
      reason: 'negative',
    });
  }
}

/**
 * Throws InvalidArgumentError for a negative or non-finite limit, or when
 * `now()` isn't finite at creation. Pass `() => clock.now()`, not `clock.now`
 * (FakeClock's methods use `this`).
 */
export function createDeadline(now: () => number, limits: DeadlineLimits): Deadline {
  const { softLimitMs, reserveMs } = limits;
  checkLimit('softLimitMs', softLimitMs);
  checkLimit('reserveMs', reserveMs);
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new InvalidArgumentError('now() must return a finite number', {
      argument: 'now',
      reason: 'not_finite',
    });
  }
  const elapsed = (): number => Math.max(0, now() - startedAt);
  return {
    startedAt,
    elapsed,
    remaining: () => Math.max(0, softLimitMs - elapsed()),
    remainingWithReserve: () => Math.max(0, softLimitMs + reserveMs - elapsed()),
    pastSoftLimit: () => elapsed() >= softLimitMs,
  };
}
