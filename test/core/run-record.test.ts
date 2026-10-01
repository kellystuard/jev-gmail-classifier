import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, StateError, type StateErrorReason } from '../../src/core/errors.ts';
import {
  type RunRecord,
  type RunSummary,
  RUN_FAILURES_ALERT_THRESHOLD,
  RUN_SUMMARY_MAX_BYTES,
  RUN_SUMMARY_MAX_KEYS,
  RUNS_KEY,
  decodeRunRecord,
  encodeRunRecord,
  isUnfinished,
  recordFailure,
  recordStart,
  recordSuccess,
  runRecordCodec,
} from '../../src/core/run-record.ts';

const T0 = Date.parse('2026-09-30T12:00:00Z');

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function roundTrip(record: RunRecord): RunRecord {
  return decodeRunRecord(JSON.parse(JSON.stringify(encodeRunRecord(record))));
}

/** A summary of `n` keys `k0`, `k1`, … with the value `value`. */
function summaryOf(n: number, value = 1): Record<string, number> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i)}`, value]));
}

describe('run record codec', () => {
  it('uses the state.runs key, version 1', () => {
    expect(RUNS_KEY).toBe('state.runs');
    expect(runRecordCodec.version).toBe(1);
  });

  it('round-trips a first start, with v first and no optional fields', () => {
    const record: RunRecord = { lastStart: T0, consecutiveFailures: 0 };
    expect(JSON.stringify(encodeRunRecord(record))).toBe(
      `{"v":1,"lastStart":${String(T0)},"consecutiveFailures":0}`,
    );
    expect(roundTrip(record)).toEqual(record);
  });

  it('round-trips a full record, fields in the stored order', () => {
    const record: RunRecord = {
      lastSummary: { classified: 3, inputTokens: 1234.5 },
      consecutiveFailures: 2,
      lastOutcome: 'failed',
      lastEnd: T0 + 5000,
      lastStart: T0,
    };
    expect(JSON.stringify(encodeRunRecord(record))).toBe(
      `{"v":1,"lastStart":${String(T0)},"lastEnd":${String(T0 + 5000)},"lastOutcome":"failed",` +
        `"consecutiveFailures":2,"lastSummary":{"classified":3,"inputTokens":1234.5}}`,
    );
    expect(roundTrip(record)).toEqual(record);
  });

  it.each<[string, unknown, StateErrorReason]>([
    ['a missing v', { lastStart: T0, consecutiveFailures: 0 }, 'schema'],
    ['an unknown v', { v: 2, lastStart: T0, consecutiveFailures: 0 }, 'version'],
    ['a missing lastStart', { v: 1, consecutiveFailures: 0 }, 'schema'],
    ['a fractional lastStart', { v: 1, lastStart: 1.5, consecutiveFailures: 0 }, 'schema'],
    ['a negative lastEnd', { v: 1, lastStart: T0, lastEnd: -1, consecutiveFailures: 0 }, 'schema'],
    [
      'an unknown outcome',
      { v: 1, lastStart: T0, lastOutcome: 'maybe', consecutiveFailures: 0 },
      'schema',
    ],
    ['negative failures', { v: 1, lastStart: T0, consecutiveFailures: -1 }, 'schema'],
    ['unsafe failures', { v: 1, lastStart: T0, consecutiveFailures: 2 ** 53 }, 'schema'],
    ['a string lastStart', { v: 1, lastStart: String(T0), consecutiveFailures: 0 }, 'schema'],
    ['an extra field', { v: 1, lastStart: T0, consecutiveFailures: 0, more: 1 }, 'schema'],
    [
      'a nested summary',
      { v: 1, lastStart: T0, consecutiveFailures: 0, lastSummary: { labels: { a: 1 } } },
      'schema',
    ],
    [
      'a string in the summary',
      { v: 1, lastStart: T0, consecutiveFailures: 0, lastSummary: { a: '1' } },
      'schema',
    ],
    [
      'a bad summary key',
      { v: 1, lastStart: T0, consecutiveFailures: 0, lastSummary: { 'bad-key': 1 } },
      'schema',
    ],
    [
      'too many summary keys',
      {
        v: 1,
        lastStart: T0,
        consecutiveFailures: 0,
        lastSummary: summaryOf(RUN_SUMMARY_MAX_KEYS + 1),
      },
      'schema',
    ],
    ['an array', [], 'schema'],
    ['a number', 5, 'schema'],
  ])('rejects %s', (_name, raw, reason) => {
    const error = caught(() => decodeRunRecord(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: RUNS_KEY, reason });
  });

  it('accepts 40 summary keys of 32 characters within 2 KB, and rejects more bytes', () => {
    const longKeys = (value: number): Record<string, number> =>
      Object.fromEntries(
        Array.from({ length: RUN_SUMMARY_MAX_KEYS }, (_, i) => [
          `k${String(i).padStart(2, '0')}${'x'.repeat(29)}`,
          value,
        ]),
      );
    const small = longKeys(1);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(roundTrip({ lastStart: T0, consecutiveFailures: 0, lastSummary: small })).toEqual({
      lastStart: T0,
      consecutiveFailures: 0,
      lastSummary: small,
    });
    const big = longKeys(1.234_567_890_123_456_7e300);
    expect(JSON.stringify(big).length).toBeGreaterThan(RUN_SUMMARY_MAX_BYTES);
    expect(() =>
      decodeRunRecord({ v: 1, lastStart: T0, consecutiveFailures: 0, lastSummary: big }),
    ).toThrow(StateError);
  });
});

describe('recordStart', () => {
  it('starts a first record at 0 failures', () => {
    expect(recordStart(undefined, T0)).toEqual({ lastStart: T0, consecutiveFailures: 0 });
  });

  it('keeps the end, outcome, failures and summary of the previous run', () => {
    const previous: RunRecord = {
      lastStart: T0,
      lastEnd: T0 + 1000,
      lastOutcome: 'failed',
      consecutiveFailures: 3,
      lastSummary: { classified: 2 },
    };
    const next = recordStart(previous, T0 + 60_000);
    expect(next).toEqual({ ...previous, lastStart: T0 + 60_000 });
    expect(next.lastStart).toBeGreaterThan(next.lastEnd ?? 0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects at = %s', (at) => {
    expect(() => recordStart(undefined, at)).toThrow(InvalidArgumentError);
  });

  describe('after an unfinished run', () => {
    it('counts a run with no end as a failure: 0 becomes 1', () => {
      const previous: RunRecord = { lastStart: T0, consecutiveFailures: 0 };
      expect(recordStart(previous, T0 + 60_000)).toEqual({
        lastStart: T0 + 60_000,
        consecutiveFailures: 1,
      });
    });

    it('counts an end before the start as a failure, and keeps the rest: 2 becomes 3', () => {
      const previous: RunRecord = {
        lastStart: T0,
        lastEnd: T0 - 60_000,
        lastOutcome: 'failed',
        consecutiveFailures: 2,
        lastSummary: { classified: 2 },
      };
      expect(recordStart(previous, T0 + 60_000)).toEqual({
        lastStart: T0 + 60_000,
        lastEnd: T0 - 60_000,
        lastOutcome: 'failed',
        consecutiveFailures: 3,
        lastSummary: { classified: 2 },
      });
    });

    it('saturates at the largest safe integer, and still round-trips', () => {
      const previous: RunRecord = { lastStart: T0, consecutiveFailures: Number.MAX_SAFE_INTEGER };
      const next = recordStart(previous, T0 + 1);
      expect(next.consecutiveFailures).toBe(Number.MAX_SAFE_INTEGER);
      expect(roundTrip(next)).toEqual(next);
    });
  });

  describe('after a finished run', () => {
    it('keeps an ok run at 0', () => {
      const previous: RunRecord = {
        lastStart: T0,
        lastEnd: T0 + 1000,
        lastOutcome: 'ok',
        consecutiveFailures: 0,
      };
      expect(recordStart(previous, T0 + 60_000).consecutiveFailures).toBe(0);
    });

    it('keeps a failed run at 2: it is not counted twice', () => {
      const previous: RunRecord = {
        lastStart: T0,
        lastEnd: T0 + 1000,
        lastOutcome: 'failed',
        consecutiveFailures: 2,
      };
      expect(recordStart(previous, T0 + 60_000).consecutiveFailures).toBe(2);
    });

    it('keeps the count of a run that ended in the millisecond it started', () => {
      const previous: RunRecord = {
        lastStart: T0,
        lastEnd: T0,
        lastOutcome: 'failed',
        consecutiveFailures: 1,
      };
      expect(recordStart(previous, T0 + 60_000).consecutiveFailures).toBe(1);
    });
  });

  describe('sequences', () => {
    it('counts killed runs 0, 1, 2, 3, then 0 after a success', () => {
      let record = recordStart(undefined, T0);
      const counts = [record.consecutiveFailures];
      for (const minute of [1, 2, 3]) {
        record = recordStart(record, T0 + minute * 60_000);
        counts.push(record.consecutiveFailures);
      }
      expect(counts).toEqual([0, 1, 2, 3]);
      expect(recordSuccess(record, T0 + 181_000).consecutiveFailures).toBe(0);
    });

    it('counts failed, killed, failed as 1, 2, 3', () => {
      // Run 1 fails and records it.
      let record = recordFailure(recordStart(undefined, T0), T0 + 1000);
      expect(record.consecutiveFailures).toBe(1);
      // Run 2 starts (still 1: run 1 is finished) and is killed.
      record = recordStart(record, T0 + 60_000);
      expect(record.consecutiveFailures).toBe(1);
      // Run 3 starts and counts run 2, then fails itself.
      record = recordStart(record, T0 + 120_000);
      expect(record.consecutiveFailures).toBe(2);
      record = recordFailure(record, T0 + 121_000);
      expect(record.consecutiveFailures).toBe(3);
    });
  });
});

describe('RUN_FAILURES_ALERT_THRESHOLD', () => {
  it('is 3', () => {
    expect(RUN_FAILURES_ALERT_THRESHOLD).toBe(3);
  });
});

describe('isUnfinished', () => {
  it.each<[string, RunRecord, boolean]>([
    ['no lastEnd', { lastStart: T0, consecutiveFailures: 0 }, true],
    ['lastEnd before lastStart', { lastStart: T0, lastEnd: T0 - 1, consecutiveFailures: 0 }, true],
    ['lastEnd equal to lastStart', { lastStart: T0, lastEnd: T0, consecutiveFailures: 0 }, false],
    ['lastEnd after lastStart', { lastStart: T0, lastEnd: T0 + 1, consecutiveFailures: 0 }, false],
  ])('%s', (_name, record, expected) => {
    expect(isUnfinished(record)).toBe(expected);
  });
});

describe('recordSuccess', () => {
  const failing: RunRecord = {
    lastStart: T0,
    lastEnd: T0 - 1000,
    lastOutcome: 'failed',
    consecutiveFailures: 4,
    lastSummary: { old: 1 },
  };

  it('ends ok, resets the failures and stores the summary', () => {
    expect(recordSuccess(failing, T0 + 2000, { classified: 5 })).toEqual({
      lastStart: T0,
      lastEnd: T0 + 2000,
      lastOutcome: 'ok',
      consecutiveFailures: 0,
      lastSummary: { classified: 5 },
    });
  });

  it('drops an older summary when the body returned none', () => {
    expect(recordSuccess(failing, T0 + 2000)).toEqual({
      lastStart: T0,
      lastEnd: T0 + 2000,
      lastOutcome: 'ok',
      consecutiveFailures: 0,
    });
  });

  it.each<[string, unknown]>([
    ['a nested value', { labels: { a: 1 } }],
    ['a non-finite value', { a: Number.POSITIVE_INFINITY }],
    ['NaN', { a: Number.NaN }],
    ['a bad key', { 'a-b': 1 }],
    ['a key over 32 characters', { [`a${'b'.repeat(32)}`]: 1 }],
    ['too many keys', summaryOf(RUN_SUMMARY_MAX_KEYS + 1)],
  ])('rejects a summary with %s', (_name, summary) => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately invalid, as a buggy caller might pass
    const error = caught(() => recordSuccess(failing, T0, summary as RunSummary));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ argument: 'summary' });
  });
});

describe('recordFailure', () => {
  it('ends failed, adds a failure and keeps the last summary', () => {
    const record: RunRecord = {
      lastStart: T0,
      consecutiveFailures: 1,
      lastSummary: { classified: 5 },
    };
    expect(recordFailure(record, T0 + 3000)).toEqual({
      lastStart: T0,
      lastEnd: T0 + 3000,
      lastOutcome: 'failed',
      consecutiveFailures: 2,
      lastSummary: { classified: 5 },
    });
  });

  it('saturates at the largest safe integer', () => {
    const record: RunRecord = { lastStart: T0, consecutiveFailures: Number.MAX_SAFE_INTEGER };
    expect(recordFailure(record, T0).consecutiveFailures).toBe(Number.MAX_SAFE_INTEGER);
    expect(roundTrip(recordFailure(record, T0)).consecutiveFailures).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('counts 1, 2, then 0 after a success', () => {
    let record = recordFailure(recordStart(undefined, T0), T0 + 1);
    expect(record.consecutiveFailures).toBe(1);
    record = recordFailure(recordStart(record, T0 + 2), T0 + 3);
    expect(record.consecutiveFailures).toBe(2);
    record = recordSuccess(recordStart(record, T0 + 4), T0 + 5);
    expect(record.consecutiveFailures).toBe(0);
  });
});
