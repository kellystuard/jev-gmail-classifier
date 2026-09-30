import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, StateError, type StateErrorReason } from '../../src/core/errors.ts';
import {
  addGmailCalls,
  decodeGmailCalls,
  encodeGmailCalls,
  GMAIL_CALLS_KEY,
  gmailCallsCodec,
  gmailCallsForDay,
} from '../../src/core/gmail-calls.ts';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('gmail calls codec', () => {
  it('uses the state.gmailCalls key', () => {
    expect(GMAIL_CALLS_KEY).toBe('state.gmailCalls');
    expect(gmailCallsCodec.version).toBe(1);
  });

  it.each([
    ['zero', { day: '2026-09-30', count: 0 }],
    ['a typical day', { day: '2026-09-30', count: 4321 }],
    ['the largest safe integer', { day: '2028-02-29', count: Number.MAX_SAFE_INTEGER }],
  ])('round-trips %s, with v first', (_name, tally) => {
    const encoded = encodeGmailCalls(tally);
    expect(JSON.stringify(encoded)).toBe(
      `{"v":1,"day":"${tally.day}","count":${String(tally.count)}}`,
    );
    expect(decodeGmailCalls(JSON.parse(JSON.stringify(encoded)))).toEqual(tally);
  });

  it.each<[string, unknown, StateErrorReason]>([
    ['a missing v', { day: '2026-09-30', count: 0 }, 'schema'],
    ['an unknown v', { v: 2, day: '2026-09-30', count: 0 }, 'version'],
    ['a negative count', { v: 1, day: '2026-09-30', count: -1 }, 'schema'],
    ['a fractional count', { v: 1, day: '2026-09-30', count: 1.5 }, 'schema'],
    ['a string count', { v: 1, day: '2026-09-30', count: '5' }, 'schema'],
    ['a non-day day', { v: 1, day: 'today', count: 0 }, 'schema'],
    ['an impossible day', { v: 1, day: '2026-02-30', count: 0 }, 'schema'],
    ['an extra field', { v: 1, day: '2026-09-30', count: 0, more: 1 }, 'schema'],
    ['a non-object', 5, 'schema'],
  ])('rejects %s', (_name, raw, reason) => {
    const error = caught(() => decodeGmailCalls(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: GMAIL_CALLS_KEY, reason });
  });
});

describe('gmailCallsForDay', () => {
  const today = '2026-09-30';

  it('keeps the stored tally for the same day', () => {
    const stored = { day: today, count: 12 };
    expect(gmailCallsForDay(stored, today)).toBe(stored);
  });

  it.each([
    ['an older day', { day: '2026-09-29', count: 12 }],
    ['a later day (the clock moved back)', { day: '2026-10-01', count: 12 }],
    ['an absent tally', undefined],
  ])('starts from 0 for %s', (_name, stored) => {
    expect(gmailCallsForDay(stored, today)).toEqual({ day: today, count: 0 });
  });

  it.each(['today', '2026-02-30', ''])('rejects the bad day %j', (bad) => {
    expect(caught(() => gmailCallsForDay(undefined, bad))).toBeInstanceOf(InvalidArgumentError);
  });
});

describe('addGmailCalls', () => {
  it('adds and keeps the day', () => {
    expect(addGmailCalls({ day: '2026-09-30', count: 5 }, 7)).toEqual({
      day: '2026-09-30',
      count: 12,
    });
  });

  it('saturates at the largest safe integer', () => {
    expect(addGmailCalls({ day: '2026-09-30', count: Number.MAX_SAFE_INTEGER - 1 }, 5).count).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects %s calls', (bad) => {
    expect(caught(() => addGmailCalls({ day: '2026-09-30', count: 0 }, bad))).toBeInstanceOf(
      InvalidArgumentError,
    );
  });
});
