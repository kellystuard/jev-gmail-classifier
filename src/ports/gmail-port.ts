import type { GmailHistoryRecord, GmailLabel, GmailThread } from '../core/gmail-types.ts';
import type { Fail, NoFields, Result } from '../core/result.ts';

/**
 * Failures any Gmail call can return (Solution Design §9).
 *
 * - `scope`: `gmail.modify` isn't granted. The adapter matches the SD §9
 *   message fragments case-insensitively. A 403 `rateLimitExceeded` is never
 *   `scope`.
 * - `rate_limited`: the per-user limit, HTTP 403 `rateLimitExceeded`, "Units
 *   per minute per user". It isn't a thread failure and isn't the daily stop:
 *   it means "stop Gmail work for this run", which E7 handles
 *   (`spikes/30-gmail-quota.md`).
 */
export type GmailFailure =
  Fail<'scope', { message: string }> | Fail<'rate_limited', { message: string }>;

/** The history types the classifier reads, in one call (SD §6.3, spike 20). */
export type GmailHistoryType = 'messageAdded' | 'labelRemoved';

export type ListHistoryRequest = {
  readonly startHistoryId: string;
  readonly historyTypes: readonly GmailHistoryType[];
  readonly pageToken?: string;
  readonly maxResults?: number;
};

export type SearchThreadIdsRequest = {
  readonly q: string;
  /** Required, so every caller decides. The exclusion search must pass `true` (SD §6.4, ADR-0017). */
  readonly includeSpamTrash: boolean;
  readonly pageToken?: string;
  readonly maxResults?: number;
};

/**
 * How much of a thread `getThread` returns:
 * - `full`: every part, with `data` as byte arrays.
 * - `metadata`: only the named headers, and no body data.
 * - `minimal`: IDs, labels and `internalDate`.
 */
export type GetThreadFormat =
  | { readonly format: 'full' }
  | { readonly format: 'metadata'; readonly metadataHeaders: readonly string[] }
  | { readonly format: 'minimal' };

/** A thread-level label change. Label IDs only, never names (SD §6.5). */
export type ThreadLabelChange = {
  readonly addLabelIds: readonly string[];
  readonly removeLabelIds: readonly string[];
};

/**
 * The Advanced Gmail Service, `Gmail.Users.*` (SD §5.2, §9). Every call is on
 * the user `me`. Owned by E3 (reading) and E6 (labels and moves), which refine
 * it.
 *
 * Expected failures are results. Anything the adapter doesn't recognize is
 * thrown as `UnexpectedResponseError` (`src/core/errors.ts`) and reaches the
 * per-thread or per-run boundary (SD §10.1).
 */
export interface GmailPort {
  /** `Users.getProfile('me')`: the owner's address (for alerts) and the current `historyId`. */
  getProfile(): Result<{ emailAddress: string; historyId: string }, GmailFailure>;

  /**
   * `Users.History.list`: **one page** per call. The caller pages, so it can
   * stop at the queue cap or the deadline (SD §6.3).
   *
   * The response `historyId` is this page's. It changes from page to page
   * while mail arrives, and later pages include newer records, so the caller
   * advances to the **last** page's `historyId` (spike 19, finding 8). Don't
   * filter on `labelId`: filter the records on the client (spike 20).
   *
   * `history_expired` is the 404 for a `startHistoryId` Gmail has discarded
   * (SD §6.3).
   */
  listHistory(
    request: ListHistoryRequest,
  ): Result<
    { records: readonly GmailHistoryRecord[]; historyId: string; nextPageToken?: string },
    GmailFailure | Fail<'history_expired'>
  >;

  /**
   * `Users.Threads.list`: **one page** of thread IDs matching `q`. The
   * exclusion filter pages until there is no `nextPageToken`, with
   * `includeSpamTrash: true` (SD §6.4, `spikes/23-exclusion-query.md`). One
   * page per call also lets E8 keep a page-token cursor.
   */
  searchThreadIds(
    request: SearchThreadIdsRequest,
  ): Result<{ threadIds: readonly string[]; nextPageToken?: string }, GmailFailure>;

  /**
   * `Users.Threads.get` in the given format. It returns Spam and Trash
   * messages too (SD §14). A thread deleted since it was queued is
   * `not_found`.
   */
  getThread(
    threadId: string,
    format: GetThreadFormat,
  ): Result<{ thread: GmailThread }, GmailFailure | Fail<'not_found'>>;

  /** `Users.Labels.list`: every label, in one response with no paging (spike 25). */
  listLabels(): Result<{ labels: readonly GmailLabel[] }, GmailFailure>;

  /**
   * `Users.Labels.create` for exactly `name`. No parent labels are created
   * (SD §6.5, `spikes/25-nested-labels.md`). Name comparison and the retry
   * after `label_exists` are E6's.
   *
   * - `label_exists`: 409 "Label name exists or conflicts". Gmail compares
   *   names case-insensitively, with spaces around `/` ignored.
   * - `invalid_label_name`: 400 "Invalid label name", for a reserved name
   *   such as `Inbox` or `Spam`.
   */
  createLabel(
    name: string,
  ): Result<
    { label: GmailLabel },
    | GmailFailure
    | Fail<'label_exists', { message: string }>
    | Fail<'invalid_label_name', { message: string }>
  >;

  /**
   * `Users.Threads.modify`: every label add and the move in one call (SD §6.5,
   * `spikes/26-moves.md`). It applies to every message in the thread.
   * Repeating it is safe.
   *
   * `invalid_label`: a name in place of an ID (400 "Invalid label") or an
   * unknown ID (400 "labelId not found"). Nothing changes.
   */
  modifyThread(
    threadId: string,
    change: ThreadLabelChange,
  ): Result<
    NoFields,
    GmailFailure | Fail<'not_found'> | Fail<'invalid_label', { message: string }>
  >;

  /**
   * `Users.Threads.trash`. Gives the same labels as `modifyThread` adding
   * `TRASH`. E6 decides which one to use (SD §6.5).
   */
  trashThread(threadId: string): Result<NoFields, GmailFailure | Fail<'not_found'>>;
}
