import { describe, expect, it } from 'vitest';

import { FakeClock } from './fake-clock.ts';

describe('FakeClock', () => {
  it('starts at an ISO time or epoch ms, in Etc/UTC by default', () => {
    expect(new FakeClock({ now: '2026-09-26T12:00:00Z' }).now()).toBe(Date.UTC(2026, 8, 26, 12));
    const clock = new FakeClock({ now: 5000 });
    expect(clock.now()).toBe(5000);
    expect(clock.timeZone()).toBe('Etc/UTC');
  });

  it('advances time on sleep and records it', () => {
    const clock = new FakeClock({ now: 1000 });
    clock.sleep(500);
    clock.sleep(0);
    clock.sleep(250);
    expect(clock.now()).toBe(1750);
    expect(clock.sleeps).toEqual([500, 0, 250]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('throws on sleep(%s)', (ms) => {
    const clock = new FakeClock({ now: 0 });
    expect(() => {
      clock.sleep(ms);
    }).toThrow(/finite, non-negative/);
    expect(clock.now()).toBe(0);
  });

  it('can be advanced, set and moved to another zone without recording sleeps', () => {
    const clock = new FakeClock({ now: 0, timeZone: 'America/New_York' });
    expect(clock.timeZone()).toBe('America/New_York');
    clock.advance(60_000);
    expect(clock.now()).toBe(60_000);
    clock.set('2026-01-01T00:00:00Z');
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1));
    clock.setTimeZone('Europe/Paris');
    expect(clock.timeZone()).toBe('Europe/Paris');
    expect(clock.sleeps).toEqual([]);
  });

  it('rejects a time it cannot parse', () => {
    expect(() => new FakeClock({ now: 'not a date' })).toThrow(/not a valid time/);
  });
});
