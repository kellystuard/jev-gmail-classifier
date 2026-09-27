import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import { GENERATED_CONFIG_FILE } from '../../scripts/generated-config.ts';

/** A fingerprint of a file or directory tree: paths, sizes, mtimes and contents. */
function fingerprint(path: string): string {
  if (!existsSync(path)) {
    return 'absent';
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    return `${String(stat.mtimeMs)}:${readFileSync(path).toString('base64')}`;
  }
  return JSON.stringify(
    readdirSync(path)
      .sort()
      .map((name) => [name, fingerprint(join(path, name))]),
  );
}

/** Runs `npm run build` the way npm does, with the given arguments. */
function runBuild(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['scripts/build.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('npm run build (end to end, failing before any output)', () => {
  const outputs = [join(REPO_ROOT, 'dist'), join(REPO_ROOT, GENERATED_CONFIG_FILE)];

  it('fails on an invalid config with exit 1 and the field paths, touching nothing', () => {
    const before = outputs.map(fingerprint);
    const result = runBuild(['--config', 'test/fixtures/config/three-errors.yaml']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Build failed: config: test/fixtures/config/three-errors.yaml is invalid:',
    );
    expect(result.stderr).toContain('  defaultThreshold: must be a number from 0 to 1');
    expect(result.stderr).toContain('  rules[1].destination: ');
    expect(result.stderr).toContain('  rules[1].treshold: ');
    // The config step comes before the typecheck.
    expect(result.stdout).toBe('');
    expect(outputs.map(fingerprint)).toEqual(before);
  });

  it('names a --config file that does not exist', () => {
    const result = runBuild(['--config', 'test/fixtures/config/no-such-file.yaml']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Build failed: config: Config file test/fixtures/config/no-such-file.yaml not found.',
    );
  });

  it('rejects an unknown argument', () => {
    const result = runBuild(['--confg', 'config.yaml']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^Build failed: arguments: .*--confg/);
  });
});
