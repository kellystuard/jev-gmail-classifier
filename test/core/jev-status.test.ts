import { describe, expect, it } from 'vitest';

import fx0 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };
import fx1 from '../fixtures/jev/200-edge-rule-ids.json' with { type: 'json' };
import fx2 from '../fixtures/jev/400-max-tokens-exceeded.json' with { type: 'json' };
import fx3 from '../fixtures/jev/400-unknown-model.json' with { type: 'json' };
import fx4 from '../fixtures/jev/400-unknown-model-typo.json' with { type: 'json' };
import fx5 from '../fixtures/jev/400-question-type-yesno.json' with { type: 'json' };
import fx6 from '../fixtures/jev/401-wrong-key.json' with { type: 'json' };
import fx7 from '../fixtures/jev/403-no-key.json' with { type: 'json' };
import fx8 from '../fixtures/jev/422-empty-questions.json' with { type: 'json' };
import fx9 from '../fixtures/jev/422-missing-state.json' with { type: 'json' };
import fx10 from '../fixtures/jev/422-state-wrong-type.json' with { type: 'json' };
import {
  classifyJevResponse,
  isJevOutageRound,
  jevErrorType,
  type JevHttpResponse,
  type JevResponseClass,
  type JevRoundOutcome,
} from '../../src/core/jev-status.ts';

/** The verbatim over-limit 400 body measured by #84. */
const MAX_TOKENS_BODY = '{"detail":{"error_type":"max_tokens_exceeded"}}';

/** Recorded by #90 (`400-unknown-model.json`, `400-question-type-yesno.json`). */
const UNKNOWN_MODEL_BODY =
  '{"detail":{"error_type":"api_usage_error","message":"Unknown model: jev-does-not-exist"}}';
const INVALID_REQUEST_BODY =
  '{"detail":{"error_type":"api_usage_error","message":"Invalid request."}}';

function response(status: number, body = ''): JevHttpResponse {
  return { status, headers: {}, body };
}

describe('classifyJevResponse', () => {
  it.each<[string, string]>([
    ['a valid body', '{"answers":{},"usage":{"input_tokens":5}}'],
    ['an empty body', ''],
    ['a non-JSON body', 'not json'],
  ])('classifies 200 with %s as success', (_name, body) => {
    expect(classifyJevResponse(response(200, body))).toBe('success');
  });

  it.each<[string, string]>([
    ['the verbatim #84 body', MAX_TOKENS_BODY],
    [
      'extra keys in detail',
      '{"detail":{"error_type":"max_tokens_exceeded","limit":32768,"x":[1]}}',
    ],
    ['extra top-level keys', '{"detail":{"error_type":"max_tokens_exceeded"},"request_id":"r"}'],
  ])('classifies a 400 with %s as invalid', (_name, body) => {
    expect(classifyJevResponse(response(400, body))).toBe('invalid');
  });

  it.each<[string, string]>([
    ['an empty body', ''],
    ['a non-JSON body', 'Bad Request'],
    ['an empty object', '{}'],
    ['a string detail', '{"detail":"max_tokens_exceeded"}'],
    ['an array detail', '{"detail":[{"loc":["body"],"msg":"bad","type":"value_error"}]}'],
    ['a null detail', '{"detail":null}'],
    ['a numeric error_type', '{"detail":{"error_type":42}}'],
    ['an upper-case error_type', '{"detail":{"error_type":"MAX_TOKENS_EXCEEDED"}}'],
    ['error_type outside detail', '{"error_type":"max_tokens_exceeded"}'],
    ['another error_type', '{"detail":{"error_type":"something_else"}}'],
    ['a JSON array', '[1,2]'],
    ['JSON null', 'null'],
  ])('classifies a 400 with %s as exceptional', (_name, body) => {
    expect(classifyJevResponse(response(400, body))).toBe('exceptional');
  });

  it.each<[string, number, string, JevResponseClass]>([
    ['the unknown-model response', 400, UNKNOWN_MODEL_BODY, 'config'],
    [
      'the same with extra keys',
      400,
      '{"detail":{"error_type":"api_usage_error","message":"Unknown model: x","n":1},"z":0}',
      'config',
    ],
    ['a 400 api_usage_error of another message', 400, INVALID_REQUEST_BODY, 'exceptional'],
    [
      'a 400 api_usage_error without a message',
      400,
      '{"detail":{"error_type":"api_usage_error"}}',
      'exceptional',
    ],
    [
      'a 400 api_usage_error with a numeric message',
      400,
      '{"detail":{"error_type":"api_usage_error","message":7}}',
      'exceptional',
    ],
    [
      'a 400 with the message but another error_type',
      400,
      '{"detail":{"error_type":"x","message":"Unknown model: a"}}',
      'exceptional',
    ],
    ['a 422 with the unknown-model body', 422, UNKNOWN_MODEL_BODY, 'invalid'],
    ['a 404 with the unknown-model body', 404, UNKNOWN_MODEL_BODY, 'exceptional'],
    ['a 404 with an empty body', 404, '', 'exceptional'],
    ['a 422 with an empty body', 422, '', 'invalid'],
    [
      'the no-key 403 body',
      403,
      '{"detail":{"error_type":"authentication_error","message":"Must supply an API key! Check your request and try again."}}',
      'auth',
    ],
  ])('classifies %s', (_name, status, body, expected) => {
    expect(classifyJevResponse(response(status, body))).toBe(expected);
  });

  it.each<[number, string, JevResponseClass]>([
    [422, '', 'invalid'],
    [
      422,
      '{"detail":[{"loc":["body","state"],"msg":"field required","type":"missing"}]}',
      'invalid',
    ],
    [422, MAX_TOKENS_BODY, 'invalid'],
    [401, '', 'auth'],
    [401, MAX_TOKENS_BODY, 'auth'],
    [402, '', 'auth'],
    [403, '', 'auth'],
    [408, '', 'retryable'],
    [429, '', 'retryable'],
    [502, '', 'retryable'],
    [503, '', 'retryable'],
    [504, '', 'retryable'],
    [529, MAX_TOKENS_BODY, 'retryable'],
    [500, '', 'exceptional'],
    [501, '', 'exceptional'],
    [505, '', 'exceptional'],
    [520, '', 'exceptional'],
    [599, '', 'exceptional'],
    [404, '', 'exceptional'],
    [409, '', 'exceptional'],
    [499, '', 'exceptional'],
    [100, '', 'exceptional'],
    [204, '', 'exceptional'],
    [301, '', 'exceptional'],
    [399, '', 'exceptional'],
    [600, '', 'exceptional'],
    [0, '', 'exceptional'],
    [-1, '', 'exceptional'],
    [200.5, '', 'exceptional'],
    [Number.NaN, '', 'exceptional'],
    [Number.POSITIVE_INFINITY, '', 'exceptional'],
  ])('classifies %s (body %j) as %s', (status, body, expected) => {
    expect(classifyJevResponse(response(status, body))).toBe(expected);
  });
});

describe('jevErrorType', () => {
  it('returns the error type of the #84 body', () => {
    expect(jevErrorType(MAX_TOKENS_BODY)).toBe('max_tokens_exceeded');
  });

  it.each<[string, string]>([
    ['an empty body', ''],
    ['a non-JSON body', '<html>'],
    ['an empty object', '{}'],
    ['a string detail', '{"detail":"x"}'],
    ['an array detail', '{"detail":[]}'],
    ['a null detail', '{"detail":null}'],
    ['a numeric error_type', '{"detail":{"error_type":42}}'],
    ['no error_type', '{"detail":{}}'],
    ['error_type outside detail', '{"error_type":"x"}'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"max_tokens_exceeded"'],
  ])('returns undefined for %s', (_name, body) => {
    expect(jevErrorType(body)).toBeUndefined();
  });

  it('keeps the case of the error type', () => {
    expect(jevErrorType('{"detail":{"error_type":"Foo_Bar"}}')).toBe('Foo_Bar');
  });

  it.each<[string, string]>([
    ['a huge body', `{"detail":{"error_type":"x","pad":"${'a'.repeat(5_000_000)}"}}`],
    ['a deeply nested body', '['.repeat(100_000) + ']'.repeat(100_000)],
    ['a truncated body', '{"detail":{"error_'],
  ])('never throws for %s', (_name, body) => {
    expect(() => jevErrorType(body)).not.toThrow();
  });
});

describe('isJevOutageRound', () => {
  const transport: JevRoundOutcome = { transport: true };

  it.each<[string, readonly JevRoundOutcome[], boolean]>([
    ['nothing', [], false],
    ['one 500', [response(500)], false],
    ['one network error', [transport], false],
    ['2 x 500', [response(500), response(500)], true],
    ['503 and 529', [response(503), response(529)], true],
    ['500 and a network error', [response(500), transport], true],
    ['2 x network error', [transport, transport], true],
    ['500 and 200', [response(500), response(200)], false],
    ['500 and 422', [response(500), response(422)], false],
    ['a network error and 429', [transport, response(429)], false],
    ['599 and 600', [response(599), response(600)], false],
    ['three 5xx and one 200', [response(500), response(502), response(504), response(200)], false],
  ])('for %s returns %s', (_name, outcomes, expected) => {
    expect(isJevOutageRound(outcomes)).toBe(expected);
  });
});

describe('the recorded Jev fixtures (#90)', () => {
  it.each<[string, JevHttpResponse, JevResponseClass]>([
    ['200-four-rules', fx0, 'success'],
    ['200-edge-rule-ids', fx1, 'success'],
    ['400-max-tokens-exceeded', fx2, 'invalid'],
    ['400-unknown-model', fx3, 'config'],
    ['400-unknown-model-typo', fx4, 'config'],
    ['400-question-type-yesno', fx5, 'exceptional'],
    ['401-wrong-key', fx6, 'auth'],
    ['403-no-key', fx7, 'auth'],
    ['422-empty-questions', fx8, 'invalid'],
    ['422-missing-state', fx9, 'invalid'],
    ['422-state-wrong-type', fx10, 'invalid'],
  ])('classifies %s', (_name, recorded, expected) => {
    expect(classifyJevResponse(recorded)).toBe(expected);
  });
});
