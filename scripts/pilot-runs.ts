/**
 * Groups the pilot's log lines by run and reads the two measures that need
 * the sequence of runs: latency (story #156 S8) and the queue balance behind
 * `coverage.balanceBreaks` (task #315).
 *
 * The identity (proved against `runScheduled` in
 * `test/scripts/pilot-queue-balance.test.ts`): across consecutive scheduled
 * runs with no manual work between them,
 *
 *     queueSize = previous queueSize + ingested
 *                 - (excluded + skipped + classified + errored + gone)
 */
import { numberField, type PilotLine, recordField, stringField } from './pilot-log.ts';

/** The entry points whose runs work on manual jobs. */
export const MANUAL_ENTRIES: readonly string[] = ['startManualRun', 'continueManualRun'];

export interface RunRecord {
  readonly runId: string;
  readonly start: PilotLine | undefined;
  readonly end: PilotLine | undefined;
  /** The run's start: its `run.start`, else `run.end` minus `durationMs`, else `run.end`. */
  readonly startTs: number;
  readonly ingests: readonly PilotLine[];
  readonly manualProgress: readonly PilotLine[];
}

interface Draft {
  start?: PilotLine;
  end?: PilotLine;
  ingests: PilotLine[];
  manualProgress: PilotLine[];
}

/** The runs of one entry point, sorted by start. */
export function groupRuns(lines: readonly PilotLine[], entry: string): readonly RunRecord[] {
  const drafts = new Map<string, Draft>();
  for (const line of lines) {
    if (line.entry !== entry) continue;
    if (
      line.event !== 'run.start' &&
      line.event !== 'run.end' &&
      line.event !== 'ingest.done' &&
      line.event !== 'manual.progress'
    ) {
      continue;
    }
    let draft = drafts.get(line.runId);
    if (draft === undefined) {
      draft = { ingests: [], manualProgress: [] };
      drafts.set(line.runId, draft);
    }
    if (line.event === 'run.start') draft.start = line;
    else if (line.event === 'run.end') draft.end = line;
    else if (line.event === 'ingest.done') draft.ingests.push(line);
    else draft.manualProgress.push(line);
  }
  const runs: RunRecord[] = [];
  for (const [runId, draft] of drafts) {
    const { start, end } = draft;
    if (start === undefined && end === undefined) continue;
    const duration = end === undefined ? undefined : numberField(end.fields, 'durationMs');
    const startTs =
      start?.ts ?? (end === undefined ? 0 : duration === undefined ? end.ts : end.ts - duration);
    runs.push({
      runId,
      start,
      end,
      startTs,
      ingests: draft.ingests,
      manualProgress: draft.manualProgress,
    });
  }
  runs.sort((a, b) => a.startTs - b.startTs);
  return runs;
}

/** Scheduled items left at the end of a run: `queueSize` minus the manual items still queued. */
function scheduledLeft(run: RunRecord): number | undefined {
  if (run.end === undefined) return undefined;
  const queueSize = numberField(run.end.fields, 'queueSize');
  if (queueSize === undefined) return undefined;
  let manual = 0;
  for (const progress of run.manualProgress) {
    manual += numberField(progress.fields, 'manualQueued') ?? 0;
  }
  return queueSize - manual;
}

/**
 * A clean run (S8): `run.end` says `drained`, no scheduled item is left, and
 * ingest finished (a call without `stopped`, no unfinished fallback).
 */
export function isCleanRun(run: RunRecord): boolean {
  if (run.end === undefined) return false;
  if (stringField(run.end.fields, 'stopped') !== 'drained') return false;
  if (scheduledLeft(run) !== 0) return false;
  if (run.ingests.length === 0) return false;
  return run.ingests.every((ingest) => {
    if (stringField(ingest.fields, 'stopped') !== undefined) return false;
    const fallback = ingest.fields['fallback'] === true;
    return !fallback || ingest.fields['fallbackDone'] === true;
  });
}

export interface Spread {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentiles, or null for no values. */
export function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[rank - 1] ?? 0;
  };
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1] ?? 0 };
}

export interface Latency {
  readonly cleanRuns: number;
  readonly otherRuns: number;
  readonly lateEpisodes: number;
  readonly maxCleanSpanMs: number | null;
  readonly longestNotCleanStreak: number;
  readonly startGapMs: Spread | null;
  readonly startGapsOverTwoIntervals: number;
}

/** The latency section over the scheduled runs whose start is in `[from, to)`. */
export function latencyOf(
  runs: readonly RunRecord[],
  from: number,
  to: number,
  intervalMinutes: number,
): Latency {
  const inWindow = runs.filter((run) => run.startTs >= from && run.startTs < to);
  const intervalMs = intervalMinutes * 60_000;
  const lateAfterMs = 2 * intervalMs + 120_000;

  let cleanRuns = 0;
  let otherRuns = 0;
  let lateEpisodes = 0;
  let maxCleanSpanMs: number | null = null;
  let streak = 0;
  let longest = 0;
  let previousClean: RunRecord | undefined;
  for (const run of inWindow) {
    if (isCleanRun(run) && run.end !== undefined) {
      cleanRuns += 1;
      streak = 0;
      if (previousClean?.end !== undefined) {
        const span = run.end.ts - previousClean.startTs;
        if (maxCleanSpanMs === null || span > maxCleanSpanMs) maxCleanSpanMs = span;
        if (span > lateAfterMs) lateEpisodes += 1;
      }
      previousClean = run;
    } else {
      otherRuns += 1;
      streak += 1;
      if (streak > longest) longest = streak;
    }
  }

  const starts = inWindow.flatMap((run) => (run.start === undefined ? [] : [run.start.ts]));
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    gaps.push((starts[i] ?? 0) - (starts[i - 1] ?? 0));
  }
  return {
    cleanRuns,
    otherRuns,
    lateEpisodes,
    maxCleanSpanMs,
    longestNotCleanStreak: longest,
    startGapMs: spread(gaps),
    startGapsOverTwoIntervals: gaps.filter((gap) => gap > 2 * intervalMs).length,
  };
}

export interface Balance {
  readonly balanceBreaks: number;
  readonly balanceNotChecked: number;
}

const OUT_KEYS = ['excluded', 'skipped', 'classified', 'errored', 'gone'] as const;

/**
 * Checks the queue identity on each scheduled run that ended in the window.
 * `manualLines` are the manual entries' `run.start` and `run.end` lines. A
 * run is not checked when it has no predecessor, when the predecessor never
 * ended (a failed or unfinished run changed the queue unseen), when it has
 * `spare` work, or when a manual entry ran between the two.
 */
export function balanceOf(
  runs: readonly RunRecord[],
  manualLines: readonly PilotLine[],
  from: number,
  to: number,
): Balance {
  let breaks = 0;
  let notChecked = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run?.end === undefined || run.startTs < from || run.startTs >= to) continue;
    const previous = i === 0 ? undefined : runs[i - 1];
    const queueSize = numberField(run.end.fields, 'queueSize');
    const ingested = numberField(run.end.fields, 'ingested');
    const before = previous?.end === undefined ? undefined : numberField(previous.end.fields, 'queueSize');
    const outs = OUT_KEYS.map((key) => numberField(run.end?.fields ?? {}, key));
    const manualBetween =
      previous?.end !== undefined &&
      manualLines.some((line) => line.ts > (previous.end?.ts ?? 0) && line.ts < (run.end?.ts ?? 0));
    if (
      previous === undefined ||
      before === undefined ||
      queueSize === undefined ||
      ingested === undefined ||
      outs.some((value) => value === undefined) ||
      recordField(run.end.fields, 'spare') !== undefined ||
      manualBetween
    ) {
      notChecked += 1;
      continue;
    }
    const out = outs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (queueSize !== before + ingested - out) breaks += 1;
  }
  return { balanceBreaks: breaks, balanceNotChecked: notChecked };
}
