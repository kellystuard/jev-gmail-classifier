/**
 * `npm run build`: typecheck, then bundle into `dist/` (Solution Design §11).
 *
 * Each step is a named function, so later steps (config validation and code
 * generation, #42) slot in before the typecheck. On failure it prints one
 * line naming the step and exits 1.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { bundle, REPO_ROOT, resolveOutDir } from './bundle.ts';

const OUT_DIR = 'dist';

class StepFailed extends Error {}

function typecheck(): void {
  try {
    execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['--noEmit'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch {
    throw new StepFailed('typecheck: tsc --noEmit reported the errors above');
  }
}

async function bundleToDist(): Promise<void> {
  try {
    await bundle({ outDir: OUT_DIR });
  } catch (error) {
    // An esbuild failure carries `errors`, which esbuild has already printed.
    const fromEsbuild = error instanceof Error && 'errors' in error;
    const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    const summary = (firstLine ?? '').replace(/:$/, '') || 'unknown error';
    throw new StepFailed(`bundle: ${summary}${fromEsbuild ? ' (details above)' : ''}`);
  }
}

function reportOutputs(): void {
  const dir = resolveOutDir(OUT_DIR);
  for (const name of readdirSync(dir).sort()) {
    const kib = (statSync(join(dir, name)).size / 1024).toFixed(1);
    console.log(`  ${relative(REPO_ROOT, join(dir, name))}  ${kib} KiB`);
  }
}

async function main(): Promise<void> {
  typecheck();
  await bundleToDist();
  reportOutputs();
}

try {
  await main();
} catch (error) {
  const message = error instanceof StepFailed ? error.message : String(error);
  console.error(`Build failed: ${message}`);
  process.exitCode = 1;
}
