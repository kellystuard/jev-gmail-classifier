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
 * Classification of each error, checked in this order:
 * - **normal failure** (returned):
 *   - `rate_limited` and `scope`, on every method;
 *   - when the caller names one, a 404 as `history_expired` or `not_found`;
 *   - when the caller lists them, its own expected kinds
 *     (`spikes/25-nested-labels.md`, `spikes/26-moves.md`): `label_exists`
 *     and `invalid_label_name` (`createLabel`), `invalid_label` and
 *     `failed_precondition` (`modifyThread`), and `invalid_page_token`
 *     (`searchThreadIds`, only for a request that has a `pageToken`;
 *     `spikes/287-page-token.md`). Each is recognized only for a method that
 *     lists it;
 * - **exceptional** (thrown as `UnexpectedResponseError`): everything else,
 *   including any other 400 (a malformed `startHistoryId` or thread ID is
 *   invalid state) and a 500.
 */
import { UnexpectedResponseError } from '../../core/errors.ts';
import { fail, type Fail } from '../../core/result.ts';
import type { GmailFailure } from '../../ports/gmail-port.ts';
import { isScopeErrorMessage } from './scope-errors.ts';

/** The failure a 404 becomes, chosen by the caller: a 404 means different things per call. */
export type GmailNotFoundKind = 'history_expired' | 'not_found';

/**
 * A failure only some methods expect, recognized only when the caller lists
 * it. Each carries the error's original `message`.
 */
export type GmailExpectedKind =
  | 'label_exists'
  | 'invalid_label_name'
  | 'invalid_label'
  | 'failed_precondition'
  | 'invalid_page_token';

/** Recognizes one expected kind, given the lower-case message. */
type ExpectedMatcher = {
  /** With a `details` object: its code and reasons, plus the text where a reason is too broad. */
  readonly withDetails: (details: GmailErrorDetails, lower: string) => boolean;
  /** Without one: the message text alone, as for the 404. */
  readonly byMessage: (lower: string) => boolean;
};

const EXPECTED_MATCHERS: Readonly<Record<GmailExpectedKind, ExpectedMatcher>> = {
  // 409 "Label name exists or conflicts", `reason: aborted` (spike 25 rows 5, 6, 9).
  label_exists: {
    withDetails: (details) => details.code === 409 || hasReason(details, 'aborted'),
    byMessage: (lower) => lower.includes('label name exists or conflicts'),
  },
  // 400 "Invalid label name", `reason: invalidArgument` (spike 25 row 7).
  invalid_label_name: {
    withDetails: (details, lower) => details.code === 400 && lower.includes('invalid label name'),
    byMessage: (lower) => lower.includes('invalid label name'),
  },
  // 400 "Invalid label: <x>" or "labelId not found", `reason: invalidArgument` (spike 25 rows 13, 14).
  invalid_label: {
    withDetails: (details, lower) => details.code === 400 && isInvalidLabelText(lower),
    byMessage: isInvalidLabelText,
  },
  // 400 "Precondition check failed.", `reason: failedPrecondition` (spike 26 "Errors").
  failed_precondition: {
    withDetails: (details) => hasReason(details, 'failedprecondition'),
    byMessage: (lower) => lower.includes('precondition check failed'),
  },
  // 400 "Invalid pageToken", `reason: invalidArgument` (spike 287, `threads.list`). The
  // text never carries `q`. Gmail also accepts some foreign tokens without an error.
  invalid_page_token: {
    withDetails: (details, lower) => details.code === 400 && lower.includes('invalid pagetoken'),
    byMessage: (lower) => lower.includes('invalid pagetoken'),
  },
};

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
 * outcome (`listHistory`: `history_expired`, `getThread` and `modifyThread`:
 * `not_found`), and `expected` for the method's own expected kinds. A 404, or
 * an expected kind, from a call that doesn't name it is unexpected.
 */
export function toGmailFailure<K extends GmailNotFoundKind, E extends GmailExpectedKind>(
  error: unknown,
  context: { method: string; notFound: K; expected: readonly E[] },
): GmailFailure | Fail<K> | Fail<E, { message: string }>;
export function toGmailFailure<K extends GmailNotFoundKind>(
  error: unknown,
  context: { method: string; notFound: K },
): GmailFailure | Fail<K>;
export function toGmailFailure<E extends GmailExpectedKind>(
  error: unknown,
  context: { method: string; expected: readonly E[] },
): GmailFailure | Fail<E, { message: string }>;
export function toGmailFailure(error: unknown, context: { method: string }): GmailFailure;
export function toGmailFailure(
  error: unknown,
  context: {
    method: string;
    notFound?: GmailNotFoundKind;
    expected?: readonly GmailExpectedKind[];
  },
): GmailFailure | Fail<GmailNotFoundKind> | Fail<GmailExpectedKind, { message: string }> {
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

  if (isScopeErrorMessage(message)) {
    return fail('scope', { message });
  }

  const isNotFound =
    details === undefined
      ? lower.trimEnd().endsWith(NOT_FOUND_MESSAGE_SUFFIX)
      : details.code === 404;
  if (isNotFound && context.notFound !== undefined) {
    return fail(context.notFound);
  }

  for (const kind of context.expected ?? []) {
    const matcher = EXPECTED_MATCHERS[kind];
    if (details === undefined ? matcher.byMessage(lower) : matcher.withDetails(details, lower)) {
      return fail(kind, { message });
    }
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

/** Whether any of `details`' reasons is `lowerReason`, ignoring case. */
function hasReason(details: GmailErrorDetails, lowerReason: string): boolean {
  return details.reasons.some((reason) => reason.toLowerCase() === lowerReason);
}

/** "Invalid label: <x>" (a name or an unusable ID) or "labelId not found" (an unknown ID). */
function isInvalidLabelText(lower: string): boolean {
  return lower.includes('invalid label') || lower.includes('labelid not found');
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
