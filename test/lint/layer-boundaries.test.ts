/**
 * Proves the layer boundaries and module rules in `scripts/lint/layers.ts`
 * (SD §4.1, "Lint rules"; ES §3). Each sample is linted as if it were the file
 * at a path in the target it tests; allowed samples report nothing.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { NO_TYPE_INFO_CONFIG } from '../../eslint.config.ts';
import {
  ADAPTER_ONLY_GLOBALS,
  LAYERS,
  LOG_ADAPTER_FILE,
  UNUSED_SERVICE_GLOBALS,
} from '../../scripts/lint/layers.ts';
import { RESTRICTION_RULES } from '../../scripts/lint/restrictions.ts';
import { lintSample, REPO_ROOT } from './lint-sample.ts';

const IMPORTS = '@typescript-eslint/no-restricted-imports';
const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';
const SYNTAX = 'no-restricted-syntax';

async function ruleIds(code: string, filePath: string): Promise<(string | null)[]> {
  return (await lintSample(code, filePath)).map((message) => message.ruleId);
}

/** One sample path per target (and the `src/` fallback). */
const FILES = {
  core: 'src/core/sample.ts',
  cycleGuard: 'src/core/result.ts',
  config: 'src/config/sample.ts',
  ports: 'src/ports/sample-port.ts',
  app: 'src/app/sample.ts',
  adapter: 'src/adapters/gas/gas-sample-adapter.ts',
  logAdapter: LOG_ADAPTER_FILE,
  entry: 'src/entry/sample.ts',
  scripts: 'scripts/sample.ts',
  test: 'test/core/sample.test.ts',
  srcFallback: 'src/sample.ts',
} as const;

type Importer = keyof typeof FILES;
const ALL_TARGETS = [
  'core',
  'cycleGuard',
  'config',
  'ports',
  'app',
  'adapter',
  'logAdapter',
  'entry',
  'scripts',
  'test',
  'srcFallback',
] as const satisfies readonly Importer[];

const IMPORTED = ['core', 'config', 'ports', 'app', 'adapters', 'entry', 'generated'] as const;
type Imported = (typeof IMPORTED)[number];

/** The relative path from an importer to the root of `src/`. */
function toSrc(importer: Importer): string {
  const file = FILES[importer];
  if (file.startsWith('src/adapters/gas/')) return '../../';
  if (file.startsWith('src/') && file.split('/').length === 2) return './';
  if (file.startsWith('src/')) return '../';
  if (file.startsWith('scripts/')) return '../src/';
  return '../../src/';
}

const MODULE_IN: Record<Imported, string> = {
  core: 'core/declared-scopes.ts',
  config: 'config/schema.ts',
  ports: 'ports/clock-port.ts',
  app: 'app/run.ts',
  adapters: 'adapters/gas/gas-clock-adapter.ts',
  entry: 'entry/main.ts',
  generated: 'generated/config.ts',
};

/**
 * The import matrix (SD §4.1): `true` allowed, `false` banned, `'types'` only
 * with `import type`.
 */
const MATRIX: Record<Exclude<Importer, 'srcFallback'>, Record<Imported, boolean | 'types'>> = {
  core: {
    core: true,
    config: true,
    ports: false,
    app: false,
    adapters: false,
    entry: false,
    generated: false,
  },
  cycleGuard: {
    core: true,
    config: false,
    ports: false,
    app: false,
    adapters: false,
    entry: false,
    generated: false,
  },
  // core/ only through result.ts and errors.ts: tested separately below.
  config: {
    core: false,
    config: true,
    ports: false,
    app: false,
    adapters: false,
    entry: false,
    generated: false,
  },
  ports: {
    core: 'types',
    config: 'types',
    ports: true,
    app: false,
    adapters: false,
    entry: false,
    generated: false,
  },
  app: {
    core: true,
    config: true,
    ports: true,
    app: true,
    adapters: false,
    entry: false,
    generated: false,
  },
  adapter: {
    core: true,
    config: true,
    ports: true,
    app: false,
    adapters: true,
    entry: false,
    generated: false,
  },
  logAdapter: {
    core: true,
    config: true,
    ports: true,
    app: false,
    adapters: true,
    entry: false,
    generated: false,
  },
  entry: {
    core: true,
    config: true,
    ports: true,
    app: true,
    adapters: true,
    entry: true,
    generated: false,
  },
  scripts: {
    core: true,
    config: true,
    ports: true,
    app: true,
    adapters: true,
    entry: true,
    generated: false,
  },
  test: {
    core: true,
    config: true,
    ports: true,
    app: true,
    adapters: true,
    entry: true,
    generated: false,
  },
};

const IMPORT_CASES = ALL_TARGETS.filter((importer) => importer !== 'srcFallback').flatMap(
  (importer) =>
    IMPORTED.map((imported) => ({ importer, imported, allowed: MATRIX[importer][imported] })),
);

describe('imports between layers (SD §4.1 matrix)', () => {
  it.each(IMPORT_CASES)(
    '$importer importing $imported: $allowed',
    async ({ importer, imported, allowed }) => {
      const specifier = `${toSrc(importer)}${MODULE_IN[imported]}`;
      const value = await ruleIds(`import { x } from '${specifier}';\n`, FILES[importer]);
      const type = await ruleIds(`import type { X } from '${specifier}';\n`, FILES[importer]);
      expect(value).toEqual(allowed === true ? [] : [IMPORTS]);
      expect(type).toEqual(allowed === false ? [IMPORTS] : []);
    },
  );

  it.each(['./', '../', '../../'])(
    'catches the %s form of a banned layer import',
    async (prefix) => {
      for (const layer of ['adapters/gas', 'entry', 'generated']) {
        expect(await ruleIds(`import { x } from '${prefix}${layer}/x.ts';\n`, FILES.app)).toEqual([
          IMPORTS,
        ]);
      }
      expect(await ruleIds(`import { x } from '${prefix}ports/x.ts';\n`, FILES.core)).toEqual([
        IMPORTS,
      ]);
      expect(
        await ruleIds(`import { x } from '${prefix}config/x.ts';\n`, FILES.cycleGuard),
      ).toEqual([IMPORTS]);
      expect(await ruleIds(`import { x } from '${prefix}core/x.ts';\n`, FILES.config)).toEqual([
        IMPORTS,
      ]);
      expect(await ruleIds(`import { x } from '${prefix}core/x.ts';\n`, FILES.ports)).toEqual([
        IMPORTS,
      ]);
    },
  );

  it('checks re-exports too', async () => {
    expect(await ruleIds("export { x } from '../adapters/gas/x.ts';\n", FILES.app)).toEqual([
      IMPORTS,
    ]);
    expect(await ruleIds("export * from '../adapters/gas/x.ts';\n", FILES.app)).toEqual([IMPORTS]);
  });

  it('lets a layer import its own files', async () => {
    expect(await ruleIds("import { x } from './x.ts';\n", FILES.core)).toEqual([]);
    expect(await ruleIds("import { x } from '../x.ts';\n", 'src/core/body/basic.ts')).toEqual([]);
    expect(await ruleIds("import { x } from './gas-http-adapter.ts';\n", FILES.adapter)).toEqual(
      [],
    );
  });

  it('does not mistake a file name for a layer folder', async () => {
    expect(await ruleIds("import { x } from './entry-points.ts';\n", FILES.app)).toEqual([]);
    expect(
      await ruleIds("import { x } from '../../scripts/generated-config.ts';\n", FILES.test),
    ).toEqual([]);
  });

  it('applies the strictest (core) rules to src/ files outside every layer folder', async () => {
    expect(await ruleIds("import { x } from './config/schema.ts';\n", FILES.srcFallback)).toEqual(
      [],
    );
    expect(
      await ruleIds("import { x } from './ports/clock-port.ts';\n", FILES.srcFallback),
    ).toEqual([IMPORTS]);
    expect(await ruleIds('export const t = Date.now();\n', FILES.srcFallback)).toEqual([
      PROPERTIES,
    ]);
  });
});

describe('the config/ cycle guard', () => {
  it.each([
    ['../core/result.ts', []],
    ['../core/errors.ts', []],
    ['../core/log-fields.ts', [IMPORTS]],
    ['../core/declared-scopes.ts', [IMPORTS]],
    ['../core/body/result.ts', [IMPORTS]],
    ['../core', [IMPORTS]],
  ])('config/ importing %s', async (specifier, expected) => {
    expect(await ruleIds(`import { x } from '${specifier}';\n`, FILES.config)).toEqual(expected);
  });

  it.each(['src/core/result.ts', 'src/core/errors.ts', 'src/core/log-fields.ts'])(
    '%s may not import config/',
    async (file) => {
      expect(await ruleIds("import { x } from '../config/schema.ts';\n", file)).toEqual([IMPORTS]);
      expect(await ruleIds("import type { X } from '../config/schema.ts';\n", file)).toEqual([
        IMPORTS,
      ]);
      expect(await ruleIds("import { x } from './log-fields.ts';\n", file)).toEqual([]);
    },
  );

  it('lets the rest of core/ import config/', async () => {
    expect(await ruleIds("import { x } from '../config/schema.ts';\n", FILES.core)).toEqual([]);
  });
});

const SRC_TARGETS = [
  'core',
  'cycleGuard',
  'config',
  'ports',
  'app',
  'adapter',
  'logAdapter',
  'entry',
  'srcFallback',
] as const;
const NON_ENTRY_SRC = SRC_TARGETS.filter((target) => target !== 'entry');

describe('packages in src/', () => {
  it.each(SRC_TARGETS)('%s may import zod and relative paths only', async (target) => {
    const file = FILES[target];
    expect(await ruleIds("import { z } from 'zod';\n", file)).toEqual([]);
    for (const banned of ['node:fs', 'fs', 'yaml', 'esbuild', 'zod/mini', '@types/node']) {
      expect(await ruleIds(`import { x } from '${banned}';\n`, file)).toEqual([IMPORTS]);
    }
  });

  it('lets scripts/ and test/ import packages', async () => {
    for (const file of [FILES.scripts, FILES.test]) {
      expect(
        await ruleIds(
          "import { parse } from 'yaml';\nimport { readFileSync } from 'node:fs';\n",
          file,
        ),
      ).toEqual([]);
    }
  });
});

describe('virtual:generated-config', () => {
  const SAMPLE = "import { EMBEDDED_CONFIG } from 'virtual:generated-config';\n";

  it('is allowed in src/entry/', async () => {
    expect(await ruleIds(SAMPLE, FILES.entry)).toEqual([]);
    expect(await ruleIds(SAMPLE, 'src/entry/embedded-config.ts')).toEqual([]);
  });

  it.each([...NON_ENTRY_SRC, 'scripts', 'test'] as const)(
    'is banned in %s, reported once',
    async (target) => {
      expect(await ruleIds(SAMPLE, FILES[target])).toEqual([IMPORTS]);
    },
  );

  it('src/entry/ may not import src/generated/ directly', async () => {
    expect(await ruleIds("import { x } from '../generated/config.ts';\n", FILES.entry)).toEqual([
      IMPORTS,
    ]);
  });

  it('tests may not import src/generated/', async () => {
    expect(
      await ruleIds("import { x } from '../../src/generated/config.ts';\n", 'test/entry/x.test.ts'),
    ).toEqual([IMPORTS]);
  });
});

describe('GmailApp (ADR-0003)', () => {
  it.each(ALL_TARGETS)('is banned in %s', async (target) => {
    expect(await ruleIds('GmailApp.getInboxThreads();\n', FILES[target])).toEqual([GLOBALS]);
  });
});

describe('Apps Script globals', () => {
  it.each(ADAPTER_ONLY_GLOBALS)('%s is allowed only in src/adapters/gas/', async (name) => {
    const code = `${name}.toString();\n`;
    for (const target of [
      'core',
      'cycleGuard',
      'config',
      'ports',
      'app',
      'entry',
      'srcFallback',
    ] as const) {
      expect(await ruleIds(code, FILES[target])).toEqual([GLOBALS]);
    }
    expect(await ruleIds(code, FILES.adapter)).toEqual([]);
    expect(await ruleIds(code, FILES.logAdapter)).toEqual([]);
  });

  it.each(UNUSED_SERVICE_GLOBALS)(
    '%s is banned in all of src/, adapters included',
    async (name) => {
      const code = `${name}.toString();\n`;
      for (const target of SRC_TARGETS) {
        expect(await ruleIds(code, FILES[target])).toEqual([GLOBALS]);
      }
    },
  );

  it('are not restricted in scripts/ and test/', async () => {
    for (const file of [FILES.scripts, FILES.test]) {
      expect(await ruleIds('Gmail.toString();\nLogger.log(1);\n', file)).toEqual([]);
    }
  });
});

describe('console', () => {
  it.each(['core', 'app', 'adapter', 'entry'] as const)('is banned in %s', async (target) => {
    expect(await ruleIds("console.log('x');\n", FILES[target])).toEqual([GLOBALS]);
  });

  it.each(['logAdapter', 'scripts', 'test'] as const)('is allowed in %s', async (target) => {
    expect(await ruleIds("console.log('x');\n", FILES[target])).toEqual([]);
  });
});

describe('clock and randomness (epic #8 decision 5)', () => {
  const CASES = [
    ['export const t = Date.now();\n', PROPERTIES],
    ['export const d = new Date();\n', SYNTAX],
    ['export const s = Date();\n', SYNTAX],
    ["export const s = Date('2026-01-01');\n", SYNTAX],
    ['export const r = Math.random();\n', PROPERTIES],
    ['export const p = performance.now();\n', GLOBALS],
  ] as const;

  it.each(CASES)('%s fails in core/, config/, app/ and entry/', async (code, rule) => {
    for (const target of ['core', 'config', 'app', 'entry'] as const) {
      expect(await ruleIds(code, FILES[target])).toEqual([rule]);
    }
  });

  it.each(CASES)('%s passes in adapters/gas/, scripts/ and test/', async (code) => {
    for (const target of ['adapter', 'logAdapter', 'scripts', 'test'] as const) {
      expect(await ruleIds(code, FILES[target])).toEqual([]);
    }
  });

  it('allows dates built from a value', async () => {
    const code =
      'export const a = new Date(0);\nexport const b = new Date(a.getTime());\nexport const c = Date.UTC(2026, 0, 1);\n';
    expect(await ruleIds(code, FILES.core)).toEqual([]);
  });
});

describe('default exports (ES §3)', () => {
  it.each(ALL_TARGETS)('are banned in %s', async (target) => {
    expect(await ruleIds('export default 1;\n', FILES[target])).toEqual([SYNTAX]);
    expect(await ruleIds('const x = 1;\nexport { x as default };\n', FILES[target])).toEqual([
      SYNTAX,
    ]);
  });

  it('are allowed in the root tool configs', async () => {
    expect(await ruleIds('export default 1;\n', 'eslint.config.ts')).toEqual([]);
    expect(await ruleIds('export default 1;\n', 'vitest.config.ts')).toEqual([]);
  });
});

describe('composition', () => {
  const full = new ESLint({ cwd: REPO_ROOT });
  const restrictionsOnly = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [...NO_TYPE_INFO_CONFIG],
  });

  it('covers every target with a sample path', () => {
    expect(LAYERS.map((target) => target.name)).toHaveLength(Object.keys(FILES).length - 1);
  });

  it.each(Object.values(FILES))(
    'eslint.config.ts sets the same restriction options for %s',
    async (file) => {
      const actual: unknown = await full.calculateConfigForFile(file);
      const expected: unknown = await restrictionsOnly.calculateConfigForFile(file);
      const rules = (config: unknown) =>
        RESTRICTION_RULES.map((rule) => [rule, rulesOf(config)[rule]]);
      expect(rules(actual)).toEqual(rules(expected));
      expect(rules(actual).every(([, setting]) => setting !== undefined)).toBe(true);
    },
  );
});

function rulesOf(config: unknown): Record<string, unknown> {
  if (typeof config === 'object' && config !== null && 'rules' in config) {
    const { rules } = config;
    if (typeof rules === 'object' && rules !== null) return { ...rules };
  }
  return {};
}
