/**
 * Vitest configuration (Engineering Standards §2, §8; Solution Design §12).
 *
 * Tests live in `test/`, mirroring `src/`, as `*.test.ts`. `spikes/` is never
 * run (its `run.test.mjs` is a `node:test` file outside E2's tooling), and
 * nothing here loads `.env`: tests make no live calls.
 *
 * Coverage is a guide, not a gate: there are deliberately no `thresholds`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
      ],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
