import { describe, expect, it } from 'vitest';

import { saveManualJob } from '../../src/app/manual-job-store.ts';
import { InvalidArgumentError, StateError } from '../../src/core/errors.ts';
import {
  MANUAL_JOB_QUERY_MAX_CHARS,
  MANUAL_KEY,
  MANUAL_PAGE_TOKEN_MAX_CHARS,
  type ManualJob,
  type ManualJobCounts,
  advanceCursor,
  countExecution,
  decodeManualJob,
  dropPageToken,
  encodeManualJob,
  isStorablePageToken,
  manualJobReservedBytes,
  needsCursorWalk,
  newManualJob,
  restoreCursor,
} from '../../src/core/manual-job.ts';
import { STATE_VALUE_MAX_BYTES, utf8ByteLength } from '../../src/core/state-limits.ts';
import { FakeState } from '../fakes/fake-state.ts';

const MAX = Number.MAX_SAFE_INTEGER;
const FIELD_ORDER = [
  'v',
  'query',
  'applyMoves',
  'startedAt',
  'cursor',
  'searchDone',
  'executions',
  'counts',
  'labels',
  'moves',
  'otherLabels',
  'otherMoves',
];
const COUNT_ORDER = [
  'pages',
  'queued',
  'merged',
  'chunks',
  'excluded',
  'skipped',
  'sent',
  'classified',
  'struck',
  'errored',
  'gone',
  'inputTokens',
];

function fresh(query = 'label:Receipts'): ManualJob {
  return newManualJob({ query, applyMoves: false, startedAt: 1_700_000_000_000 });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

type Raw = {
  v?: unknown;
  query?: unknown;
  applyMoves?: unknown;
  startedAt?: unknown;
  cursor: { seen?: unknown; pageToken?: unknown; extra?: unknown };
  searchDone?: unknown;
  executions?: unknown;
  counts: Record<string, unknown>;
  labels?: unknown;
  moves?: unknown;
  otherLabels?: unknown;
  otherMoves?: unknown;
  extra?: unknown;
};

/** A stored job as plain data, to break one field at a time. */
function stored(): Raw {
  return {
    v: 1,
    query: 'label:x',
    applyMoves: false,
    startedAt: 1,
    cursor: { seen: 0 },
    searchDone: false,
    executions: 0,
    counts: Object.fromEntries(COUNT_ORDER.map((key) => [key, 0])),
    labels: {},
    moves: {},
    otherLabels: 0,
    otherMoves: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return Object.fromEntries(Object.entries(value));
}

function allCounts(n: number): ManualJobCounts {
  return {
    pages: n,
    queued: n,
    merged: n,
    chunks: n,
    excluded: n,
    skipped: n,
    sent: n,
    classified: n,
    struck: n,
    errored: n,
    gone: n,
    inputTokens: n,
  };
}

function allKeys(map: Readonly<Record<string, number>>, n: number): Record<string, number> {
  return Object.fromEntries(Object.keys(map).map((key) => [key, n]));
}

function roundTrip(job: ManualJob): ManualJob {
  return decodeManualJob(JSON.parse(JSON.stringify(encodeManualJob(job))));
}

function withKeys(job: ManualJob, keys: readonly string[]): ManualJob {
  return {
    ...job,
    labels: Object.fromEntries(keys.map((k, i) => [k, i + 1])),
    moves: Object.fromEntries(keys.map((k, i) => [`label:${k}`, i + 1])),
  };
}

describe('MANUAL_KEY', () => {
  it('is state.manual', () => {
    expect(MANUAL_KEY).toBe('state.manual');
  });
});

describe('the codec round trip', () => {
  const page = { idsOnPage: 100, queued: 90, merged: 10 };
  const jobs: [string, ManualJob][] = [
    ['a new job', fresh()],
    ['a job with a token', advanceCursor(fresh(), { ...page, nextPageToken: 'abc123' })],
    [
      'a finished search',
      advanceCursor(advanceCursor(fresh(), { ...page, nextPageToken: 'abc123' }), {
        idsOnPage: 3,
        queued: 3,
        merged: 0,
      }),
    ],
    [
      'filled maps',
      withKeys(fresh(), [
        'constructor',
        'toString',
        'hasOwnProperty',
        '__proto__',
        'Clients/Ünï/日本',
      ]),
    ],
  ];

  it.each(jobs)('round-trips %s', (_name, job) => {
    const decoded = roundTrip(job);
    expect(decoded).toEqual(job);
    expect(JSON.stringify(encodeManualJob(decoded))).toBe(JSON.stringify(encodeManualJob(job)));
  });

  it('writes the fields in the stored order, v first, and leaves an absent token out', () => {
    const encoded = asRecord(encodeManualJob(fresh()));
    expect(Object.keys(encoded)).toEqual(FIELD_ORDER);
    expect(encoded['v']).toBe(1);
    expect(Object.keys(asRecord(encoded['cursor']))).toEqual(['seen']);
    expect(Object.keys(asRecord(encoded['counts']))).toEqual(COUNT_ORDER);
    const withToken = advanceCursor(fresh(), {
      idsOnPage: 1,
      queued: 1,
      merged: 0,
      nextPageToken: 't',
    });
    const tokenCursor = asRecord(asRecord(encodeManualJob(withToken))['cursor']);
    expect(Object.keys(tokenCursor)).toEqual(['seen', 'pageToken']);
  });

  it('orders the fields itself, whatever order the given object has', () => {
    const job = fresh();
    const shuffled: ManualJob = {
      otherMoves: job.otherMoves,
      moves: job.moves,
      labels: job.labels,
      counts: job.counts,
      executions: job.executions,
      searchDone: job.searchDone,
      cursor: job.cursor,
      startedAt: job.startedAt,
      applyMoves: job.applyMoves,
      query: job.query,
      otherLabels: job.otherLabels,
    };
    expect(JSON.stringify(encodeManualJob(shuffled))).toBe(JSON.stringify(encodeManualJob(job)));
  });

  it('keeps map keys in insertion order', () => {
    const job = withKeys(fresh(), ['b', 'a', 'c']);
    expect(Object.keys(roundTrip(job).labels)).toEqual(['b', 'a', 'c']);
  });

  it('keeps keys named like Object.prototype members as own keys', () => {
    const keys = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];
    const decoded = roundTrip(withKeys(fresh(), keys));
    for (const map of [decoded.labels, decoded.moves]) {
      const own = Object.keys(map).map((k) => k.replace(/^label:/, ''));
      expect(own).toEqual(keys);
      expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    }
    expect(Object.getOwnPropertyDescriptor(decoded.labels, '__proto__')?.value).toBe(4);
    const probe: Record<string, unknown> = {};
    expect(Object.keys(probe)).toEqual([]);
    expect(probe['polluted']).toBeUndefined();
  });
});

describe('decoding refuses', () => {
  function decodeFails(raw: unknown, reason: 'schema' | 'version'): StateError {
    try {
      decodeManualJob(raw);
    } catch (error) {
      if (!(error instanceof StateError)) {
        throw error;
      }
      expect(error.reason).toBe(reason);
      return error;
    }
    throw new Error('expected decode to throw');
  }

  function mutated(change: (value: Raw) => void): Raw {
    const value = stored();
    change(value);
    return value;
  }

  it('an unknown v', () => {
    decodeFails(
      mutated((v) => {
        v.v = 2;
      }),
      'version',
    );
  });

  it('a missing v', () => {
    decodeFails(
      mutated((v) => {
        delete v.v;
      }),
      'schema',
    );
  });

  const schemaCases: [string, (value: Raw) => void][] = [
    [
      'an extra top-level key',
      (v) => {
        v.extra = 1;
      },
    ],
    [
      'an extra cursor key',
      (v) => {
        v.cursor.extra = 1;
      },
    ],
    [
      'an extra counts key',
      (v) => {
        v.counts['extra'] = 1;
      },
    ],
    [
      'a negative number',
      (v) => {
        v.executions = -1;
      },
    ],
    [
      'a fractional number',
      (v) => {
        v.counts['sent'] = 1.5;
      },
    ],
    [
      'an unsafe number',
      (v) => {
        v.startedAt = 2 ** 53;
      },
    ],
    [
      'a negative map value',
      (v) => {
        v.labels = { a: -1 };
      },
    ],
    [
      'a fractional map value',
      (v) => {
        v.moves = { archive: 0.5 };
      },
    ],
    [
      'an empty map key',
      (v) => {
        v.labels = { '': 1 };
      },
    ],
    [
      'a map that is an array',
      (v) => {
        v.labels = [];
      },
    ],
    [
      'an empty query',
      (v) => {
        v.query = '';
      },
    ],
    [
      'an over-long query',
      (v) => {
        v.query = 'q'.repeat(MANUAL_JOB_QUERY_MAX_CHARS + 1);
      },
    ],
    [
      'an empty pageToken',
      (v) => {
        v.cursor.pageToken = '';
      },
    ],
    [
      'an over-long pageToken',
      (v) => {
        v.cursor.pageToken = 'a'.repeat(MANUAL_PAGE_TOKEN_MAX_CHARS + 1);
      },
    ],
    [
      'a non-ASCII pageToken',
      (v) => {
        v.cursor.pageToken = 'tokén';
      },
    ],
    [
      'a pageToken with a quote',
      (v) => {
        v.cursor.pageToken = 'a"b';
      },
    ],
    [
      'a pageToken with a backslash',
      (v) => {
        v.cursor.pageToken = 'a\\b';
      },
    ],
    [
      'a pageToken with a space',
      (v) => {
        v.cursor.pageToken = 'a b';
      },
    ],
    [
      'searchDone with a token',
      (v) => {
        v.searchDone = true;
        v.cursor.pageToken = 'abc';
      },
    ],
  ];

  it.each(schemaCases)('%s', (_name, change) => {
    decodeFails(mutated(change), 'schema');
  });

  it('a value that is not an object', () => {
    decodeFails('x', 'schema');
    decodeFails(null, 'schema');
  });

  it('never puts the query or the token in the error', () => {
    const secret = 'SECRET-QUERY-TEXT';
    const token = 'SECRET-TOKEN"x';
    const raw = mutated((v) => {
      v.query = secret;
      v.cursor.pageToken = token;
      v.extra = secret;
    });
    const error = decodeFails(raw, 'schema');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(error.toLogFields())).not.toContain('SECRET');
  });
});

describe('isStorablePageToken', () => {
  it.each([
    ['abc-DEF_123/+=', true],
    ['~!#[]', true],
    ['', false],
    ['a"b', false],
    ['a\\b', false],
    ['a b', false],
    ['é', false],
    ['a'.repeat(MANUAL_PAGE_TOKEN_MAX_CHARS), true],
    ['a'.repeat(MANUAL_PAGE_TOKEN_MAX_CHARS + 1), false],
  ])('%j -> %s', (token, expected) => {
    expect(isStorablePageToken(token)).toBe(expected);
  });
});

describe('newManualJob', () => {
  it('starts at the beginning with everything at 0', () => {
    const job = fresh();
    expect(job.cursor).toEqual({ seen: 0 });
    expect(job.searchDone).toBe(false);
    expect(job.executions).toBe(0);
    expect(Object.values(job.counts)).toEqual(Array<number>(12).fill(0));
    expect(job.labels).toEqual({});
    expect(job.moves).toEqual({});
    expect(job.otherLabels).toBe(0);
    expect(job.otherMoves).toBe(0);
    expect(job.applyMoves).toBe(false);
    expect(job.startedAt).toBe(1_700_000_000_000);
  });

  it.each([
    ['an empty query', { query: '', applyMoves: false, startedAt: 1 }],
    [
      'an over-long query',
      { query: 'q'.repeat(MANUAL_JOB_QUERY_MAX_CHARS + 1), applyMoves: false, startedAt: 1 },
    ],
    ['a negative startedAt', { query: 'q', applyMoves: false, startedAt: -1 }],
    ['a fractional startedAt', { query: 'q', applyMoves: false, startedAt: 1.5 }],
    ['an unsafe startedAt', { query: 'q', applyMoves: false, startedAt: 2 ** 53 }],
    ['a NaN startedAt', { query: 'q', applyMoves: false, startedAt: Number.NaN }],
  ])('throws for %s', (_name, input) => {
    expect(() => newManualJob(input)).toThrow(InvalidArgumentError);
  });

  it('accepts the longest query', () => {
    expect(() => fresh('q'.repeat(MANUAL_JOB_QUERY_MAX_CHARS))).not.toThrow();
  });
});

describe('advanceCursor', () => {
  it('adds a page with a next token', () => {
    const job = advanceCursor(fresh(), {
      idsOnPage: 100,
      queued: 80,
      merged: 20,
      nextPageToken: 'next1',
    });
    expect(job.cursor).toEqual({ seen: 100, pageToken: 'next1' });
    expect(job.searchDone).toBe(false);
    expect(job.counts.pages).toBe(1);
    expect(job.counts.queued).toBe(80);
    expect(job.counts.merged).toBe(20);
  });

  it('replaces the token and adds up across pages', () => {
    const one = advanceCursor(fresh(), {
      idsOnPage: 60,
      queued: 60,
      merged: 0,
      nextPageToken: 'a',
    });
    const two = advanceCursor(one, { idsOnPage: 40, queued: 10, merged: 30, nextPageToken: 'b' });
    expect(two.cursor).toEqual({ seen: 100, pageToken: 'b' });
    expect(two.counts).toMatchObject({ pages: 2, queued: 70, merged: 30 });
  });

  it('finishes the search without a token, and removes the old one', () => {
    const one = advanceCursor(fresh(), { idsOnPage: 5, queued: 5, merged: 0, nextPageToken: 'a' });
    const done = advanceCursor(one, { idsOnPage: 2, queued: 1, merged: 1 });
    expect(done.searchDone).toBe(true);
    expect(done.cursor).toEqual({ seen: 7 });
    expect('pageToken' in done.cursor).toBe(false);
  });

  it('accepts an empty last page', () => {
    const done = advanceCursor(fresh(), { idsOnPage: 0, queued: 0, merged: 0 });
    expect(done.searchDone).toBe(true);
    expect(done.counts.pages).toBe(1);
  });

  it('does not mutate its input', () => {
    const job = deepFreeze(fresh());
    expect(() =>
      advanceCursor(job, { idsOnPage: 1, queued: 1, merged: 0, nextPageToken: 'a' }),
    ).not.toThrow();
    expect(job.cursor).toEqual({ seen: 0 });
  });

  it('saturates at the largest safe integer', () => {
    const near: ManualJob = {
      ...fresh(),
      cursor: { seen: MAX - 1 },
      counts: { ...fresh().counts, pages: MAX, queued: MAX - 1, merged: MAX },
    };
    const next = advanceCursor(near, { idsOnPage: 5, queued: 3, merged: 2, nextPageToken: 'a' });
    expect(next.cursor.seen).toBe(MAX);
    expect(next.counts).toMatchObject({ pages: MAX, queued: MAX, merged: MAX });
  });

  const page = { idsOnPage: 2, queued: 1, merged: 1 };
  it.each([
    ['a negative idsOnPage', { ...page, idsOnPage: -1 }],
    ['a fractional queued', { ...page, queued: 0.5 }],
    ['an unsafe merged', { ...page, merged: 2 ** 53 }],
    ['queued + merged below idsOnPage', { ...page, idsOnPage: 3 }],
    ['queued + merged above idsOnPage', { ...page, idsOnPage: 1 }],
    ['an unstorable token', { ...page, nextPageToken: 'a"b' }],
    ['an empty token', { ...page, nextPageToken: '' }],
  ])('throws for %s', (_name, bad) => {
    expect(() => advanceCursor(fresh(), bad)).toThrow(InvalidArgumentError);
  });

  it('throws when the search is already done', () => {
    const done = advanceCursor(fresh(), { idsOnPage: 0, queued: 0, merged: 0 });
    expect(() => advanceCursor(done, { idsOnPage: 0, queued: 0, merged: 0 })).toThrow(
      InvalidArgumentError,
    );
  });
});

describe('dropPageToken', () => {
  it('removes the token and keeps seen', () => {
    const job = advanceCursor(fresh(), { idsOnPage: 4, queued: 4, merged: 0, nextPageToken: 'a' });
    const dropped = dropPageToken(deepFreeze(job));
    expect(dropped.cursor).toEqual({ seen: 4 });
    expect('pageToken' in dropped.cursor).toBe(false);
    expect(dropped.searchDone).toBe(false);
  });

  it('returns the job unchanged when there is no token', () => {
    const job = fresh();
    expect(dropPageToken(job)).toBe(job);
  });
});

describe('needsCursorWalk', () => {
  const started = advanceCursor(fresh(), {
    idsOnPage: 10,
    queued: 10,
    merged: 0,
    nextPageToken: 'a',
  });
  it.each([
    ['no token and seen 0 (the first page)', fresh(), false],
    ['a token', started, false],
    ['no token, seen > 0, not done', dropPageToken(started), true],
    ['searchDone', advanceCursor(started, { idsOnPage: 1, queued: 1, merged: 0 }), false],
  ])('%s -> %s', (_name, job, expected) => {
    expect(needsCursorWalk(job)).toBe(expected);
  });
});

describe('restoreCursor', () => {
  const walked = dropPageToken(
    advanceCursor(
      advanceCursor(fresh(), { idsOnPage: 100, queued: 100, merged: 0, nextPageToken: 'a' }),
      { idsOnPage: 50, queued: 40, merged: 10, nextPageToken: 'b' },
    ),
  );

  it('sets the cursor and leaves the counts alone', () => {
    const job = restoreCursor(deepFreeze(walked), { seen: 150, pageToken: 'c', searchDone: false });
    expect(job.cursor).toEqual({ seen: 150, pageToken: 'c' });
    expect(job.counts).toEqual(walked.counts);
    expect(needsCursorWalk(job)).toBe(false);
  });

  it('can restore a finished search and a smaller seen', () => {
    const done = restoreCursor(walked, { seen: 150, searchDone: true });
    expect(done.searchDone).toBe(true);
    expect(done.cursor).toEqual({ seen: 150 });
    const less = restoreCursor(walked, { seen: 100, pageToken: 'x', searchDone: false });
    expect(less.cursor.seen).toBe(100);
  });

  it.each([
    ['searchDone with a token', { seen: 10, pageToken: 'a', searchDone: true }],
    ['an unstorable token', { seen: 10, pageToken: 'a b', searchDone: false }],
    ['seen past the job', { seen: 151, searchDone: false }],
    ['a negative seen', { seen: -1, searchDone: false }],
    ['a fractional seen', { seen: 1.5, searchDone: false }],
  ])('throws for %s', (_name, cursor) => {
    expect(() => restoreCursor(walked, cursor)).toThrow(InvalidArgumentError);
  });
});

describe('countExecution', () => {
  it('adds one without mutating', () => {
    const job = deepFreeze(fresh());
    expect(countExecution(job).executions).toBe(1);
    expect(job.executions).toBe(0);
  });

  it('saturates', () => {
    expect(countExecution({ ...fresh(), executions: MAX }).executions).toBe(MAX);
  });
});

describe('the size proof', () => {
  const encodedBytes = (job: ManualJob): number =>
    utf8ByteLength(JSON.stringify(encodeManualJob(job)));

  it('1: the worst query still fits one value', () => {
    const worst = fresh('\ud800'.repeat(MANUAL_JOB_QUERY_MAX_CHARS));
    expect(JSON.stringify(worst.query).length).toBe(2 + 6 * MANUAL_JOB_QUERY_MAX_CHARS);
    expect(manualJobReservedBytes(worst)).toBeLessThanOrEqual(STATE_VALUE_MAX_BYTES);
  });

  it('2: the real size is at most the reserved size', () => {
    const base = fresh();
    const page = { idsOnPage: 100, queued: 100, merged: 0 };
    const midSearch = advanceCursor(base, { ...page, nextPageToken: 'tok123' });
    const finished = advanceCursor(midSearch, { idsOnPage: 1, queued: 1, merged: 0 });
    const big: ManualJob = {
      ...finished,
      startedAt: MAX,
      executions: MAX,
      counts: allCounts(MAX),
    };
    const fullMaps = withKeys(
      midSearch,
      Array.from({ length: 40 }, (_, i) => `Label ${String(i)}/é`),
    );
    const jobs: ManualJob[] = [base, midSearch, finished, big, fullMaps];
    for (const job of jobs) {
      expect(encodedBytes(job)).toBeLessThanOrEqual(manualJobReservedBytes(job));
    }
  });

  it('3: keys added under the 8,000-byte rule still fit after widening', () => {
    let job = fresh('from:someone label:x');
    let added = 0;
    for (let i = 0; ; i += 1) {
      const next = withMore(job, `Clients/Customer-${String(i)}`);
      if (manualJobReservedBytes(next) > 8000) {
        break;
      }
      job = next;
      added += 1;
    }
    expect(added).toBeGreaterThan(10);
    const widened: ManualJob = {
      ...job,
      startedAt: MAX,
      executions: MAX,
      cursor: { seen: MAX, pageToken: 'a'.repeat(MANUAL_PAGE_TOKEN_MAX_CHARS) },
      counts: allCounts(MAX),
      labels: allKeys(job.labels, MAX),
      moves: allKeys(job.moves, MAX),
      otherLabels: MAX,
      otherMoves: MAX,
    };
    expect(encodedBytes(widened)).toBe(manualJobReservedBytes(job));
    expect(manualJobReservedBytes(job)).toBeLessThanOrEqual(8000);
    expect(encodedBytes(widened)).toBeLessThanOrEqual(STATE_VALUE_MAX_BYTES);
    expect(() => {
      saveManualJob(new FakeState(), widened);
    }).not.toThrow();
  });

  function withMore(job: ManualJob, name: string): ManualJob {
    return {
      ...job,
      labels: { ...job.labels, [name]: 1 },
      moves: { ...job.moves, [`label:${name}`]: 1 },
    };
  }
});
