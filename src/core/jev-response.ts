/**
 * Turning one final Jev response into a `JevResult` (Solution Design §8.1,
 * §8.2, §10.1; Epic E5, task #89).
 *
 * E7 calls `interpretResponse` per thread, inside the per-thread boundary, after
 * the sender (#96) has classified and retried. An expected failure is a result
 * (`invalid`, `auth`, `config`, `retryable`); anything exceptional throws
 * `UnexpectedResponseError`. Nothing here logs.
 *
 * Never in a message, a field or a cause: the response body, a probability,
 * `state`, a question, or any header other than the request ID. Error bodies
 * echo the request (test/fixtures/jev/README.md), so only `detail.error_type`,
 * and only when it is a short identifier, is kept.
 */
import { z } from 'zod';

import { InvalidArgumentError, UnexpectedResponseError } from './errors.ts';
import { classifyJevResponse, jevErrorType } from './jev-status.ts';
import type { JevHttpResponse } from './jev-status.ts';
import { fail, ok } from './result.ts';
import type { Fail, Result } from './result.ts';

/** Rule id to probability in [0, 1]. Only the asked ids, in the order asked. */
export type JevAnswers = Readonly<Record<string, number>>;

export type JevResult = Result<
  {
    readonly answers: JevAnswers;
    readonly inputTokens: number;
    readonly outputTokens?: number;
    readonly requestId?: string;
    readonly model: string;
  },
  | Fail<'invalid', { status: number; errorType?: string; requestId?: string }>
  | Fail<'auth', { status: number; requestId?: string }>
  | Fail<'config', { status: number; errorType?: string; requestId?: string }>
  | Fail<'retryable', { status: number; requestId?: string }>
  // Never returned here: the sender returns it for a request HttpPort refused
  // for a missing scope, and E7 raises `scope_missing`.
  | Fail<'scope', { message: string }>
>;

const REQUEST_ID_HEADER = 'x-typesafe-request-id';

/** A `detail.error_type` worth keeping: a short identifier, not free text. */
const ERROR_TYPE = /^[A-Za-z0-9_.-]{1,64}$/;

const COUNT = z.number().int().nonnegative();

/** The 200 envelope. Unknown keys are allowed. Each answer is checked apart. */
const envelopeSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: COUNT,
    output_tokens: COUNT.optional(),
  }),
});

const answerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
});

const usageSchema = z.object({ usage: z.object({ input_tokens: COUNT }) });

function unexpected(
  response: JevHttpResponse,
  requestId: string | undefined,
  reason: string,
  ruleId?: string,
): UnexpectedResponseError {
  const suffix = ruleId === undefined ? '' : ` (rule ${ruleId})`;
  return new UnexpectedResponseError(`Unexpected Jev response: ${reason}${suffix}`, {
    service: 'jev',
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    reason,
  });
}

/** `{ok: true, value}`, or `{ok: false}` for a body that isn't JSON. Never throws. */
function parseJson(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(body);
    return { ok: true, value };
  } catch {
    // Handled: callers report `invalid_json` without the body or the parse
    // error, which can quote the body.
    return { ok: false };
  }
}

/**
 * @throws InvalidArgumentError for empty or duplicated `ruleIds` (a caller bug).
 * @throws UnexpectedResponseError for an exceptional status, or a 200 whose
 *   body doesn't have an acceptable `noul` answer for every rule id.
 */
export function interpretResponse(
  response: JevHttpResponse,
  ruleIds: readonly string[],
): JevResult {
  if (ruleIds.length === 0) {
    throw new InvalidArgumentError('ruleIds must not be empty', {
      argument: 'ruleIds',
      reason: 'empty',
    });
  }
  if (new Set(ruleIds).size !== ruleIds.length) {
    throw new InvalidArgumentError('ruleIds must not repeat an id', {
      argument: 'ruleIds',
      reason: 'duplicate_id',
    });
  }
  const rawRequestId = response.headers[REQUEST_ID_HEADER];
  const requestId = rawRequestId === undefined || rawRequestId === '' ? undefined : rawRequestId;
  const withId = requestId === undefined ? {} : { requestId };
  const { status } = response;

  switch (classifyJevResponse(response)) {
    case 'success':
      return interpretSuccess(response, ruleIds, requestId);
    case 'invalid':
      return fail('invalid', { status, ...errorTypeField(response.body), ...withId });
    case 'config':
      return fail('config', { status, ...errorTypeField(response.body), ...withId });
    case 'auth':
      return fail('auth', { status, ...withId });
    case 'retryable':
      return fail('retryable', { status, ...withId });
    case 'exceptional':
      throw unexpected(response, requestId, 'unexpected_status');
  }
}

function errorTypeField(body: string): { errorType?: string } {
  const errorType = jevErrorType(body);
  return errorType !== undefined && ERROR_TYPE.test(errorType) ? { errorType } : {};
}

function interpretSuccess(
  response: JevHttpResponse,
  ruleIds: readonly string[],
  requestId: string | undefined,
): JevResult {
  const json = parseJson(response.body);
  if (!json.ok) {
    throw unexpected(response, requestId, 'invalid_json');
  }
  const envelope = envelopeSchema.safeParse(json.value);
  if (!envelope.success) {
    throw unexpected(response, requestId, 'malformed_body');
  }
  const { model, answers: rawAnswers, usage } = envelope.data;
  const answers: Record<string, number> = {};
  // A Map holds own entries only: a rule id like `constructor` mustn't find the
  // prototype's property.
  const asked = new Map(Object.entries(rawAnswers));
  for (const ruleId of ruleIds) {
    if (!asked.has(ruleId)) {
      throw unexpected(response, requestId, 'missing_answer', ruleId);
    }
    const answer = answerSchema.safeParse(asked.get(ruleId));
    if (!answer.success) {
      throw unexpected(response, requestId, 'malformed_answer', ruleId);
    }
    answers[ruleId] = answer.data.noul;
  }
  return ok({
    answers,
    inputTokens: usage.input_tokens,
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
    ...(requestId === undefined ? {} : { requestId }),
    model,
  });
}

/**
 * The input tokens Jev billed for a response: `usage.input_tokens` of a 200
 * whose body is JSON with a non-negative safe integer there, otherwise 0. Never
 * throws. It counts a 200 that `interpretResponse` later rejects, because Jev
 * billed it (Epic E5 decision 5).
 */
export function usageInputTokens(response: JevHttpResponse): number {
  if (response.status !== 200) {
    return 0;
  }
  const json = parseJson(response.body);
  if (!json.ok) {
    return 0;
  }
  const parsed = usageSchema.safeParse(json.value);
  if (!parsed.success || !Number.isSafeInteger(parsed.data.usage.input_tokens)) {
    return 0;
  }
  return parsed.data.usage.input_tokens;
}
