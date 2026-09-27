import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import {
  MISSING_DEFAULT_CONFIG,
  parseConfigText,
  readConfig,
  type ConfigSourceResult,
} from '../../scripts/config-source.ts';

const FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'config');

function readFixture(name: string): ConfigSourceResult {
  return readConfig(join(FIXTURES, name), { isDefault: false, displayName: name });
}

describe('readConfig', () => {
  it('returns the raw YAML data of a valid file, without defaults or transforms', () => {
    const result = readFixture('valid.yaml');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.raw).toMatchObject({
        defaultThreshold: 0.8,
        rules: [
          { id: 'fixture-approval', label: 'Approval Required' },
          { id: 'fixture-bill', label: 'Finance/Bill', threshold: 0.9 },
          // The raw string, not the parsed `MoveDestination`: the runtime parses it again.
          { id: 'fixture-newsletter', action: 'move', destination: 'label:Newsletters' },
        ],
      });
      // A default the schema would add is not added here.
      expect(result.raw).not.toHaveProperty('rules.0.action');
    }
  });

  it('shows the line and column of a YAML syntax error', () => {
    expect(readFixture('syntax-error.yaml')).toEqual({
      ok: false,
      kind: 'yaml',
      lines: ['syntax-error.yaml:7:18: Nested mappings are not allowed in compact mappings'],
    });
  });

  it('rejects a duplicate key', () => {
    expect(readFixture('duplicate-key.yaml')).toEqual({
      ok: false,
      kind: 'yaml',
      lines: ['duplicate-key.yaml:7:1: Map keys must be unique'],
    });
  });

  it('rejects an empty file', () => {
    expect(readFixture('empty.yaml')).toEqual({
      ok: false,
      kind: 'empty',
      lines: ['empty.yaml is empty. Copy config.example.yaml and edit your rules.'],
    });
  });

  it.each(['# only a comment\n', '---\n', '~\n'])('treats %j as empty', (text) => {
    expect(parseConfigText(text, 'c.yaml')).toMatchObject({ ok: false, kind: 'empty' });
  });

  it('rejects more than one YAML document', () => {
    expect(readFixture('two-documents.yaml')).toEqual({
      ok: false,
      kind: 'multiple_documents',
      lines: [
        'two-documents.yaml:7:1: the file holds more than one YAML document (---); keep one',
      ],
    });
  });

  it('prints every schema error as path: message, under a header', () => {
    expect(readFixture('three-errors.yaml')).toEqual({
      ok: false,
      kind: 'invalid',
      lines: [
        'three-errors.yaml is invalid:',
        '  defaultThreshold: must be a number from 0 to 1',
        '  rules[1].destination: must be archive, spam, trash or label:<name>',
        '  rules[1].treshold: unknown field; check the spelling against config.example.yaml',
      ],
    });
  });

  it('reports a file that is not a mapping at the root', () => {
    expect(parseConfigText('just a string\n', 'c.yaml')).toMatchObject({
      ok: false,
      kind: 'invalid',
      lines: ['c.yaml is invalid:', expect.stringMatching(/^ {2}\(root\): must be a set of settings/)],
    });
  });

  it('tells the user to copy the example when the default config.yaml is missing', () => {
    const result = readConfig(join(FIXTURES, 'no-such-file.yaml'), {
      isDefault: true,
      displayName: 'config.yaml',
    });
    expect(result).toEqual({ ok: false, kind: 'not_found', lines: [MISSING_DEFAULT_CONFIG] });
    expect(MISSING_DEFAULT_CONFIG).toContain('Copy config.example.yaml to config.yaml');
    expect(MISSING_DEFAULT_CONFIG).toContain('npm run build -- --config config.example.yaml');
  });

  it('names the missing file when --config points nowhere', () => {
    expect(readConfig('missing/other.yaml', { isDefault: false })).toEqual({
      ok: false,
      kind: 'not_found',
      lines: ['Config file missing/other.yaml not found.'],
    });
  });

  it('reports a path it cannot read as a file', () => {
    expect(readConfig(FIXTURES, { isDefault: false, displayName: 'fixtures' })).toEqual({
      ok: false,
      kind: 'unreadable',
      lines: ['Cannot read config file fixtures: EISDIR'],
    });
  });
});
