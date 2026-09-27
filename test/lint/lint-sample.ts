/**
 * Lints a code sample with the repo's no-type-information lint blocks, so a
 * test can show that a restriction fires (or stays quiet) for a given path.
 *
 * Why not ESLint's `RuleTester`: the restrictions are configurations of
 * built-in rules, and `RuleTester` tests a rule's implementation, not our
 * configuration. The sample needn't exist on disk: `filePath` only decides
 * which blocks (layers) apply.
 */
import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { NO_TYPE_INFO_CONFIG } from '../../eslint.config.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Parses `.ts` files without type information, as the restriction rules need none. */
const PARSER_CONFIG: Linter.Config = {
  name: 'lint-sample/parser',
  files: ['**/*.ts'],
  languageOptions: { parser: tseslint.parser, sourceType: 'module' },
  plugins: { '@typescript-eslint': tseslint.plugin },
};

const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: true,
  overrideConfig: [PARSER_CONFIG, ...NO_TYPE_INFO_CONFIG],
});

export interface LintSampleMessage {
  /** `null` for a parse error. */
  readonly ruleId: string | null;
  readonly message: string;
}

/**
 * Lints `code` as if it were the file at `filePath` (relative to the repo
 * root, such as `src/core/sample.ts`) and returns the problems found.
 */
export async function lintSample(code: string, filePath: string): Promise<LintSampleMessage[]> {
  const results = await eslint.lintText(code, { filePath, warnIgnored: true });
  return results.flatMap((result) =>
    result.messages.map(({ ruleId, message }) => ({ ruleId, message })),
  );
}
