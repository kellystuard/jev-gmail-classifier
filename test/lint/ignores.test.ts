import { join } from 'node:path';

import { ESLint } from 'eslint';
import { getFileInfo } from 'prettier';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './lint-sample.ts';

// Paths E2's tooling must never lint or reformat (epic #8, "Repository state").
const IGNORED_BY_BOTH = [
  'spikes/run.mjs',
  'test/fixtures/gmail/01-plain-utf8-7bit.json',
  'docs/archive/notes.ts',
  'dist/Code.js',
  'coverage/index.js',
  'src/generated/config.ts',
  '.claude/worktrees/copy/src/core/result.ts',
];

describe('lint ignores', () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });

  it.each(IGNORED_BY_BOTH)('ESLint ignores %s', async (path) => {
    expect(await eslint.isPathIgnored(join(REPO_ROOT, path))).toBe(true);
  });

  it('ESLint lints src/', async () => {
    expect(await eslint.isPathIgnored(join(REPO_ROOT, 'src/entry/main.ts'))).toBe(false);
  });
});

describe('format ignores', () => {
  const ignorePath = [join(REPO_ROOT, '.gitignore'), join(REPO_ROOT, '.prettierignore')];

  it.each([...IGNORED_BY_BOTH, 'README.md', 'output/solution-design.md', 'package-lock.json'])(
    'Prettier ignores %s',
    async (path) => {
      expect((await getFileInfo(join(REPO_ROOT, path), { ignorePath })).ignored).toBe(true);
    },
  );

  it.each(['src/entry/main.ts', '.github/dependabot.yml', 'package.json'])(
    'Prettier checks %s',
    async (path) => {
      expect((await getFileInfo(join(REPO_ROOT, path), { ignorePath })).ignored).toBe(false);
    },
  );
});
