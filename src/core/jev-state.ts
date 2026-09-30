/**
 * Builds Jev's `state` (Solution Design §8.3) from a Gmail thread: the messages
 * that count, newest first, each with the allowlisted headers under
 * descriptive keys and a plain-text `body`. Pure `core/` code: it reads no
 * Gmail, logs nothing and never throws for any thread content. Truncation to
 * fit Jev's limits is a later step (`threadToState`).
 */

import type { BodyConverter } from './body/body-converter.ts';
import { messageBodyText } from './body/mime-walk.ts';
import type { Utf8Decoder } from './body/utf8.ts';
import { parseInternalDate } from './first-classification.ts';
import type { GmailMessage, GmailThread } from './gmail-types.ts';

/** One message in Jev's `state`. Keys in this order; an absent key means "not sent". */
export type JevStateMessage = {
  readonly from?: string;
  readonly sender?: string;
  readonly replyTo?: string;
  readonly to?: string;
  readonly cc?: string;
  readonly subject?: string;
  readonly date?: string;
  readonly listId?: string;
  readonly listUnsubscribe?: string;
  readonly precedence?: string;
  readonly autoSubmitted?: string;
  readonly body?: string;
};

/** A header-backed key of a state message (every key but `body`). */
export type StateHeaderKey = Exclude<keyof JevStateMessage, 'body'>;

/**
 * The SD §8.3 header allowlist: header name (matched case-insensitively) to
 * state key, in output order. This is the one place the keys are defined.
 */
export const STATE_HEADER_KEYS: readonly (readonly [headerName: string, key: StateHeaderKey])[] = [
  ['From', 'from'],
  ['Sender', 'sender'],
  ['Reply-To', 'replyTo'],
  ['To', 'to'],
  ['Cc', 'cc'],
  ['Subject', 'subject'],
  ['Date', 'date'],
  ['List-Id', 'listId'],
  ['List-Unsubscribe', 'listUnsubscribe'],
  ['Precedence', 'precedence'],
  ['Auto-Submitted', 'autoSubmitted'],
];

/**
 * Labels that keep a message out of `state`: it was never sent (`DRAFT`), Gmail
 * judged it spam, or the user trashed it. Matches ingest and `screenChunk`.
 */
const LEFT_OUT_LABELS: readonly string[] = ['DRAFT', 'SPAM', 'TRASH'];

/** What `buildState` needs from outside `core/`: the HTML converter and the UTF-8 decoder. */
export type BuildStateDeps = {
  readonly converter: BodyConverter;
  readonly decodeUtf8: Utf8Decoder;
};

/** The allowlisted headers of a message's top-level part, keyed by state key, in map order. */
function headerFields(message: GmailMessage): Partial<Record<StateHeaderKey, string>> {
  const collected = new Map<string, string[]>();
  for (const header of message.payload?.headers ?? []) {
    const value = header.value.trim();
    if (value === '') continue;
    const name = header.name.trim().toLowerCase();
    const values = collected.get(name);
    if (values === undefined) collected.set(name, [value]);
    else values.push(value);
  }
  const fields: Partial<Record<StateHeaderKey, string>> = {};
  for (const [headerName, key] of STATE_HEADER_KEYS) {
    const values = collected.get(headerName.toLowerCase());
    if (values !== undefined) fields[key] = values.join(', ');
  }
  return fields;
}

/**
 * The thread's state, newest first.
 *
 * - **Kept:** every message except those labelled `DRAFT`, `SPAM` or `TRASH`.
 *   No messages, or none kept, gives `[]`.
 * - **Order:** `internalDate` descending. The sort is stable, and a message
 *   without a parseable `internalDate` counts as the oldest.
 * - **Headers:** only the message's top-level `payload.headers` (a forwarded
 *   message's headers sit on a nested part), names matched case-insensitively,
 *   values trimmed. A repeated header is joined with `", "`. An absent or blank
 *   header has no key.
 * - **Body:** `messageBodyText`. Empty text gives no `body` key.
 * - A message with no `payload` is kept as `{}`, so the count and order stay true.
 */
export function buildState(thread: GmailThread, deps: BuildStateDeps): JevStateMessage[] {
  const kept = (thread.messages ?? [])
    .filter((message) => !LEFT_OUT_LABELS.some((label) => message.labelIds?.includes(label)))
    .map((message) => ({ message, arrivedAt: parseInternalDate(message.internalDate) }));
  kept.sort((a, b) => {
    if (a.arrivedAt === undefined || b.arrivedAt === undefined) {
      if (a.arrivedAt === b.arrivedAt) return 0;
      return a.arrivedAt === undefined ? 1 : -1;
    }
    return b.arrivedAt - a.arrivedAt;
  });
  return kept.map(({ message }) => {
    const body = messageBodyText(message.payload, deps);
    return body === '' ? headerFields(message) : { ...headerFields(message), body };
  });
}
