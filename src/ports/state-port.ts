/** A key for persistent state. Only `state.*` keys hold JSON (ADR-0007). */
export type StateKey = `state.${string}`;

/** A JSON value, as `JSON.stringify` writes it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Script Properties, `PropertiesService.getScriptProperties()` (Solution
 * Design §5.2, §7.3; ADR-0007).
 *
 * - The JSON methods take only `state.*` keys. User inputs (`MANUAL_*`,
 *   `RESET_POSITION`) go through `getInput` and `deleteInput`, and
 *   `JEV_API_KEY` only through `SecretsPort`.
 * - Sizes are the UTF-8 byte length of the JSON text (`src/core/state-limits.ts`).
 *   A value over 9 KB, or a write that takes the store over 500 KB, throws
 *   `StateError` (`too_large` or `store_full`) and leaves the store unchanged.
 *   The store total counts keys and values: Google doesn't say whether keys
 *   count, so this is the conservative choice.
 * - The port only parses JSON. Callers check versions and shapes with Zod.
 * - **Sharding** (`state.queue.<n>`, the cap) is E3's, built on these
 *   methods. E3 decides whether it becomes a port method and updates SD §5.2.
 *
 * A failure the adapter doesn't recognize is thrown and reaches the per-run
 * boundary (SD §10.1).
 */
export interface StatePort {
  /** The parsed JSON value, or `undefined` if the key is absent. Throws `StateError` (`parse`) on bad JSON. */
  get(key: StateKey): unknown;

  /** Writes `value` as JSON. Throws `StateError` (`too_large` or `store_full`) and changes nothing if it doesn't fit. */
  set(key: StateKey, value: JsonValue): void;

  /** Deletes the key. Deleting an absent key does nothing. */
  delete(key: StateKey): void;

  /** Every `state.*` key that starts with `prefix`, sorted by code unit. */
  keys(prefix: StateKey): readonly StateKey[];

  /** A plain user input (`MANUAL_*`, `RESET_POSITION`), or `undefined` if unset. */
  getInput(name: string): string | undefined;

  /** Deletes a user input, for example once a manual run has read it. */
  deleteInput(name: string): void;
}
