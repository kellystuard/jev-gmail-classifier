/**
 * `npm run probe`: the local Jev probe (Solution Design §12). The work is in
 * `probe-run.ts`; this file only wires in Node's I/O and sets the exit code.
 *
 *     npm run probe -- [--config <file>] [--show-state] [--json] [--env <file>] <file.eml>...
 *
 * It sends each `.eml`'s content to Jev with your key: use only mail you are
 * happy to send. It never prints the key.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { REPO_ROOT } from './bundle.ts';
import { runProbe } from './probe-run.ts';

function gitCommonDir(): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    // Not a git checkout, or no git: there is no main checkout to look in.
    return undefined;
  }
}

try {
  process.exitCode = await runProbe(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    readFile: (path) => readFileSync(path),
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
    cwd: process.cwd(),
    repoRoot: REPO_ROOT,
    gitCommonDir,
  });
} catch (error) {
  // A bug, not a bad file or response: runProbe reports those itself.
  console.error(`Probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
