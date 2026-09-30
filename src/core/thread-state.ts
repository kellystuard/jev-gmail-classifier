/**
 * The one entry point E5 and E7 call to turn a Gmail thread into Jev's `state`
 * (Solution Design §8.3, §8.4): build it, then fit it under both of Jev's
 * limits with room for the questions. Pure `core/` code: it logs nothing, and
 * never throws for any thread content.
 */

import { selectBodyConverter } from './body/body-converter.ts';
import type { PlainTextMethod } from './body/body-converter.ts';
import type { Utf8Decoder } from './body/utf8.ts';
import type { GmailThread } from './gmail-types.ts';
import { buildState } from './jev-state.ts';
import { reservedTokensForQuestions } from './token-estimate.ts';
import { truncateState } from './truncation.ts';
import type { TruncatedState } from './truncation.ts';

/** Plain values, not `Config`, so the probe and tests can call it without a full config. */
export interface ThreadToStateOptions {
  /** `config.plainTextMethod`. */
  readonly plainTextMethod: PlainTextMethod;
  /** Every rule's question, `config.rules.map((r) => r.question)`: all go in every request. */
  readonly questions: readonly string[];
}

/**
 * The thread's `state`, newest first, fitted under Jev's limits.
 *
 * Selects the converter for `plainTextMethod`, builds `state` with
 * `buildState`, and truncates it with `reservedTokensForQuestions(questions)`
 * reserved, so both SD §8.4 budget rules hold. A thread with no message left
 * (all `DRAFT`, `SPAM` or `TRASH`) gives `{state: []}`, which E7 skips as
 * `no_messages`. `truncated` is present only when something was cut.
 */
export function threadToState(
  thread: GmailThread,
  options: ThreadToStateOptions,
  decodeUtf8: Utf8Decoder,
): TruncatedState {
  const converter = selectBodyConverter(options.plainTextMethod);
  const state = buildState(thread, { converter, decodeUtf8 });
  if (state.length === 0) return { state: [] };
  return truncateState(state, reservedTokensForQuestions(options.questions));
}
