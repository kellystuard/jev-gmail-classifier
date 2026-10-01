/**
 * Ingest: Gmail history to the work queue (Solution Design §6.3; epic #9
 * decisions 5, 6, 8, 9 and 10).
 *
 * Reads history from `state.position` one page at a time, queues each thread
 * with a new received or sent message, saves the queue, then moves the
 * position. It calls only `GmailPort.listHistory`: no thread is read here
 * (decision 6). `screenChunk` (#71) checks `Jev/Error`, current labels and
 * first classification when an item is first read.
 *
 * It also re-queues a thread when the user removes `Jev/Error` from it (#65):
 * a `labelRemoved` entry whose removed labels include an ID in
 * `state.jevErrorLabel`. That retry is `scheduled` and labels-only
 * (`firstClassification: false`), and resets the strikes of an item already
 * queued (decisions 5 and 7).
 *
 * When Gmail no longer accepts the position (`history_expired`, a 404), it
 * starts the resumable fallback (#73; SD §6.3 "Expired position"): it reads
 * the mailbox's current `historyId` from `getProfile`, saves a cursor in
 * `state.fallback`, and searches time windows, oldest first, across as many
 * calls as it takes (`src/core/history-fallback.ts`). While the cursor exists,
 * ingest runs the fallback instead of reading history. When it's done, the
 * position is set from the cursor, and then the cursor is deleted.
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import { assertNever } from '../core/assert-never.ts';
import { StateError } from '../core/errors.ts';
import type { GmailHistoryRecord } from '../core/gmail-types.ts';
import { jevErrorRemovalThreadIds, messageAddedThreadIds } from '../core/history-records.ts';
import { decodePosition, encodePosition, type Position, POSITION_KEY } from '../core/position.ts';
import {
  advanceFallback,
  canStopEarly,
  FALLBACK_KEY,
  FALLBACK_MAX_PAGES,
  type FallbackCursor,
  fallbackCursorCodec,
  type FallbackWindow,
  fallbackWindow,
  isFallbackDone,
  planWindow,
  shrinkWindow,
  startFallback,
} from '../core/history-fallback.ts';
import { type Fail, fail, ok, type Result } from '../core/result.ts';
import { enqueue, QUEUE_MAX_ITEMS, type WorkQueue } from '../core/work-queue.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailFailure, GmailHistoryType, GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { readJevErrorLabelIds } from './jev-error-label-store.ts';
import { saveQueue } from './queue-store.ts';
import { rejectedPageTokenError } from './rejected-page-token.ts';

/** The history types ingest asks for, in one call (SD §6.3). */
export const INGEST_HISTORY_TYPES: readonly GmailHistoryType[] = ['messageAdded', 'labelRemoved'];

/** `maxResults` for every `history.list` page (decision 9). */
export const INGEST_PAGE_SIZE = 100;

/** `maxResults` for every fallback search page (`threads.list` allows up to 500). */
export const FALLBACK_SEARCH_PAGE_SIZE = 500;

export type IngestDeps = {
  readonly gmail: GmailPort;
  readonly state: StatePort;
  readonly log: LogPort;
  readonly clock: ClockPort;
};

export type IngestOptions = {
  /**
   * Checked before each `listHistory` call (the first included), before
   * `getProfile`, before each fallback window, and before each search page
   * after a window's first. Default: always true. E7 passes its `Deadline` check.
   */
  readonly shouldContinue?: () => boolean;
};

/**
 * Why ingest stopped before the end of history, or of the fallback. Each is a
 * normal result. In history, the position moves to the last fully handled
 * record; in the fallback, every completed window is kept:
 * - `cap`: the queue is full (back-pressure; processing makes room), or a
 *   fallback window must wait for room;
 * - `deadline`: `shouldContinue()` returned false;
 * - `rate_limited`: Gmail's per-user limit, so stop Gmail work for this run;
 * - `scope`: `gmail.modify` isn't granted. E7 logs and alerts `scope_missing`.
 */
export type IngestStop = 'cap' | 'deadline' | 'rate_limited' | 'scope';

export type IngestCounts = {
  /** `listHistory` calls that succeeded. */
  readonly pages: number;
  /** Records read, bare ones included. */
  readonly records: number;
  /** New work items, from history and the fallback. */
  readonly queued: number;
  /** Enqueues merged into an existing item, including a thread queued earlier in the same call. */
  readonly merged: number;
  /** `messagesAdded` entries left out for `DRAFT`, `SPAM` or `TRASH`. */
  readonly ignored: number;
  /** Distinct threads queued or merged because the user removed `Jev/Error` from them. */
  readonly jevErrorRetries: number;
};

/** The expired-history fallback's progress in one call (SD §6.3 "Expired position"). */
export type IngestFallback = {
  /** This call created the cursor (and reported `history_expired`). */
  readonly started: boolean;
  /** This call finished the fallback: the position is set and the cursor deleted. */
  readonly done: boolean;
  /** Windows completed in this call. */
  readonly windows: number;
  /** This call's fallback items: new ones. */
  readonly queued: number;
  /** This call's fallback items: merged into an existing item. */
  readonly merged: number;
  /** New threads this call found but had no room for (`take_some`): a lower bound. */
  readonly missed: number;
  /** Epoch s: the next window's `after:` bound. Past `until` when done. */
  readonly nextAfter: number;
  /** Epoch s: the last second the fallback searches. */
  readonly until: number;
};

export type IngestResult = {
  readonly stopped?: IngestStop;
  /** Conditions for E7 to pass on to E9's alerts: `history_expired` from the call that starts a fallback. */
  readonly alerts: readonly AlertCondition[];
  readonly counts: IngestCounts;
  /** Set on every call that ran or started a fallback. */
  readonly fallback?: IngestFallback;
};

type MutableCounts = { -readonly [K in keyof IngestCounts]: IngestCounts[K] };

/**
 * Ingests history from `state.position` into `queue`, and returns the new
 * queue and a result. The queue is saved (when any enqueue succeeded) before
 * the position or the fallback cursor moves.
 *
 * - **Fallback:** when `state.fallback` exists, ingest runs the fallback
 *   instead of reading history, and doesn't read `state.position`. On
 *   `history_expired` from any history page, it starts one (`startFallback`).
 * - **Position:** after the last page, that page's `historyId`. When stopped
 *   early (`cap`, `deadline`, `rate_limited`, `scope`), the `id` of the last
 *   record fully handled, or unchanged if there's none. `savedAt` is read
 *   after the last `listHistory` call. An unchanged `historyId` isn't written.
 *   When a fallback finishes, `{historyId: cursor.historyId, savedAt: cursor.startedAt}`.
 * - **Throws** `StateError` `missing` when `state.position` is absent (only
 *   `install` writes the first one), and whatever the codecs, a Gmail call
 *   (`UnexpectedResponseError`) or the state store throws. Nothing is caught:
 *   the next run reads the same history, or searches the same window, again,
 *   and repeated threads merge.
 * - Logs `ingest.done` once per call that returns.
 */
export function ingest(
  deps: IngestDeps,
  queue: WorkQueue,
  options: IngestOptions = {},
): { queue: WorkQueue; result: IngestResult } {
  const shouldContinue = options.shouldContinue ?? (() => true);
  const counts: MutableCounts = {
    pages: 0,
    records: 0,
    queued: 0,
    merged: 0,
    ignored: 0,
    jevErrorRetries: 0,
  };

  const rawCursor = deps.state.get(FALLBACK_KEY);
  if (rawCursor !== undefined) {
    // The fallback owns the next position: `state.position` isn't read.
    const cursor = fallbackCursorCodec.decode(FALLBACK_KEY, rawCursor);
    const run = runFallback(deps, shouldContinue, counts, queue, cursor, false);
    return finish(deps.log, {
      queue: run.queue,
      ...(run.stopped === undefined ? {} : { stopped: run.stopped }),
      counts,
      alerts: [],
      fallback: run.fallback,
      ...(run.fallback.done ? { historyId: cursor.historyId } : {}),
    });
  }

  const position = readPosition(deps.state);
  const history = readHistory(deps, shouldContinue, counts, queue, position);
  if (history.expired) {
    return startFallbackAfterExpiry(deps, shouldContinue, counts, history.queue, position);
  }

  if (counts.queued + counts.merged > 0) {
    saveQueue(deps.state, history.queue);
  }
  if (history.historyId !== position.historyId) {
    deps.state.set(
      POSITION_KEY,
      encodePosition({ historyId: history.historyId, savedAt: deps.clock.now() }),
    );
  }

  return finish(deps.log, {
    queue: history.queue,
    ...(history.stopped === undefined ? {} : { stopped: history.stopped }),
    counts,
    alerts: [],
    startHistoryId: position.historyId,
    historyId: history.historyId,
  });
}

/** Reads and decodes `state.position`. Throws `StateError` (`missing`, or the codec's). */
function readPosition(state: StatePort): Position {
  const raw = state.get(POSITION_KEY);
  if (raw === undefined) {
    throw new StateError(`State ${POSITION_KEY} is missing: install writes it`, {
      key: POSITION_KEY,
      reason: 'missing',
    });
  }
  return decodePosition(raw);
}

type HistoryRead = {
  readonly queue: WorkQueue;
  readonly stopped?: IngestStop;
  /** A page returned `history_expired`: the caller starts the fallback. */
  readonly expired: boolean;
  /** The position to save (SD §6.3 "Advance"). Unused when `expired`. */
  readonly historyId: string;
};

/** Pages through history from `position`, queuing threads. Saves nothing. */
function readHistory(
  deps: IngestDeps,
  shouldContinue: () => boolean,
  counts: MutableCounts,
  queue: WorkQueue,
  position: Position,
): HistoryRead {
  // Read once, before the first page. A `StateError` propagates (decision 9).
  const recordContext: RecordContext = {
    clock: deps.clock,
    position,
    jevErrorLabelIds: readJevErrorLabelIds(deps.state),
    retriedThreadIds: new Set(),
    counts,
  };

  let current = queue;
  let lastHandledId: string | undefined;
  let pageToken: string | undefined;
  let stopped: IngestStop | undefined;
  let endHistoryId: string | undefined;

  while (stopped === undefined && endHistoryId === undefined) {
    if (!shouldContinue()) {
      stopped = 'deadline';
      break;
    }
    const page = deps.gmail.listHistory({
      startHistoryId: position.historyId,
      historyTypes: INGEST_HISTORY_TYPES,
      maxResults: INGEST_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!page.ok) {
      // Classification (ES §5): `rate_limited` and `scope` are normal
      // failures that stop this run's ingest, keeping what's handled.
      // `history_expired` starts the fallback. Anything else was thrown by
      // the adapter as exceptional, and propagates.
      switch (page.kind) {
        case 'rate_limited':
        case 'scope':
          stopped = page.kind;
          break;
        case 'history_expired':
          return { queue: current, expired: true, historyId: position.historyId };
        default:
          return assertNever(page);
      }
      break;
    }
    counts.pages += 1;

    for (const record of page.records) {
      counts.records += 1;
      const step = ingestRecord(recordContext, current, record);
      current = step.queue;
      if (!step.handled) {
        stopped = 'cap';
        break;
      }
      lastHandledId = record.id;
    }

    if (stopped === undefined) {
      if (page.nextPageToken === undefined) {
        endHistoryId = page.historyId;
      } else {
        pageToken = page.nextPageToken;
      }
    }
  }

  return {
    queue: current,
    ...(stopped === undefined ? {} : { stopped }),
    expired: false,
    // Never a page's `historyId` when stopping early: it's the mailbox's
    // current ID, and would skip the pages not yet read (SD §6.3 "Advance").
    historyId: endHistoryId ?? lastHandledId ?? position.historyId,
  };
}

type RecordContext = {
  readonly clock: ClockPort;
  readonly position: Position;
  /** The IDs in `state.jevErrorLabel`, read once per call. */
  readonly jevErrorLabelIds: readonly string[];
  /** The threads counted in `counts.jevErrorRetries`, so a thread in two records counts once. */
  readonly retriedThreadIds: Set<string>;
  readonly counts: MutableCounts;
};

/**
 * Queues the threads of one record: its `messageAdded` threads, then the
 * threads whose `Jev/Error` was removed. `handled` is true when every thread
 * was queued or merged, or there was nothing to queue. At the cap it's false,
 * and the threads queued before it stay in the returned queue: the next run
 * reads the record again, and they merge.
 */
function ingestRecord(
  context: RecordContext,
  queue: WorkQueue,
  record: GmailHistoryRecord,
): { readonly queue: WorkQueue; readonly handled: boolean } {
  const { clock, position, counts } = context;
  const added = messageAddedThreadIds(record);
  counts.ignored += added.ignored;
  let current = queue;
  for (const threadId of added.threadIds) {
    const result = enqueue(current, {
      threadId,
      source: 'scheduled',
      enqueuedAt: clock.now(),
      positionSavedAt: position.savedAt,
    });
    if (!result.ok) {
      return { queue: current, handled: false };
    }
    current = result.queue;
    counts[result.outcome] += 1;
  }
  for (const threadId of jevErrorRemovalThreadIds(record, context.jevErrorLabelIds)) {
    // A retry is labels-only: its messages predate the position (decision 7).
    const result = enqueue(current, {
      threadId,
      source: 'scheduled',
      enqueuedAt: clock.now(),
      firstClassification: false,
      resetStrikes: true,
    });
    if (!result.ok) {
      return { queue: current, handled: false };
    }
    current = result.queue;
    counts[result.outcome] += 1;
    context.retriedThreadIds.add(threadId);
    counts.jevErrorRetries = context.retriedThreadIds.size;
  }
  return { queue: current, handled: true };
}

// ---------------------------------------------------------------------------
// The expired-history fallback (#73; SD §6.3 "Expired position")
// ---------------------------------------------------------------------------

/**
 * `history_expired` from a history page: reads the resume point from
 * `getProfile` before any search, saves the queue (if earlier pages changed
 * it), writes the cursor, logs `history.expired`, reports the alert, and runs
 * the fallback in the same call. `state.position` stays as it is until the
 * fallback finishes. When `shouldContinue()` is false or `getProfile` fails,
 * no cursor is written, and the next run gets the 404 again.
 */
function startFallbackAfterExpiry(
  deps: IngestDeps,
  shouldContinue: () => boolean,
  counts: MutableCounts,
  queue: WorkQueue,
  position: Position,
): { queue: WorkQueue; result: IngestResult } {
  const profile = shouldContinue() ? deps.gmail.getProfile() : undefined;
  if (counts.queued + counts.merged > 0) {
    saveQueue(deps.state, queue);
  }
  const unchanged = {
    queue,
    counts,
    alerts: [],
    startHistoryId: position.historyId,
    historyId: position.historyId,
  };
  if (profile === undefined) {
    return finish(deps.log, { ...unchanged, stopped: 'deadline' });
  }
  if (!profile.ok) {
    return finish(deps.log, { ...unchanged, stopped: profile.kind });
  }

  const cursor = startFallback({
    historyId: profile.historyId,
    oldSavedAt: position.savedAt,
    now: deps.clock.now(),
  });
  deps.state.set(FALLBACK_KEY, fallbackCursorCodec.encode(cursor));
  deps.log.warn('history.expired', {
    historyId: position.historyId,
    savedAt: position.savedAt,
    resumeHistoryId: cursor.historyId,
    // A position ahead of the mailbox was corrupt, not expired (spike 62, finding 3).
    aheadOfMailbox: BigInt(position.historyId) > BigInt(cursor.historyId),
    until: cursor.until,
  });

  const run = runFallback(deps, shouldContinue, counts, queue, cursor, true);
  return finish(deps.log, {
    queue: run.queue,
    ...(run.stopped === undefined ? {} : { stopped: run.stopped }),
    counts,
    // Only the call that creates the cursor reports it (epic decision 10).
    alerts: ['history_expired'],
    fallback: run.fallback,
    startHistoryId: position.historyId,
    historyId: run.fallback.done ? cursor.historyId : position.historyId,
  });
}

type FallbackRun = {
  readonly queue: WorkQueue;
  readonly stopped?: IngestStop;
  readonly fallback: IngestFallback;
};

/**
 * Runs the fallback from `start` (as stored in `state.fallback`): one window
 * at a time, oldest first, saving the queue and then the cursor after each.
 * Nothing of an unfinished window is saved; a cursor that only shrank since
 * its last save is written, so the next run doesn't halve again. When the
 * cursor is done, finishes: the position, then the key's delete.
 */
function runFallback(
  deps: IngestDeps,
  shouldContinue: () => boolean,
  counts: MutableCounts,
  queue: WorkQueue,
  start: FallbackCursor,
  started: boolean,
): FallbackRun {
  let cursor = start;
  let savedCursor = start;
  let current = queue;
  let stopped: IngestStop | undefined;
  const totals = { windows: 0, queued: 0, merged: 0, missed: 0 };

  while (stopped === undefined && !isFallbackDone(cursor)) {
    if (!shouldContinue()) {
      stopped = 'deadline';
      break;
    }
    // A window of merges only could still fit, but searching a full queue
    // every run would spend units halving for nothing.
    if (current.length >= QUEUE_MAX_ITEMS) {
      stopped = 'cap';
      break;
    }
    const window = fallbackWindow(cursor);
    const search = searchWindow(deps.gmail, window, current, shouldContinue);
    if (!search.ok) {
      stopped = search.kind;
      break;
    }
    const plan = planWindow({
      queue: current,
      matchedIds: search.threadIds,
      complete: search.complete,
      windowSeconds: cursor.windowSeconds,
    });
    if (plan.kind === 'shrink') {
      cursor = shrinkWindow(cursor);
      continue;
    }
    if (plan.kind === 'wait') {
      stopped = 'cap';
      break;
    }
    let take = search.threadIds;
    if (plan.kind === 'take_some') {
      take = plan.take;
      totals.missed += plan.missed;
      deps.log.warn('history.fallback_missed', {
        after: window.after,
        before: window.before,
        missed: plan.missed,
      });
    }

    const step = enqueueWindow(deps.clock, current, take, cursor.oldSavedAt);
    current = step.queue;
    counts.queued += step.queued;
    counts.merged += step.merged;
    totals.queued += step.queued;
    totals.merged += step.merged;
    // The queue before the cursor (epic decision 8's rule): a crash between
    // the two searches this window again, and its threads merge.
    if (step.queued + step.merged > 0) {
      saveQueue(deps.state, current);
    }
    cursor = advanceFallback(cursor, window, step);
    deps.state.set(FALLBACK_KEY, fallbackCursorCodec.encode(cursor));
    savedCursor = cursor;
    totals.windows += 1;
  }

  if (cursor !== savedCursor) {
    deps.state.set(FALLBACK_KEY, fallbackCursorCodec.encode(cursor));
  }
  const done = isFallbackDone(cursor);
  if (done) {
    // The position first, then the key: a crash between the two leaves a done
    // cursor, and the next call repeats this finish. `savedAt` is when
    // `cursor.historyId` was read, so every message before it is covered.
    deps.state.set(
      POSITION_KEY,
      encodePosition({ historyId: cursor.historyId, savedAt: cursor.startedAt }),
    );
    deps.state.delete(FALLBACK_KEY);
  }

  return {
    queue: current,
    ...(stopped === undefined ? {} : { stopped }),
    fallback: {
      started,
      done,
      ...totals,
      nextAfter: cursor.nextAfter,
      until: cursor.until,
    },
  };
}

type WindowSearch = Result<
  { readonly threadIds: readonly string[]; readonly complete: boolean },
  GmailFailure | Fail<'deadline'>
>;

/**
 * Searches one window, page by page, collecting distinct thread IDs.
 * `complete` is false when it stopped early: `canStopEarly`, or
 * `FALLBACK_MAX_PAGES` pages. A failure or the deadline drops the matches.
 * `includeSpamTrash` is false: ingest ignores Spam and Trash (SD §6.3).
 */
function searchWindow(
  gmail: GmailPort,
  window: FallbackWindow,
  queue: WorkQueue,
  shouldContinue: () => boolean,
): WindowSearch {
  const threadIds: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < FALLBACK_MAX_PAGES; page++) {
    if (page > 0 && !shouldContinue()) {
      return fail('deadline');
    }
    const result = gmail.searchThreadIds({
      q: window.q,
      includeSpamTrash: false,
      maxResults: FALLBACK_SEARCH_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!result.ok) {
      if (result.kind === 'invalid_page_token') {
        // A token from this same window search: invalid state. Nothing is queued
        // and the cursor stays, so the next run searches the window again.
        throw rejectedPageTokenError();
      }
      return result;
    }
    for (const id of result.threadIds) {
      if (!seen.has(id)) {
        seen.add(id);
        threadIds.push(id);
      }
    }
    if (result.nextPageToken === undefined) {
      return ok({ threadIds, complete: true });
    }
    if (canStopEarly({ queue, matchedIds: threadIds })) {
      return ok({ threadIds, complete: false });
    }
    pageToken = result.nextPageToken;
  }
  return ok({ threadIds, complete: false });
}

/**
 * Queues a window's chosen threads as `scheduled`, against the old position's
 * `savedAt`, with `firstClassification` unset (epic decisions 5 and 7).
 * `planWindow` left room for them, so `full` is a bug, and throws.
 */
function enqueueWindow(
  clock: ClockPort,
  queue: WorkQueue,
  threadIds: readonly string[],
  oldSavedAt: number,
): { readonly queue: WorkQueue; readonly queued: number; readonly merged: number } {
  let current = queue;
  const counts = { queued: 0, merged: 0 };
  for (const threadId of threadIds) {
    const result = enqueue(current, {
      threadId,
      source: 'scheduled',
      enqueuedAt: clock.now(),
      positionSavedAt: oldSavedAt,
    });
    if (!result.ok) {
      throw new Error(`A fallback enqueue reported full (${result.cap}) after planWindow`);
    }
    current = result.queue;
    counts[result.outcome] += 1;
  }
  return { queue: current, ...counts };
}

type Finished = {
  readonly queue: WorkQueue;
  readonly stopped?: IngestStop;
  readonly counts: IngestCounts;
  readonly alerts: readonly AlertCondition[];
  readonly fallback?: IngestFallback;
  /** The position read at the start. A call that continues a fallback doesn't read it. */
  readonly startHistoryId?: string;
  /** The position after the call, when known: unchanged, advanced, or set by the fallback's finish. */
  readonly historyId?: string;
};

/** Logs `ingest.done` and builds the return value. */
function finish(log: LogPort, done: Finished): { queue: WorkQueue; result: IngestResult } {
  const { queue, stopped, counts, fallback } = done;
  const fields = {
    ...counts,
    queueSize: queue.length,
    ...(done.startHistoryId === undefined ? {} : { startHistoryId: done.startHistoryId }),
    ...(done.historyId === undefined ? {} : { historyId: done.historyId }),
    ...(stopped === undefined ? {} : { stopped }),
    ...(fallback === undefined
      ? {}
      : {
          fallback: true,
          fallbackStarted: fallback.started,
          fallbackDone: fallback.done,
          fallbackWindows: fallback.windows,
          fallbackMissed: fallback.missed,
          fallbackNextAfter: fallback.nextAfter,
          fallbackUntil: fallback.until,
        }),
  };
  if (stopped === 'rate_limited' || stopped === 'scope' || (fallback?.missed ?? 0) > 0) {
    log.warn('ingest.done', fields);
  } else {
    log.info('ingest.done', fields);
  }
  const result: IngestResult = {
    ...(stopped === undefined ? {} : { stopped }),
    alerts: [...done.alerts],
    counts: { ...counts },
    ...(fallback === undefined ? {} : { fallback }),
  };
  return { queue, result };
}
