/**
 * The config the build embedded (Solution Design §7.2, §11), validated again
 * at load. Only `src/entry/` imports `virtual:generated-config`.
 *
 * A failure throws `ConfigError`. E7 calls this inside the per-run boundary,
 * which logs the failure, and E9 adds the `config_invalid` alert.
 */
import { EMBEDDED_CONFIG } from 'virtual:generated-config';

import { loadConfig } from '../config/loader.ts';
import type { Config } from '../config/schema.ts';

export function loadEmbeddedConfig(): Config {
  return loadConfig(EMBEDDED_CONFIG);
}
