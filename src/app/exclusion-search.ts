/**
 * The exclusion search for a chunk (Solution Design §6.4 step 2, ADR-0017):
 * which of the chunk's threads have a message that matches `excludeQuery`.
 *
 * One Gmail search covers the whole chunk, paged and bounded. When the bound
 * is reached, each thread not yet found gets a search of its own. A search
 * that can't finish never lets a thread through (`search_capped`), and a
 * failed call fails the whole check closed.
 *
 * It reads no threads, touches no queue and logs nothing: the query holds the
 * user's `excludeQuery`, which describes private mail. `screenChunk` (#71)
 * logs the per-thread events.
 */

import { buildExclusionQuery } from '../core/exclusion-query.ts';
import type { GmailThread } from '../core/gmail-types.ts';
import { type Result, ok } from '../core/result.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailFailure, GmailPort } from '../ports/gmail-port.ts';
import { rejectedPageTokenError } from './rejected-page-token.ts';

/** IDs requested per page: the most `threads.list` allows. */
export const EXCLUSION_SEARCH_PAGE_SIZE = 500;

/** Pages one search may read: 20 pages of 500 is 10,000 threads and 200 quota units (SD §9). */
export const EXCLUSION_SEARCH_MAX_PAGES = 20;

/**
 * Why a thread is excluded:
 * - `matched`: a message in it matched `excludeQuery`.
 * - `search_capped`: its own search reached the page bound without finishing,
 *   so the thread is treated as excluded (the check didn't complete).
 */
export type ExclusionReason = 'matched' | 'search_capped';

type SearchOutcome = Result<{ found: ReadonlySet<string>; capped: boolean }, GmailFailure>;

/**
 * Searches `q` page by page for the `targets` (thread IDs), at most
 * `EXCLUSION_SEARCH_MAX_PAGES` pages. Stops when every target is found, or
 * when a page has no `nextPageToken`. `capped` is true when the last page
 * allowed still had a `nextPageToken` and a target was missing.
 */
function search(
  gmail: GmailPort,
  q: string,
  targets: ReadonlySet<string>,
  counter: { calls: number },
): SearchOutcome {
  const found = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 1; page <= EXCLUSION_SEARCH_MAX_PAGES; page++) {
    counter.calls += 1;
    const result = gmail.searchThreadIds({
      q,
      includeSpamTrash: true,
      maxResults: EXCLUSION_SEARCH_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!result.ok) {
      if (result.kind === 'invalid_page_token') {
        // A token from this same loop: invalid state, so it fails closed by throwing.
        throw rejectedPageTokenError();
      }
      return result;
    }
    for (const id of result.threadIds) {
      if (targets.has(id)) {
        found.add(id);
      }
    }
    if (found.size === targets.size || result.nextPageToken === undefined) {
      return ok({ found, capped: false });
    }
    pageToken = result.nextPageToken;
  }
  return ok({ found, capped: true });
}

/**
 * Finds the `threads` in which any message matches `excludeQuery`.
 *
 * `threads` are the metadata threads left after screening's skips, each with
 * at least one message (`buildExclusionQuery` throws for a set of threads with
 * no messages at all, and so does the per-thread fallback for a thread with
 * none). `excluded` maps each excluded thread ID to why; a thread not in it
 * passed the check. `searchCalls` counts the `searchThreadIds` calls, 10 quota
 * units each.
 *
 * With no threads it makes no call. It reads `clock.now()` once and uses that
 * time for every query of the call. A failed search call (`rate_limited`,
 * `scope`) is returned at once, with no further call and no partial map, so
 * the caller keeps and removes nothing. Anything the port throws propagates.
 */
export function searchExcludedThreads(
  deps: { readonly gmail: GmailPort; readonly clock: ClockPort },
  excludeQuery: string,
  threads: readonly GmailThread[],
): Result<{ excluded: ReadonlyMap<string, ExclusionReason>; searchCalls: number }, GmailFailure> {
  const excluded = new Map<string, ExclusionReason>();
  if (threads.length === 0) {
    return ok({ excluded, searchCalls: 0 });
  }

  const now = deps.clock.now();
  const counter = { calls: 0 };

  const chunk = search(
    deps.gmail,
    buildExclusionQuery(excludeQuery, threads, now),
    new Set(threads.map((thread) => thread.id)),
    counter,
  );
  if (!chunk.ok) {
    return chunk;
  }
  for (const id of chunk.found) {
    excluded.set(id, 'matched');
  }

  if (chunk.capped) {
    // The chunk window is too wide to page through: search each thread not yet
    // found with its own window, and count each search's pages on its own.
    for (const thread of threads) {
      if (excluded.has(thread.id)) {
        continue;
      }
      const own = search(
        deps.gmail,
        buildExclusionQuery(excludeQuery, [thread], now),
        new Set([thread.id]),
        counter,
      );
      if (!own.ok) {
        return own;
      }
      if (own.found.has(thread.id)) {
        excluded.set(thread.id, 'matched');
      } else if (own.capped) {
        excluded.set(thread.id, 'search_capped');
      }
    }
  }

  return ok({ excluded, searchCalls: counter.calls });
}
