/**
 * `config.schema.json`: the JSON Schema editors use to check `config.yaml`
 * (Solution Design §7.2). Generated from `configSchema`, committed, and
 * rewritten by every `npm run build`. It lives in `scripts/`, so it never
 * reaches the bundle.
 *
 * JSON Schema can't express the schema's refinements (label-name rules,
 * unique rule IDs, the `label`/`destination` cross-field rules), so editors
 * check the shape and the build checks the rest.
 */
import { z } from 'zod';

import { configSchema } from '../src/config/schema.ts';

/** The committed file, relative to the repo root. */
export const CONFIG_JSON_SCHEMA_FILE = 'config.schema.json';

/** The file's full text: the schema as 2-space JSON, with a final newline. */
export function configJsonSchemaText(): string {
  // `io: 'input'` makes fields with defaults optional, which is what a user writes.
  const { $schema, ...rest } = z.toJSONSchema(configSchema, { io: 'input', target: 'draft-7' });
  const document = {
    $schema,
    title: 'jev-gmail-classifier config.yaml',
    description:
      'Generated from src/config/schema.ts by npm run build. Do not edit. Editors check the ' +
      'shape; the build also checks label names, unique rule ids and the label/destination rules.',
    ...rest,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
