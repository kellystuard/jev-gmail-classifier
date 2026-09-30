/**
 * `GasSecretsAdapter`: `SecretsPort` over the `JEV_API_KEY` Script Property
 * (Solution Design §5.2, §7.3; epic #11 decision 9).
 *
 * It reads the property on every call, with no cache, so a key the user
 * changes takes effect at the next call. The key is never logged or put in an
 * error message (Engineering Standards §6); the adapter doesn't log at all.
 * Anything Apps Script throws reaches the per-run boundary (SD §10.1).
 */
import type { SecretsPort } from '../../ports/secrets-port.ts';

/** The Script Property that holds the key. */
const JEV_API_KEY_PROPERTY = 'JEV_API_KEY';

/** `PropertiesService.getScriptProperties()`, the method this file uses. */
interface ScriptProperties {
  getProperty(key: string): string | null;
}

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const PropertiesService: {
  getScriptProperties(): ScriptProperties;
};

/** The key trimmed, or `undefined` when it's unset (`null`) or blank. */
export function normalizeApiKey(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export class GasSecretsAdapter implements SecretsPort {
  getJevApiKey(): string | undefined {
    return normalizeApiKey(
      PropertiesService.getScriptProperties().getProperty(JEV_API_KEY_PROPERTY),
    );
  }
}
