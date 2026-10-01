/**
 * `node scripts/pilot-measures.ts`: the pilot log reducer (task #315). The
 * work is in `pilot-measures-run.ts`; this file only wires in Node's I/O and
 * sets the exit code. It prints numbers only (see that file's header).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { REPO_ROOT } from './bundle.ts';
import { runPilotMeasures } from './pilot-measures-run.ts';

/** True when `dir`, or its nearest existing parent, is inside a git work tree. */
function isInGitWorkTree(dir: string): boolean {
  let probe = dir;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const out = execFileSync('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'true';
  } catch {
    // Not a git work tree, or no git.
    return false;
  }
}

try {
  process.exitCode = runPilotMeasures(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (line) => {
      console.error(line);
    },
    cwd: process.cwd(),
    repoRoot: REPO_ROOT,
    isInGitWorkTree,
  });
} catch {
  // A bug, not a bad file: the message could quote a file, so it is not printed.
  console.error('The pilot reducer failed unexpectedly.');
  process.exitCode = 1;
}
