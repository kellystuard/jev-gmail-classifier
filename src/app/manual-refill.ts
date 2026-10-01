/**
 * The manual job's refill (Solution Design §6.6; epic #14 decisions 6 and 7;
 * ADR-0017): reads pages of the job search and queues each thread ID as a
 * manual work item, while the queue has room and the caller says there is time
 * and Gmail units left. It also owns the cursor reset: when Gmail rejects a
 * page token kept from an earlier execution, it drops the token and walks the
 * search again from the first page, queuing nothing, until it is back where
 * the job was.
 *
 * - The job search is never the exclusion check. Its `q` is `job.query`
 *   exactly, and manual items reach `screenChunk` like scheduled ones. This
 *   file takes no config.
 * - It makes no `getThread`, no Jev call and no label change, and it doesn't
 *   read the deadline or the units: `canContinue` is the caller's.
 * - It logs only `manual.cursor_reset`, with `seen` and `reason`: never the
 *   query, a token, a thread ID or Gmail's error text.
 * - `rate_limited` and `scope` are results (`stopGmail`). A response Gmail
 *   shouldn't give throws `UnexpectedResponseError`, before anything is saved
 *   for that page. A `StateError` from a save propagates.
 */
import { UnexpectedResponseError } from '../core/errors.ts';
import {
  type ManualJob,
  MANUAL_PAGE_SIZE,
  advanceCursor,
  dropPageToken,
  isStorablePageToken,
  needsCursorWalk,
  restoreCursor,
} from '../core/manual-job.ts';
import {
  QUEUE_MAX_ITEMS,
  QUEUE_MAX_MANUAL_ITEMS,
  type WorkQueue,
  enqueue,
} from '../core/work-queue.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { saveManualJob } from './manual-job-store.ts';
import { saveQueue } from './queue-store.ts';

/**
 * The most empty pages that still carry a next token one call accepts in a
 * row, queue pages and walk pages together. Gmail answers some bad tokens with
 * such a page and no error (`spikes/287-page-token.md`); one more is an
 * unexpected response, so a job can't spend every run's Gmail units on pages
 * that hold nothing.
 */
export const REFILL_MAX_EMPTY_PAGES = 10;

export type RefillDeps = {
  /** The run's counting wrapper. */
  readonly gmail: GmailPort;
  readonly state: StatePort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

export type RefillResult = {
  /** As saved. */
  readonly job: ManualJob;
  /** As saved. */
  readonly queue: WorkQueue;
  /** Pages queued by this call. Walk pages aren't counted. */
  readonly pages: number;
  readonly queued: number;
  readonly merged: number;
  /** A Gmail failure stopped the call: the caller stops Gmail work for this run. */
  readonly stopGmail?: StopGmail;
};

type StopGmail = 'rate_limited' | 'scope';

/** Consecutive empty pages with a next token, over the whole call. */
type EmptyPageGuard = { emptyPages: number };

type WalkResult =
  | { readonly kind: 'done'; readonly job: ManualJob }
  | { readonly kind: 'unfinished'; readonly stopGmail?: StopGmail };

/**
 * Queues job-search pages until the search is done, the queue has no room for
 * a whole page (more than 100 manual items, or more than 900 items in all),
 * `canContinue()` is false, or Gmail fails. `canContinue` is called before
 * every search call, the walk's too.
 *
 * Each page is saved queue first, then job: a crash between the two repeats
 * the page next time, and the repeats merge. Returns the job and the queue as
 * saved, and this call's counts.
 *
 * Throws `UnexpectedResponseError` (`service: 'gmail'`) for a rejected token
 * that this call got from Gmail itself (or a rejection with no token sent), a
 * next token that can't be stored or that repeats the one just sent, and more
 * than `REFILL_MAX_EMPTY_PAGES` empty pages in a row.
 */
export function refillManualQueue(
  job: ManualJob,
  queue: WorkQueue,
  deps: RefillDeps,
  canContinue: () => boolean,
): RefillResult {
  let currentJob = job;
  let currentQueue = queue;
  /** The cursor's token came from Gmail in this call, so a rejection of it is unexpected. */
  let tokenIsFresh = false;
  /** This call dropped the token and logged it, so the walk isn't `pending`. */
  let resetInThisCall = false;
  const totals = { pages: 0, queued: 0, merged: 0 };
  const guard: EmptyPageGuard = { emptyPages: 0 };

  const result = (stopGmail?: StopGmail): RefillResult => ({
    job: currentJob,
    queue: currentQueue,
    pages: totals.pages,
    queued: totals.queued,
    merged: totals.merged,
    ...(stopGmail === undefined ? {} : { stopGmail }),
  });

  for (;;) {
    if (!hasRoomForPage(currentJob, currentQueue) || !canContinue()) {
      return result();
    }

    if (needsCursorWalk(currentJob)) {
      if (!resetInThisCall) {
        deps.log.warn('manual.cursor_reset', { seen: currentJob.cursor.seen, reason: 'pending' });
      }
      const walk = walkToCursor(currentJob, deps.gmail, canContinue, guard);
      if (walk.kind === 'unfinished') {
        // Nothing more is saved: the next execution walks again from the first page.
        return result(walk.stopGmail);
      }
      currentJob = walk.job;
      saveManualJob(deps.state, currentJob);
      tokenIsFresh = true;
      continue;
    }

    const sentToken = currentJob.cursor.pageToken;
    const page = searchPage(deps.gmail, currentJob.query, sentToken);
    if (!page.ok) {
      if (page.kind !== 'invalid_page_token') {
        return result(page.kind);
      }
      if (sentToken === undefined) {
        throw unexpected('searchThreadIds rejected a page token when none was sent');
      }
      if (tokenIsFresh) {
        throw unexpected('searchThreadIds rejected a page token from the same execution');
      }
      // The token came from an earlier execution (decision 6): drop it, then walk.
      currentJob = dropPageToken(currentJob);
      saveManualJob(deps.state, currentJob);
      deps.log.warn('manual.cursor_reset', { seen: currentJob.cursor.seen, reason: 'rejected' });
      resetInThisCall = true;
      continue;
    }
    const nextPageToken = checkNextToken(page, sentToken, guard);

    const now = deps.clock.now();
    let pageQueue = currentQueue;
    let queued = 0;
    let merged = 0;
    for (const threadId of page.threadIds) {
      // No `firstClassification` and no `positionSavedAt`: screening decides
      // `false` for a new manual item, and a merge can't overwrite a scheduled
      // item's undecided flag.
      const added = enqueue(pageQueue, {
        threadId,
        source: 'manual',
        enqueuedAt: now,
        ...(currentJob.applyMoves ? { applyMoves: true } : {}),
      });
      if (!added.ok) {
        // Can't happen while a whole page fits. Keep the queue and the job as
        // they were before this page.
        return result();
      }
      pageQueue = added.queue;
      if (added.outcome === 'queued') {
        queued += 1;
      } else {
        merged += 1;
      }
    }

    const advanced = advanceCursor(currentJob, {
      idsOnPage: page.threadIds.length,
      queued,
      merged,
      nextPageToken,
    });
    saveQueue(deps.state, pageQueue);
    currentQueue = pageQueue;
    saveManualJob(deps.state, advanced);
    currentJob = advanced;
    tokenIsFresh = true;
    totals.pages += 1;
    totals.queued += queued;
    totals.merged += merged;
  }
}

/** Conditions 1 to 3: the search isn't done, and a whole page fits under both caps. */
function hasRoomForPage(job: ManualJob, queue: WorkQueue): boolean {
  if (job.searchDone || queue.length > QUEUE_MAX_ITEMS - MANUAL_PAGE_SIZE) {
    return false;
  }
  const manualItems = queue.filter((item) => item.source === 'manual').length;
  return manualItems <= QUEUE_MAX_MANUAL_ITEMS - MANUAL_PAGE_SIZE;
}

/** The job search: always the same `q` and page size, the token only when there is one. */
function searchPage(
  gmail: GmailPort,
  q: string,
  pageToken: string | undefined,
): ReturnType<GmailPort['searchThreadIds']> {
  return gmail.searchThreadIds({
    q,
    includeSpamTrash: false,
    maxResults: MANUAL_PAGE_SIZE,
    ...(pageToken === undefined ? {} : { pageToken }),
  });
}

/**
 * The page's next token, checked. Throws for a token that can't be stored,
 * one that repeats the token just sent (the search would go round in a
 * circle), and one empty page too many in a row.
 */
function checkNextToken(
  page: { readonly threadIds: readonly string[]; readonly nextPageToken?: string },
  sentToken: string | undefined,
  guard: EmptyPageGuard,
): string | undefined {
  const next = page.nextPageToken;
  if (next === undefined) {
    return undefined;
  }
  if (!isStorablePageToken(next)) {
    throw unexpected('searchThreadIds returned a page token that cannot be stored');
  }
  if (next === sentToken) {
    throw unexpected('searchThreadIds returned the page token it was sent');
  }
  if (page.threadIds.length > 0) {
    guard.emptyPages = 0;
    return next;
  }
  guard.emptyPages += 1;
  if (guard.emptyPages > REFILL_MAX_EMPTY_PAGES) {
    throw unexpected('searchThreadIds returned too many empty pages in a row');
  }
  return next;
}

/**
 * Finds the cursor again by counting, from the first page, queuing and saving
 * nothing. The caller has checked `canContinue()` for the first page. It ends
 * at the page boundary where `seen` IDs have been passed; at the last boundary
 * before that when a page would pass the target; or at the end of the results
 * (`searchDone`). Every token it uses is seconds old, so a rejected one throws.
 */
function walkToCursor(
  job: ManualJob,
  gmail: GmailPort,
  canContinue: () => boolean,
  guard: EmptyPageGuard,
): WalkResult {
  const target = job.cursor.seen;
  let passed = 0;
  let token: string | undefined;
  let checked = true;
  for (;;) {
    if (passed === target) {
      return {
        kind: 'done',
        job: restoreCursor(job, { seen: passed, pageToken: token, searchDone: false }),
      };
    }
    if (!checked && !canContinue()) {
      return { kind: 'unfinished' };
    }
    checked = false;
    const page = searchPage(gmail, job.query, token);
    if (!page.ok) {
      if (page.kind === 'invalid_page_token') {
        throw unexpected('searchThreadIds rejected a page token from the same execution');
      }
      return { kind: 'unfinished', stopGmail: page.kind };
    }
    if (passed + page.threadIds.length > target) {
      // The result set changed, or the pages are cut differently: stop at the
      // boundary before the target. The normal loop reads this page again.
      return {
        kind: 'done',
        job: restoreCursor(job, { seen: passed, pageToken: token, searchDone: false }),
      };
    }
    passed += page.threadIds.length;
    const next = checkNextToken(page, token, guard);
    if (next === undefined) {
      // The results ended at or before the target.
      return { kind: 'done', job: restoreCursor(job, { seen: passed, searchDone: true }) };
    }
    token = next;
  }
}

/** The reason is fixed text: never the query, a token or Gmail's own message. */
function unexpected(reason: string): UnexpectedResponseError {
  return new UnexpectedResponseError('Gmail searchThreadIds gave an unexpected response', {
    service: 'gmail',
    reason,
  });
}
