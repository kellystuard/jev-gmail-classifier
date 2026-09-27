/**
 * Gmail resource types, as the Advanced Gmail Service (`Gmail.Users.*`)
 * returns them (Solution Design §5.2, §6.3, §9). Field names match the API,
 * so the adapter passes Gmail's objects through untouched. Only the fields the
 * classifier reads are listed. Fields are optional unless Gmail always sends
 * them.
 *
 * These live in `core/`, not `ports/`, because pure core code (E3's history
 * filters, E4's state builder) reads them, and `core/` can't import `ports/`.
 */

/** One header. Values arrive with RFC 2047 decoded and folding removed (spike 29). */
export type GmailHeader = {
  readonly name: string;
  readonly value: string;
};

/**
 * A part's body. `data` is a **byte array of signed bytes**, with the transfer
 * encoding undone and already transcoded to UTF-8 by Gmail, whatever charset
 * the part declares. It is never a base64 string. Decode it as UTF-8, never
 * with the declared charset (spike 29). A part with an `attachmentId` has no
 * inline `data`.
 */
export type GmailMessagePartBody = {
  readonly size?: number;
  readonly data?: readonly number[];
  readonly attachmentId?: string;
};

/**
 * A MIME part. `partId` is `""` for a single-part payload, `"0"`, `"1"` for
 * top-level children and `"0.0"` for nested ones. A `message/rfc822` part is
 * expanded into nested `parts` (spike 29).
 */
export type GmailMessagePart = {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: GmailMessagePartBody;
  readonly parts?: readonly GmailMessagePart[];
};

/**
 * A message from `threads.get`. `internalDate` (epoch milliseconds) and
 * `historyId` are strings. A message's `historyId` moves on any later change,
 * so it can't tell when the message arrived (SD §6.3).
 */
export type GmailMessage = {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: readonly string[];
  readonly internalDate?: string;
  readonly historyId?: string;
  readonly sizeEstimate?: number;
  readonly snippet?: string;
  readonly payload?: GmailMessagePart;
};

/** A thread from `threads.get`. Its messages include Spam and Trash ones (SD §6.4, §14). */
export type GmailThread = {
  readonly id: string;
  readonly historyId?: string;
  readonly messages?: readonly GmailMessage[];
};

/** A message as a history record refers to it. */
export type GmailMessageRef = {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: readonly string[];
};

/**
 * A label change in a history record: the label IDs added or removed, and the
 * message. `message.labelIds` are the message's labels right after that
 * change, not now (spike 20, finding 1).
 */
export type GmailLabelChange = {
  readonly labelIds: readonly string[];
  readonly message: GmailMessageRef;
};

/**
 * One `users.history.list` record (SD §6.3).
 *
 * - **Both change arrays are optional.** Gmail also returns records with only
 *   `id` and `messages`; E3 ignores them (spike 19, finding 1).
 * - `messagesAdded[].message.labelIds` are the labels when the message was
 *   added, not now (spike 19, finding 2).
 * - A whole-thread label removal gives one record, with one `labelsRemoved`
 *   entry per message that had the label (spike 20, finding 2).
 */
export type GmailHistoryRecord = {
  readonly id: string;
  readonly messages?: readonly { readonly id: string; readonly threadId: string }[];
  readonly messagesAdded?: readonly { readonly message: GmailMessageRef }[];
  readonly labelsRemoved?: readonly GmailLabelChange[];
  readonly labelsAdded?: readonly GmailLabelChange[];
};

/**
 * A label from `labels.list` or `labels.create`. User label IDs look like
 * `Label_<n>`. System label IDs are names (`INBOX`, `SPAM`). `type` is
 * `system` or `user`.
 */
export type GmailLabel = {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
};
