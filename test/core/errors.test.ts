import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  InvalidArgumentError,
  JevClassifierError,
  RunAbortError,
  StateError,
  ThreadProcessingError,
  UnexpectedResponseError,
} from '../../src/core/errors.ts';
import { fail } from '../../src/core/result.ts';

type ErrorClass = abstract new (...args: never[]) => JevClassifierError;

const cases: readonly [string, () => JevClassifierError, ErrorClass][] = [
  ['JevClassifierError', () => new JevClassifierError('base'), JevClassifierError],
  [
    'ConfigError',
    () => new ConfigError([{ path: 'rules[0].id', message: 'Required' }]),
    ConfigError,
  ],
  ['StateError', () => new StateError('bad', { key: 'state.queue', reason: 'parse' }), StateError],
  [
    'UnexpectedResponseError',
    () => new UnexpectedResponseError('odd', { service: 'jev', reason: 'missing answer' }),
    UnexpectedResponseError,
  ],
  [
    'ThreadProcessingError',
    () => new ThreadProcessingError('failed', { threadId: 't1', failure: fail('invalid') }),
    ThreadProcessingError,
  ],
  ['RunAbortError', () => new RunAbortError('401', { reason: 'auth' }), RunAbortError],
  [
    'InvalidArgumentError',
    () => new InvalidArgumentError('bad', { argument: 'reservedTokens', reason: 'negative' }),
    InvalidArgumentError,
  ],
];

describe.each(cases)('%s', (name, make, cls) => {
  it('is an instance of itself, JevClassifierError and Error', () => {
    const error = make();
    expect(error).toBeInstanceOf(cls);
    expect(error).toBeInstanceOf(JevClassifierError);
    expect(error).toBeInstanceOf(Error);
  });

  it('has its own name', () => {
    expect(make().name).toBe(name);
  });

  it('logs flat, JSON-safe fields with its name and message', () => {
    const error = make();
    const fields = error.toLogFields();
    expect(fields).toMatchObject({ error: name, errorMessage: error.message });
    expect(JSON.parse(JSON.stringify(fields))).toEqual(fields);
    expect(fields).not.toHaveProperty('stack');
    expect(fields).not.toHaveProperty('cause');
  });
});

describe('JevClassifierError', () => {
  it('logs its fields', () => {
    const error = new JevClassifierError('boom', { threadId: 't1', probabilities: { a: 0.5 } });
    expect(error.toLogFields()).toEqual({
      threadId: 't1',
      probabilities: { a: 0.5 },
      error: 'JevClassifierError',
      errorMessage: 'boom',
    });
  });

  it('logs the name and message of an Error cause', () => {
    const cause = new TypeError('bad input');
    const error = new JevClassifierError('wrapped', {}, { cause });
    expect(error.cause).toBe(cause);
    expect(error.toLogFields()['cause']).toBe('TypeError: bad input');
  });

  it('logs a non-Error cause as a string', () => {
    const error = new JevClassifierError('wrapped', {}, { cause: 'timeout' });
    expect(error.toLogFields()['cause']).toBe('timeout');
  });

  it('keeps the reserved keys when a field has the same name', () => {
    const error = new JevClassifierError('real', { error: 'x', errorMessage: 'y', cause: 'z' });
    expect(error.toLogFields()).toEqual({
      error: 'JevClassifierError',
      errorMessage: 'real',
      cause: 'z',
    });
  });
});

describe('ConfigError', () => {
  const issues = [
    { path: 'rules[2].threshold', message: 'Number must be less than or equal to 1' },
    { path: 'excludeQuery', message: 'Required' },
    { path: '', message: 'Unrecognized key: "extra"' },
  ];

  it('lists every issue in its message, one per line', () => {
    expect(new ConfigError(issues).message).toBe(
      [
        'Invalid config:',
        'rules[2].threshold: Number must be less than or equal to 1',
        'excludeQuery: Required',
        '(root): Unrecognized key: "extra"',
      ].join('\n'),
    );
  });

  it('keeps the issues and logs them as lines', () => {
    const error = new ConfigError(issues);
    expect(error.issues).toEqual(issues);
    expect(error.toLogFields()['issues']).toEqual([
      'rules[2].threshold: Number must be less than or equal to 1',
      'excludeQuery: Required',
      '(root): Unrecognized key: "extra"',
    ]);
  });
});

describe('StateError', () => {
  it('logs its typed fields and leaves out undefined ones', () => {
    const error = new StateError('too big', {
      key: 'state.queue',
      reason: 'too_large',
      bytes: 9300,
      limit: 9216,
    });
    expect(error.reason).toBe('too_large');
    expect(error.version).toBeUndefined();
    expect(error.toLogFields()).toEqual({
      key: 'state.queue',
      reason: 'too_large',
      bytes: 9300,
      limit: 9216,
      error: 'StateError',
      errorMessage: 'too big',
    });
  });
});

describe('StateError missing', () => {
  it('names a required key that is absent', () => {
    const error = new StateError('State state.position is missing', {
      key: 'state.position',
      reason: 'missing',
    });
    expect(error.reason).toBe('missing');
    expect(error.toLogFields()).toEqual({
      key: 'state.position',
      reason: 'missing',
      error: 'StateError',
      errorMessage: 'State state.position is missing',
    });
  });
});

describe('UnexpectedResponseError', () => {
  it('logs its typed fields and the cause', () => {
    const error = new UnexpectedResponseError(
      'Malformed 200 from Jev',
      { service: 'jev', status: 200, requestId: 'req_1', reason: 'answers missing' },
      { cause: new SyntaxError('Unexpected token') },
    );
    expect(error.status).toBe(200);
    expect(error.toLogFields()).toEqual({
      service: 'jev',
      status: 200,
      requestId: 'req_1',
      reason: 'answers missing',
      error: 'UnexpectedResponseError',
      errorMessage: 'Malformed 200 from Jev',
      cause: 'SyntaxError: Unexpected token',
    });
  });
});

describe('ThreadProcessingError', () => {
  it('carries the failed result and logs its fields without ok', () => {
    const failure = fail('invalid', { status: 422, requestId: 'req_2' });
    const error = new ThreadProcessingError('Jev rejected the thread', {
      threadId: 't9',
      failure,
    });
    expect(error.threadId).toBe('t9');
    expect(error.failure).toBe(failure);
    expect(error.toLogFields()).toEqual({
      kind: 'invalid',
      status: 422,
      requestId: 'req_2',
      threadId: 't9',
      error: 'ThreadProcessingError',
      errorMessage: 'Jev rejected the thread',
    });
  });
});

describe('RunAbortError', () => {
  it('logs its reason', () => {
    const error = new RunAbortError('No API key', { reason: 'missing_key' });
    expect(error.reason).toBe('missing_key');
    expect(error.toLogFields()).toEqual({
      reason: 'missing_key',
      error: 'RunAbortError',
      errorMessage: 'No API key',
    });
  });
});
