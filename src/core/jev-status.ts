/**
 * Classifying Jev's HTTP responses (Solution Design §8.5; Epic E5, task #92).
 *
 * `classifyJevResponse` decides, from the status alone (plus the error body
 * for the two rows that need it), what the sender and `interpretResponse`
 * should do with a response. It never throws: throwing for an exceptional
 * response is `interpretResponse`'s job, inside E7's per-thread boundary.
 *
 * The table (one row per case; SD §8.5 has the same table):
 *
 * - 200: `success`. Interpreted by `interpretResponse`; the body is never read here.
 * - The unknown-model response (a 400 `api_usage_error` whose message starts
 *   with `Unknown model`, recorded by #90): `config`. A mistyped
 *   `jevModel` is a config mistake, not a property of the mail. Checked first.
 * - 400 with `detail.error_type === 'max_tokens_exceeded'`: `invalid`. Over
 *   Jev's token limit (measured by #84). The same content fails again.
 * - Any other 400: `exceptional`. Unknown bad request, a bug on our side.
 * - 401, 402, 403: `auth`. Missing or invalid key, or an account that can't
 *   be used (no credit, suspended, no access). The problem is the account,
 *   not the mail.
 * - 408, 429, 502, 503, 504, 529: `retryable`. Timeout, rate limit, bad
 *   gateway, unavailable, gateway timeout, overloaded.
 * - 422: `invalid`. The request failed validation.
 * - 500 and any other 500-599: `exceptional`. A generic server error isn't
 *   assumed temporary (PDD §4.6).
 * - 404 and any other 400-499: `exceptional`. Unexpected.
 * - Anything else (1xx, other 2xx, 3xx, 600 and up, not an integer):
 *   `exceptional`. Never expected.
 * - `transport` (from `HttpPort`, a network error or timeout): `retryable`.
 *   It has no status, so it isn't an input here: the sender applies it.
 *
 * Nothing here logs, stores or returns a response body.
 */

/**
 * One HTTP response from Jev. Core's own copy of the shape: `core/` can't
 * import `ports/`. An `HttpResult` with `ok: true` is assignable to it.
 * Header names are lower-case.
 */
export interface JevHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type JevResponseClass =
  'success' | 'invalid' | 'auth' | 'config' | 'retryable' | 'exceptional';

/** The `detail.error_type` of an over-limit 400 (measured by #84). */
const MAX_TOKENS_EXCEEDED = 'max_tokens_exceeded';

/** The exact statuses that have a class of their own. */
const STATUS_CLASSES: ReadonlyMap<number, JevResponseClass> = new Map<number, JevResponseClass>([
  [200, 'success'], // interpreted by interpretResponse
  [401, 'auth'], // missing or invalid key
  [402, 'auth'], // no credit: the account, not the mail
  [403, 'auth'], // suspended or no access: the account, not the mail
  [408, 'retryable'], // timeout
  [422, 'invalid'], // failed validation: the same content fails again
  [429, 'retryable'], // rate limit
  [502, 'retryable'], // bad gateway
  [503, 'retryable'], // unavailable
  [504, 'retryable'], // gateway timeout
  [529, 'retryable'], // overloaded
]);

const UNKNOWN_MODEL_ERROR_TYPE = 'api_usage_error';
const UNKNOWN_MODEL_MESSAGE_PREFIX = 'Unknown model';

/**
 * `detail.error_type` from an error body, or `undefined` when the body isn't
 * JSON, has no `detail` object, or `error_type` isn't a string. Never throws.
 */
export function jevErrorType(body: string): string | undefined {
  const errorType = jevDetailField(body, 'error_type');
  return typeof errorType === 'string' ? errorType : undefined;
}

/** A field of the body's `detail` object, or `undefined`. Never throws. */
function jevDetailField(body: string, key: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Handled and documented: an error body's shape is undocumented (SD §8.2),
    // so a body that isn't JSON simply has no detail.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const detail: unknown = Reflect.get(parsed, 'detail');
  // FastAPI-style 422 bodies have `detail` as an array: that has no fields.
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return undefined;
  }
  return Reflect.get(detail, key);
}

/**
 * The unknown-model response, recorded by #90 (`400-unknown-model.json`):
 * status 400, `detail.error_type` `api_usage_error` and a `detail.message`
 * that starts with `Unknown model`. Other `api_usage_error` 400s (for example
 * `Invalid request.`) don't match. Read only for a 400; never logged.
 */
function isUnknownModelResponse(response: JevHttpResponse): boolean {
  if (response.status !== 400 || jevErrorType(response.body) !== UNKNOWN_MODEL_ERROR_TYPE) {
    return false;
  }
  const message = jevDetailField(response.body, 'message');
  return typeof message === 'string' && message.startsWith(UNKNOWN_MODEL_MESSAGE_PREFIX);
}

/** Never throws, for any input. */
export function classifyJevResponse(response: JevHttpResponse): JevResponseClass {
  const { status } = response;
  if (!Number.isInteger(status)) {
    return 'exceptional';
  }
  if (isUnknownModelResponse(response)) {
    return 'config';
  }
  if (status === 400) {
    return jevErrorType(response.body) === MAX_TOKENS_EXCEEDED ? 'invalid' : 'exceptional';
  }
  return STATUS_CLASSES.get(status) ?? 'exceptional';
}

/** One attempt's outcome in a round, as the sender sees it: a response, or a network error. */
export type JevRoundOutcome = JevHttpResponse | { readonly transport: true };

/**
 * True when a round has at least 2 outcomes and every one is a 5xx or a
 * network error: Jev is down, so sending stops for the run, nothing is
 * struck and the items stay queued (SD §8.5). One failure among successes
 * isn't an outage. Never throws.
 */
export function isJevOutageRound(outcomes: readonly JevRoundOutcome[]): boolean {
  return (
    outcomes.length >= 2 &&
    outcomes.every((outcome) =>
      'transport' in outcome ? true : outcome.status >= 500 && outcome.status <= 599,
    )
  );
}
