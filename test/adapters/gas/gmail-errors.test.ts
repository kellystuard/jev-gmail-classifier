import { describe, expect, it } from 'vitest';

import { UnexpectedResponseError } from '../../../src/core/errors.ts';
import {
  type GmailExpectedKind,
  type GmailNotFoundKind,
  toGmailFailure,
} from '../../../src/adapters/gas/gmail-errors.ts';

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

// ---- E6: the write half (spikes 25, 26 and 30) ----

/** Any context. It matches the plain overload; the mapper reads every field at run time. */
type Context = {
  readonly method: string;
  readonly notFound?: GmailNotFoundKind;
  readonly expected?: readonly GmailExpectedKind[];
};

/** The contexts exactly as `GasGmailAdapter` passes them. */
const LIST_LABELS = { method: 'listLabels' } as const;
const CREATE_LABEL = {
  method: 'createLabel',
  expected: ['label_exists', 'invalid_label_name'],
} as const;
const MODIFY_THREAD = {
  method: 'modifyThread',
  notFound: 'not_found',
  expected: ['invalid_label', 'failed_precondition'],
} as const;

const WRITE_CONTEXTS: readonly (readonly [string, Context])[] = [
  ['listLabels', LIST_LABELS],
  ['createLabel', CREATE_LABEL],
  ['modifyThread', MODIFY_THREAD],
];

/** The spikes' message form: `API call to gmail.users.<call> failed with error: <text>`. */
function spikeMessage(call: string, text: string): string {
  return `API call to gmail.users.${call} failed with error: ${text}`;
}

/** A spike error with its `details` object. */
function spikeError(call: string, text: string, code: number, reason: string): Error {
  return gmailException(spikeMessage(call, text), {
    code,
    message: text,
    errors: [{ domain: 'global', reason }],
  });
}

// Exact texts from spike 25 (rows 5-7, 9, 13, 14) and spike 26 ("Errors").
const LABEL_EXISTS = 'Label name exists or conflicts';
const INVALID_LABEL_NAME = 'Invalid label name';
const INVALID_LABEL = 'Invalid label: Finance/Bill';
const LABEL_ID_NOT_FOUND = 'labelId not found';
const PRECONDITION = 'Precondition check failed.';

describe('toGmailFailure: scope and rate_limited on the write methods', () => {
  const scopeCases = WRITE_CONTEXTS.flatMap(([name, context]) =>
    SCOPE_FRAGMENTS.map((fragment) => [name, fragment, context] as const),
  );

  it.each(scopeCases)('%s maps "%s" to scope', (_name, fragment, context) => {
    const message = spikeMessage('threads.modify', fragment);
    expect(toGmailFailure(new Error(message), context)).toEqual({
      ok: false,
      kind: 'scope',
      message,
    });
  });

  it.each(WRITE_CONTEXTS)("%s maps spike 30's rate limit to rate_limited", (_name, context) => {
    expect(toGmailFailure(new Error(SPIKE_30_RATE_LIMIT_MESSAGE), context)).toEqual({
      ok: false,
      kind: 'rate_limited',
      message: SPIKE_30_RATE_LIMIT_MESSAGE,
    });
  });

  it.each(WRITE_CONTEXTS)(
    '%s maps a 403 rateLimitExceeded that names a scope fragment to rate_limited',
    (_name, context) => {
      const message = 'Rate Limit Exceeded. Request had insufficient authentication scopes.';
      const error = gmailException(message, {
        code: 403,
        errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }],
      });
      expect(toGmailFailure(error, context)).toEqual({ ok: false, kind: 'rate_limited', message });
    },
  );
});

describe('toGmailFailure: createLabel', () => {
  const cases: readonly (readonly [string, Error, string])[] = [
    ['409 aborted', spikeError('labels.create', LABEL_EXISTS, 409, 'aborted'), 'label_exists'],
    [
      '"Label name exists or conflicts" with no details',
      new Error(spikeMessage('labels.create', LABEL_EXISTS)),
      'label_exists',
    ],
    ['a 409 with no reason', gmailException('conflict', { code: 409 }), 'label_exists'],
    [
      'reason ABORTED with no code',
      gmailException('conflict', { errors: [{ reason: 'ABORTED' }] }),
      'label_exists',
    ],
    [
      '400 "Invalid label name"',
      spikeError('labels.create', INVALID_LABEL_NAME, 400, 'invalidArgument'),
      'invalid_label_name',
    ],
    [
      '"Invalid label name" with no details',
      new Error(spikeMessage('labels.create', INVALID_LABEL_NAME)),
      'invalid_label_name',
    ],
  ];

  it.each(cases)('maps %s to %s with the original message', (_name, error, kind) => {
    expect(toGmailFailure(error, CREATE_LABEL)).toEqual({
      ok: false,
      kind,
      message: error.message,
    });
  });
});

describe('toGmailFailure: modifyThread', () => {
  const cases: readonly (readonly [string, Error, string])[] = [
    [
      '400 "Invalid label: Finance/Bill"',
      spikeError('threads.modify', INVALID_LABEL, 400, 'invalidArgument'),
      'invalid_label',
    ],
    [
      '400 "labelId not found"',
      spikeError('threads.modify', LABEL_ID_NOT_FOUND, 400, 'invalidArgument'),
      'invalid_label',
    ],
    [
      '"Invalid label: Finance/Bill" with no details',
      new Error(spikeMessage('threads.modify', INVALID_LABEL)),
      'invalid_label',
    ],
    [
      '"labelId not found" with no details',
      new Error(spikeMessage('threads.modify', LABEL_ID_NOT_FOUND)),
      'invalid_label',
    ],
    [
      '400 failedPrecondition',
      spikeError('threads.modify', PRECONDITION, 400, 'failedPrecondition'),
      'failed_precondition',
    ],
    [
      '"Precondition check failed." with no details',
      new Error(spikeMessage('threads.modify', PRECONDITION)),
      'failed_precondition',
    ],
  ];

  it.each(cases)('maps %s to %s with the original message', (_name, error, kind) => {
    expect(toGmailFailure(error, MODIFY_THREAD)).toEqual({
      ok: false,
      kind,
      message: error.message,
    });
  });

  it('maps a 404 to not_found, with its details or by its message alone', () => {
    const message = spikeMessage('threads.modify', 'Requested entity was not found.');
    expect(toGmailFailure(gmailException(message, SPIKE_62_404_DETAILS), MODIFY_THREAD)).toEqual({
      ok: false,
      kind: 'not_found',
    });
    expect(toGmailFailure(new Error(message), MODIFY_THREAD)).toEqual({
      ok: false,
      kind: 'not_found',
    });
  });
});

describe('toGmailFailure: no leaks between methods', () => {
  const conflict = (call: string): Error => spikeError(call, LABEL_EXISTS, 409, 'aborted');
  const notFound = gmailException(SPIKE_62_404_MESSAGE, SPIKE_62_404_DETAILS);
  const cases: readonly (readonly [string, Context, Error])[] = [
    [
      'createLabel given "Invalid label: X"',
      CREATE_LABEL,
      spikeError('labels.create', 'Invalid label: X', 400, 'invalidArgument'),
    ],
    [
      'createLabel given "Precondition check failed."',
      CREATE_LABEL,
      spikeError('labels.create', PRECONDITION, 400, 'failedPrecondition'),
    ],
    [
      'createLabel given "Precondition check failed." with no details',
      CREATE_LABEL,
      new Error(spikeMessage('labels.create', PRECONDITION)),
    ],
    ['createLabel given a 404', CREATE_LABEL, notFound],
    ['modifyThread given a 409', MODIFY_THREAD, conflict('threads.modify')],
    [
      'modifyThread given "Label name exists or conflicts" with no details',
      MODIFY_THREAD,
      new Error(spikeMessage('threads.modify', LABEL_EXISTS)),
    ],
    ['listLabels given a 404', LIST_LABELS, notFound],
    ['listLabels given a 409', LIST_LABELS, conflict('labels.list')],
    [
      'listLabels given "Invalid label: X"',
      LIST_LABELS,
      spikeError('labels.list', 'Invalid label: X', 400, 'invalidArgument'),
    ],
    ['getProfile given a 409', { method: 'getProfile' }, conflict('getProfile')],
    [
      'listHistory given a 409',
      { method: 'listHistory', notFound: 'history_expired' },
      conflict('history.list'),
    ],
    ['searchThreadIds given a 409', { method: 'searchThreadIds' }, conflict('threads.list')],
    [
      'getThread given a 409',
      { method: 'getThread', notFound: 'not_found' },
      conflict('threads.get'),
    ],
  ];

  it.each(cases)('%s throws UnexpectedResponseError', (_name, context, error) => {
    const thrown = caught(() => toGmailFailure(error, context));
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({
      service: 'gmail',
      reason: `${context.method} failed`,
      cause: error,
    });
  });
});

describe('toGmailFailure: still unexpected on the write methods', () => {
  const cases: readonly (readonly [string, Context, Error, number])[] = [
    [
      'modifyThread, a 400 invalidArgument "Invalid id value"',
      MODIFY_THREAD,
      spikeError('threads.modify', 'Invalid id value', 400, 'invalidArgument'),
      400,
    ],
    ...WRITE_CONTEXTS.map(
      ([name, context]) =>
        [
          `${name}, a 500`,
          context,
          spikeError('labels.list', 'Backend Error', 500, 'backendError'),
          500,
        ] as const,
    ),
  ];

  it.each(cases)('%s throws UnexpectedResponseError', (_name, context, error, status) => {
    const thrown = caught(() => toGmailFailure(error, context));
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    if (!(thrown instanceof UnexpectedResponseError)) {
      return;
    }
    expect(thrown.service).toBe('gmail');
    expect(thrown.status).toBe(status);
    expect(thrown.reason).toBe(`${context.method} failed`);
    expect(thrown.message).toBe(`Gmail ${context.method} failed: ${error.message}`);
    expect(thrown.cause).toBe(error);
  });
});
