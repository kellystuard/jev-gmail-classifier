/**
 * Fits Jev's `state` under its input limit (Solution Design §8.4, ADR-0010),
 * working on the structure and dropping the oldest content first. Pure `core/`
 * code: it never mutates its input and never throws for any thread content.
 */

import { InvalidArgumentError } from './errors.ts';
import type { JevStateMessage, StateHeaderKey } from './jev-state.ts';
import { STATE_HEADER_KEYS } from './jev-state.ts';
import { estimateTokens, JEV_LIMIT_TOKENS } from './token-estimate.ts';

/** What truncation cut, measured against its input (SD §8.4). E7 logs it in `thread.classified`. */
export interface TruncationStats {
  /** Input messages minus output messages. */
  readonly messagesDropped: number;
  /** Kept messages that had a `body` in the input and have none in the output. */
  readonly bodiesDropped: number;
  /** UTF-16 code units of body and header text removed or cut, each counted once. */
  readonly charsDropped: number;
}

/** `state`, and the stats only when something was cut. */
export interface TruncatedState {
  readonly state: JevStateMessage[];
  readonly truncated?: TruncationStats;
}

/** The header values of a message, keyed by state key. */
type HeaderValues = Partial<Record<StateHeaderKey, string>>;

/** The tokens of one message as it appears in the serialized array. */
function messageTokens(message: JevStateMessage): number {
  return estimateTokens(JSON.stringify(message));
}

/** The tokens of a serialized array whose messages sum to `sum`: brackets and commas. */
function arrayTokens(sum: number, count: number): number {
  return count === 0 ? 2 : sum + count + 1;
}

/** A message's header values, in map order. */
function headersOf(message: JevStateMessage): HeaderValues {
  const headers: HeaderValues = {};
  for (const [, key] of STATE_HEADER_KEYS) {
    const value = message[key];
    if (value !== undefined) headers[key] = value;
  }
  return headers;
}

/** The UTF-16 length of every value a message holds. */
function textLength(message: JevStateMessage): number {
  let length = message.body?.length ?? 0;
  for (const [, key] of STATE_HEADER_KEYS) length += message[key]?.length ?? 0;
  return length;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * The longest prefix length of `text` no longer than `max` that doesn't end on
 * a high surrogate, so no cut splits a pair.
 */
function safeCut(text: string, max: number): number {
  let length = Math.min(max, text.length);
  while (length > 0 && isHighSurrogate(text.charCodeAt(length - 1))) length--;
  return length;
}

/**
 * The largest `n` in `[lo, hi)` for which `fits(n)` holds, assuming `fits` is
 * monotone, `lo` is the fallback (returned when nothing above it fits) and
 * `fits(hi)` is false.
 */
function largestFitting(lo: number, hi: number, fits: (n: number) => boolean): number {
  let low = lo;
  let high = hi;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Step 3: cuts the newest message's body from the end to the longest prefix
 * whose serialized message fits `budget`, or removes it if no prefix does.
 */
function cutBody(
  message: JevStateMessage,
  budget: number,
): { message: JevStateMessage; charsDropped: number } {
  const body = message.body;
  const headers = headersOf(message);
  if (body === undefined) return { message: headers, charsDropped: 0 };
  if (messageTokens(headers) > budget) return { message: headers, charsDropped: body.length };
  // Estimates are additive: the message with a body costs this much plus the body's JSON string.
  const withoutBodyText = messageTokens({ ...headers, body: '' }) - 2;
  const fitsAt = (length: number): boolean =>
    withoutBodyText + estimateTokens(JSON.stringify(body.slice(0, length))) <= budget;
  // Search over cut lengths that end on a whole code point; `safeCut` is monotone.
  const kept = safeCut(
    body,
    largestFitting(0, body.length, (length) => fitsAt(safeCut(body, length))),
  );
  if (kept === 0) return { message: headers, charsDropped: body.length };
  return { message: { ...headers, body: body.slice(0, kept) }, charsDropped: body.length - kept };
}

/** The header values capped by `lengthOf(key, value)`, in map order; empty values lose their key. */
function capHeaders(
  headers: HeaderValues,
  lengthOf: (key: StateHeaderKey, value: string) => number,
): HeaderValues {
  const capped: HeaderValues = {};
  for (const [, key] of STATE_HEADER_KEYS) {
    const value = headers[key];
    if (value === undefined) continue;
    const length = lengthOf(key, value);
    if (length > 0) capped[key] = value.slice(0, length);
  }
  return capped;
}

/**
 * Step 4: cuts the longest header values of a message with no body from the
 * end until it fits `budget`. The longest value is cut first, just enough to
 * fit or down to the next longest, and ties go in key-map order. A value cut to
 * empty is removed with its key. If nothing fits, the result is `{}`.
 *
 * Equivalent and linear-logarithmic: find the largest cap `c` such that every
 * value cut to `c` fits. At `c + 1` it doesn't, so cut the values longer than
 * `c` from `c + 1` to `c` one at a time, in key-map order, until it fits.
 */
function cutHeaders(
  headers: HeaderValues,
  budget: number,
): { message: JevStateMessage; charsDropped: number } {
  let longest = 0;
  for (const value of Object.values(headers)) longest = Math.max(longest, value.length);
  const fits = (message: HeaderValues): boolean => messageTokens(message) <= budget;
  const cappedAt = (cap: number): HeaderValues => capHeaders(headers, (_, v) => safeCut(v, cap));
  const cap = largestFitting(0, longest, (c) => fits(cappedAt(c)));

  let result = cappedAt(cap + 1);
  const lowered = new Set<StateHeaderKey>();
  for (const [, key] of STATE_HEADER_KEYS) {
    if (fits(result)) break;
    const value = headers[key];
    if (value === undefined || safeCut(value, cap) === safeCut(value, cap + 1)) continue;
    lowered.add(key);
    result = capHeaders(headers, (k, v) => safeCut(v, lowered.has(k) ? cap : cap + 1));
  }
  if (!fits(result)) result = {};

  let charsDropped = 0;
  for (const [, key] of STATE_HEADER_KEYS) {
    charsDropped += (headers[key]?.length ?? 0) - (result[key]?.length ?? 0);
  }
  return { message: result, charsDropped };
}

/**
 * Cuts `state` (newest first, from `buildState`) until
 * `estimateStateTokens(result) + reservedTokens <= JEV_LIMIT_TOKENS`, re-checking
 * after each change and stopping as soon as it fits (SD §8.4):
 *
 * 1. Remove the `body` of the oldest message that has one, then the next
 *    oldest, keeping their headers. Never the newest message's in this step.
 * 2. Remove the oldest message entirely, then the next oldest, until only the
 *    newest is left.
 * 3. Cut the newest message's `body` from the end to the longest prefix that
 *    fits, measured on the serialized JSON. If none does, remove the `body`.
 * 4. Cut the newest message's longest header values from the end (see
 *    `cutHeaders`). A value cut to empty is removed with its key.
 *
 * The newest message is never dropped, no cut splits a surrogate pair, and no
 * marker is appended. If `reservedTokens` alone exceeds the limit, the result
 * is `[{}]`. Output messages keep `buildState`'s key order.
 *
 * @throws InvalidArgumentError if `reservedTokens` isn't a finite, non-negative number.
 */
export function truncateState(
  state: readonly JevStateMessage[],
  reservedTokens: number,
): TruncatedState {
  if (!Number.isFinite(reservedTokens) || reservedTokens < 0) {
    throw new InvalidArgumentError('reservedTokens must be a finite, non-negative number', {
      argument: 'reservedTokens',
      reason: Number.isFinite(reservedTokens) ? 'negative' : 'not_finite',
    });
  }
  const budget = JEV_LIMIT_TOKENS - reservedTokens;
  const messages: JevStateMessage[] = state.map((message) => ({ ...message }));
  const tokens = messages.map(messageTokens);
  let sum = tokens.reduce((total, t) => total + t, 0);
  const fits = (): boolean => arrayTokens(sum, messages.length) <= budget;
  if (fits()) return { state: messages };

  let charsDropped = 0;

  // Step 1: the oldest bodies, never the newest's.
  for (let i = messages.length - 1; i >= 1 && !fits(); i--) {
    const message = messages[i];
    if (message?.body === undefined) continue;
    const headers = headersOf(message);
    charsDropped += message.body.length;
    const headerTokens = messageTokens(headers);
    sum += headerTokens - (tokens[i] ?? 0);
    messages[i] = headers;
    tokens[i] = headerTokens;
  }

  // Step 2: the oldest messages, never the newest.
  while (messages.length > 1 && !fits()) {
    const dropped = messages.pop();
    sum -= tokens.pop() ?? 0;
    if (dropped !== undefined) charsDropped += textLength(dropped);
  }

  // Steps 3 and 4: the newest message alone, inside the array's brackets.
  const newest = messages[0];
  if (newest !== undefined && !fits()) {
    const messageBudget = budget - arrayTokens(0, 1);
    const cut = cutBody(newest, messageBudget);
    charsDropped += cut.charsDropped;
    let message = cut.message;
    if (messageTokens(message) > messageBudget) {
      const headers = cutHeaders(headersOf(message), messageBudget);
      charsDropped += headers.charsDropped;
      message = headers.message;
    }
    messages[0] = message;
  }

  const messagesDropped = state.length - messages.length;
  let bodiesDropped = 0;
  messages.forEach((message, i) => {
    if (state[i]?.body !== undefined && message.body === undefined) bodiesDropped++;
  });
  if (messagesDropped === 0 && bodiesDropped === 0 && charsDropped === 0) {
    return { state: messages };
  }
  return { state: messages, truncated: { messagesDropped, bodiesDropped, charsDropped } };
}
