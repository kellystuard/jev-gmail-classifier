/**
 * The config the build embedded, as raw data (Solution Design §11). E2
 * placeholder: #43 replaces this with `loadEmbeddedConfig()`, which validates
 * it again and returns a frozen `Config`.
 */
import { EMBEDDED_CONFIG } from 'virtual:generated-config';

export function embeddedConfig(): unknown {
  return EMBEDDED_CONFIG;
}
