/**
 * Maps an exception from the Advanced Gmail Service to a failure kind
 * (Solution Design §5.2, §9; Engineering Standards §5).
 *
 * Pure, with no Apps Script globals, so it is unit-tested with the exact error
 * texts and shapes E1 recorded (`spikes/27-missing-scope.md`,
 * `spikes/30-gmail-quota.md`, `spikes/62-history-resume.md`).
 *
 * The service throws a `GoogleJsonResponseException`: an `Error` whose
 * `message` is `API call to gmail.users.<resource>.<method> failed with error:
 * <text>` and whose `details` is `{code, message, errors: [{reason, domain}]}`.
 * `details` can be missing (a scope error may be a plain `Error`), so every
 * field is read with a type guard.
 *
 * Classification of each error:
 * - **normal failure** (returned): `rate_limited`, `scope`, and, when the
 *   caller names one, a 404 as `history_expired` or `not_found`;
 * - **exceptional** (thrown as `UnexpectedResponseError`): everything else,
 *   including a 400 `invalid` (a malformed `startHistoryId` is invalid state)
 *   and a 500.
 */
import { UnexpectedResponseError } from '../../core/errors.ts';
import { fail, type Fail } from '../../core/result.ts';
import type { GmailFailure } from '../../ports/gmail-port.ts';

/** The failure a 404 becomes, chosen by the caller: a 404 means different things per call. */
export type GmailNotFoundKind = 'history_expired' | 'not_found';

/** Message fragments that mean a missing OAuth scope (SD §9), compared in lower case. */
const SCOPE_FRAGMENTS: readonly string[] = [
  'authorization is required to perform that action',
  'insufficient authentication scopes',
  'specified permissions are not sufficient',
];

/** Reasons Gmail gives for its per-user rate limit, in lower case. A 403 with either is never `scope`. */
const RATE_LIMIT_REASONS: readonly string[] = ['ratelimitexceeded', 'userratelimitexceeded'];

const RATE_LIMIT_MESSAGE_FRAGMENT = 'units per minute per user';

const NOT_FOUND_MESSAGE_SUFFIX = 'requested entity was not found.';

/** The parts of a `GoogleJsonResponseException` this file reads. */
type GmailErrorDetails = {
  readonly code: number | undefined;
  readonly reasons: readonly string[];
};

/**
 * Returns the recognized failure for `error`, or throws
 * `UnexpectedResponseError`. Pass `notFound` where a 404 is an expected
 * outcome (`listHistory`: `history_expired`, `getThread`: `not_found`). A 404
 * from a call without it is unexpected.
 */
export function toGmailFailure(error: unknown, context: { method: string }): GmailFailure;
export function toGmailFailure<K extends GmailNotFoundKind>(
  error: unknown,
  context: { method: string; notFound: K },
): GmailFailure | Fail<K>;
export function toGmailFailure(
  error: unknown,
  context: { method: string; notFound?: GmailNotFoundKind },
): GmailFailure | Fail<GmailNotFoundKind> {
  const message = readMessage(error);
  const lower = message.toLowerCase();
  const details = readDetails(error);

  // Rate limits come first: a 403 `rateLimitExceeded` must never be `scope`.
  if (
    details?.code === 429 ||
    details?.reasons.some((reason) => RATE_LIMIT_REASONS.includes(reason.toLowerCase())) === true ||
    lower.includes(RATE_LIMIT_MESSAGE_FRAGMENT)
  ) {
    return fail('rate_limited', { message });
  }

  if (SCOPE_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return fail('scope', { message });
  }

  const isNotFound =
    details === undefined
      ? lower.trimEnd().endsWith(NOT_FOUND_MESSAGE_SUFFIX)
      : details.code === 404;
  if (isNotFound && context.notFound !== undefined) {
    return fail(context.notFound);
  }

  throw new UnexpectedResponseError(
    `Gmail ${context.method} failed: ${message}`,
    {
      service: 'gmail',
      ...(details?.code === undefined ? {} : { status: details.code }),
      reason: `${context.method} failed`,
    },
    { cause: error },
  );
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

/** `details.code` and every `details.errors[].reason`, or `undefined` when there is no `details` object. */
function readDetails(error: unknown): GmailErrorDetails | undefined {
  if (typeof error !== 'object' || error === null || !('details' in error)) {
    return undefined;
  }
  const { details } = error;
  if (typeof details !== 'object' || details === null) {
    return undefined;
  }
  const code = 'code' in details && typeof details.code === 'number' ? details.code : undefined;
  const reasons: string[] = [];
  if ('errors' in details && Array.isArray(details.errors)) {
    const entries: unknown[] = details.errors;
    for (const entry of entries) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        'reason' in entry &&
        typeof entry.reason === 'string'
      ) {
        reasons.push(entry.reason);
      }
    }
  }
  return { code, reasons };
}
