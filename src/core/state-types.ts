/**
 * Types for persistent state that `core/` reads. They live here because
 * `core/` can't import `ports/` (Solution Design §4.1, §5.2). `StatePort`
 * (`src/ports/state-port.ts`) re-exports them.
 */

/** A key for persistent state. Only `state.*` keys hold JSON (ADR-0007). */
export type StateKey = `state.${string}`;

/** A JSON value, as `JSON.stringify` writes it. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
