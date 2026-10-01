/**
 * The config the build embedded (Solution Design §7.2, §11), validated again
 * at load. Only `src/entry/` imports `virtual:generated-config`.
 *
 * A failure throws `ConfigError`. `runEntry` calls this inside the per-run
 * boundary, which logs `run.failed` and raises the `config_invalid` alert. The
 * alert mailer emails it, except for `uninstall` and `cancelManualRun`, which
 * only log (`src/entry/main.ts`).
 */
import { EMBEDDED_CONFIG } from 'virtual:generated-config';

import { loadConfig } from '../config/loader.ts';
import type { Config } from '../config/schema.ts';

export function loadEmbeddedConfig(): Config {
  return loadConfig(EMBEDDED_CONFIG);
}
