import type { GmailMessage } from './gmail-types.ts';

/**
 * Decides whether a thread is a **first classification** (a brand-new
 * conversation), which is the only case where a move may apply (Solution
 * Design §6.3).
 *
 * `messages` are the thread's messages as a metadata or minimal `threads.get`
 * returns them, with their current labels (pass `thread.messages ?? []`).
 * `positionSavedAt` is the `savedAt` (epoch ms) of the position the work item
 * was queued against. The caller has validated it.
 *
 * Returns `true` when there is at least one non-`DRAFT` message and every
 * non-`DRAFT` message has an `internalDate` at or after `positionSavedAt`. There
 * is no skew margin. Otherwise it returns `false`, the safe direction (labels
 * only): no messages, only drafts, a message without a valid `internalDate`, or
 * a `NaN` `positionSavedAt`. Messages now in Spam or Trash still count, so an
 * old thread can't look new.
 *
 * `internalDate` is a string of epoch ms, so it is parsed and compared as a
 * number. A message's `historyId` is never used (it moves on any change).
 */
export function isFirstClassification(
  messages: readonly Pick<GmailMessage, 'labelIds' | 'internalDate'>[],
  positionSavedAt: number,
): boolean {
  let sawNonDraft = false;
  for (const message of messages) {
    if (message.labelIds?.includes('DRAFT') === true) continue;
    sawNonDraft = true;
    const arrivedAt = parseInternalDate(message.internalDate);
    if (arrivedAt === undefined || !(arrivedAt >= positionSavedAt)) return false;
  }
  return sawNonDraft;
}

/** Parses a string of decimal characters 0-9 into a safe integer, else `undefined`. */
export function parseInternalDate(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
