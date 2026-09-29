/**
 * The Script Properties key rules and size limits (Solution Design §3, §5.2,
 * §7.3; ADR-0007). `GasStateAdapter` and `FakeState` both call these, so app
 * code tested against the fake behaves the same in Apps Script. Sizes are
 * UTF-8 bytes (`./state-limits.ts`).
 *
 * No message contains a stored value: they name the key and the sizes only.
 */
import { StateError, type StateErrorReason } from './errors.ts';
import { STATE_STORE_MAX_BYTES, STATE_VALUE_MAX_BYTES, utf8ByteLength } from './state-limits.ts';

const STATE_PREFIX = 'state.';
const SECRET_KEY = 'JEV_API_KEY';

/** Throws `StateError` (`bad_key`) unless `key` starts with `state.`. */
export function assertStateKey(key: string): void {
  if (!key.startsWith(STATE_PREFIX)) {
    throw stateError(`${key} isn't a state.* key`, key, 'bad_key');
  }
}

/**
 * Throws `StateError` (`bad_key`) if `name` starts with `state.` or is
 * `JEV_API_KEY`: the key is only read through `SecretsPort`.
 */
export function assertInputName(name: string): void {
  if (name.startsWith(STATE_PREFIX) || name === SECRET_KEY) {
    throw stateError(`${name} isn't a user input`, name, 'bad_key');
  }
}

/** What one property counts toward the store's 500 KB: its key plus its value. */
export function propertyBytes(key: string, text: string): number {
  return utf8ByteLength(key) + utf8ByteLength(text);
}

/**
 * Checks a write of `text` to `key` before anything is written.
 *
 * @param storeBytes the whole store's size now (every key and value)
 * @param currentBytes `propertyBytes` of the key's current value, 0 if absent
 * @returns the store's size after the write
 * @throws `StateError` `too_large` if `text` is over 9 KB, or `store_full` if
 *   the store would go over 500 KB
 */
export function checkStateWrite(
  key: string,
  text: string,
  storeBytes: number,
  currentBytes: number,
): number {
  const bytes = utf8ByteLength(text);
  if (bytes > STATE_VALUE_MAX_BYTES) {
    throw stateError(`Value for ${key} is too large`, key, 'too_large', {
      bytes,
      limit: STATE_VALUE_MAX_BYTES,
    });
  }
  const total = storeBytes - currentBytes + utf8ByteLength(key) + bytes;
  if (total > STATE_STORE_MAX_BYTES) {
    throw stateError(`Writing ${key} would fill the store`, key, 'store_full', {
      bytes: total,
      limit: STATE_STORE_MAX_BYTES,
    });
  }
  return total;
}

/**
 * Parses stored JSON text. Throws `StateError` (`parse`) with the parse error
 * as `cause`. The message names the key, never the text.
 */
export function parseStateText(key: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw stateError(`Invalid JSON in ${key}`, key, 'parse', {}, cause);
  }
}

function stateError(
  message: string,
  key: string,
  reason: StateErrorReason,
  sizes: { bytes?: number; limit?: number } = {},
  cause?: unknown,
): StateError {
  return new StateError(message, { key, reason, ...sizes }, { cause });
}
