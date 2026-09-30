/**
 * The run controller (Solution Design §6.2; epic #13 decision 7; task #118):
 * the body `onTrigger` runs inside `runEntry`.
 *
 * 1. `runPreflight`: the key (a missing one throws `RunAbortError('missing_key')`),
 *    the scopes and the budget.
 * 2. No `gmail.modify`: nothing else runs, not even a Gmail call.
 * 3. `loadQueue`, then 4. `ingest`, bounded by the deadline and the run's Gmail
 *    units. `rate_limited` or `scope` means no processing this run.
 * 5. The chunk loop, only with `script.external_request` and budget left: one
 *    `LabelCache` per run; each chunk starts only while `canStartChunk` allows
 *    (time, then units); each thread is taken **at most once per run**; the
 *    loop stops after a chunk that stopped Gmail work, stopped sending, or
 *    asked to abort.
 * 6. E8's spare-time hook, when scheduled work drained with time left.
 * 7. `run.end`, once, also when a step stopped early and before an abort.
 * 8. An abort (`auth`, `config_invalid`) throws `RunAbortError` after
 *    `run.end`; the queue is already saved and `runEntry` logs `run.failed`.
 *
 * It logs only `run.end` and ingest's `scope_missing`: each callee logs its
 * own events. A `RunAbortError` or `StateError` thrown by a callee propagates
 * without `run.end`.
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import type { Utf8Decoder } from '../core/body/utf8.ts';
import { DECLARED_SCOPES } from '../core/declared-scopes.ts';
import { RunAbortError } from '../core/errors.ts';
import type { RunSummary } from '../core/run-record.ts';
import { canStartChunk } from '../core/run-limits.ts';
import { SCOPE_FEATURES } from '../core/scope-features.ts';
import { takeChunk, type WorkQueue } from '../core/work-queue.ts';
import type { AuthPort } from '../ports/auth-port.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { HttpPort } from '../ports/http-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { RandomPort } from '../ports/random-port.ts';
import type { SecretsPort } from '../ports/secrets-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { ingest, type IngestResult } from './ingest.ts';
import { createLabelCache, type LabelCache } from './label-cache.ts';
import { type ChunkResult, processChunk } from './process-chunk.ts';
import { loadQueue } from './queue-store.ts';
import type { RunContext } from './run-entry.ts';
import { runPreflight } from './run-preflight.ts';

const [GMAIL_MODIFY] = DECLARED_SCOPES;

export type SpareTimeInput = {
  readonly ctx: RunContext;
  readonly labels: LabelCache;
  readonly apiKey: string;
  /** As saved after the loop. */
  readonly queue: WorkQueue;
  /** Taken this run: never take them again. */
  readonly settledThreadIds: ReadonlySet<string>;
};

/** E8's hook: manual work in spare time. Returns flat counts for `run.end`'s `spare` field. E7 passes none. */
export type SpareTimeHook = (input: SpareTimeInput) => RunSummary;

export type ScheduledDeps = {
  readonly http: HttpPort;
  readonly state: StatePort;
  readonly log: LogPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly secrets: SecretsPort;
  readonly auth: AuthPort;
  readonly decodeUtf8: Utf8Decoder;
  readonly spareTime?: SpareTimeHook;
};

/** Why the run stopped (SD §6.2, §10.5 `run.end`). */
export type RunStop =
  /** Preflight: `gmail.modify` is missing, nothing ran. */
  | 'gmail_scope_missing'
  | 'ingest_rate_limited'
  | 'ingest_scope'
  /** Preflight: `script.external_request` is missing; ingest ran. */
  | 'classify_scope_missing'
  /** Preflight or the sender: today's token budget is reached. */
  | 'budget'
  /** Nothing left to take this run. */
  | 'drained'
  /** Not enough time, or Gmail units, left to start the next chunk. */
  | 'deadline'
  | 'units'
  /** A chunk's `stopGmail`. */
  | 'rate_limited'
  | 'scope'
  /** A chunk's `stopSending` (`budget` maps to `budget`). */
  | 'send_deadline'
  | 'send_scope'
  | 'outage'
  /** A chunk's `abort` (`auth`, `config_invalid`): `RunAbortError` is thrown after `run.end`. */
  | 'abort';

export type RunReport = {
  /** Flat numbers for `state.runs.lastSummary` (#120). */
  readonly summary: RunSummary;
  readonly stopped: RunStop;
  /** Threads labelled, per label name. */
  readonly labels: Readonly<Record<string, number>>;
  /** Threads moved, per destination (`archive`, `spam`, `trash`, `label:<name>`). */
  readonly moves: Readonly<Record<string, number>>;
  readonly alerts: readonly AlertCondition[];
};

/** The run's counts, gathered as it goes. */
type Tally = {
  ingested: number;
  merged: number;
  excluded: number;
  skipped: number;
  classified: number;
  struck: number;
  errored: number;
  untouched: number;
  gone: number;
  sent: number;
  chunks: number;
  inputTokens: number;
  queueSize: number;
  /** Maps, so a label named like an `Object.prototype` member is counted safely. */
  readonly labels: Map<string, number>;
  readonly moves: Map<string, number>;
};

/** Where processing stopped, and whether a chunk asked to abort. */
type LoopEnd = {
  readonly stopped: RunStop;
  readonly queue: WorkQueue;
  readonly abort?: 'auth' | 'config_invalid';
  readonly spare?: RunSummary;
};

/**
 * One scheduled run, from the preflight to `run.end`.
 *
 * @throws RunAbortError `missing_key` from the preflight (before any Gmail or
 *   Jev call), or `auth` / `config_invalid` after `run.end` when a chunk
 *   returned `abort`.
 * @throws StateError from any callee (a missing `state.position`: run `install`).
 */
export function runScheduled(ctx: RunContext, deps: ScheduledDeps): RunReport {
  const { state, log, clock } = deps;
  const preflight = runPreflight(
    { secrets: deps.secrets, auth: deps.auth, state, clock, log },
    ctx.config,
    ctx.alerts,
  );
  const tally = emptyTally();

  let end: LoopEnd;
  if (!preflight.scopes.can.gmail) {
    // SD §9: a trigger run calling an unauthorized service fails at once, so
    // no Gmail call is made. The queue is only read, for `queueSize`.
    end = { stopped: 'gmail_scope_missing', queue: loadQueue(state) };
  } else {
    let queue = loadQueue(state);
    const ingested = ingest({ gmail: ctx.gmail, state, log, clock }, queue, {
      shouldContinue: () =>
        ctx.deadline.remaining() > 0 && ctx.gmailUsage().units < ctx.limits.maxGmailUnitsPerRun,
    });
    queue = ingested.queue;
    addIngest(tally, ingested.result);
    ctx.alerts.addAll(ingested.result.alerts);

    if (ingested.result.stopped === 'rate_limited') {
      end = { stopped: 'ingest_rate_limited', queue };
    } else if (ingested.result.stopped === 'scope') {
      const { feature, disables } = SCOPE_FEATURES[GMAIL_MODIFY];
      log.warn('scope_missing', { scope: GMAIL_MODIFY, step: 'ingest', feature, disables });
      ctx.alerts.add('scope_missing', { scopes: [GMAIL_MODIFY] });
      end = { stopped: 'ingest_scope', queue };
    } else if (!preflight.scopes.can.classify) {
      end = { stopped: 'classify_scope_missing', queue };
    } else if (preflight.budgetReached) {
      end = { stopped: 'budget', queue };
    } else {
      end = processQueue(ctx, deps, preflight.apiKey, queue, tally);
    }
  }
  tally.queueSize = end.queue.length;

  const usage = ctx.gmailUsage();
  const summary: RunSummary = {
    ingested: tally.ingested,
    merged: tally.merged,
    excluded: tally.excluded,
    skipped: tally.skipped,
    classified: tally.classified,
    struck: tally.struck,
    errored: tally.errored,
    untouched: tally.untouched,
    gone: tally.gone,
    sent: tally.sent,
    chunks: tally.chunks,
    inputTokens: tally.inputTokens,
    queueSize: tally.queueSize,
    gmailCalls: usage.calls,
    gmailCallsToday: usage.callsToday,
    gmailUnits: usage.units,
    durationMs: ctx.deadline.elapsed(),
  };
  const alerts = ctx.alerts.collected().conditions;
  log.info('run.end', {
    ...summary,
    stopped: end.stopped,
    labels: Object.fromEntries(tally.labels),
    moves: Object.fromEntries(tally.moves),
    alerts,
    ...(end.spare === undefined ? {} : { spare: { ...end.spare } }),
  });

  if (end.abort !== undefined) {
    throw new RunAbortError(
      end.abort === 'auth'
        ? 'Jev refused the API key: check JEV_API_KEY in Script Properties'
        : 'Jev rejected the configured model: check jevModel in config.yaml',
      { reason: end.abort },
    );
  }
  return {
    summary,
    stopped: end.stopped,
    labels: Object.fromEntries(tally.labels),
    moves: Object.fromEntries(tally.moves),
    alerts,
  };
}

/**
 * The chunk loop (step 5) and the spare-time hook (step 6). Each thread is
 * taken at most once per run: a struck or untouched item stays at the front of
 * the queue, and `taken` keeps it out of later chunks.
 */
function processQueue(
  ctx: RunContext,
  deps: ScheduledDeps,
  apiKey: string,
  initial: WorkQueue,
  tally: Tally,
): LoopEnd {
  const { limits, deadline } = ctx;
  const labels = createLabelCache({ gmail: ctx.gmail, log: deps.log });
  const taken = new Set<string>();
  let queue = initial;
  let stopped: RunStop | undefined;
  let abort: 'auth' | 'config_invalid' | undefined;

  while (stopped === undefined) {
    const chunk = takeChunk(queue, limits.chunkSize, taken);
    if (chunk.length === 0) {
      stopped = 'drained';
      break;
    }
    const remainingMs = deadline.remaining();
    if (
      !canStartChunk(
        { remainingMs, unitsUsed: ctx.gmailUsage().units, chunkLength: chunk.length },
        limits,
      )
    ) {
      stopped = remainingMs < limits.minChunkStartMs ? 'deadline' : 'units';
      break;
    }
    for (const item of chunk) {
      taken.add(item.threadId);
    }

    const result = processChunk(chunk, queue, {
      config: ctx.config,
      gmail: ctx.gmail,
      http: deps.http,
      state: deps.state,
      log: deps.log,
      clock: deps.clock,
      random: deps.random,
      labels,
      decodeUtf8: deps.decodeUtf8,
      apiKey,
      remainingMs: deadline.remaining,
    });
    queue = result.queue;
    addChunk(tally, result);
    collectAlerts(ctx, result);
    abort = result.abort;
    stopped = chunkStop(result);
  }

  if (stopped === 'drained' && deps.spareTime !== undefined && deadline.remaining() > 0) {
    const spare = deps.spareTime({ ctx, labels, apiKey, queue, settledThreadIds: taken });
    return { stopped, queue, spare };
  }
  return { stopped, queue, ...(abort === undefined ? {} : { abort }) };
}

/** Why the loop stops after this chunk, or `undefined` to go on. The abort wins. */
function chunkStop(result: ChunkResult): RunStop | undefined {
  if (result.abort !== undefined) return 'abort';
  if (result.stopGmail !== undefined) return result.stopGmail;
  switch (result.stopSending) {
    case undefined:
      return undefined;
    case 'budget':
      return 'budget';
    case 'deadline':
      return 'send_deadline';
    case 'scope':
      return 'send_scope';
    case 'outage':
      return 'outage';
    case 'auth':
    case 'config':
      // processChunk sets `abort` with these; kept for safety.
      return 'abort';
  }
}

function collectAlerts(ctx: RunContext, result: ChunkResult): void {
  ctx.alerts.addAll(result.alerts);
  if (result.erroredThreadIds.length > 0) {
    ctx.alerts.add('errored', { threadIds: result.erroredThreadIds });
  }
  if (result.missingScopes.length > 0) {
    ctx.alerts.add('scope_missing', { scopes: result.missingScopes });
  }
}

function emptyTally(): Tally {
  return {
    ingested: 0,
    merged: 0,
    excluded: 0,
    skipped: 0,
    classified: 0,
    struck: 0,
    errored: 0,
    untouched: 0,
    gone: 0,
    sent: 0,
    chunks: 0,
    inputTokens: 0,
    queueSize: 0,
    labels: new Map(),
    moves: new Map(),
  };
}

function addIngest(tally: Tally, result: IngestResult): void {
  tally.ingested += result.counts.queued;
  tally.merged += result.counts.merged;
}

function addChunk(tally: Tally, result: ChunkResult): void {
  tally.chunks += 1;
  tally.excluded += result.counts.excluded;
  tally.skipped += result.counts.skipped;
  tally.sent += result.counts.sent;
  tally.inputTokens += result.inputTokens;
  for (const settlement of result.settlements) {
    tally[settlement.outcome] += 1;
    const applied = settlement.applied;
    if (applied === undefined) continue;
    for (const name of applied.labels) {
      increment(tally.labels, name);
    }
    if (applied.move !== undefined) {
      increment(
        tally.moves,
        applied.move.kind === 'label' ? `label:${applied.move.label}` : applied.move.kind,
      );
    }
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
