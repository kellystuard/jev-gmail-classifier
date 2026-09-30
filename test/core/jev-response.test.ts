import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidArgumentError, UnexpectedResponseError } from '../../src/core/errors.ts';
import { interpretResponse, usageInputTokens } from '../../src/core/jev-response.ts';
import type { JevResult } from '../../src/core/jev-response.ts';
import type { JevHttpResponse } from '../../src/core/jev-status.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'jev');
const used = new Set<string>();
const fixtureSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

function fixture(name: string): JevHttpResponse {
  used.add(`${name}.json`);
  return fixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')));
}

const FOUR = ['approval', 'bill', 'newsletter', 'shipping'];
const LONG_ID = `a${'-_'.repeat(15)}z`;
const REQ = 'req_test';

function reply(body: unknown, overrides: Partial<JevHttpResponse> = {}): JevHttpResponse {
  return {
    status: 200,
    headers: { 'x-typesafe-request-id': REQ },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...overrides,
  };
}

function envelope(answers: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 10, output_tokens: 2 },
    ...extra,
  };
}

const noul = (p: unknown): unknown => ({ type: 'noul', noul: p });

function thrown(fn: () => unknown): UnexpectedResponseError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnexpectedResponseError) {
      return error;
    }
    throw error;
  }
  throw new Error('did not throw');
}

describe('interpretResponse: fixtures', () => {
  it('reads the four-rule 200', () => {
    const result = interpretResponse(fixture('200-four-rules'), FOUR);
    expect(result).toEqual({
      ok: true,
      answers: { approval: 0.06, bill: 0.01, newsletter: 0.93, shipping: 0.02 },
      inputTokens: 580,
      outputTokens: 68,
      requestId: 'req_01a0f0a817707d35a24d604207bb0e52',
      model: 'jev-1.13.0',
    });
  });

  it('reads the edge rule ids, including constructor', () => {
    const result = interpretResponse(fixture('200-edge-rule-ids'), ['a', 'constructor', LONG_ID]);
    expect(result).toMatchObject({
      ok: true,
      answers: { a: 0.03, constructor: 0.03, [LONG_ID]: 0.04 },
      inputTokens: 395,
    });
  });

  it.each([
    ['401-wrong-key', 401],
    ['403-no-key', 403],
  ])('%s is auth', (name, status) => {
    const response = fixture(name);
    expect(interpretResponse(response, FOUR)).toEqual({
      ok: false,
      kind: 'auth',
      status,
      requestId: response.headers['x-typesafe-request-id'],
    });
  });

  it.each(['422-empty-questions', '422-missing-state', '422-state-wrong-type'])(
    '%s is invalid without an errorType',
    (name) => {
      const result = interpretResponse(fixture(name), FOUR);
      expect(result).toMatchObject({ ok: false, kind: 'invalid', status: 422 });
      expect(result).not.toHaveProperty('errorType');
    },
  );

  it('keeps errorType for the max_tokens_exceeded 400', () => {
    expect(interpretResponse(fixture('400-max-tokens-exceeded'), FOUR)).toMatchObject({
      ok: false,
      kind: 'invalid',
      status: 400,
      errorType: 'max_tokens_exceeded',
    });
  });

  it.each(['400-unknown-model', '400-unknown-model-typo'])('%s is config', (name) => {
    expect(interpretResponse(fixture(name), FOUR)).toMatchObject({
      ok: false,
      kind: 'config',
      status: 400,
      errorType: 'api_usage_error',
    });
  });

  it('throws for any other 400', () => {
    const error = thrown(() => interpretResponse(fixture('400-question-type-yesno'), FOUR));
    expect(error.reason).toBe('unexpected_status');
    expect(error.status).toBe(400);
  });

  it('uses every fixture', () => {
    // Runs last: the tests above register the files they read.
    const unused = readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && !used.has(f));
    expect(unused).toEqual([]);
  });
});

describe('interpretResponse: 200', () => {
  const good = { a: noul(0.5), b: noul(0.25) };

  it('accepts the boundaries 0 and 1', () => {
    const result = interpretResponse(reply(envelope({ a: noul(0), b: noul(1) })), ['a', 'b']);
    expect(result).toMatchObject({ ok: true, answers: { a: 0, b: 1 } });
  });

  it('ignores extra answers and unknown keys, and follows ruleIds order', () => {
    const result = interpretResponse(
      reply(envelope({ z: noul(0.9), b: noul(0.25), a: noul(0.5) }, { extra: 1 })),
      ['a', 'b'],
    );
    expect(result).toMatchObject({ ok: true, answers: { a: 0.5, b: 0.25 } });
    if (result.ok) {
      expect(Object.keys(result.answers)).toEqual(['a', 'b']);
    }
  });

  it('omits outputTokens and requestId when absent', () => {
    const result = interpretResponse(
      reply({ model: 'm', answers: good, usage: { input_tokens: 3 } }, { headers: {} }),
      ['a', 'b'],
    );
    expect(result).toEqual({
      ok: true,
      answers: { a: 0.5, b: 0.25 },
      inputTokens: 3,
      model: 'm',
    });
    expect(result).not.toHaveProperty('outputTokens');
    expect(result).not.toHaveProperty('requestId');
  });

  it('treats an empty request id as absent', () => {
    const result = interpretResponse(
      reply(envelope(good), { headers: { 'x-typesafe-request-id': '' } }),
      ['a', 'b'],
    );
    expect(result).not.toHaveProperty('requestId');
  });

  const usage = { input_tokens: 1 };
  const cases: [string, unknown, string, string?][] = [
    ['not JSON', 'nope', 'invalid_json'],
    ['JSON but not an object', '[1]', 'malformed_body'],
    ['null', 'null', 'malformed_body'],
    ['answers missing', { model: 'm', usage }, 'malformed_body'],
    ['answers not an object', { model: 'm', answers: 5, usage }, 'malformed_body'],
    ['model missing', { answers: good, usage }, 'malformed_body'],
    ['model empty', { model: '', answers: good, usage }, 'malformed_body'],
    ['usage missing', { model: 'm', answers: good }, 'malformed_body'],
    [
      'input_tokens negative',
      { model: 'm', answers: good, usage: { input_tokens: -1 } },
      'malformed_body',
    ],
    [
      'input_tokens fractional',
      { model: 'm', answers: good, usage: { input_tokens: 1.5 } },
      'malformed_body',
    ],
    [
      'output_tokens negative',
      { model: 'm', answers: good, usage: { input_tokens: 1, output_tokens: -1 } },
      'malformed_body',
    ],
    ['one answer missing', envelope({ a: noul(0.5) }), 'missing_answer', 'b'],
    [
      'type not noul',
      envelope({ a: noul(0.5), b: { type: 'yesno', noul: 0.5 } }),
      'malformed_answer',
      'b',
    ],
    ['answer not an object', envelope({ a: noul(0.5), b: 0.5 }), 'malformed_answer', 'b'],
    ['noul a string', envelope({ a: noul('0.5'), b: noul(0.5) }), 'malformed_answer', 'a'],
    ['noul null', envelope({ a: noul(null), b: noul(0.5) }), 'malformed_answer', 'a'],
    ['noul below 0', envelope({ a: noul(-0.01), b: noul(0.5) }), 'malformed_answer', 'a'],
    ['noul above 1', envelope({ a: noul(1.01), b: noul(0.5) }), 'malformed_answer', 'a'],
  ];

  it.each(cases)('%s throws', (_name, body, reason, ruleId) => {
    const error = thrown(() => interpretResponse(reply(body), ['a', 'b']));
    expect(error).toMatchObject({ service: 'jev', status: 200, requestId: REQ, reason });
    if (ruleId !== undefined) {
      expect(error.message).toContain(ruleId);
    }
  });

  it('does not find a rule id on the prototype', () => {
    const error = thrown(() =>
      interpretResponse(reply(envelope({ a: noul(0.5) })), ['a', 'constructor']),
    );
    expect(error.reason).toBe('missing_answer');
  });
});

describe('interpretResponse: statuses', () => {
  it.each([500, 418, 400, 302])('%i throws', (status) => {
    const error = thrown(() => interpretResponse(reply('x', { status }), FOUR));
    expect(error).toMatchObject({ reason: 'unexpected_status', status, requestId: REQ });
  });

  it.each([408, 429, 502, 503, 504, 529])('%i is retryable', (status) => {
    expect(interpretResponse(reply('{}', { status }), FOUR)).toEqual({
      ok: false,
      kind: 'retryable',
      status,
      requestId: REQ,
    });
  });

  it.each([401, 402, 403])('%i is auth', (status) => {
    expect(interpretResponse(reply('{}', { status }), FOUR)).toMatchObject({
      kind: 'auth',
      status,
    });
  });

  const detail = (d: unknown): string => JSON.stringify({ detail: d });
  it.each([
    ['no error_type', detail({ message: 'x' }), undefined],
    ['not JSON', 'oops', undefined],
    ['error_type with spaces', detail({ error_type: 'has spaces' }), undefined],
    ['error_type too long', detail({ error_type: 'a'.repeat(65) }), undefined],
    ['a number', detail({ error_type: 5 }), undefined],
    ['an identifier', detail({ error_type: 'some.type-1_x' }), 'some.type-1_x'],
  ])('422 with %s', (_name, body, errorType) => {
    const result = interpretResponse(reply(body, { status: 422 }), FOUR);
    if (errorType === undefined) {
      expect(result).not.toHaveProperty('errorType');
    } else {
      expect(result).toMatchObject({ errorType });
    }
  });

  it('omits requestId on a failure when the header is absent', () => {
    const result: JevResult = interpretResponse(reply('{}', { status: 422, headers: {} }), FOUR);
    expect(result).toEqual({ ok: false, kind: 'invalid', status: 422 });
  });
});

describe('interpretResponse: no leak', () => {
  const SENTINEL = 'SECRET-SENTINEL-BODY';

  const bodies: [string, JevHttpResponse][] = [
    ['500', reply(`{"note":"${SENTINEL}"}`, { status: 500 })],
    ['418', reply(SENTINEL, { status: 418 })],
    ['not JSON', reply(SENTINEL)],
    ['malformed body', reply({ model: SENTINEL })],
    ['bad probability', reply(envelope({ a: noul(SENTINEL) }))],
    ['missing answer', reply(envelope({ [SENTINEL]: noul(0.5) }))],
    ['400', reply(`{"detail":{"error_type":"x","message":"${SENTINEL}"}}`, { status: 400 })],
  ];

  it.each(bodies)('%s', (_name, response) => {
    const error = thrown(() => interpretResponse(response, ['a']));
    expect(error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(error.toLogFields())).not.toContain(SENTINEL);
  });
});

describe('interpretResponse: bad ruleIds', () => {
  it.each([
    [[], 'empty'],
    [['a', 'b', 'a'], 'duplicate_id'],
  ])('%j', (ruleIds, reason) => {
    try {
      interpretResponse(reply(envelope({})), ruleIds);
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error).toMatchObject({ argument: 'ruleIds', reason });
    }
  });
});

describe('usageInputTokens', () => {
  it('reads the 200 fixtures', () => {
    expect(usageInputTokens(fixture('200-four-rules'))).toBe(580);
    expect(usageInputTokens(fixture('200-edge-rule-ids'))).toBe(395);
  });

  it('counts a 200 that interpretResponse rejects', () => {
    const response = reply(envelope({ a: noul(0.5) }, { usage: { input_tokens: 77 } }));
    expect(() => interpretResponse(response, ['a', 'b'])).toThrow(UnexpectedResponseError);
    expect(usageInputTokens(response)).toBe(77);
  });

  it('is 0 for the non-200 fixtures', () => {
    for (const name of ['401-wrong-key', '422-missing-state', '400-max-tokens-exceeded']) {
      expect(usageInputTokens(fixture(name))).toBe(0);
    }
  });

  const okUsage = (usage: unknown): string => JSON.stringify({ usage });
  it.each([
    ['bad JSON', 'nope'],
    ['null', 'null'],
    ['an array', '[]'],
    ['no usage', '{}'],
    ['usage null', okUsage(null)],
    ['usage a string', okUsage('5')],
    ['no input_tokens', okUsage({})],
    ['negative', okUsage({ input_tokens: -1 })],
    ['fractional', okUsage({ input_tokens: 1.5 })],
    ['a string', okUsage({ input_tokens: '5' })],
    ['unsafe integer', '{"usage":{"input_tokens":1e300}}'],
    ['empty body', ''],
  ])('is 0 for %s', (_name, body) => {
    expect(usageInputTokens(reply(body))).toBe(0);
  });

  it('is 0 for any other status', () => {
    expect(usageInputTokens(reply(okUsage({ input_tokens: 5 }), { status: 201 }))).toBe(0);
    expect(usageInputTokens(reply(okUsage({ input_tokens: 5 }), { status: 500 }))).toBe(0);
  });

  it('accepts 0', () => {
    expect(usageInputTokens(reply(okUsage({ input_tokens: 0 })))).toBe(0);
  });
});
