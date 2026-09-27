/**
 * Builds the lint restriction blocks (Engineering Standards §3, §4).
 *
 * In flat config, a rule's options in a later matching block replace the
 * earlier ones instead of merging with them. So each of the four restriction
 * rules must be set once per file, with the full list for that file. This
 * module does that: `layers.ts` (#38) and `v8-bans.ts` (#39) only declare
 * lists, and `buildRestrictionConfig()` concatenates them into one block per
 * target. `eslint.config.ts` places these blocks after every other block, so
 * nothing can replace their options.
 */
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { EVERYWHERE, LAYERS } from './layers.ts';
import { SRC_RUNTIME_BANS } from './v8-bans.ts';

/** A global variable that may not be referenced (`no-restricted-globals`). */
export interface GlobalRestriction {
  readonly name: string;
  readonly message: string;
}

/** An object property that may not be used (`no-restricted-properties`). */
export interface PropertyRestriction {
  readonly object?: string;
  readonly property?: string;
  readonly message: string;
}

/** An AST selector that may not match (`no-restricted-syntax`). */
export interface SyntaxRestriction {
  readonly selector: string;
  readonly message: string;
}

interface ImportRestrictionBase {
  readonly message: string;
  /** Allow `import type` of this path or pattern. */
  readonly allowTypeImports?: boolean;
  readonly importNames?: readonly string[];
}

/** An exact module specifier (`paths` of `@typescript-eslint/no-restricted-imports`). */
export interface PathImportRestriction extends ImportRestrictionBase {
  readonly name: string;
}

/** Gitignore-style specifier patterns (`patterns[].group`). */
export interface GroupImportRestriction extends ImportRestrictionBase {
  readonly group: readonly string[];
}

/** A regular expression over the specifier (`patterns[].regex`). */
export interface RegexImportRestriction extends ImportRestrictionBase {
  readonly regex: string;
}

export type ImportRestriction =
  PathImportRestriction | GroupImportRestriction | RegexImportRestriction;

/** The four restriction lists one target contributes. */
export interface Restrictions {
  readonly globals: readonly GlobalRestriction[];
  readonly properties: readonly PropertyRestriction[];
  readonly syntax: readonly SyntaxRestriction[];
  readonly imports: readonly ImportRestriction[];
}

/** A set of files that shares one set of restrictions, such as a layer folder. */
export interface LintTarget {
  /** Shown as the block name in `eslint --print-config` and the config inspector. */
  readonly name: string;
  readonly files: readonly string[];
  readonly ignores?: readonly string[];
  /** Whether the files are in `src/`, so they also get `SRC_RUNTIME_BANS`. */
  readonly inSrc: boolean;
  /** Marks the target whose lists also apply to `src/` files outside every layer folder. */
  readonly strictest?: boolean;
  readonly restrictions: Restrictions;
}

export const NO_RESTRICTIONS: Restrictions = {
  globals: [],
  properties: [],
  syntax: [],
  imports: [],
};

/** Every file ESLint lints. `EVERYWHERE` applies to all of them. */
export const ALL_LINTED_FILES: readonly string[] = ['**/*.ts', '**/*.js', '**/*.mjs', '**/*.cjs'];

/** The fallback for `src/` files that no layer target matches. */
export const SRC_FILES: readonly string[] = ['src/**/*.ts'];

/** The restriction rules every block sets. Tests use it to check no other block sets them. */
export const RESTRICTION_RULES: readonly string[] = [
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-syntax',
  '@typescript-eslint/no-restricted-imports',
];

/** Concatenates restriction lists. */
export function combineRestrictions(...lists: readonly Restrictions[]): Restrictions {
  return {
    globals: lists.flatMap((r) => r.globals),
    properties: lists.flatMap((r) => r.properties),
    syntax: lists.flatMap((r) => r.syntax),
    imports: lists.flatMap((r) => r.imports),
  };
}

function isPath(restriction: ImportRestriction): restriction is PathImportRestriction {
  return 'name' in restriction;
}

/** The rule settings for one block: all four rules, with the full lists. */
export function restrictionRules(restrictions: Restrictions): Linter.RulesRecord {
  return {
    // The typescript-eslint version supports `allowTypeImports`.
    'no-restricted-imports': 'off',
    'no-restricted-globals': ['error', ...restrictions.globals],
    'no-restricted-properties': ['error', ...restrictions.properties],
    'no-restricted-syntax': ['error', ...restrictions.syntax],
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        paths: restrictions.imports.filter(isPath),
        patterns: restrictions.imports.filter((r) => !isPath(r)),
      },
    ],
  };
}

function block(
  name: string,
  files: readonly string[],
  ignores: readonly string[] | undefined,
  restrictions: Restrictions,
): Linter.Config {
  return {
    name: `jev/restrictions/${name}`,
    files: [...files],
    ...(ignores === undefined ? {} : { ignores: [...ignores] }),
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: restrictionRules(restrictions),
  };
}

/**
 * The restriction blocks, in order:
 *
 * 1. `EVERYWHERE`, for every linted file.
 * 2. A fallback for all of `src/`, with the strictest target's lists, so a
 *    file outside every layer folder gets the strictest rules.
 * 3. One block per target, with its own lists plus `SRC_RUNTIME_BANS` (for
 *    `src/` targets) plus `EVERYWHERE`.
 *
 * A later block replaces an earlier one's options for the files it matches,
 * which is why every block carries the complete lists.
 */
export function buildRestrictionConfig(
  layers: readonly LintTarget[] = LAYERS,
  srcRuntimeBans: Restrictions = SRC_RUNTIME_BANS,
  everywhere: Restrictions = EVERYWHERE,
): Linter.Config[] {
  const strictest = layers.find((target) => target.strictest === true);
  return [
    block('everywhere', ALL_LINTED_FILES, undefined, everywhere),
    block(
      'src-fallback',
      SRC_FILES,
      undefined,
      combineRestrictions(strictest?.restrictions ?? NO_RESTRICTIONS, srcRuntimeBans, everywhere),
    ),
    ...layers.map((target) =>
      block(
        target.name,
        target.files,
        target.ignores,
        combineRestrictions(
          target.restrictions,
          target.inSrc ? srcRuntimeBans : NO_RESTRICTIONS,
          everywhere,
        ),
      ),
    ),
  ];
}
