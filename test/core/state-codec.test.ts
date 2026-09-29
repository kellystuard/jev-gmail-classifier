import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StateError } from '../../src/core/errors.ts';
import { defineStateCodec, type StateMigration } from '../../src/core/state-codec.ts';

const KEY = 'state.demo';

// A made-up codec at version 3. v1 was { label }, v2 was { label, count } and
// v3 is { name, count, items[] }.
const v3 = defineStateCodec({
  version: 3,
  schema: z.strictObject({
    name: z.string(),
    count: z.number(),
    items: z.array(z.strictObject({ id: z.string(), strikes: z.number() })),
  }),
  migrations: [
    { from: 1, migrate: (value) => ({ ...value, count: 0 }) },
    {
      from: 2,
      migrate: (value) => {
        const { label, ...rest } = value;
        return { ...rest, name: label, items: [] };
      },
    },
  ],
});

// A made-up codec at version 1, with no migrations.
const v1 = defineStateCodec({ version: 1, schema: z.strictObject({ n: z.number() }) });

function decodeError(fn: () => unknown): StateError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StateError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected decode to throw');
}

describe('encode', () => {
  it('writes v first and round-trips', () => {
    const value = { name: 'x', count: 2, items: [{ id: 'a', strikes: 1 }] };
    const stored = v3.encode(value);
    expect(JSON.stringify(stored).startsWith('{"v":3,')).toBe(true);
    expect(JSON.stringify(stored)).toBe(
      '{"v":3,"name":"x","count":2,"items":[{"id":"a","strikes":1}]}',
    );
    // Through JSON, as the port stores it.
    expect(v3.decode(KEY, JSON.parse(JSON.stringify(stored)))).toEqual(value);
  });

  it('round-trips at version 1', () => {
    expect(JSON.stringify(v1.encode({ n: 7 }))).toBe('{"v":1,"n":7}');
    expect(v1.decode(KEY, v1.encode({ n: 7 }))).toEqual({ n: 7 });
  });

  it('exposes the version', () => {
    expect(v3.version).toBe(3);
    expect(v1.version).toBe(1);
  });
});

describe('decode migrations', () => {
  it('migrates a v1 value through 1→2→3', () => {
    expect(v3.decode(KEY, { v: 1, label: 'old' })).toEqual({ name: 'old', count: 0, items: [] });
  });

  it('runs only 2→3 for a v2 value', () => {
    expect(v3.decode(KEY, { v: 2, label: 'mid', count: 5 })).toEqual({
      name: 'mid',
      count: 5,
      items: [],
    });
  });

  it('runs migrations in order, each on the previous result without v', () => {
    const seen: string[] = [];
    const codec = defineStateCodec({
      version: 3,
      schema: z.strictObject({ trail: z.array(z.string()) }),
      migrations: [
        {
          from: 2,
          migrate: (value) => {
            seen.push(`2:${Object.keys(value).join(',')}`);
            return { trail: [...z.array(z.string()).parse(value['trail']), '2'] };
          },
        },
        {
          from: 1,
          migrate: (value) => {
            seen.push(`1:${Object.keys(value).join(',')}`);
            return { trail: ['1'] };
          },
        },
      ],
    });
    expect(codec.decode(KEY, { v: 1, junk: true })).toEqual({ trail: ['1', '2'] });
    expect(seen).toEqual(['1:junk', '2:trail']);
  });

  it('does not change raw, even when it is deep-frozen', () => {
    const raw = Object.freeze({ v: 1, label: 'frozen' });
    expect(v3.decode(KEY, raw)).toEqual({ name: 'frozen', count: 0, items: [] });
    expect(raw).toEqual({ v: 1, label: 'frozen' });

    const nested = Object.freeze({
      v: 3,
      name: 'n',
      count: 1,
      items: Object.freeze([Object.freeze({ id: 'a', strikes: 0 })]),
    });
    expect(v3.decode(KEY, nested).items).toEqual([{ id: 'a', strikes: 0 }]);
  });

  it('keeps a stored __proto__ key as data', () => {
    const raw: unknown = JSON.parse('{"v":1,"n":1,"__proto__":{"polluted":true}}');
    const error = decodeError(() => v1.decode(KEY, raw));
    expect(error.reason).toBe('schema');
    const probe: Record<string, unknown> = {};
    expect(probe['polluted']).toBeUndefined();
  });
});

describe('decode schema errors', () => {
  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'text'],
    ['a number', 3],
    ['an object with no v', { name: 'x', count: 1, items: [] }],
    ['v as a string', { v: '3', name: 'x', count: 1, items: [] }],
    ['v as a fraction', { v: 1.5, label: 'x' }],
    ['v as null', { v: null, name: 'x' }],
    ['a class instance', new Date(0)],
  ])('is schema for %s', (_name, raw) => {
    const error = decodeError(() => v3.decode(KEY, raw));
    expect(error.reason).toBe('schema');
    expect(error.key).toBe(KEY);
    expect(error.version).toBeUndefined();
  });

  it('is schema for a current-version value with a wrong field, naming the path', () => {
    const raw = { v: 3, name: 'x', count: 1, items: [{ id: 'a', strikes: 0 }, { id: 'b' }] };
    const error = decodeError(() => v3.decode(KEY, raw));
    expect(error.reason).toBe('schema');
    expect(error.version).toBe(3);
    expect(error.message).toContain(KEY);
    expect(error.message).toMatch(/items\[1\]\.strikes: Invalid input: expected number/);
  });

  it('is schema for an unknown field under a strict schema, without naming it', () => {
    const error = decodeError(() => v1.decode(KEY, { v: 1, n: 1, leftover: 'SECRET-KEY-NAME' }));
    expect(error.reason).toBe('schema');
    expect(error.message).toContain('Unrecognized key (1)');
    expect(error.message).not.toContain('SECRET-KEY-NAME');
  });

  it('names the root when the whole value is wrong', () => {
    const codec = defineStateCodec({ version: 1, schema: z.array(z.string()) });
    // The payload is not an object, so this codec can never accept a stored value.
    expect(decodeError(() => codec.decode(KEY, { v: 1 })).message).toContain('(root)');
  });

  it('is schema when a migration returns a value the schema rejects', () => {
    const codec = defineStateCodec({
      version: 2,
      schema: z.strictObject({ n: z.number() }),
      migrations: [{ from: 1, migrate: () => ({ n: 'not a number' }) }],
    });
    const error = decodeError(() => codec.decode(KEY, { v: 1 }));
    expect(error.reason).toBe('schema');
    expect(error.version).toBe(1);
    expect(error.message).toContain('n: Invalid input: expected number');
  });
});

describe('decode version errors', () => {
  it('is version for a v newer than the codec, and stores nothing', () => {
    const raw = { v: 4, name: 'x', count: 1, items: [] };
    const error = decodeError(() => v3.decode(KEY, raw));
    expect(error.reason).toBe('version');
    expect(error.version).toBe(4);
    expect(error.key).toBe(KEY);
    expect(raw).toEqual({ v: 4, name: 'x', count: 1, items: [] });
  });

  it.each([
    ['0', 0],
    ['-1', -1],
  ])('is version for v: %s', (_name, v) => {
    const error = decodeError(() => v3.decode(KEY, { v, label: 'x' }));
    expect(error.reason).toBe('version');
    expect(error.version).toBe(v);
  });

  it('is version for an older v with no migration', () => {
    const gap = defineStateCodec({
      version: 3,
      schema: z.strictObject({ n: z.number() }),
      migrations: [{ from: 2, migrate: (value) => value }],
    });
    // 2 → 3 exists, so v2 works. v1 has no step from 1.
    expect(gap.decode(KEY, { v: 2, n: 1 })).toEqual({ n: 1 });
    const error = decodeError(() => gap.decode(KEY, { v: 1, n: 1 }));
    expect(error.reason).toBe('version');
    expect(error.version).toBe(1);
    expect(error.message).toContain('no migration from 1');
  });

  it('is version when a later step is missing', () => {
    const gap = defineStateCodec({
      version: 3,
      schema: z.strictObject({ n: z.number() }),
      migrations: [{ from: 1, migrate: (value) => value }],
    });
    const error = decodeError(() => gap.decode(KEY, { v: 1, n: 1 }));
    expect(error.reason).toBe('version');
    expect(error.message).toContain('no migration from 2');
  });

  it('is version when a migration throws, and keeps the cause', () => {
    const boom = new TypeError('boom');
    const codec = defineStateCodec({
      version: 2,
      schema: z.strictObject({ n: z.number() }),
      migrations: [
        {
          from: 1,
          migrate: () => {
            throw boom;
          },
        },
      ],
    });
    const error = decodeError(() => codec.decode(KEY, { v: 1 }));
    expect(error.reason).toBe('version');
    expect(error.version).toBe(1);
    expect(error.cause).toBe(boom);
    expect(error.toLogFields()['cause']).toBe('TypeError: boom');
  });
});

describe('error fields and secrecy', () => {
  it('carries key, reason and version in the fields', () => {
    const error = decodeError(() => v3.decode(KEY, { v: 9 }));
    expect(error.toLogFields()).toMatchObject({ key: KEY, reason: 'version', version: 9 });
  });

  it('never includes the stored value in the message or the log fields', () => {
    const planted = 'PLANTED-SUBJECT-Ünïcode-42';
    const codec = defineStateCodec({
      version: 2,
      schema: z.strictObject({ subject: z.string().max(3), n: z.number() }),
      migrations: [
        {
          from: 1,
          migrate: (value) => {
            if (value['explode'] === true) {
              throw new Error('migration failed');
            }
            return { ...value, n: 1 };
          },
        },
      ],
    });
    const raws: unknown[] = [
      { v: 2, subject: planted, n: 1 }, // too_big
      { v: 2, subject: 'ok', n: planted }, // invalid_type
      { v: 2, subject: 'ok', n: 1, [planted]: planted }, // unrecognized key
      { v: 1, subject: planted, explode: true }, // migration throws
      { v: 3, subject: planted }, // newer
      { v: planted }, // bad v
      planted, // not an object
    ];
    for (const raw of raws) {
      const error = decodeError(() => codec.decode(KEY, raw));
      expect(error.message).not.toContain(planted);
      expect(JSON.stringify(error.toLogFields())).not.toContain(planted);
    }
  });
});

describe('defineStateCodec', () => {
  const schema = z.strictObject({ n: z.number() });
  const keep: StateMigration['migrate'] = (value) => ({ ...value });

  it.each([
    ['version 0', { version: 0, schema }],
    ['a negative version', { version: -1, schema }],
    ['a fractional version', { version: 1.5, schema }],
    [
      'a duplicate from',
      {
        version: 3,
        schema,
        migrations: [
          { from: 1, migrate: keep },
          { from: 1, migrate: keep },
        ],
      },
    ],
    ['from equal to version', { version: 2, schema, migrations: [{ from: 2, migrate: keep }] }],
    ['from above version', { version: 2, schema, migrations: [{ from: 5, migrate: keep }] }],
    ['from 0', { version: 2, schema, migrations: [{ from: 0, migrate: keep }] }],
    ['a fractional from', { version: 3, schema, migrations: [{ from: 1.5, migrate: keep }] }],
  ])('throws Error for %s', (_name, spec) => {
    expect(() => defineStateCodec(spec)).toThrow(Error);
    expect(() => defineStateCodec(spec)).not.toThrow(StateError);
  });

  it('accepts a gap between migrations', () => {
    expect(() =>
      defineStateCodec({ version: 4, schema, migrations: [{ from: 3, migrate: keep }] }),
    ).not.toThrow();
  });
});
