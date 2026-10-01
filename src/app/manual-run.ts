/**
 * The manual processor (Solution Design §6.6 "Continuation"; epic #14
 * decisions 8, 9 and 11; ADR-0009; task #136). Three entry points:
 *
 * - `runManualJob`: one execution's work on the job. Refill the queue from the
 *   job search, take a chunk of manual items, `processChunk`, add its counts to
 *   the job, and go round again until something stops it or the job completes.
 * - `createManualSpareTime`: the hook a scheduled run calls in its spare time.
 * - `continueManualJob`: the body of an editor run (`continueManualRun`, and
 *   `startManualRun` after a start). It does manual work only: no ingest and
 *   no scheduled item.
 *
 * - It takes `source: 'manual'` items only; the scheduled loop takes the rest.
 *   So a chunk never mixes sources and every manual settlement is counted for
 *   the job.
 * - Each thread is taken at most once per execution (`taken`).
 * - Its only Gmail and Jev calls are the refill's and `processChunk`'s. No
 *   retry and no sleep here.
 * - It logs `manual.progress`, `manual.completed`, the refill's
 *   `scope_missing` (`step: 'manual_search'`) and, in an editor run, `run.end`.
 *   Never a body, a subject, a sender, the key or `state`. Only
 *   `manual.completed` carries the job's query.
 * - `runManualJob` never throws `RunAbortError`: it returns `abort`, and its
 *   caller throws after `run.end`. A `StateError`, or an
 *   `UnexpectedResponseError` from the refill or a chunk's screening,
 *   propagates.
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import type { Utf8Decoder } from '../core/body/utf8.ts';
import { DECLARED_SCOPES } from '../core/declared-scopes.ts';
import {
  type ManualExecutionCounts,
  addChunkToExecution,
  addChunkToJob,
  emptyExecutionCounts,
  manualCompletedFields,
  manualProgressFields,
} from '../core/manual-counts.ts';
import { type ManualJob, countExecution } from '../core/manual-job.ts';
import type { RunSummary } from '../core/run-record.ts';
import { GMAIL_UNIT_COST, canStartChunk } from '../core/run-limits.ts';
import { SCOPE_FEATURES } from '../core/scope-features.ts';
import { type WorkQueue, takeChunk } from '../core/work-queue.ts';
import type { AuthPort } from '../ports/auth-port.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { HttpPort } from '../ports/http-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { RandomPort } from '../ports/random-port.ts';
import type { SecretsPort } from '../ports/secrets-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { type LabelCache, createLabelCache } from './label-cache.ts';
import { deleteManualJob, loadManualJob, saveManualJob } from './manual-job-store.ts';
import { refillManualQueue } from './manual-refill.ts';
import { processChunk } from './process-chunk.ts';
import { loadQueue } from './queue-store.ts';
import { type SpareTimeHook, chunkStop, collectAlerts, runAbortError } from './run-controller.ts';
import type { RunContext } from './run-entry.ts';
import { runPreflight } from './run-preflight.ts';

const [GMAIL_MODIFY] = DECLARED_SCOPES;

/** Why an execution stopped working on the job (`manual.progress`'s `stopped`). */
export type ManualStop =
  /** There is no job. */
  | 'no_job'
  /** The job finished in this execution. */
  | 'completed'
  /** Every queued manual item was already taken in this execution. */
  | 'waiting'
  /** No manual item queued, and no room to queue a page. */
  | 'queue_full'
  /** No time, or no Gmail units, for a page or a chunk. */
  | 'deadline'
  | 'units'
  /** A `stopGmail`, from the refill or a chunk. */
  | 'rate_limited'
  | 'scope'
  /** A chunk's `stopSending`. */
  | 'budget'
  | 'send_deadline'
  | 'send_scope'
  | 'outage'
  /** A chunk's `abort`: the caller throws after `run.end`. */
  | 'abort';

export type ManualDeps = {
  readonly http: HttpPort;
  readonly state: StatePort;
  readonly log: LogPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly decodeUtf8: Utf8Decoder;
};

export type ManualRunInput = {
  /** The execution's one cache. */
  readonly labels: LabelCache;
  readonly apiKey: string;
  /** As loaded or saved. */
  readonly queue: WorkQueue;
  /** Threads already taken in this execution. `runManualJob` adds to it. */
  readonly taken: Set<string>;
};

export type ManualRunResult = {
  readonly job: 'none' | 'active' | 'completed';
  /** This execution's 13 flat counts; `{}` when `job` is `none`. */
  readonly counts: RunSummary;
  readonly stopped: ManualStop;
  /** As saved. */
  readonly queue: WorkQueue;
  readonly abort?: 'auth' | 'config_invalid';
};

/**
 * One execution's work on the manual job. With no job it does nothing at all
 * (no log, no write) and returns the queue it was given.
 *
 * Otherwise it counts the execution, then loops: refill, take a manual chunk,
 * check that it may start, `processChunk`, add the chunk to the job and save
 * it, collect the chunk's alerts. It ends when the job completes (the search
 * is done and no manual item is queued: `manual.progress`, `manual.completed`,
 * then the job is deleted) or when something stops it (the job is saved, then
 * `manual.progress`).
 *
 * A crash between `processChunk`'s queue save and the job's save loses that
 * chunk's counts, never a thread.
 *
 * @throws StateError from a load or a save.
 * @throws UnexpectedResponseError from the refill or a chunk's screening.
 */
export function runManualJob(
  ctx: RunContext,
  deps: ManualDeps,
  input: ManualRunInput,
): ManualRunResult {
  const { state, log, clock } = deps;
  const { limits, deadline } = ctx;
  const loaded = loadManualJob(state);
  if (loaded === undefined) {
    return { job: 'none', counts: {}, stopped: 'no_job', queue: input.queue };
  }

  let job: ManualJob = countExecution(loaded);
  let counts: ManualExecutionCounts = emptyExecutionCounts();
  let queue = input.queue;
  let stopped: ManualStop | undefined;
  let abort: 'auth' | 'config_invalid' | undefined;

  /** Time and Gmail units for one more job-search page. */
  const canContinue = (): boolean =>
    deadline.remaining() > 0 &&
    ctx.gmailUsage().units + GMAIL_UNIT_COST.searchThreadIds <= limits.maxGmailUnitsPerRun;

  while (stopped === undefined) {
    const refill = refillManualQueue(
      job,
      queue,
      { gmail: ctx.gmail, state, clock, log },
      canContinue,
    );
    job = refill.job;
    queue = refill.queue;
    counts = {
      ...counts,
      pages: counts.pages + refill.pages,
      queued: counts.queued + refill.queued,
      merged: counts.merged + refill.merged,
    };
    if (refill.stopGmail !== undefined) {
      if (refill.stopGmail === 'scope') {
        const { feature, disables } = SCOPE_FEATURES[GMAIL_MODIFY];
        log.warn('scope_missing', {
          scope: GMAIL_MODIFY,
          step: 'manual_search',
          feature,
          disables,
        });
        ctx.alerts.add('scope_missing', { scopes: [GMAIL_MODIFY] });
      }
      stopped = refill.stopGmail;
      break;
    }

    const chunk = takeChunk(queue, limits.chunkSize, input.taken, 'manual');
    if (chunk.length === 0) {
      if (manualItems(queue) > 0) {
        // All struck or untouched in this execution: the next one takes them.
        stopped = 'waiting';
      } else if (job.searchDone) {
        stopped = 'completed';
      } else if (deadline.remaining() <= 0) {
        stopped = 'deadline';
      } else {
        stopped = canContinue() ? 'queue_full' : 'units';
      }
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
      input.taken.add(item.threadId);
    }

    const result = processChunk(chunk, queue, {
      config: ctx.config,
      gmail: ctx.gmail,
      http: deps.http,
      state,
      log,
      clock,
      random: deps.random,
      labels: input.labels,
      decodeUtf8: deps.decodeUtf8,
      apiKey: input.apiKey,
      remainingMs: deadline.remaining,
    });
    queue = result.queue;
    job = addChunkToJob(job, result);
    saveManualJob(state, job);
    counts = addChunkToExecution(counts, result);
    collectAlerts(ctx, result);
    abort = result.abort;
    stopped = chunkStop(result);
  }

  if (stopped === 'completed') {
    log.info('manual.progress', manualProgressFields(job, { counts, stopped, manualQueued: 0 }));
    log.info('manual.completed', manualCompletedFields(job, clock.now()));
    deleteManualJob(state);
    return { job: 'completed', counts, stopped, queue };
  }

  // This stores `executions` even when nothing else changed.
  saveManualJob(state, job);
  log.info(
    'manual.progress',
    manualProgressFields(job, { counts, stopped, manualQueued: manualItems(queue) }),
  );
  return {
    job: 'active',
    counts,
    stopped,
    queue,
    ...(abort === undefined ? {} : { abort }),
  };
}

function manualItems(queue: WorkQueue): number {
  return queue.filter((item) => item.source === 'manual').length;
}

/**
 * The spare-time hook of a scheduled run: `runManualJob` with the run's
 * context, label cache and key, and the threads the run already took. The run
 * passes its own (scheduled) limits, so spare time does about one manual chunk
 * per run. `runScheduled` reaches the hook only with `script.external_request`
 * granted and budget left, so neither is checked here.
 */
export function createManualSpareTime(deps: ManualDeps): SpareTimeHook {
  return (input) => {
    const result = runManualJob(input.ctx, deps, {
      labels: input.labels,
      apiKey: input.apiKey,
      queue: input.queue,
      taken: new Set(input.settledThreadIds),
    });
    return {
      counts: result.counts,
      queue: result.queue,
      ...(result.abort === undefined ? {} : { abort: result.abort }),
    };
  };
}

/** Why an editor run stopped (`run.end`'s `stopped`). */
export type ManualEditorStop = ManualStop | 'gmail_scope_missing' | 'classify_scope_missing';

export type ManualRunReport = {
  readonly job: 'none' | 'active' | 'completed';
  readonly stopped: ManualEditorStop;
  readonly alerts: readonly AlertCondition[];
};

/**
 * One editor run, from the preflight to `run.end`: manual work only. It never
 * reads history and never takes a scheduled item; the position is moved only
 * by scheduled runs.
 *
 * 1. `runPreflight` (key, scopes, budget).
 * 2. No job: `no_job`, a normal return.
 * 3. No `gmail.modify`: `gmail_scope_missing`, no Gmail call at all.
 * 4. `loadQueue`.
 * 5. No `script.external_request` (`classify_scope_missing`) or the budget
 *    reached (`budget`): no refill and no chunk.
 * 6. One label cache, then `runManualJob` with nothing taken.
 * 7. `run.end`, once, on every path from step 2 on.
 * 8. A chunk's `abort` throws `RunAbortError` after `run.end`; the job and the
 *    queue are already saved.
 *
 * `summary` is the numeric `run.end` fields, for `state.runs.lastSummary`.
 *
 * @throws RunAbortError `missing_key` from the preflight (before anything
 *   else; a saved job stays), or `auth` / `config_invalid` after `run.end`.
 * @throws StateError or UnexpectedResponseError from a callee, without `run.end`.
 */
export function continueManualJob(
  ctx: RunContext,
  deps: ManualDeps & { readonly secrets: SecretsPort; readonly auth: AuthPort },
): { readonly summary: RunSummary; readonly report: ManualRunReport } {
  const { state, log, clock } = deps;
  const preflight = runPreflight(
    { secrets: deps.secrets, auth: deps.auth, state, clock, log },
    ctx.config,
    ctx.alerts,
  );

  let counts: RunSummary = emptyExecutionCounts();
  let job: ManualRunReport['job'] = 'active';
  let stopped: ManualEditorStop;
  let queue: WorkQueue;
  let abort: 'auth' | 'config_invalid' | undefined;

  if (loadManualJob(state) === undefined) {
    job = 'none';
    stopped = 'no_job';
    queue = loadQueue(state);
  } else if (!preflight.scopes.can.gmail) {
    // SD §9: no Gmail call without the scope. The queue is only read, for `queueSize`.
    stopped = 'gmail_scope_missing';
    queue = loadQueue(state);
  } else {
    queue = loadQueue(state);
    if (!preflight.scopes.can.classify) {
      stopped = 'classify_scope_missing';
    } else if (preflight.budgetReached) {
      stopped = 'budget';
    } else {
      const result = runManualJob(ctx, deps, {
        labels: createLabelCache({ gmail: ctx.gmail, log }),
        apiKey: preflight.apiKey,
        queue,
        taken: new Set(),
      });
      job = result.job;
      stopped = result.stopped;
      queue = result.queue;
      abort = result.abort;
      if (result.job !== 'none') {
        counts = result.counts;
      }
    }
  }

  const usage = ctx.gmailUsage();
  const summary: RunSummary = {
    ...counts,
    queueSize: queue.length,
    gmailCalls: usage.calls,
    gmailCallsToday: usage.callsToday,
    gmailUnits: usage.units,
    durationMs: ctx.deadline.elapsed(),
  };
  const alerts = ctx.alerts.collected().conditions;
  log.info('run.end', { ...summary, stopped, job, alerts });

  if (abort !== undefined) {
    throw runAbortError(abort);
  }
  return { summary, report: { job, stopped, alerts } };
}
