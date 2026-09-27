/**
 * ESLint flat config (Engineering Standards §2–§4).
 *
 * ESLint owns correctness and layering; Prettier owns formatting, so no
 * formatting rules are turned on here. The layer and V8 restrictions come from
 * `scripts/lint/` and go last, so no later block can replace their options.
 *
 * The default export is what ESLint loads (config files need one). The named
 * `NO_TYPE_INFO_CONFIG` is reused by `test/lint/lint-sample.ts`, which lints
 * samples without type information.
 */
import * as comments from '@eslint-community/eslint-plugin-eslint-comments';
import eslint from '@eslint/js';
import type { Linter } from 'eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { buildRestrictionConfig } from './scripts/lint/restrictions.ts';

/** ES §4: no `any`, no `as` casts (except `as const`), no non-null `!`. */
export const TYPE_SAFETY_CONFIG: Linter.Config = {
  name: 'jev/type-safety',
  files: ['**/*.ts'],
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
  },
};

/**
 * The only escape hatch is a justified disable comment:
 * `// eslint-disable-next-line <rule> -- <why>`. A comment without a
 * justification, a blanket disable, or one that suppresses nothing fails.
 */
export const DISABLE_DIRECTIVE_CONFIG: Linter.Config = {
  name: 'jev/disable-directives',
  linterOptions: { reportUnusedDisableDirectives: 'error' },
  plugins: { '@eslint-community/eslint-comments': { rules: comments.rules } },
  rules: {
    '@eslint-community/eslint-comments/require-description': 'error',
    '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
  },
};

/** The blocks that need no type information, in the order the full config uses them. */
export const NO_TYPE_INFO_CONFIG: readonly Linter.Config[] = [
  TYPE_SAFETY_CONFIG,
  DISABLE_DIRECTIVE_CONFIG,
  ...buildRestrictionConfig(),
];

export default defineConfig(
  globalIgnores(
    [
      'spikes/',
      'test/fixtures/',
      'docs/',
      'dist/',
      'coverage/',
      'src/generated/',
      // Agents' git worktrees: full copies of the repo inside the maintainer's checkout.
      '.claude/',
    ],
    'jev/ignores',
  ),
  eslint.configs.recommended,
  {
    name: 'jev/typescript',
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ES §4: exhaustive switches over unions.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    name: 'jev/node',
    files: ['scripts/**', 'test/**', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  ...NO_TYPE_INFO_CONFIG,
);
