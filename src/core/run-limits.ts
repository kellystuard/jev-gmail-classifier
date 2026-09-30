/**
 * The run limits (Solution Design §10.3; ADR-0008; epic E7 decisions 1, 3, 16).
 *
 * Every run (scheduled, manual, lifecycle) takes its soft time limit, reserve,
 * chunk size and per-run Gmail quota-unit cap from here. The values are
 * internal constants, never config. Pure: no clock, no ports, no logging.
 */
import { InvalidArgumentError } from './errors.ts';

export type RunKind = 'scheduled' | 'manual';

export type TriggerInterval = 1 | 5 | 10 | 15 | 30;

export type RunLimits = {
  /** Stop starting new work after this many ms of the run. */
  readonly softLimitMs: number;
  /** Planning figure: time after the soft limit to finish paid-for work. */
  readonly reserveMs: number;
  /** Items per chunk; at most 20 (one `fetchAll` batch). */
  readonly chunkSize: number;
  /** Gmail quota units one run may plan to use (a planning bound, not a hard stop). */
  readonly maxGmailUnitsPerRun: number;
  /** The least `remainingMs` a chunk may start with: `chunkSize * 400 + 5,000`. */
  readonly minChunkStartMs: number;
};

/** The Gmail quota units per `GmailPort` method (Solution Design §9). */
export const GMAIL_UNIT_COST: Readonly<
  Record<
    | 'getProfile'
    | 'listHistory'
    | 'searchThreadIds'
    | 'getThread'
    | 'listLabels'
    | 'createLabel'
    | 'modifyThread',
    number
  >
> = Object.freeze({
  getProfile: 1,
  listHistory: 2,
  searchThreadIds: 10,
  getThread: 40,
  listLabels: 1,
  createLabel: 5,
  modifyThread: 10,
});

/** Metadata read 40 + full read 40 + modify 10. */
export const THREAD_UNIT_ESTIMATE = GMAIL_UNIT_COST.getThread * 2 + GMAIL_UNIT_COST.modifyThread;

/** One exclusion-search page per chunk. */
export const CHUNK_UNIT_OVERHEAD = GMAIL_UNIT_COST.searchThreadIds;

/** Two `threads.get` per thread at up to about 0.2 s each. */
const MS_PER_THREAD_READS = 400;

/** Same value as `INITIAL_ROUND_ESTIMATE_MS` in `src/app/jev-sender.ts` (core/ may not import app/; a test checks they match). */
const SEND_ROUND_ESTIMATE_MS = 5000;

const RESERVE_MS = 10_000;

type Row = {
  readonly softLimitMs: number;
  readonly chunkSize: number;
  readonly maxGmailUnitsPerRun: number;
};

const SCHEDULED_ROWS: Readonly<Record<TriggerInterval, Row>> = {
  1: { softLimitMs: 8000, chunkSize: 5, maxGmailUnitsPerRun: 1000 },
  5: { softLimitMs: 15_000, chunkSize: 20, maxGmailUnitsPerRun: 3000 },
  10: { softLimitMs: 30_000, chunkSize: 20, maxGmailUnitsPerRun: 3000 },
  15: { softLimitMs: 30_000, chunkSize: 20, maxGmailUnitsPerRun: 3000 },
  30: { softLimitMs: 30_000, chunkSize: 20, maxGmailUnitsPerRun: 3000 },
};

const MANUAL_ROW: Row = { softLimitMs: 270_000, chunkSize: 20, maxGmailUnitsPerRun: 13_500 };

function build(row: Row): RunLimits {
  return Object.freeze({
    softLimitMs: row.softLimitMs,
    reserveMs: RESERVE_MS,
    chunkSize: row.chunkSize,
    maxGmailUnitsPerRun: row.maxGmailUnitsPerRun,
    minChunkStartMs: row.chunkSize * MS_PER_THREAD_READS + SEND_ROUND_ESTIMATE_MS,
  });
}

function isInterval(value: number): value is TriggerInterval {
  return value === 1 || value === 5 || value === 10 || value === 15 || value === 30;
}

/**
 * The limits of one run. `lifecycle` runs (`install`, `uninstall`) ask for the
 * `scheduled` row of the configured interval. Returns a fresh frozen object.
 */
export function runLimits(kind: RunKind, triggerIntervalMinutes: TriggerInterval): RunLimits {
  const given: string = kind;
  if (given === 'manual') {
    return build(MANUAL_ROW);
  }
  if (given !== 'scheduled') {
    throw new InvalidArgumentError('Unknown run kind.', {
      argument: 'kind',
      reason: 'must be scheduled or manual',
    });
  }
  if (!isInterval(triggerIntervalMinutes)) {
    throw new InvalidArgumentError('Unsupported trigger interval.', {
      argument: 'triggerIntervalMinutes',
      reason: 'must be 1, 5, 10, 15 or 30',
    });
  }
  return build(SCHEDULED_ROWS[triggerIntervalMinutes]);
}

/** True when a chunk of `chunkLength` items may start now (decision 3). */
export function canStartChunk(
  input: {
    readonly remainingMs: number;
    readonly unitsUsed: number;
    readonly chunkLength: number;
  },
  limits: RunLimits,
): boolean {
  const { remainingMs, unitsUsed, chunkLength } = input;
  if (!Number.isInteger(chunkLength) || chunkLength < 1) {
    throw new InvalidArgumentError('Invalid chunk length.', {
      argument: 'chunkLength',
      reason: 'must be an integer of at least 1',
    });
  }
  if (!Number.isFinite(unitsUsed) || unitsUsed < 0) {
    throw new InvalidArgumentError('Invalid units used.', {
      argument: 'unitsUsed',
      reason: 'must be a finite number of at least 0',
    });
  }
  if (Number.isNaN(remainingMs)) {
    throw new InvalidArgumentError('Invalid remaining time.', {
      argument: 'remainingMs',
      reason: 'must be a number',
    });
  }
  return (
    remainingMs >= limits.minChunkStartMs &&
    unitsUsed + chunkLength * THREAD_UNIT_ESTIMATE + CHUNK_UNIT_OVERHEAD <=
      limits.maxGmailUnitsPerRun
  );
}
