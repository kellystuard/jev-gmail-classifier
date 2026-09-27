import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DECLARED_SCOPES } from '../src/core/declared-scopes.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_TEXT = readFileSync(join(REPO_ROOT, 'appsscript.json'), 'utf8');

/** The full-Gmail scope as a complete string literal (ADR-0003). */
const FULL_GMAIL_SCOPE_LITERAL = /["'`]https:\/\/mail\.google\.com\/["'`]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('appsscript.json is not a JSON object');
  }
  return parsed;
}

/** The absolute path of every file under `src/`, skipping build output in `src/generated/`. */
function sourceFiles(): string[] {
  const srcDir = join(REPO_ROOT, 'src');
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(join(srcDir, 'generated')));
}

describe('appsscript.json', () => {
  const manifest = parseManifest(MANIFEST_TEXT);

  it('runs on V8 in UTC and logs exceptions to Cloud Logging', () => {
    expect(manifest['runtimeVersion']).toBe('V8');
    expect(manifest['timeZone']).toBe('Etc/UTC');
    expect(manifest['exceptionLogging']).toBe('STACKDRIVER');
  });

  it('enables exactly the Gmail advanced service, v1', () => {
    expect(manifest).toHaveProperty(
      ['dependencies', 'enabledAdvancedServices'],
      [{ userSymbol: 'Gmail', serviceId: 'gmail', version: 'v1' }],
    );
  });

  it('declares exactly DECLARED_SCOPES, in order', () => {
    expect(manifest['oauthScopes']).toEqual([...DECLARED_SCOPES]);
  });

  it('has no top-level keys beyond the expected five', () => {
    expect(Object.keys(manifest).sort()).toEqual(
      ['dependencies', 'exceptionLogging', 'oauthScopes', 'runtimeVersion', 'timeZone'].sort(),
    );
  });

  it('never mentions the full-Gmail scope', () => {
    expect(MANIFEST_TEXT).not.toContain('mail.google.com');
  });
});

describe('src/', () => {
  it('never contains the full-Gmail scope as a string literal', () => {
    const offenders = sourceFiles().filter((path) =>
      FULL_GMAIL_SCOPE_LITERAL.test(readFileSync(path, 'utf8')),
    );
    expect(offenders.map((path) => relative(REPO_ROOT, path))).toEqual([]);
  });
});
