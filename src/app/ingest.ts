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
 * Extended later by #65 (`Jev/Error` removals: `INGEST_HISTORY_TYPES`,
 * `ingestRecord` and the counts) and #73 (the expired-history fallback: the
 * `history_expired` branch of the failure `switch`).
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import { assertNever } from '../core/assert-never.ts';
import { StateError } from '../core/errors.ts';
import type { GmailHistoryRecord } from '../core/gmail-types.ts';
import { messageAddedThreadIds } from '../core/history-records.ts';
import { decodePosition, encodePosition, type Position, POSITION_KEY } from '../core/position.ts';
import { enqueue, type WorkQueue } from '../core/work-queue.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailHistoryType, GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { saveQueue } from './queue-store.ts';

/** The history types ingest asks for. #65 adds `labelRemoved`. */
export const INGEST_HISTORY_TYPES: readonly GmailHistoryType[] = ['messageAdded'];

/** `maxResults` for every `history.list` page (decision 9). */
export const INGEST_PAGE_SIZE = 100;

export type IngestDeps = {
  readonly gmail: GmailPort;
  readonly state: StatePort;
  readonly log: LogPort;
  readonly clock: ClockPort;
};

export type IngestOptions = {
  /** Checked before each `listHistory` call, the first included. Default: always true. E7 passes its `Deadline` check. */
  readonly shouldContinue?: () => boolean;
};

/**
 * Why ingest stopped before the end of history. Each is a normal result, and
 * the position moves to the last fully handled record:
 * - `cap`: the queue is full (back-pressure; processing makes room);
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
  /** New work items. */
  readonly queued: number;
  /** Enqueues merged into an existing item, including a thread queued earlier in the same call. */
  readonly merged: number;
  /** `messagesAdded` entries left out for `DRAFT`, `SPAM` or `TRASH`. */
  readonly ignored: number;
};

export type IngestResult = {
  /** `history_expired` is temporary: #73 replaces it with the fallback. */
  readonly stopped?: IngestStop | 'history_expired';
  /** Conditions for E7 to pass on to E9's alerts. Always empty until #73. */
  readonly alerts: readonly AlertCondition[];
  readonly counts: IngestCounts;
};

type MutableCounts = { -readonly [K in keyof IngestCounts]: IngestCounts[K] };

/**
 * Ingests history from `state.position` into `queue`, and returns the new
 * queue and a result. The queue is saved (when any enqueue succeeded) before
 * the position moves.
 *
 * - **Position:** after the last page, that page's `historyId`. When stopped
 *   early (`cap`, `deadline`, `rate_limited`, `scope`), the `id` of the last
 *   record fully handled, or unchanged if there's none. `savedAt` is read
 *   after the last `listHistory` call. An unchanged `historyId` isn't written.
 * - **Throws** `StateError` `missing` when `state.position` is absent (only
 *   `install` writes the first one), and whatever the codec, `listHistory`
 *   (`UnexpectedResponseError`) or the state store throws. Nothing is caught:
 *   the next run reads the same history again, and repeated threads merge.
 * - Logs `ingest.done` once per call that returns.
 */
export function ingest(
  deps: IngestDeps,
  queue: WorkQueue,
  options: IngestOptions = {},
): { queue: WorkQueue; result: IngestResult } {
  const shouldContinue = options.shouldContinue ?? (() => true);
  const position = readPosition(deps.state);
  const counts: MutableCounts = { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0 };

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
      // `history_expired` needs the fallback. Anything else was thrown by
      // the adapter as exceptional, and propagates.
      switch (page.kind) {
        case 'rate_limited':
        case 'scope':
          stopped = page.kind;
          break;
        case 'history_expired':
          // #73 replaces this branch with the date-search fallback and the
          // `history_expired` alert. Until then: save nothing, keep the input queue.
          return finish(deps.log, {
            queue,
            stopped: 'history_expired',
            counts,
            startHistoryId: position.historyId,
            historyId: position.historyId,
          });
        default:
          return assertNever(page);
      }
      break;
    }
    counts.pages += 1;

    for (const record of page.records) {
      counts.records += 1;
      const step = ingestRecord(deps.clock, current, record, position, counts);
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

  // Never a page's `historyId` when stopping early: it's the mailbox's
  // current ID, and would skip the pages not yet read (SD §6.3 "Advance").
  const historyId = endHistoryId ?? lastHandledId ?? position.historyId;

  if (counts.queued + counts.merged > 0) {
    saveQueue(deps.state, current);
  }
  if (historyId !== position.historyId) {
    deps.state.set(POSITION_KEY, encodePosition({ historyId, savedAt: deps.clock.now() }));
  }

  return finish(deps.log, {
    queue: current,
    ...(stopped === undefined ? {} : { stopped }),
    counts,
    startHistoryId: position.historyId,
    historyId,
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

/**
 * Queues the threads of one record. `handled` is true when every thread was
 * queued or merged, or there was nothing to queue. At the cap it's false, and
 * the threads queued before it stay in the returned queue: the next run reads
 * the record again, and they merge.
 */
function ingestRecord(
  clock: ClockPort,
  queue: WorkQueue,
  record: GmailHistoryRecord,
  position: Position,
  counts: MutableCounts,
): { readonly queue: WorkQueue; readonly handled: boolean } {
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
  return { queue: current, handled: true };
}

type Finished = {
  readonly queue: WorkQueue;
  readonly stopped?: IngestStop | 'history_expired';
  readonly counts: IngestCounts;
  readonly startHistoryId: string;
  readonly historyId: string;
};

/** Logs `ingest.done` and builds the return value. */
function finish(log: LogPort, done: Finished): { queue: WorkQueue; result: IngestResult } {
  const { queue, stopped, counts } = done;
  const fields = {
    ...counts,
    queueSize: queue.length,
    startHistoryId: done.startHistoryId,
    historyId: done.historyId,
    ...(stopped === undefined ? {} : { stopped }),
  };
  if (stopped === 'rate_limited' || stopped === 'scope' || stopped === 'history_expired') {
    log.warn('ingest.done', fields);
  } else {
    log.info('ingest.done', fields);
  }
  const result: IngestResult = {
    ...(stopped === undefined ? {} : { stopped }),
    alerts: [],
    counts: { ...counts },
  };
  return { queue, result };
}
