/**
 * Reads and writes `state.jevErrorLabel` over `StatePort` (Solution Design
 * §7.3; epic #9 decision 11). The codec and the pure functions are in
 * `src/core/jev-error-label.ts`. They live apart because `core/` can't import
 * `ports/`.
 *
 * Nothing here logs: the caller does.
 */
import {
  addJevErrorLabelId,
  decodeJevErrorLabelIds,
  encodeJevErrorLabelIds,
  JEV_ERROR_LABEL_KEY,
} from '../core/jev-error-label.ts';
import type { StatePort } from '../ports/state-port.ts';

/**
 * The known `Jev/Error` label IDs, oldest first. An absent key returns `[]`
 * (no ID known yet: no removal matches, and nothing is skipped as
 * `jev_error`). A value that fails to decode throws `StateError`, and is never
 * reset or overwritten.
 */
export function readJevErrorLabelIds(state: StatePort): readonly string[] {
  const raw = state.get(JEV_ERROR_LABEL_KEY);
  return raw === undefined ? [] : decodeJevErrorLabelIds(raw);
}

/**
 * Remembers `id` as the newest `Jev/Error` label ID, and returns the new list.
 * Writes `state.jevErrorLabel` only when the list changed, so E6 can call it
 * every run without a write. E6 calls it whenever it creates or looks up
 * `Jev/Error`, **before** first adding the label to any thread. Throws
 * `StateError` before writing anything when the stored value fails to decode
 * or `id` is empty or over 200 characters.
 */
export function rememberJevErrorLabelId(state: StatePort, id: string): readonly string[] {
  const known = readJevErrorLabelIds(state);
  const next = addJevErrorLabelId(known, id);
  const changed = next.length !== known.length || next.some((value, i) => value !== known[i]);
  if (changed) {
    state.set(JEV_ERROR_LABEL_KEY, encodeJevErrorLabelIds(next));
  }
  return next;
}
