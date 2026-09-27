import { describe, expect, it } from 'vitest';

import config from '../../eslint.config.ts';
import {
  ALL_LINTED_FILES,
  buildRestrictionConfig,
  NO_RESTRICTIONS,
  RESTRICTION_RULES,
  SRC_FILES,
  type LintTarget,
  type Restrictions,
} from '../../scripts/lint/restrictions.ts';

function only(kind: keyof Restrictions, entry: string): Restrictions {
  switch (kind) {
    case 'globals':
      return { ...NO_RESTRICTIONS, globals: [{ name: entry, message: entry }] };
    case 'properties':
      return { ...NO_RESTRICTIONS, properties: [{ object: entry, message: entry }] };
    case 'syntax':
      return { ...NO_RESTRICTIONS, syntax: [{ selector: entry, message: entry }] };
    case 'imports':
      return { ...NO_RESTRICTIONS, imports: [{ name: entry, message: entry }] };
  }
}

const CORE: LintTarget = {
  name: 'core',
  files: ['src/core/**/*.ts'],
  inSrc: true,
  strictest: true,
  restrictions: only('globals', 'coreGlobal'),
};
const TEST: LintTarget = {
  name: 'test',
  files: ['test/**/*.ts'],
  ignores: ['test/fixtures/**'],
  inSrc: false,
  restrictions: only('syntax', 'TestSelector'),
};
const RUNTIME = only('properties', 'runtimeObject');
const EVERYWHERE = only('imports', 'everywhere-module');

describe('buildRestrictionConfig', () => {
  const blocks = buildRestrictionConfig([CORE, TEST], RUNTIME, EVERYWHERE);

  it('emits everywhere, the src fallback, then one block per target', () => {
    expect(blocks.map((block) => block.files)).toEqual([
      [...ALL_LINTED_FILES],
      [...SRC_FILES],
      CORE.files,
      TEST.files,
    ]);
    expect(blocks[3]?.ignores).toEqual(TEST.ignores);
  });

  it('sets every restriction rule in every block, so no earlier options leak through', () => {
    for (const block of blocks) {
      expect(Object.keys(block.rules ?? {})).toEqual(
        expect.arrayContaining([...RESTRICTION_RULES]),
      );
      expect(block.rules?.['no-restricted-imports']).toBe('off');
    }
  });

  it('concatenates the target, src runtime and everywhere lists', () => {
    const [everywhere, fallback, core, test] = blocks.map((block) => block.rules);
    const importPaths = (rules: typeof core) => rules?.['@typescript-eslint/no-restricted-imports'];

    expect(everywhere?.['no-restricted-globals']).toEqual(['error']);
    expect(importPaths(everywhere)).toEqual(['error', { paths: EVERYWHERE.imports, patterns: [] }]);

    // The fallback uses the strictest target's lists.
    expect(fallback).toEqual(core);
    expect(core?.['no-restricted-globals']).toEqual(['error', ...CORE.restrictions.globals]);
    expect(core?.['no-restricted-properties']).toEqual(['error', ...RUNTIME.properties]);
    expect(importPaths(core)).toEqual(['error', { paths: EVERYWHERE.imports, patterns: [] }]);

    // Targets outside src/ don't get the runtime bans.
    expect(test?.['no-restricted-syntax']).toEqual(['error', ...TEST.restrictions.syntax]);
    expect(test?.['no-restricted-properties']).toEqual(['error']);
    expect(importPaths(test)).toEqual(['error', { paths: EVERYWHERE.imports, patterns: [] }]);
  });

  it('splits import restrictions into paths and patterns', () => {
    const imports: Restrictions = {
      ...NO_RESTRICTIONS,
      imports: [
        { name: 'fs', message: 'no fs' },
        { group: ['../adapters/*'], message: 'no adapters' },
        { regex: '^node:', message: 'no node' },
      ],
    };
    const [everywhere] = buildRestrictionConfig([], NO_RESTRICTIONS, imports);
    expect(everywhere?.rules?.['@typescript-eslint/no-restricted-imports']).toEqual([
      'error',
      { paths: [imports.imports[0]], patterns: [imports.imports[1], imports.imports[2]] },
    ]);
  });

  it('falls back to the runtime and everywhere lists while no target is strictest', () => {
    const [, fallback] = buildRestrictionConfig([], RUNTIME, EVERYWHERE);
    expect(fallback?.rules?.['no-restricted-globals']).toEqual(['error']);
    expect(fallback?.rules?.['no-restricted-properties']).toEqual(['error', ...RUNTIME.properties]);
  });
});

describe('eslint.config.ts', () => {
  it('ends with the restriction blocks, so nothing after them replaces their options', () => {
    const restrictionBlocks = buildRestrictionConfig();
    const tail = config.slice(-restrictionBlocks.length);
    expect(tail.map((block) => block.name)).toEqual(restrictionBlocks.map((block) => block.name));
    expect(tail.map((block) => block.rules)).toEqual(restrictionBlocks.map((block) => block.rules));
  });
});
