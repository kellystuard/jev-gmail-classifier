/**
 * Jev's input limits and the token estimate that keeps a request under them
 * (Solution Design §8.4). The numbers were measured against `jev-1.13.0` by
 * #84 (`spikes/84-token-ratio.md`) and are copied here, not re-derived.
 */

import type { JevStateMessage } from './jev-state.ts';

/** SD §8.4: Jev's limit for `state` plus the longest single question. */
export const JEV_LIMIT_TOKENS = 32_768;

/** SD §8.4: Jev's limit for `state` plus all questions combined. */
export const JEV_COMBINED_LIMIT_TOKENS = 65_536;

/** SD §8.4: the fixed cost of a request (a minimal request measured 279). */
export const REQUEST_OVERHEAD_TOKENS = 300;

/** SD §8.4: Jev's wrapper around each question (measured about 8). */
export const QUESTION_OVERHEAD_TOKENS = 10;

/** SD §8.4: the safety margin under `JEV_LIMIT_TOKENS`. */
export const MARGIN_TOKENS = 1_000;

/** SD §8.4: the safety margin under `JEV_COMBINED_LIMIT_TOKENS`. */
export const COMBINED_MARGIN_TOKENS = 2_000;

/**
 * An upper bound on the tokens Jev counts for `text`: its UTF-8 byte length,
 * counted from UTF-16 code units without `TextEncoder` (SD §8.4). Below `0x80`
 * counts 1, below `0x800` counts 2, each half of a surrogate pair counts 2, and
 * any other code unit counts 3. An integer, so there is nothing to round.
 *
 * Jev spends at most one token per UTF-8 byte for every kind of text #84
 * measured, so this never underestimates. It's additive: the estimate of a
 * concatenation is the sum of the parts' estimates.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) tokens += 1;
    else if (c < 0x800) tokens += 2;
    else if (c >= 0xd800 && c <= 0xdfff) tokens += 2;
    else tokens += 3;
  }
  return tokens;
}

/** The estimate of `state` as it's sent: `JSON.stringify(state)`, escapes, keys and punctuation included. */
export function estimateStateTokens(state: readonly JevStateMessage[]): number {
  return estimateTokens(JSON.stringify(state));
}

/**
 * The tokens to reserve beside `state` for these questions, so that
 * `estimateStateTokens(state) + reserved <= JEV_LIMIT_TOKENS` keeps both of
 * SD §8.4's budget rules true (with `qᵢ` each question's estimate and `n`
 * questions):
 *
 * - `s + max(qᵢ) + 300 + 10 + 1000 ≤ 32768`
 * - `s + Σqᵢ + 300 + 10n + 2000 ≤ 65536`
 *
 * So it's the larger of `max(qᵢ) + 10 + 300 + 1000` and
 * `Σqᵢ + 10n + 300 + 2000 − (65536 − 32768)`. The largest estimate wins, not
 * the longest string (CJK counts more per character). No questions reserve
 * only the request overhead and the margin.
 */
export function reservedTokensForQuestions(questions: readonly string[]): number {
  let largest = 0;
  let total = 0;
  for (const question of questions) {
    const tokens = estimateTokens(question);
    largest = Math.max(largest, tokens);
    total += tokens;
  }
  const perQuestion = questions.length === 0 ? 0 : QUESTION_OVERHEAD_TOKENS;
  const single = largest + perQuestion + REQUEST_OVERHEAD_TOKENS + MARGIN_TOKENS;
  const combined =
    total +
    QUESTION_OVERHEAD_TOKENS * questions.length +
    REQUEST_OVERHEAD_TOKENS +
    COMBINED_MARGIN_TOKENS -
    (JEV_COMBINED_LIMIT_TOKENS - JEV_LIMIT_TOKENS);
  return Math.max(single, combined);
}
