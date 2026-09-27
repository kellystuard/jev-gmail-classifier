import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import { configSchema, type Config } from '../../src/config/schema.ts';

const EXAMPLE_FILE = join(REPO_ROOT, 'config.example.yaml');
const text = readFileSync(EXAMPLE_FILE, 'utf8');
const raw: unknown = parse(text);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('config.example.yaml', () => {
  it('points editors at config.schema.json on its first line', () => {
    expect(text.split('\n')[0]).toBe('# yaml-language-server: $schema=./config.schema.json');
  });

  it('is valid under the schema', () => {
    const result = configSchema.safeParse(raw);
    expect(result.error?.issues).toBeUndefined();
  });

  it('sets every top-level field explicitly, including those with defaults', () => {
    expect(isRecord(raw)).toBe(true);
    const written = Object.keys(isRecord(raw) ? raw : {}).sort();
    expect(written).toEqual(Object.keys(configSchema.shape).sort());
  });

  describe('rules', () => {
    const config: Config = configSchema.parse(raw);

    it('include a label rule and a move rule', () => {
      expect(config.rules.some((rule) => rule.action === 'label')).toBe(true);
      expect(config.rules.some((rule) => rule.action === 'move')).toBe(true);
    });

    it('include a label: destination and an archive destination', () => {
      const kinds = config.rules.flatMap((rule) =>
        rule.action === 'move' ? [rule.destination.kind] : [],
      );
      expect(kinds).toContain('label');
      expect(kinds).toContain('archive');
    });

    it('never report or delete mail when copied as-is (no spam or trash)', () => {
      const kinds = config.rules.flatMap((rule) =>
        rule.action === 'move' ? [rule.destination.kind] : [],
      );
      expect(kinds).not.toContain('spam');
      expect(kinds).not.toContain('trash');
    });

    it('include a per-rule threshold, and a high one on every move rule', () => {
      expect(config.rules.some((rule) => rule.threshold !== undefined)).toBe(true);
      for (const rule of config.rules) {
        if (rule.action === 'move') {
          expect(rule.threshold, rule.id).toBeGreaterThanOrEqual(0.9);
        }
      }
    });

    it('use .example domains only in excludeQuery', () => {
      const domains = config.excludeQuery?.match(/[a-z0-9-]+(\.[a-z0-9-]+)+/gi) ?? [];
      for (const domain of domains) {
        expect(domain).toMatch(/\.example$/);
      }
    });
  });
});
