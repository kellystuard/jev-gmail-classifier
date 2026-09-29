/**
 * Pure filtering of Gmail history records into candidate threads (Solution
 * Design §6.3, "Filter `messageAdded` records" and "Filter `labelRemoved`
 * records"). `src/app/ingest.ts` queues what these return.
 */
import type { GmailHistoryRecord } from './gmail-types.ts';

/**
 * Labels that drop a `messagesAdded` entry. A record's labels are the ones the
 * message had **when it was added** (spike 19, finding 2), so this catches
 * drafts and mail that arrived in Spam or Trash. Mail moved there later is
 * caught when the thread is read (#71).
 */
const IGNORED_ADDED_LABELS: readonly string[] = ['DRAFT', 'SPAM', 'TRASH'];

export type MessageAddedThreads = {
  /** Distinct thread IDs, in order of first appearance. */
  readonly threadIds: readonly string[];
  /** `messagesAdded` entries left out for `DRAFT`, `SPAM` or `TRASH`. */
  readonly ignored: number;
};

/**
 * The threads a record's `messagesAdded` entries add to.
 *
 * - An entry whose `message.labelIds` include `DRAFT`, `SPAM` or `TRASH` is
 *   left out and counted in `ignored`. A missing `labelIds` means no labels.
 * - `INBOX` isn't required: filter-archived mail has none (spike 19,
 *   finding 9). `SENT` counts like received mail. `CATEGORY_*` doesn't matter.
 * - A record with no `messagesAdded` (a bare record, or a label record) gives
 *   `{ threadIds: [], ignored: 0 }`.
 */
export function messageAddedThreadIds(record: GmailHistoryRecord): MessageAddedThreads {
  const threadIds: string[] = [];
  let ignored = 0;
  for (const { message } of record.messagesAdded ?? []) {
    const labels = message.labelIds ?? [];
    if (labels.some((label) => IGNORED_ADDED_LABELS.includes(label))) {
      ignored += 1;
    } else if (!threadIds.includes(message.threadId)) {
      threadIds.push(message.threadId);
    }
  }
  return { threadIds, ignored };
}

/** Labels that drop a `labelsRemoved` entry: the message is now in Trash or Spam, and processing ignores such threads. */
const IGNORED_REMOVAL_LABELS: readonly string[] = ['TRASH', 'SPAM'];

/**
 * The threads a record's `labelsRemoved` entries re-queue: those where a known
 * `Jev/Error` label was removed (SD §6.3, "Filter `labelRemoved` records").
 * Distinct thread IDs, in order of first appearance.
 *
 * - **Keep** an entry whose removed `labelIds` include any of
 *   `jevErrorLabelIds`. The match is on the entry's `labelIds` (the IDs
 *   removed), **not** on `message.labelIds` (the labels left after the
 *   change): trashing a labelled thread writes a `labelsRemoved [INBOX]` entry
 *   whose `message.labelIds` still include the `Jev/Error` ID, and it must not
 *   match (spike 20, S06).
 * - **Skip** an entry whose `message.labelIds` include `TRASH` or `SPAM`. This
 *   is per entry, then threads are de-duplicated, so a thread is kept when at
 *   least one of its entries is outside Trash and Spam (spike 20, finding 4).
 * - `[]` for another label's removal (for example `UNREAD`), `labelsAdded`
 *   entries, a record with no change arrays, and empty `jevErrorLabelIds`.
 */
export function jevErrorRemovalThreadIds(
  record: GmailHistoryRecord,
  jevErrorLabelIds: readonly string[],
): readonly string[] {
  const threadIds: string[] = [];
  if (jevErrorLabelIds.length === 0) {
    return threadIds;
  }
  for (const { labelIds, message } of record.labelsRemoved ?? []) {
    if (!labelIds.some((label) => jevErrorLabelIds.includes(label))) {
      continue;
    }
    if ((message.labelIds ?? []).some((label) => IGNORED_REMOVAL_LABELS.includes(label))) {
      continue;
    }
    if (!threadIds.includes(message.threadId)) {
      threadIds.push(message.threadId);
    }
  }
  return threadIds;
}
