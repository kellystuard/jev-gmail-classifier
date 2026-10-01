/**
 * The `state.runs` heartbeat (Solution Design §7.3, §10.1; epic #13 decision
 * 6): the codec, and the pure updates `runEntry` (`src/app/run-entry.ts`)
 * applies at the start and end of a run. `consecutiveFailures` counts the runs
 * in a row that failed or never recorded their end (`isUnfinished`: killed at
 * the 6-minute limit, or stopped by hand); `runEntry` raises the `run_failures`
 * alert when it goes up and is at least `RUN_FAILURES_ALERT_THRESHOLD` (epic
 * #15 decision 9).
 *
 * Stored as `{"v": 1, "lastStart", "lastEnd"?, "lastOutcome"?,
 * "consecutiveFailures", "lastSummary"?}`, in that order, with absent optional
 * fields left out. A value that can't be decoded throws `StateError` and is
 * never reset.
 */
import { z } from 'zod';

import { InvalidArgumentError } from './errors.ts';
import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';

/** The Script Properties key. */
export const RUNS_KEY = 'state.runs';

/** Flat counts from the body of a successful run, such as `{classified: 12, errored: 0}`. */
export type RunSummary = Readonly<Record<string, number>>;

export type RunRecord = {
  /** Epoch ms when the latest run took the lock. */
  readonly lastStart: number;
  /** Epoch ms when the latest finished run ended. Absent before the first one ends. */
  readonly lastEnd?: number;
  readonly lastOutcome?: 'ok' | 'failed';
  /** Failed or unfinished runs since the last success. A safe integer ≥ 0, saturating. */
  readonly consecutiveFailures: number;
  /** The summary of the latest successful run that returned one. */
  readonly lastSummary?: RunSummary;
};

/** `run_failures` is raised at this many failed or unfinished runs in a row: the same count as the strike rule. */
export const RUN_FAILURES_ALERT_THRESHOLD = 3;

/** At most this many keys in `lastSummary`. */
export const RUN_SUMMARY_MAX_KEYS = 40;

/** `lastSummary`'s JSON text is at most this many UTF-8 bytes. */
export const RUN_SUMMARY_MAX_BYTES = 2048;

/** A summary key: a letter, then letters or digits, at most 32 characters. */
const SUMMARY_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The keys are ASCII, so the JSON text's length is its UTF-8 byte count. */
const summarySchema = z
  .record(
    z.string().regex(SUMMARY_KEY, 'Expected a key like ^[A-Za-z][A-Za-z0-9]{0,31}$'),
    z.number(),
  )
  .refine((summary) => Object.keys(summary).length <= RUN_SUMMARY_MAX_KEYS, {
    message: `Expected at most ${String(RUN_SUMMARY_MAX_KEYS)} keys`,
  })
  .refine((summary) => JSON.stringify(summary).length <= RUN_SUMMARY_MAX_BYTES, {
    message: `Expected at most ${String(RUN_SUMMARY_MAX_BYTES)} bytes of JSON`,
  });

const runRecordSchema = z
  .strictObject({
    lastStart: timestampSchema,
    lastEnd: timestampSchema.optional(),
    lastOutcome: z.enum(['ok', 'failed']).optional(),
    consecutiveFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastSummary: summarySchema.optional(),
  })
  .transform((fields): RunRecord => buildRecord(fields));

/** The record with its fields in the stored order and absent optional fields left out. */
function buildRecord(fields: {
  readonly lastStart: number;
  readonly lastEnd?: number | undefined;
  readonly lastOutcome?: 'ok' | 'failed' | undefined;
  readonly consecutiveFailures: number;
  readonly lastSummary?: RunSummary | undefined;
}): RunRecord {
  return {
    lastStart: fields.lastStart,
    ...(fields.lastEnd === undefined ? {} : { lastEnd: fields.lastEnd }),
    ...(fields.lastOutcome === undefined ? {} : { lastOutcome: fields.lastOutcome }),
    consecutiveFailures: fields.consecutiveFailures,
    ...(fields.lastSummary === undefined ? {} : { lastSummary: { ...fields.lastSummary } }),
  };
}

/**
 * `decode(RUNS_KEY, raw)` throws `StateError` `version` for an unknown `v`,
 * and `schema` for a missing `v` or a bad shape (including a nested, oversized
 * or non-finite `lastSummary`). `encode` writes `v` first.
 */
export const runRecordCodec = defineStateCodec({ version: 1, schema: runRecordSchema });

/** Decodes a `state.runs` value. The caller handles an absent key. Throws `StateError`. */
export function decodeRunRecord(raw: unknown): RunRecord {
  return runRecordCodec.decode(RUNS_KEY, raw);
}

/** The JSON to store under `state.runs`, fields in the stored order. */
export function encodeRunRecord(record: RunRecord): JsonValue {
  return runRecordCodec.encode(buildRecord(record));
}

function checkTime(at: number): void {
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new InvalidArgumentError('at must be a safe integer of at least 0 (epoch ms)', {
      argument: 'at',
      reason: 'invalid_timestamp',
    });
  }
}

/**
 * Whether the run that wrote `lastStart` never recorded its end: no `lastEnd`,
 * or `lastEnd < lastStart`. `lastEnd === lastStart` is finished (a run can
 * start and end in the same millisecond).
 */
export function isUnfinished(record: RunRecord): boolean {
  return record.lastEnd === undefined || record.lastEnd < record.lastStart;
}

/** One more consecutive failure, saturating at `Number.MAX_SAFE_INTEGER`. */
function oneMoreFailure(count: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, count + 1);
}

/**
 * A run took the lock at `at`. Keeps `lastEnd`, `lastOutcome` and
 * `lastSummary` from `previous` (absent: a first run, at 0 failures), so a run
 * that never ends shows as `lastStart > lastEnd`. An unfinished `previous`
 * counts as a failure here, because nothing else could count it: one more
 * consecutive failure. A finished one keeps its count (a failed run already
 * counted itself).
 */
export function recordStart(previous: RunRecord | undefined, at: number): RunRecord {
  checkTime(at);
  if (previous === undefined) return buildRecord({ lastStart: at, consecutiveFailures: 0 });
  return buildRecord({
    ...previous,
    lastStart: at,
    consecutiveFailures: isUnfinished(previous)
      ? oneMoreFailure(previous.consecutiveFailures)
      : previous.consecutiveFailures,
  });
}

/**
 * The run ended well at `at`: `lastOutcome: 'ok'`, `consecutiveFailures: 0`,
 * and `lastSummary` = `summary` (left out when the body returned none, so a
 * summary always describes the latest success). Throws `InvalidArgumentError`
 * for a summary the codec would reject (a bad key, a non-finite or nested
 * value, more than 40 keys, or over 2 KB): a caller bug, never dropped
 * silently.
 */
export function recordSuccess(record: RunRecord, at: number, summary?: RunSummary): RunRecord {
  checkTime(at);
  if (summary !== undefined && !summarySchema.safeParse(summary).success) {
    throw new InvalidArgumentError('The run summary is not a valid flat summary', {
      argument: 'summary',
      reason: 'invalid_summary',
    });
  }
  return buildRecord({
    lastStart: record.lastStart,
    lastEnd: at,
    lastOutcome: 'ok',
    consecutiveFailures: 0,
    lastSummary: summary,
  });
}

/**
 * The run failed at `at`: `lastOutcome: 'failed'` and one more consecutive
 * failure (saturating at `Number.MAX_SAFE_INTEGER`). `lastSummary` is kept:
 * it describes the latest success.
 */
export function recordFailure(record: RunRecord, at: number): RunRecord {
  checkTime(at);
  return buildRecord({
    ...record,
    lastEnd: at,
    lastOutcome: 'failed',
    consecutiveFailures: oneMoreFailure(record.consecutiveFailures),
  });
}
