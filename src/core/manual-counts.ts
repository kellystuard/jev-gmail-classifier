/**
 * Counting a manual job's chunks and building its two report events (Solution
 * Design §6.6 "Reporting", §10.5; epic #14 decisions 5, 10, 11, 15, 16 and 17).
 * Pure: no port, no clock (`now` is a parameter), no logging. `#136` calls it.
 */
import type { MoveDestination } from '../config/schema.ts';
import type { LogFields } from './log-fields.ts';
import { manualJobReservedBytes } from './manual-job.ts';
import type { ManualJob, ManualJobCounts } from './manual-job.ts';

/** What the counting reads of a processed chunk. `ChunkResult` (src/app/process-chunk.ts) satisfies it. */
export type ManualChunkInput = {
  readonly counts: { readonly excluded: number; readonly skipped: number; readonly sent: number };
  readonly inputTokens: number;
  readonly settlements: readonly {
    readonly outcome: 'classified' | 'struck' | 'errored' | 'untouched' | 'gone';
    readonly applied?: { readonly labels: readonly string[]; readonly move?: MoveDestination };
  }[];
};

/** A new key is added to `labels` or `moves` only while the job's reserved size is at most this many UTF-8 bytes. */
export const MANUAL_COUNT_KEYS_MAX_BYTES = 8000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `archive`, `spam`, `trash` or `label:<name>`: the same keys as `run.end`'s `moves`. */
export function moveKey(move: MoveDestination): string {
  return move.kind === 'label' ? `label:${move.label}` : move.kind;
}

/**
 * Adds one processed chunk to the job's totals. Returns a new job. `untouched`
 * settlements add nothing (the thread stays queued). A new label or move key is
 * added only while `manualJobReservedBytes` stays within
 * `MANUAL_COUNT_KEYS_MAX_BYTES`; otherwise it counts in `otherLabels` or
 * `otherMoves`.
 */
export function addChunkToJob(job: ManualJob, chunk: ManualChunkInput): ManualJob {
  const counts: Mutable<ManualJobCounts> = {
    ...job.counts,
    chunks: job.counts.chunks + 1,
    excluded: job.counts.excluded + chunk.counts.excluded,
    skipped: job.counts.skipped + chunk.counts.skipped,
    sent: job.counts.sent + chunk.counts.sent,
    inputTokens: job.counts.inputTokens + chunk.inputTokens,
  };
  for (const settlement of chunk.settlements) {
    if (settlement.outcome !== 'untouched') {
      counts[settlement.outcome] += 1;
    }
  }
  let current: ManualJob = { ...job, counts };
  for (const settlement of chunk.settlements) {
    const applied = settlement.applied;
    if (applied === undefined) continue;
    for (const name of applied.labels) {
      current = countKey(current, 'labels', name);
    }
    if (applied.move !== undefined) {
      current = countKey(current, 'moves', moveKey(applied.move));
    }
  }
  return current;
}

function countKey(job: ManualJob, which: 'labels' | 'moves', key: string): ManualJob {
  // A Map, never `record[key]`: a label can be named `constructor` or `__proto__`.
  const map = new Map(Object.entries(job[which]));
  const existing = map.get(key);
  if (existing !== undefined) {
    map.set(key, existing + 1);
    return { ...job, [which]: Object.fromEntries(map) };
  }
  map.set(key, 1);
  const candidate: ManualJob = { ...job, [which]: Object.fromEntries(map) };
  if (manualJobReservedBytes(candidate) <= MANUAL_COUNT_KEYS_MAX_BYTES) {
    return candidate;
  }
  return which === 'labels'
    ? { ...job, otherLabels: job.otherLabels + 1 }
    : { ...job, otherMoves: job.otherMoves + 1 };
}

/** One execution's flat counts. A `type`, so it is assignable to `RunSummary`. */
export type ManualExecutionCounts = {
  readonly pages: number;
  readonly queued: number;
  readonly merged: number;
  readonly chunks: number;
  readonly excluded: number;
  readonly skipped: number;
  readonly sent: number;
  readonly classified: number;
  readonly struck: number;
  readonly errored: number;
  readonly untouched: number;
  readonly gone: number;
  readonly inputTokens: number;
};

export function emptyExecutionCounts(): ManualExecutionCounts {
  return {
    pages: 0,
    queued: 0,
    merged: 0,
    chunks: 0,
    excluded: 0,
    skipped: 0,
    sent: 0,
    classified: 0,
    struck: 0,
    errored: 0,
    untouched: 0,
    gone: 0,
    inputTokens: 0,
  };
}

/** Adds a chunk to the execution's counts (`untouched` included). Leaves `pages`, `queued` and `merged` alone. */
export function addChunkToExecution(
  counts: ManualExecutionCounts,
  chunk: ManualChunkInput,
): ManualExecutionCounts {
  const next: Mutable<ManualExecutionCounts> = {
    ...counts,
    chunks: counts.chunks + 1,
    excluded: counts.excluded + chunk.counts.excluded,
    skipped: counts.skipped + chunk.counts.skipped,
    sent: counts.sent + chunk.counts.sent,
    inputTokens: counts.inputTokens + chunk.inputTokens,
  };
  for (const settlement of chunk.settlements) {
    next[settlement.outcome] += 1;
  }
  return next;
}

/** The fields of `manual.progress`: the execution's counts and the job's running totals. */
export function manualProgressFields(
  job: ManualJob,
  execution: {
    readonly counts: ManualExecutionCounts;
    readonly stopped: string;
    readonly manualQueued: number;
  },
): LogFields {
  const c = execution.counts;
  return {
    pages: c.pages,
    queued: c.queued,
    merged: c.merged,
    chunks: c.chunks,
    excluded: c.excluded,
    skipped: c.skipped,
    sent: c.sent,
    classified: c.classified,
    struck: c.struck,
    errored: c.errored,
    untouched: c.untouched,
    gone: c.gone,
    inputTokens: c.inputTokens,
    stopped: execution.stopped,
    manualQueued: execution.manualQueued,
    searchDone: job.searchDone,
    seen: job.cursor.seen,
    executions: job.executions,
    totalClassified: job.counts.classified,
    totalErrored: job.counts.errored,
    totalExcluded: job.counts.excluded,
    totalSkipped: job.counts.skipped,
  };
}

/** The fields of `manual.completed`: the job's totals and its per-label and per-destination counts. */
export function manualCompletedFields(job: ManualJob, now: number): LogFields {
  const c = job.counts;
  return {
    query: job.query,
    applyMoves: job.applyMoves,
    startedAt: job.startedAt,
    durationMs: Math.max(0, now - job.startedAt),
    executions: job.executions,
    pages: c.pages,
    queued: c.queued,
    merged: c.merged,
    chunks: c.chunks,
    excluded: c.excluded,
    skipped: c.skipped,
    sent: c.sent,
    classified: c.classified,
    struck: c.struck,
    errored: c.errored,
    gone: c.gone,
    inputTokens: c.inputTokens,
    labels: Object.fromEntries(Object.entries(job.labels)),
    moves: Object.fromEntries(Object.entries(job.moves)),
    otherLabels: job.otherLabels,
    otherMoves: job.otherMoves,
  };
}
