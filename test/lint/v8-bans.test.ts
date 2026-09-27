/**
 * Proves the Apps Script V8 runtime bans in `scripts/lint/v8-bans.ts` and the
 * ES §4 type-safety bans (ES §4, "V8 runtime limits" and "Banned").
 */
import { describe, expect, it } from 'vitest';

import { lintSample } from './lint-sample.ts';

const GLOBALS = 'no-restricted-globals';
const SYNTAX = 'no-restricted-syntax';

const SRC_FILES = ['src/core/sample.ts', 'src/adapters/gas/gas-sample-adapter.ts'];
const NODE_FILES = ['scripts/sample.ts', 'test/core/sample.test.ts'];

async function ruleIds(code: string, filePath: string): Promise<(string | null)[]> {
  return (await lintSample(code, filePath)).map((message) => message.ruleId);
}

/** Each sample and the rules it breaks in `src/`. */
const SYNTAX_SAMPLES: readonly (readonly [string, string, readonly string[]])[] = [
  ['#private field', 'export class A {\n  #x = 1;\n}\n', [SYNTAX]],
  ['#private method', 'export class A {\n  #m(): void {}\n}\n', [SYNTAX]],
  ['static field', 'export class A {\n  static x = 1;\n}\n', [SYNTAX]],
  ['static block', 'export class A {\n  static {}\n}\n', [SYNTAX]],
  ['async function', 'export async function f() {}\n', [SYNTAX]],
  ['async arrow', 'export const f = async () => 1;\n', [SYNTAX]],
  [
    'method using await',
    'export class A {\n  async m() {\n    await 1;\n  }\n}\n',
    [SYNTAX, SYNTAX],
  ],
  ['for await', 'for await (const x of []) {\n  void x;\n}\n', [SYNTAX]],
  ['dynamic import()', "export const m = import('./x.ts');\n", [SYNTAX]],
  ['import.meta', 'export const u = import.meta.url;\n', [SYNTAX]],
];

const BANNED_GLOBALS = [
  // Timers.
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  // Missing web APIs.
  'fetch',
  'atob',
  'btoa',
  'TextDecoder',
  'TextEncoder',
  'crypto',
  // Synchronous by design.
  'Promise',
  // Node.
  'process',
  'Buffer',
  'global',
  'require',
  'module',
  '__dirname',
  '__filename',
  // DOM.
  'window',
  'self',
  'document',
  'navigator',
  // Would bypass every global ban.
  'globalThis',
  // Precaution until a spike shows they work.
  'URL',
  'URLSearchParams',
];

describe('V8 runtime bans in src/', () => {
  describe.each(SRC_FILES)('%s', (file) => {
    it.each(SYNTAX_SAMPLES)('rejects a %s', async (_name, code, expected) => {
      expect(await ruleIds(code, file)).toEqual(expected);
    });

    it.each(BANNED_GLOBALS)('rejects %s', async (name) => {
      expect(await ruleIds(`export const v = ${name};\n`, file)).toEqual([GLOBALS]);
    });

    // no-restricted-globals sees only value references. A type erases from the
    // bundle, and any code that makes a Promise is caught by the value bans.
    it('allows a banned global in a type position', async () => {
      expect(await ruleIds('export type P = Promise<number>;\n', file)).toEqual([]);
    });
  });
});

describe('scripts/ and test/ run in Node', () => {
  describe.each(NODE_FILES)('%s', (file) => {
    it.each(SYNTAX_SAMPLES)('allows a %s', async (_name, code) => {
      expect(await ruleIds(code, file)).toEqual([]);
    });

    it.each(BANNED_GLOBALS)('allows %s', async (name) => {
      expect(await ruleIds(`export const v = ${name};\n`, file)).toEqual([]);
    });
  });
});

describe('allowed near-misses in src/', () => {
  it.each([
    [
      'a private field',
      'export class A {\n  private x = 1;\n  get(): number {\n    return this.x;\n  }\n}\n',
    ],
    ['an instance field', 'export class A {\n  x = 1;\n}\n'],
    ['a non-async generator', 'export function* g(): Generator<number> {\n  yield 1;\n}\n'],
    ['a local variable named fetch', 'const fetch = (): number => 1;\nexport const v = fetch();\n'],
    [
      'a property named setTimeout',
      'export function f(obj: { setTimeout(): void }): void {\n  obj.setTimeout();\n}\n',
    ],
    [
      'a parameter named process',
      'export function f(process: string): string {\n  return process;\n}\n',
    ],
    [
      'a for...of loop',
      'export function f(xs: number[]): void {\n  for (const x of xs) {\n    void x;\n  }\n}\n',
    ],
  ])('allows %s', async (_name, code) => {
    for (const file of SRC_FILES) {
      expect(await ruleIds(code, file)).toEqual([]);
    }
  });
});

describe('type-safety bans in src/ (ES §4)', () => {
  const ASSERTIONS = '@typescript-eslint/consistent-type-assertions';

  it.each([
    ['any', 'export const a: any = 1;\n', ['@typescript-eslint/no-explicit-any']],
    [
      'a non-null assertion',
      'export function f(x?: string): string {\n  return x!;\n}\n',
      ['@typescript-eslint/no-non-null-assertion'],
    ],
    ['an as cast', 'type Foo = { a: 1 };\nexport const v = {} as Foo;\n', [ASSERTIONS]],
    ['an angle-bracket cast', 'type Foo = { a: 1 };\nexport const v = <Foo>{};\n', [ASSERTIONS]],
    [
      'a double cast',
      'type Foo = { a: 1 };\nexport const v = 1 as unknown as Foo;\n',
      [ASSERTIONS, ASSERTIONS],
    ],
    ['as const', "export const v = ['a'] as const;\n", []],
  ])('%s', async (_name, code, expected) => {
    expect(await ruleIds(code, 'src/core/sample.ts')).toEqual(expected);
  });

  it('accepts a justified disable comment', async () => {
    const code =
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the sample needs it\nexport const a: any = 1;\n';
    expect(await ruleIds(code, 'src/core/sample.ts')).toEqual([]);
  });

  it('rejects a disable comment without a justification', async () => {
    const code =
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport const a: any = 1;\n';
    expect(await ruleIds(code, 'src/core/sample.ts')).toEqual([
      '@eslint-community/eslint-comments/require-description',
    ]);
  });
});
