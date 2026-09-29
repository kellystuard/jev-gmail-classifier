import { describe, expect, it } from 'vitest';

import { UnexpectedResponseError } from '../../../src/core/errors.ts';
import { toGmailFailure } from '../../../src/adapters/gas/gmail-errors.ts';

/** Builds what the Advanced Service throws: an `Error` with a `details` property. */
function gmailException(message: string, details?: object): Error {
  const error = new Error(message);
  if (details !== undefined) {
    Object.assign(error, { details });
  }
  return error;
}

// Exact texts and shapes from the spikes.
const SPIKE_62_404_MESSAGE =
  'API call to gmail.users.history.list failed with error: Requested entity was not found.';
const SPIKE_62_404_DETAILS = {
  code: 404,
  message: 'Requested entity was not found.',
  errors: [{ reason: 'notFound', domain: 'global' }],
};
const SPIKE_30_RATE_LIMIT_MESSAGE =
  "API call to gmail.users.threads.get failed with error: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:<project-number>'.";

const SCOPE_FRAGMENTS = [
  'Authorization is required to perform that action',
  'insufficient authentication scopes',
  'Specified permissions are not sufficient',
];

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('toGmailFailure: scope', () => {
  const cases = SCOPE_FRAGMENTS.flatMap((fragment) => [
    [`${fragment} (verbatim)`, `API call to gmail.users.getProfile failed with error: ${fragment}`],
    [`${fragment} (upper case)`, `Exception: ${fragment.toUpperCase()}.`],
    [`${fragment} (lower case)`, fragment.toLowerCase()],
  ]);

  it.each(cases)('%s maps to scope with the original message', (_name, message) => {
    expect(toGmailFailure(new Error(message), { method: 'getProfile' })).toEqual({
      ok: false,
      kind: 'scope',
      message,
    });
  });

  it('maps a scope error with a details object too', () => {
    const message = 'Request had insufficient authentication scopes.';
    const error = gmailException(message, {
      code: 403,
      errors: [{ reason: 'insufficientPermissions' }],
    });
    expect(toGmailFailure(error, { method: 'listHistory', notFound: 'history_expired' })).toEqual({
      ok: false,
      kind: 'scope',
      message,
    });
  });
});

describe('toGmailFailure: rate_limited', () => {
  const cases: readonly [string, Error][] = [
    ["spike 30's exact message, with no details", new Error(SPIKE_30_RATE_LIMIT_MESSAGE)],
    [
      '403 rateLimitExceeded',
      gmailException('API call failed with error: Rate Limit Exceeded', {
        code: 403,
        errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }],
      }),
    ],
    [
      '403 userRateLimitExceeded',
      gmailException('API call failed with error: User-rate limit exceeded', {
        code: 403,
        errors: [{ reason: 'userRateLimitExceeded', domain: 'usageLimits' }],
      }),
    ],
    [
      'a second error carrying the reason',
      gmailException('API call failed with error: Rate Limit Exceeded', {
        code: 403,
        errors: [{ reason: 'other' }, { reason: 'rateLimitExceeded' }],
      }),
    ],
    [
      '429',
      gmailException('API call failed with error: Too Many Requests', {
        code: 429,
        errors: [],
      }),
    ],
    ['the message in another case', new Error('QUOTA EXCEEDED: units per minute per user')],
  ];

  it.each(cases)('%s maps to rate_limited with the original message', (_name, error) => {
    expect(toGmailFailure(error, { method: 'getThread' })).toEqual({
      ok: false,
      kind: 'rate_limited',
      message: error.message,
    });
  });

  it('is rate_limited, not scope, when a 403 rateLimitExceeded also names a scope fragment', () => {
    const message = 'Rate Limit Exceeded. Specified permissions are not sufficient.';
    const error = gmailException(message, {
      code: 403,
      errors: [{ reason: 'rateLimitExceeded' }],
    });
    expect(toGmailFailure(error, { method: 'getProfile' })).toEqual({
      ok: false,
      kind: 'rate_limited',
      message,
    });
  });

  it('is rate_limited, not scope, when the message has both a scope fragment and the quota name', () => {
    const message = `insufficient authentication scopes. ${SPIKE_30_RATE_LIMIT_MESSAGE}`;
    expect(toGmailFailure(new Error(message), { method: 'getProfile' })).toMatchObject({
      kind: 'rate_limited',
    });
  });
});

describe('toGmailFailure: 404', () => {
  const inputs: readonly [string, Error][] = [
    [
      "spike 62's exact message and details",
      gmailException(SPIKE_62_404_MESSAGE, SPIKE_62_404_DETAILS),
    ],
    ['the message with no details', new Error(SPIKE_62_404_MESSAGE)],
    [
      'details.code 404 whatever the message says',
      gmailException('API call to gmail.users.threads.get failed with error: gone', { code: 404 }),
    ],
  ];

  it.each(inputs)('%s maps to history_expired with notFound: history_expired', (_name, error) => {
    expect(toGmailFailure(error, { method: 'listHistory', notFound: 'history_expired' })).toEqual({
      ok: false,
      kind: 'history_expired',
    });
  });

  it.each(inputs)('%s maps to not_found with notFound: not_found', (_name, error) => {
    expect(toGmailFailure(error, { method: 'getThread', notFound: 'not_found' })).toEqual({
      ok: false,
      kind: 'not_found',
    });
  });

  it.each(inputs)('%s throws UnexpectedResponseError with no notFound', (_name, error) => {
    const thrown = caught(() => toGmailFailure(error, { method: 'getProfile' }));
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({ service: 'gmail', reason: 'getProfile failed', cause: error });
  });

  it('does not treat a message that only mentions the text as a 404 when details say otherwise', () => {
    const error = gmailException(SPIKE_62_404_MESSAGE, { code: 500 });
    const thrown = caught(() =>
      toGmailFailure(error, { method: 'listHistory', notFound: 'history_expired' }),
    );
    expect(thrown).toMatchObject({ status: 500 });
  });
});

describe('toGmailFailure: unexpected', () => {
  const invalid = gmailException(
    'API call to gmail.users.history.list failed with error: Invalid value at start_history_id',
    { code: 400, message: 'Invalid value', errors: [{ reason: 'invalid', domain: 'global' }] },
  );
  const serverError = gmailException(
    'API call to gmail.users.history.list failed with error: Backend Error',
    { code: 500, errors: [{ reason: 'backendError', domain: 'global' }] },
  );
  const plain = new Error('Something nobody has seen before');

  const cases: readonly [string, unknown, number | undefined, string][] = [
    ['a 400 invalid', invalid, 400, invalid.message],
    ['a 500', serverError, 500, serverError.message],
    ['a plain Error with an unknown message', plain, undefined, plain.message],
    ['a thrown string', 'boom', undefined, 'boom'],
  ];

  it.each(cases)('%s throws UnexpectedResponseError', (_name, error, status, message) => {
    const thrown = caught(() =>
      toGmailFailure(error, { method: 'listHistory', notFound: 'history_expired' }),
    );
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    if (!(thrown instanceof UnexpectedResponseError)) {
      return;
    }
    expect(thrown.service).toBe('gmail');
    expect(thrown.status).toBe(status);
    expect(thrown.reason).toBe('listHistory failed');
    expect(thrown.message).toBe(`Gmail listHistory failed: ${message}`);
    expect(thrown.cause).toBe(error);
  });

  it('ignores a non-numeric details.code', () => {
    const error = gmailException('odd', { code: '404' });
    const thrown = caught(() =>
      toGmailFailure(error, { method: 'listHistory', notFound: 'history_expired' }),
    );
    expect(thrown).toMatchObject({ service: 'gmail' });
    expect(thrown).not.toHaveProperty('status', '404');
  });
});

describe('toGmailFailure: searchThreadIds and getThread', () => {
  const NOT_FOUND_GET =
    'API call to gmail.users.threads.get failed with error: Requested entity was not found.';
  const NOT_FOUND_LIST =
    'API call to gmail.users.threads.list failed with error: Requested entity was not found.';
  const searchOptions = { method: 'searchThreadIds' } as const;
  const getOptions = { method: 'getThread', notFound: 'not_found' } as const;

  it('maps a getThread 404 to not_found, with its details or by its message alone', () => {
    expect(toGmailFailure(gmailException(NOT_FOUND_GET, SPIKE_62_404_DETAILS), getOptions)).toEqual(
      { ok: false, kind: 'not_found' },
    );
    expect(toGmailFailure(new Error(NOT_FOUND_GET), getOptions)).toEqual({
      ok: false,
      kind: 'not_found',
    });
  });

  it('throws UnexpectedResponseError for a searchThreadIds 404, with the status when known', () => {
    const withDetails = gmailException(NOT_FOUND_LIST, SPIKE_62_404_DETAILS);
    const thrown = caught(() => toGmailFailure(withDetails, searchOptions));
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({
      service: 'gmail',
      status: 404,
      reason: 'searchThreadIds failed',
      cause: withDetails,
    });
    const plain = new Error(NOT_FOUND_LIST);
    expect(caught(() => toGmailFailure(plain, searchOptions))).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it.each([searchOptions, getOptions])(
    'maps the rate limit the same way for $method',
    (options) => {
      expect(toGmailFailure(new Error(SPIKE_30_RATE_LIMIT_MESSAGE), options)).toEqual({
        ok: false,
        kind: 'rate_limited',
        message: SPIKE_30_RATE_LIMIT_MESSAGE,
      });
      const error = gmailException('API call failed with error: Rate Limit Exceeded', {
        code: 403,
        errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }],
      });
      expect(toGmailFailure(error, options)).toMatchObject({ ok: false, kind: 'rate_limited' });
    },
  );

  const scopeCases = SCOPE_FRAGMENTS.flatMap((fragment) => [
    ['searchThreadIds', searchOptions, fragment] as const,
    ['getThread', getOptions, fragment] as const,
  ]);
  it.each(scopeCases)('maps a scope fragment to scope for %s: %s', (_method, options, fragment) => {
    const message = `API call to gmail.users.threads.x failed with error: ${fragment}`;
    expect(toGmailFailure(new Error(message), options)).toEqual({
      ok: false,
      kind: 'scope',
      message,
    });
  });

  it('throws UnexpectedResponseError for a malformed thread ID (400), with the status', () => {
    const error = gmailException(
      'API call to gmail.users.threads.get failed with error: Invalid id value',
      {
        code: 400,
        message: 'Invalid id value',
        errors: [{ reason: 'invalidArgument', domain: 'global' }],
      },
    );
    const thrown = caught(() => toGmailFailure(error, getOptions));
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({ service: 'gmail', status: 400, reason: 'getThread failed' });
  });

  it('puts no query text in the error or its fields for an unrecognized search failure', () => {
    const error = gmailException(
      'API call to gmail.users.threads.list failed with error: Invalid Value',
      { code: 400, message: 'Invalid Value', errors: [{ reason: 'invalid', domain: 'global' }] },
    );
    const thrown = caught(() => toGmailFailure(error, searchOptions));
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    if (!(thrown instanceof UnexpectedResponseError)) {
      return;
    }
    expect(thrown).toMatchObject({
      service: 'gmail',
      status: 400,
      reason: 'searchThreadIds failed',
    });
    // The mapping never receives `q`, so nothing it builds can hold it.
    expect(Object.keys(thrown.fields).sort()).toEqual(['reason', 'service', 'status']);
  });
});
