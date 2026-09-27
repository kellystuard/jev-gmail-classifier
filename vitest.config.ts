/**
 * Vitest configuration (Engineering Standards §2, §8; Solution Design §12).
 *
 * Tests live in `test/`, mirroring `src/`, as `*.test.ts`. `spikes/` is never
 * run (its `run.test.mjs` is a `node:test` file outside E2's tooling), and
 * nothing here loads `.env`: tests make no live calls.
 *
 * Coverage is a guide, not a gate: there are deliberately no `thresholds`.
 */
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { defineConfig, type Plugin } from 'vitest/config';

import { GENERATED_CONFIG_SPECIFIER, generatedConfigModule } from './scripts/generated-config.ts';

/** The fixture that stands in for the user's config wherever a test needs one. */
const FIXTURE_CONFIG = 'test/fixtures/config/valid.yaml';

/**
 * Serves `virtual:generated-config` from the fixture, the way `bundle()` does
 * from the user's config (Solution Design §11). Tests never import it
 * themselves; it is here because `src/entry/` does, and tests import
 * `src/entry/main.ts`. So tests never depend on `config.yaml` or a build.
 */
function generatedConfigFixture(): Plugin {
  // No `\0` prefix: an id ending in `.ts` gets Vite's TypeScript transform,
  // which the module's `: unknown` annotation needs.
  const resolvedId = `/@generated-config-fixture/config.ts`;
  return {
    name: 'generated-config-fixture',
    resolveId(id) {
      return id === GENERATED_CONFIG_SPECIFIER ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) {
        return undefined;
      }
      const raw: unknown = parse(readFileSync(FIXTURE_CONFIG, 'utf8'));
      return generatedConfigModule(raw, FIXTURE_CONFIG);
    },
  };
}

export default defineConfig({
  plugins: [generatedConfigFixture()],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['spikes/**', '.claude/**', 'dist/**', 'coverage/**', 'node_modules/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Written by the build.
        'src/generated/**',
        // Apps Script adapters are covered by spikes and the smoke test, not unit tests.
        'src/adapters/gas/**',
        // Composition root, checked by the bundle test.
        'src/entry/**',
        // Interfaces and types only: nothing runs, so nothing to cover.
        'src/ports/**',
      ],
      // skipFull: false lists fully covered files too, so the table shows every file.
      reporter: [['text', { skipFull: false }], 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
