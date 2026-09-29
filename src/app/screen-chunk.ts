/**
 * Chunk screening (Solution Design §6.4 step 2, ADR-0017; epic #9 decision 12):
 * everything that happens to a chunk before anything is read for Jev.
 *
 * It reads each chunk thread once, in metadata form, skips the threads that
 * can't be classified, fixes each item's first-classification flag, and drops
 * every thread in which any message matches `excludeQuery`. Scheduled and
 * manual items take exactly the same path.
 *
 * It writes no state and makes no Gmail change: the caller (E7) saves the
 * returned queue. It fails closed: a failed read or search returns the failure
 * with no queue and no log, so nothing is kept, removed or flagged, and the
 * whole chunk is screened again in a later run.
 */

import type { Config } from '../config/schema.ts';
import { isFirstClassification } from '../core/first-classification.ts';
import type { GmailMessage, GmailThread } from '../core/gmail-types.ts';
import { hasJevErrorLabel } from '../core/jev-error-label.ts';
import { type Result, ok } from '../core/result.ts';
import {
  type WorkItem,
  type WorkQueue,
  dequeue,
  setFirstClassification,
} from '../core/work-queue.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailFailure, GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { type ExclusionReason, searchExcludedThreads } from './exclusion-search.ts';
import { readJevErrorLabelIds } from './jev-error-label-store.ts';

/**
 * What one call did, flat so E7 can put it in `run.end`.
 *
 * - `read`: `getThread` calls, one per chunk item.
 * - `skippedNotFound`, `skippedJevError`, `skippedNoMessages`: threads skipped, by reason.
 * - `excluded`: threads dropped by the exclusion check, `search_capped` ones included.
 * - `searchCapped`: the subset of `excluded` whose own search hit the page bound.
 * - `kept`: items that go on to be read for Jev.
 * - `searchCalls`: `searchThreadIds` calls (10 quota units each).
 */
export type ScreenCounts = {
  readonly read: number;
  readonly skippedNotFound: number;
  readonly skippedJevError: number;
  readonly skippedNoMessages: number;
  readonly excluded: number;
  readonly searchCapped: number;
  readonly kept: number;
  readonly searchCalls: number;
};

/** A chunk item that goes on, with its metadata thread. */
export type ScreenedItem = { readonly item: WorkItem; readonly thread: GmailThread };

type SkipReason = 'not_found' | 'jev_error' | 'no_messages';

/** Labels that take a message out of `state`, and out of "is there anything to classify" (SD §6.3). */
const NOT_CLASSIFIABLE_LABELS: readonly string[] = ['DRAFT', 'SPAM', 'TRASH'];

function isClassifiable(message: GmailMessage): boolean {
  return !NOT_CLASSIFIABLE_LABELS.some((label) => message.labelIds?.includes(label) === true);
}

/**
 * Screens `chunk` (what `takeChunk` returned for `queue`) and returns the new
 * queue, the items kept with their metadata threads (in chunk order), and the
 * counts.
 *
 * Only `config.excludeQuery` is read. With none, or with no thread left after
 * the skips, no search is made.
 *
 * A `rate_limited` or `scope` failure from any read or search is returned at
 * once: no further Gmail call, nothing logged, no queue. Exceptions (an
 * unrecognized Gmail error, a `StateError` from `state.jevErrorLabel`)
 * propagate to E7's per-run boundary.
 */
export function screenChunk(
  deps: {
    readonly gmail: GmailPort;
    readonly state: StatePort;
    readonly log: LogPort;
    readonly clock: ClockPort;
  },
  config: Config,
  queue: WorkQueue,
  chunk: readonly WorkItem[],
): Result<{ queue: WorkQueue; kept: readonly ScreenedItem[]; counts: ScreenCounts }, GmailFailure> {
  // An absent key means no ID is known: nothing is skipped as `jev_error`.
  const jevErrorLabelIds = readJevErrorLabelIds(deps.state);

  // 1. Read every thread once, in metadata form, and sort it into skipped or remaining.
  const skipped: { item: WorkItem; reason: SkipReason }[] = [];
  const remaining: ScreenedItem[] = [];
  let read = 0;
  for (const item of chunk) {
    read += 1;
    const result = deps.gmail.getThread(item.threadId, {
      format: 'metadata',
      metadataHeaders: ['Date'],
    });
    if (!result.ok) {
      if (result.kind === 'not_found') {
        skipped.push({ item, reason: 'not_found' });
        continue;
      }
      return result;
    }
    const { thread } = result;
    // A new message doesn't inherit `Jev/Error`, so every message counts (spike 20, finding 5).
    if (hasJevErrorLabel(thread, jevErrorLabelIds)) {
      skipped.push({ item, reason: 'jev_error' });
    } else if (!(thread.messages ?? []).some(isClassifiable)) {
      skipped.push({ item, reason: 'no_messages' });
    } else {
      remaining.push({ item, thread });
    }
  }

  // 2. Exclusion, over the threads left. Every one has at least one message.
  let exclusions: ReadonlyMap<string, ExclusionReason> = new Map();
  let searchCalls = 0;
  if (config.excludeQuery !== undefined && remaining.length > 0) {
    const searched = searchExcludedThreads(
      { gmail: deps.gmail, clock: deps.clock },
      config.excludeQuery,
      remaining.map(({ thread }) => thread),
    );
    if (!searched.ok) {
      return searched;
    }
    exclusions = searched.excluded;
    searchCalls = searched.searchCalls;
  }

  // Every read and search has succeeded: from here on nothing fails closed.

  // 3. First classification, for the threads not skipped, where it is still unset.
  //    A stored item with no flag always has a `positionSavedAt` (the queue codec
  //    guarantees it); without one the safe direction is labels only.
  let next = queue;
  for (const { item, thread } of remaining) {
    if (item.firstClassification === undefined) {
      const decided =
        item.positionSavedAt !== undefined &&
        isFirstClassification(thread.messages ?? [], item.positionSavedAt);
      next = setFirstClassification(next, item.threadId, decided);
    }
  }

  // 4. Remove what is finished, log it, and collect what goes on.
  for (const { item, reason } of skipped) {
    next = dequeue(next, item.threadId);
    deps.log.info('thread.skipped', { threadId: item.threadId, source: item.source, reason });
  }
  let searchCapped = 0;
  const kept: ScreenedItem[] = [];
  for (const { item, thread } of remaining) {
    const reason = exclusions.get(item.threadId);
    if (reason === undefined) {
      const updated = next.find((candidate) => candidate.threadId === item.threadId);
      kept.push({ item: updated ?? item, thread });
      continue;
    }
    next = dequeue(next, item.threadId);
    // Never the subject, the sender or any header: the user asked for this mail to stay private.
    const fields = { threadId: item.threadId, source: item.source, reason };
    if (reason === 'search_capped') {
      searchCapped += 1;
      deps.log.warn('thread.excluded', fields);
    } else {
      deps.log.info('thread.excluded', fields);
    }
  }

  const skippedBy = (reason: SkipReason): number =>
    skipped.filter((entry) => entry.reason === reason).length;
  return ok({
    queue: next,
    kept,
    counts: {
      read,
      skippedNotFound: skippedBy('not_found'),
      skippedJevError: skippedBy('jev_error'),
      skippedNoMessages: skippedBy('no_messages'),
      excluded: remaining.length - kept.length,
      searchCapped,
      kept: kept.length,
      searchCalls,
    },
  });
}
