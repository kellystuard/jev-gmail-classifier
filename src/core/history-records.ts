/**
 * Pure filtering of Gmail history records into candidate threads (Solution
 * Design §6.3, "Filter `messageAdded` records"). `src/app/ingest.ts` queues
 * what these return. #65 adds the `labelsRemoved` filter here.
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
