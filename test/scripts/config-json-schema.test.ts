import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import { CONFIG_JSON_SCHEMA_FILE, configJsonSchemaText } from '../../scripts/config-json-schema.ts';

describe('config.schema.json', () => {
  it('matches the schema it is generated from', () => {
    const committed = readFileSync(join(REPO_ROOT, CONFIG_JSON_SCHEMA_FILE), 'utf8');
    // A plain comparison, so the failure message says what to do rather than
    // printing a diff of the whole file.
    const upToDate = committed === configJsonSchemaText();
    expect(upToDate, 'config.schema.json is out of date: run npm run build and commit it').toBe(
      true,
    );
  });

  it('is a draft-7 schema with a title, where fields with defaults are optional', () => {
    const schema: unknown = JSON.parse(configJsonSchemaText());
    expect(schema).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'jev-gmail-classifier config.yaml',
      type: 'object',
      required: ['defaultThreshold', 'rules'],
      additionalProperties: false,
    });
  });
});
