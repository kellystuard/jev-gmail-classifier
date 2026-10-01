import { describe, expect, it } from 'vitest';

import type { LogFields } from '../../src/core/log-fields.ts';
import {
  FORBIDDEN_LOG_FIELDS,
  LOG_REDACT_MAX_DEPTH,
  LOG_SECRET_MIN_CHARS,
  LOG_STRING_MAX_CHARS,
  REDACTED,
  isForbiddenLogField,
  redact,
} from '../../src/core/redact.ts';

/** The type system allows no deep or odd value: a cast stands in for a slip. */
function slip(value: Record<string, unknown>): LogFields {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- tests a slip the types forbid.
  return value as LogFields;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('isForbiddenLogField', () => {
  it('has the nine names', () => {
    expect(FORBIDDEN_LOG_FIELDS).toHaveLength(9);
    for (const name of FORBIDDEN_LOG_FIELDS) expect(isForbiddenLogField(name)).toBe(true);
  });

  it.each([
    'apiKey',
    'API_KEY',
    'api-key',
    'JEV_API_KEY',
    'jev-api-key',
    'pageToken',
    'page_token',
    'Authorization',
    'BODY',
  ])('forbids %s', (name) => {
    expect(isForbiddenLogField(name)).toBe(true);
  });

  it.each([
    'key',
    'bodyLength',
    'stateKey',
    'inputTokens',
    'tokens',
    'subject',
    'from',
    'nextPageToken',
    '',
  ])('allows "%s"', (name) => {
    expect(isForbiddenLogField(name)).toBe(false);
  });
});

describe('redact: names', () => {
  it.each([
    ['a string', 'x'],
    ['a number', 5],
    ['an array', ['a', 'b']],
    ['a record', { a: 1 }],
  ])('replaces %s under a forbidden top-level name', (_label, value) => {
    expect(redact(slip({ body: value, note: 'ok' }))).toEqual({ body: REDACTED, note: 'ok' });
  });

  it('keeps a number, boolean or null under a forbidden key in a record (S1)', () => {
    const fields: LogFields = {
      probabilities: { password: 0.93, token: 0.1, bill: 0.5 },
      labels: { Secret: 3, Body: 1 },
      flags: { token: true, secret: null },
    };
    expect(redact(fields)).toEqual(fields);
  });

  it('replaces a string, array or object under a forbidden key in a record', () => {
    expect(redact({ headers: { authorization: 'x', other: 'y' } })).toEqual({
      headers: { authorization: REDACTED, other: 'y' },
    });
    expect(redact(slip({ r: { token: ['a'], body: { a: 1 } } }))).toEqual({
      r: { token: REDACTED, body: REDACTED },
    });
  });

  it('keeps __proto__ and constructor as own record keys', () => {
    const labels = Object.fromEntries([
      ['__proto__', 2],
      ['constructor', 3],
    ]);
    const out = redact({ labels });
    const result = out['labels'];
    expect(Object.keys(typeof result === 'object' && result !== null ? result : {})).toEqual([
      '__proto__',
      'constructor',
    ]);
    expect(JSON.stringify(out)).toBe('{"labels":{"__proto__":2,"constructor":3}}');
  });
});

describe('redact: Bearer', () => {
  it.each([
    ['Authorization: Bearer abc.def-123 sent', 'Authorization: Bearer [redacted] sent'],
    ['bearer abc', 'Bearer [redacted]'],
    ['BEARER   abc', 'Bearer [redacted]'],
    ['Bearer a and bearer b', 'Bearer [redacted] and Bearer [redacted]'],
    ['ends with Bearer', 'ends with Bearer'],
  ])('%s', (input, expected) => {
    expect(redact({ note: input })).toEqual({ note: expected });
  });

  it('scrubs array elements and record values', () => {
    expect(redact({ list: ['Bearer abc'], rec: { k: 'Bearer abc' } })).toEqual({
      list: ['Bearer [redacted]'],
      rec: { k: 'Bearer [redacted]' },
    });
  });
});

describe('redact: secret values', () => {
  const secret = 'sk-secret-12'; // 12 characters

  it('replaces the secret anywhere in a string, in arrays and in records', () => {
    const out = redact(
      {
        a: `${secret} middle`,
        b: `start ${secret} end`,
        c: `end ${secret}`,
        d: `${secret}${secret}`,
        e: [`x ${secret}`, 1],
        f: { k: `y ${secret}` },
      },
      [secret],
    );
    expect(out).toEqual({
      a: `${REDACTED} middle`,
      b: `start ${REDACTED} end`,
      c: `end ${REDACTED}`,
      d: `${REDACTED}${REDACTED}`,
      e: [`x ${REDACTED}`, 1],
      f: { k: `y ${REDACTED}` },
    });
  });

  it('ignores a secret under the minimum length', () => {
    expect(LOG_SECRET_MIN_CHARS).toBe(8);
    expect(redact({ a: 'abcdefg' }, ['abcdefg'])).toEqual({ a: 'abcdefg' });
    expect(redact({ a: 'abcdefgh' }, ['abcdefgh'])).toEqual({ a: REDACTED });
  });

  it('matches a secret with regex characters as text', () => {
    expect(redact({ a: 'x a.b*c+d?e$ y aXbbbbcdde' }, ['a.b*c+d?e$'])).toEqual({
      a: `x ${REDACTED} y aXbbbbcdde`,
    });
  });

  it('changes nothing for an empty or omitted list', () => {
    expect(redact({ a: 'sk-secret-12' }, [])).toEqual({ a: 'sk-secret-12' });
    expect(redact({ a: 'sk-secret-12' })).toEqual({ a: 'sk-secret-12' });
  });
});

describe('redact: length', () => {
  it('leaves 2,000 units and cuts 2,001', () => {
    expect(LOG_STRING_MAX_CHARS).toBe(2000);
    expect(redact({ note: 'a'.repeat(2000) })).toEqual({ note: 'a'.repeat(2000) });
    expect(redact({ note: 'a'.repeat(2001) })).toEqual({
      note: `${'a'.repeat(2000)}…[+1 chars]`,
    });
  });

  it('cuts a long body under an allowed name', () => {
    expect(redact({ note: 'b'.repeat(10000) })).toEqual({
      note: `${'b'.repeat(2000)}…[+8000 chars]`,
    });
  });

  it('does not split a surrogate pair', () => {
    const text = `${'a'.repeat(1999)}😀tail`; // unit 2000 and 2001 are the pair
    const out = redact({ note: text });
    expect(out).toEqual({ note: `${'a'.repeat(1999)}…[+${String(text.length - 1999)} chars]` });
  });

  it('replaces a secret that straddles the cut point', () => {
    const secret = 'straddle-secret';
    const text = `${'a'.repeat(1995)}${secret}${'z'.repeat(50)}`;
    const out = redact({ note: text }, [secret]);
    const note = out['note'];
    expect(typeof note === 'string' && note.includes('straddle')).toBe(false);
    expect(typeof note === 'string' && note.startsWith(`${'a'.repeat(1995)}[reda`)).toBe(true);
  });
});

describe('redact: purity', () => {
  it('returns a new object, keeps order, and never mutates', () => {
    const fields = deepFreeze({
      z: 'Bearer abc',
      list: ['a', 'b'],
      rec: { token: 'x', n: 1 },
      body: 'b',
      n: 1,
      t: true,
      nul: null,
    });
    const out = redact(fields, ['whatever-secret']);
    expect(out).not.toBe(fields);
    expect(Object.keys(out)).toEqual(['z', 'list', 'rec', 'body', 'n', 't', 'nul']);
    expect(out).toEqual({
      z: 'Bearer [redacted]',
      list: ['a', 'b'],
      rec: { token: REDACTED, n: 1 },
      body: REDACTED,
      n: 1,
      t: true,
      nul: null,
    });
    expect(fields.z).toBe('Bearer abc');
  });
});

describe('redact: odd input', () => {
  it('replaces what is nested at the depth cap, and does not throw', () => {
    expect(LOG_REDACT_MAX_DEPTH).toBe(4);
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    // top-level value is depth 1; the object at depth 4 (the value of `c`) is replaced
    expect(redact(slip({ deep }))).toEqual({ deep: { a: { b: { c: REDACTED } } } });
  });

  it('does not throw for a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => redact(slip({ cyclic }))).not.toThrow();
  });

  it('passes undefined and functions through', () => {
    expect(() => redact(slip({ a: undefined, b: () => 1 }))).not.toThrow();
    expect(redact(slip({ a: undefined }))).toEqual({ a: undefined });
  });
});

describe('redact: real events pass through unchanged', () => {
  const events: Record<string, LogFields> = {
    'thread.classified': {
      threadId: 't1',
      subject: 'Your invoice for September',
      from: 'billing@example.com',
      probabilities: { invoice: 0.93, newsletter: 0.02 },
      fired: ['invoice'],
      actions: ['label:Invoices'],
      truncated: false,
      requestId: 'req_123',
      model: 'jev-latest',
      inputTokens: 1234,
    },
    'run.end': {
      chunks: 2,
      labels: { Invoices: 3, Receipts: 1 },
      moves: { archive: 2 },
      spare: 12.5,
    },
    'run.failed': { error: 'StateError', key: 'state.queue.0', message: 'bad shape' },
  };
  it.each(Object.entries(events))('%s', (_name, fields) => {
    expect(redact(fields)).toEqual(fields);
  });
});
