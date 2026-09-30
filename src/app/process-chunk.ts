/**
 * One chunk of the work queue, end to end (Solution Design §6.4; epic #13
 * decision 5; task #266): `screenChunk` → full `getThread` → `threadToState`
 * → `buildRequest` → one `sendJevRequests` call → `settleThread` per entry →
 * `saveQueue` once.
 *
 * E7's run controller loops over it, and E8 reuses it for manual chunks. It
 * takes plain `remainingMs`, not a `Deadline`. It never throws `RunAbortError`
 * itself: it returns `abort`, and the controller throws after its loop
 * (decision 7). It logs only `scope_missing` and the full read's
 * `thread.skipped`; screening, the sender and `settleThread` log their own
 * events.
 */

import type { Config } from '../config/schema.ts';
import type { AlertCondition } from '../core/alert-condition.ts';
import type { Utf8Decoder } from '../core/body/utf8.ts';
import { DECLARED_SCOPES, type DeclaredScope } from '../core/declared-scopes.ts';
import { InvalidArgumentError } from '../core/errors.ts';
import { buildRequest } from '../core/jev-request.ts';
import { threadToState } from '../core/thread-state.ts';
import type { TruncationStats } from '../core/truncation.ts';
import { dequeue, type WorkItem, type WorkItemSource, type WorkQueue } from '../core/work-queue.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { HttpPort } from '../ports/http-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { RandomPort } from '../ports/random-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import type { AppliedChange } from './apply-decision.ts';
import {
  type JevSendEntry,
  type JevSendRequest,
  type JevSendStop,
  MAX_REQUESTS_PER_FETCHALL,
  sendJevRequests,
} from './jev-sender.ts';
import type { LabelCache } from './label-cache.ts';
import { saveQueue } from './queue-store.ts';
import { screenChunk } from './screen-chunk.ts';
import {
  type SettleDeps,
  settleThread,
  strikeForException,
  type ThreadOutcome,
  type ThreadSettlement,
} from './settle-thread.ts';

const [GMAIL_MODIFY, EXTERNAL_REQUEST] = DECLARED_SCOPES;

export type ChunkDeps = {
  readonly config: Config;
  /** The run's counting wrapper (#267), passed by the caller. */
  readonly gmail: GmailPort;
  readonly http: HttpPort;
  readonly state: StatePort;
  readonly log: LogPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  /** The run's one cache. */
  readonly labels: LabelCache;
  readonly decodeUtf8: Utf8Decoder;
  readonly apiKey: string;
  /** The time left for sending, in ms: E7 passes `deadline.remaining`. */
  readonly remainingMs: () => number;
};

export type ChunkCounts = {
  /** Screening's metadata reads (`ScreenCounts.read`); 0 when screening failed. */
  readonly screened: number;
  /** Screening's three skip reasons, plus `not_found` and `no_messages` at the full read. */
  readonly skipped: number;
  /** `ScreenCounts.excluded`. */
  readonly excluded: number;
  /** Requests passed to `sendJevRequests`. */
  readonly sent: number;
};

/** One settled thread, flat, for the controller's `run.end` counts (and E8's per-destination counts). */
export type ChunkSettlement = {
  readonly threadId: string;
  readonly source: WorkItemSource;
  readonly outcome: ThreadOutcome;
  /** `classified` only. */
  readonly applied?: AppliedChange;
  readonly strikes?: number;
};

export type ChunkResult = {
  /** Already saved, except when screening failed (then the input queue, nothing saved). */
  readonly queue: WorkQueue;
  readonly counts: ChunkCounts;
  /** De-duplicated, first-seen order. */
  readonly alerts: readonly AlertCondition[];
  readonly erroredThreadIds: readonly string[];
  /** Every item that was settled, by `settleThread` or by `strikeForException`, in chunk order. */
  readonly settlements: readonly ChunkSettlement[];
  /** The sender's `inputTokens`. */
  readonly inputTokens: number;
  /** The missing scope(s) met by a call in this chunk, for the collector's details. */
  readonly missingScopes: readonly DeclaredScope[];
  readonly stopGmail?: 'rate_limited' | 'scope';
  readonly stopSending?: JevSendStop;
  readonly abort?: 'auth' | 'config_invalid';
};

/** Where a call met a missing scope, for `scope_missing` (SD §10.5). */
type ScopeStep = 'screen' | 'read' | 'send';

/** A thread read and built, waiting for its answer. */
type Built = {
  readonly threadId: string;
  readonly request: JevSendRequest;
  readonly subject?: string;
  readonly from?: string;
  readonly truncated?: TruncationStats;
};

/** What the chunk has gathered so far; turned into a `ChunkResult` at the end. */
type Tally = {
  queue: WorkQueue;
  skipped: number;
  sent: number;
  inputTokens: number;
  readonly alerts: AlertCondition[];
  readonly erroredThreadIds: string[];
  readonly settlements: ChunkSettlement[];
  readonly missingScopes: DeclaredScope[];
  stopGmail?: 'rate_limited' | 'scope';
  stopSending?: JevSendStop;
  abort?: 'auth' | 'config_invalid';
};

/**
 * Processes `chunk` (what `takeChunk` returned for `queue`) and returns the
 * saved queue and what happened.
 *
 * @throws InvalidArgumentError for an empty chunk, one over
 *   `MAX_REQUESTS_PER_FETCHALL` items, a repeated thread ID, or an item not in
 *   `queue` (caller bugs).
 * @throws RunAbortError, StateError from any dependency (the queue save
 *   included), and whatever the sender throws.
 */
export function processChunk(
  chunk: readonly WorkItem[],
  queue: WorkQueue,
  deps: ChunkDeps,
): ChunkResult {
  checkChunk(chunk, queue);
  const { config, log } = deps;

  // 1. Screen. A failure returns at once: nothing saved, nothing sent.
  const screened = screenChunk(deps, config, queue, chunk);
  if (!screened.ok) {
    const scope = screened.kind === 'scope';
    if (scope) {
      logScopeMissing(log, GMAIL_MODIFY, 'screen');
    }
    return {
      queue,
      counts: { screened: 0, skipped: 0, excluded: 0, sent: 0 },
      alerts: scope ? ['scope_missing'] : [],
      erroredThreadIds: [],
      settlements: [],
      inputTokens: 0,
      missingScopes: scope ? [GMAIL_MODIFY] : [],
      stopGmail: screened.kind,
    };
  }

  const { counts } = screened;
  const tally: Tally = {
    queue: screened.queue,
    skipped: counts.skippedNotFound + counts.skippedJevError + counts.skippedNoMessages,
    sent: 0,
    inputTokens: 0,
    alerts: [],
    erroredThreadIds: [],
    settlements: [],
    missingScopes: [],
  };
  const settleDeps: SettleDeps = {
    config,
    gmail: deps.gmail,
    labels: deps.labels,
    state: deps.state,
    log,
  };

  // 2. Read and build each kept thread; 3. send; 4. settle. Then save, whatever happened.
  const built = readAndBuild(
    screened.kept.map(({ item }) => item),
    deps,
    settleDeps,
    tally,
  );
  if (tally.stopGmail === undefined && built.length > 0) {
    const entries = send(built, deps, tally);
    settleEntries(entries, built, settleDeps, tally);
  }
  saveQueue(deps.state, tally.queue);

  return {
    queue: tally.queue,
    counts: {
      screened: counts.read,
      skipped: tally.skipped,
      excluded: counts.excluded,
      sent: tally.sent,
    },
    alerts: tally.alerts,
    erroredThreadIds: tally.erroredThreadIds,
    settlements: tally.settlements,
    inputTokens: tally.inputTokens,
    missingScopes: tally.missingScopes,
    ...(tally.stopGmail === undefined ? {} : { stopGmail: tally.stopGmail }),
    ...(tally.stopSending === undefined ? {} : { stopSending: tally.stopSending }),
    ...(tally.abort === undefined ? {} : { abort: tally.abort }),
  };
}

function checkChunk(chunk: readonly WorkItem[], queue: WorkQueue): void {
  const invalid = (reason: string, argument = 'chunk'): InvalidArgumentError =>
    new InvalidArgumentError(`The chunk is invalid: ${reason}`, { argument, reason });
  if (chunk.length === 0) {
    throw invalid('empty');
  }
  if (chunk.length > MAX_REQUESTS_PER_FETCHALL) {
    throw invalid('too_long');
  }
  const ids = new Set(chunk.map((item) => item.threadId));
  if (ids.size !== chunk.length) {
    throw invalid('duplicate_thread');
  }
  const queued = new Set(queue.map((item) => item.threadId));
  if (chunk.some((item) => !queued.has(item.threadId))) {
    throw invalid('item_not_queued', 'queue');
  }
}

/**
 * The full read and the request for each item, in chunk order. A `rate_limited`
 * or `scope` read sets `tally.stopGmail` and stops: nothing read so far is
 * sent. One thread's exception is one strike for that thread.
 */
function readAndBuild(
  items: readonly WorkItem[],
  deps: ChunkDeps,
  settleDeps: SettleDeps,
  tally: Tally,
): Built[] {
  const built: Built[] = [];
  for (const kept of items) {
    const { threadId, source } = kept;
    try {
      const read = deps.gmail.getThread(threadId, { format: 'full' });
      if (!read.ok) {
        if (read.kind === 'not_found') {
          skip(tally, deps.log, kept, 'not_found');
          continue;
        }
        if (read.kind === 'scope') {
          scopeMissing(tally, deps.log, GMAIL_MODIFY, 'read');
        }
        tally.stopGmail = read.kind;
        return [];
      }
      const fitted = threadToState(
        read.thread,
        {
          plainTextMethod: deps.config.plainTextMethod,
          questions: deps.config.rules.map((rule) => rule.question),
        },
        deps.decodeUtf8,
      );
      const newest = fitted.state[0];
      if (newest === undefined) {
        // The thread changed since screening: nothing left to classify.
        skip(tally, deps.log, kept, 'no_messages');
        continue;
      }
      const body = buildRequest(
        { model: deps.config.jevModel, rules: deps.config.rules },
        fitted.state,
      );
      built.push({
        threadId,
        request: { id: threadId, body },
        ...(newest.subject === undefined ? {} : { subject: newest.subject }),
        ...(newest.from === undefined ? {} : { from: newest.from }),
        ...(fitted.truncated === undefined ? {} : { truncated: fitted.truncated }),
      });
    } catch (error) {
      // Rethrows RunAbortError and StateError.
      const settled = strikeForException(
        error,
        { item: current(tally.queue, threadId), queue: tally.queue },
        settleDeps,
      );
      record(tally, threadId, source, settled);
    }
  }
  return built;
}

function send(built: readonly Built[], deps: ChunkDeps, tally: Tally): readonly JevSendEntry[] {
  tally.sent = built.length;
  const result = sendJevRequests(
    built.map(({ request }) => request),
    {
      http: deps.http,
      clock: deps.clock,
      random: deps.random,
      log: deps.log,
      state: deps.state,
      apiKey: deps.apiKey,
      dailyTokenBudget: deps.config.dailyTokenBudget,
      remainingMs: deps.remainingMs,
    },
  );
  tally.inputTokens = result.inputTokens;
  addAlerts(tally, result.alerts);
  if (result.stopped !== undefined) {
    tally.stopSending = result.stopped;
    if (result.stopped === 'scope') {
      scopeMissing(tally, deps.log, EXTERNAL_REQUEST, 'send');
    }
    // A later stopGmail can keep the paid-for 401 or unknown-model entry from
    // being settled; the stop still aborts the run.
    if (result.stopped === 'auth') {
      tally.abort = 'auth';
    } else if (result.stopped === 'config') {
      tally.abort = 'config_invalid';
    }
  }
  return result.entries;
}

/** Settles each entry in request order, until a settlement stops Gmail work. */
function settleEntries(
  entries: readonly JevSendEntry[],
  built: readonly Built[],
  settleDeps: SettleDeps,
  tally: Tally,
): void {
  let abort: 'auth' | 'config_invalid' | undefined;
  for (const [index, entry] of entries.entries()) {
    const info = built[index];
    if (info === undefined) {
      continue;
    }
    const item = current(tally.queue, info.threadId);
    const settled = settleThread(
      entry,
      {
        item,
        queue: tally.queue,
        ...(info.subject === undefined ? {} : { subject: info.subject }),
        ...(info.from === undefined ? {} : { from: info.from }),
        ...(info.truncated === undefined ? {} : { truncated: info.truncated }),
      },
      settleDeps,
    );
    record(tally, item.threadId, item.source, settled);
    if (settled.alerts.includes('scope_missing')) {
      // A Jev `scope` entry is `script.external_request` (already added by the
      // sender's stop); any other is a Gmail write.
      addScope(tally, 'scope' in entry ? EXTERNAL_REQUEST : GMAIL_MODIFY);
    }
    abort ??= settled.abort;
    if (settled.stopGmail !== undefined) {
      tally.stopGmail = settled.stopGmail;
      break;
    }
  }
  // The first settlement's abort wins over the sender's stop.
  if (abort !== undefined) {
    tally.abort = abort;
  }
}

/** Threads the queue through and records the settlement, its alerts and an errored ID. */
function record(
  tally: Tally,
  threadId: string,
  source: WorkItemSource,
  settled: ThreadSettlement,
): void {
  tally.queue = settled.queue;
  addAlerts(tally, settled.alerts);
  if (settled.outcome === 'errored') {
    tally.erroredThreadIds.push(threadId);
  }
  tally.settlements.push({
    threadId,
    source,
    outcome: settled.outcome,
    ...(settled.applied === undefined ? {} : { applied: settled.applied }),
    ...(settled.strikes === undefined ? {} : { strikes: settled.strikes }),
  });
}

function skip(
  tally: Tally,
  log: LogPort,
  item: WorkItem,
  reason: 'not_found' | 'no_messages',
): void {
  tally.queue = dequeue(tally.queue, item.threadId);
  tally.skipped += 1;
  log.info('thread.skipped', { threadId: item.threadId, source: item.source, reason });
}

/** A call met a missing scope: the alert, the scope, and one `scope_missing` log. */
function scopeMissing(tally: Tally, log: LogPort, scope: DeclaredScope, step: ScopeStep): void {
  addAlerts(tally, ['scope_missing']);
  addScope(tally, scope);
  logScopeMissing(log, scope, step);
}

function logScopeMissing(log: LogPort, scope: DeclaredScope, step: ScopeStep): void {
  log.warn('scope_missing', {
    scope,
    step,
    disables: scope === GMAIL_MODIFY ? 'gmail' : 'classify',
  });
}

function addAlerts(tally: Tally, alerts: readonly AlertCondition[]): void {
  for (const alert of alerts) {
    if (!tally.alerts.includes(alert)) {
      tally.alerts.push(alert);
    }
  }
}

function addScope(tally: Tally, scope: DeclaredScope): void {
  if (!tally.missingScopes.includes(scope)) {
    tally.missingScopes.push(scope);
  }
}

/** The item as it is now in `queue` (screening may have set its first-classification flag). */
function current(queue: WorkQueue, threadId: string): WorkItem {
  const item = queue.find((candidate) => candidate.threadId === threadId);
  if (item === undefined) {
    // Only this function dequeues a kept item, and each is handled once.
    throw new InvalidArgumentError('A kept item left the queue', {
      argument: 'queue',
      reason: 'item_not_queued',
    });
  }
  return item;
}
