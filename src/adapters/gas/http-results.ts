/**
 * Pure helpers for `GasHttpAdapter` (Solution Design §5.2, §8.5), with no Apps
 * Script globals, so they are unit-tested.
 *
 * Spike #94 (`spikes/94-fetch-all.md`) recorded what they handle:
 * `getAllHeaders()` gives each header's value as a string, or as an array of
 * strings when the header is repeated (`Set-Cookie`), with the server's own
 * name casing; and `UrlFetchApp.fetchAll` throws one `Exception` for the whole
 * batch when any request can't be sent (`DNS error: <url>`).
 */
import { fail } from '../../core/result.ts';
import type { HttpResult } from '../../ports/http-port.ts';
import { isScopeErrorMessage } from './scope-errors.ts';

/** The longest `message` a failure carries. */
export const MAX_FAILURE_MESSAGE_LENGTH = 500;

/**
 * Lower-cases every header name (the `HttpPort` contract). An array value (a
 * repeated header) is joined with `", "`, and so are names that collide after
 * lower-casing, in input order. Any other value becomes `String(value)`.
 */
export function normalizeHeaders(raw: Readonly<Record<string, unknown>>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
    const existing = headers[lower];
    headers[lower] = existing === undefined ? text : `${existing}, ${text}`;
  }
  return headers;
}

/**
 * The results for a batch whose `fetchAll` threw: `count` copies of `scope`
 * when the message names a missing scope, otherwise of `transport`, since
 * `fetchAll` can't say which request failed. The message is the error's own,
 * cut to `MAX_FAILURE_MESSAGE_LENGTH` characters; nothing from the requests
 * (headers, payloads) is added.
 */
export function batchFailure(error: unknown, count: number): HttpResult[] {
  const fullMessage = readMessage(error);
  const message = fullMessage.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  const failure: HttpResult = isScopeErrorMessage(fullMessage)
    ? fail('scope', { message })
    : fail('transport', { message });
  return Array.from({ length: count }, () => failure);
}

/** The error's own message, or its string form for a thrown non-`Error`. */
function readMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
}
