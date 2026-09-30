import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../src/core/errors.ts';
import { buildRequest, JEV_ENDPOINT } from '../../src/core/jev-request.ts';
import type { BuildRequestOptions } from '../../src/core/jev-request.ts';
import type { JevStateMessage } from '../../src/core/jev-state.ts';

const exampleRules = [
  { id: 'approval', question: 'Does this email ask the recipient to approve something?' },
  { id: 'bill', question: 'Is this email a bill or invoice?' },
  { id: 'newsletter', question: 'Is this email a newsletter the recipient subscribed to?' },
  { id: 'shipping', question: 'Is this email only a shipping or delivery notification?' },
];

const state: readonly JevStateMessage[] = [
  { from: 'a@example.com', subject: 'Hi', body: 'Second' },
  { from: 'b@example.com', body: 'First' },
];

/** The longest id the schema allows: 32 characters, with `-` and `_`. */
const longId = `a${'-_'.repeat(15)}z`;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function options(rules: BuildRequestOptions['rules'], model = 'jev-latest'): BuildRequestOptions {
  return { model, rules };
}

function thrownBy(fn: () => unknown): InvalidArgumentError {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an InvalidArgumentError');
}

describe('JEV_ENDPOINT', () => {
  it('is the systemone URL', () => {
    expect(JEV_ENDPOINT).toBe('https://api.typesafe.ai/v1/systemone');
  });
});

describe('buildRequest', () => {
  it.each([
    ['one rule', exampleRules.slice(0, 1)],
    ['four rules', exampleRules],
  ])('makes a noul question per rule, keyed by id (%s)', (_name, rules) => {
    const body = buildRequest(options(rules), state);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe(state);
    expect(Object.keys(body.questions)).toEqual(rules.map((r) => r.id));
    for (const rule of rules) {
      expect(body.questions[rule.id]).toEqual({ type: 'noul', instructions: rule.question });
    }
  });

  it('serializes with a pinned key order', () => {
    const body = buildRequest(options(exampleRules.slice(0, 2), 'jev-1'), [
      { from: 'a@example.com', body: 'Hello' },
    ]);
    expect(JSON.stringify(body)).toBe(
      '{"model":"jev-1","state":[{"from":"a@example.com","body":"Hello"}],"questions":{' +
        '"approval":{"type":"noul","instructions":"Does this email ask the recipient to approve something?"},' +
        '"bill":{"type":"noul","instructions":"Is this email a bill or invoice?"}}}',
    );
  });

  it('accepts a state of one empty message', () => {
    const body = buildRequest(options(exampleRules), [{}]);
    expect(body.state).toEqual([{}]);
  });

  it('does not mutate deep-frozen inputs', () => {
    const frozenOptions = deepFreeze({ model: 'jev-latest', rules: structuredClone(exampleRules) });
    const frozenState = deepFreeze(structuredClone([...state]));
    expect(() => buildRequest(frozenOptions, frozenState)).not.toThrow();
  });

  it.each([['a'], [longId], ['constructor']])('accepts the rule id %s as a plain own key', (id) => {
    const body = buildRequest(options([{ id, question: 'Q?' }]), state);
    expect(Object.keys(body.questions)).toEqual([id]);
    expect(Object.getOwnPropertyNames(body.questions)).toEqual([id]);
    expect(body.questions[id]).toEqual({ type: 'noul', instructions: 'Q?' });
  });

  const secret = 'SECRET QUESTION TEXT';
  it.each<[string, BuildRequestOptions, readonly JevStateMessage[], string, string]>([
    ['no rules', options([]), state, 'rules', 'empty'],
    [
      'a duplicate id',
      options([
        { id: 'a', question: secret },
        { id: 'a', question: secret },
      ]),
      state,
      'rules',
      'duplicate_id',
    ],
    ['a blank model', options([{ id: 'a', question: secret }], '  '), state, 'model', 'blank'],
    ['an empty state', options([{ id: 'a', question: secret }]), [], 'state', 'empty'],
  ])('throws InvalidArgumentError for %s', (_name, opts, st, argument, reason) => {
    const error = thrownBy(() => buildRequest(opts, st));
    expect(error.argument).toBe(argument);
    expect(error.reason).toBe(reason);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toLogFields())).not.toContain(secret);
  });
});
