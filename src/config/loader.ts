/**
 * The runtime config loader (Solution Design §5.1, §7.2; ADR-0013).
 *
 * The build validated the config and embedded the raw YAML data. The script
 * validates it again here with the same schema, so a hand-edited or stale
 * bundle can't run with an invalid config. Defaults and the `destination`
 * transform apply here, in one place.
 */
import { ConfigError } from '../core/errors.ts';
import { configIssues } from './issues.ts';
import { configSchema, type Config } from './schema.ts';

/** Freezes `value` and every object and array inside it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates `raw` with the config schema and returns it deeply frozen.
 *
 * Throws `ConfigError`, listing every issue by field path, when `raw` is
 * invalid: that is invalid state (SD §10.1). The messages never quote the
 * value of `excludeQuery` or a `question` (see `schema.ts`).
 */
export function loadConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(configIssues(result.error));
  }
  return deepFreeze(result.data);
}
