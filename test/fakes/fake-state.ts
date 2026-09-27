import { StateError, type StateErrorReason } from '../../src/core/errors.ts';
import {
  STATE_STORE_MAX_BYTES,
  STATE_VALUE_MAX_BYTES,
  utf8ByteLength,
} from '../../src/core/state-limits.ts';
import type { JsonValue, StateKey, StatePort } from '../../src/ports/state-port.ts';
import { type FailNextOptions, type FakeCall, FailureQueue } from './failure-queue.ts';

type StateMethod = 'get' | 'set' | 'delete' | 'keys' | 'getInput' | 'deleteInput';

const STATE_PREFIX = 'state.';
const SECRET_KEY = 'JEV_API_KEY';

/**
 * Script Properties: one map of property names to strings. `state.*` keys hold
 * JSON; other names are plain user inputs. It enforces the 9 KB value and
 * 500 KB store limits (Solution Design §3), counting keys plus values in UTF-8
 * bytes, and leaves the store unchanged when a write fails.
 */
export class FakeState implements StatePort {
  readonly calls: FakeCall<StateMethod>[] = [];
  private readonly store = new Map<string, string>();
  private readonly failures = new FailureQueue<StateMethod, never>();

  get(key: StateKey): unknown {
    this.begin('get', [key]);
    assertStateKey(key);
    const text = this.store.get(key);
    if (text === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw stateError(`Invalid JSON in ${key}`, key, 'parse', {}, cause);
    }
  }

  set(key: StateKey, value: JsonValue): void {
    this.begin('set', [key, value]);
    assertStateKey(key);
    const text = JSON.stringify(value);
    const bytes = utf8ByteLength(text);
    if (bytes > STATE_VALUE_MAX_BYTES) {
      throw stateError(`Value for ${key} is too large`, key, 'too_large', {
        bytes,
        limit: STATE_VALUE_MAX_BYTES,
      });
    }
    const total = this.bytesUsed() - this.entryBytes(key) + utf8ByteLength(key) + bytes;
    if (total > STATE_STORE_MAX_BYTES) {
      throw stateError(`Writing ${key} would fill the store`, key, 'store_full', {
        bytes: total,
        limit: STATE_STORE_MAX_BYTES,
      });
    }
    this.store.set(key, text);
  }

  delete(key: StateKey): void {
    this.begin('delete', [key]);
    assertStateKey(key);
    this.store.delete(key);
  }

  keys(prefix: StateKey): readonly StateKey[] {
    this.begin('keys', [prefix]);
    assertStateKey(prefix);
    return [...this.store.keys()].filter((k): k is StateKey => k.startsWith(prefix)).sort();
  }

  getInput(name: string): string | undefined {
    this.begin('getInput', [name]);
    assertInputName(name);
    return this.store.get(name);
  }

  deleteInput(name: string): void {
    this.begin('deleteInput', [name]);
    assertInputName(name);
    this.store.delete(name);
  }

  /** Makes the next call(s) to `method` throw `error`, before anything changes. */
  failNext(method: StateMethod, error: Error, options: FailNextOptions = {}): void {
    this.failures.add(method, error, options);
  }

  /** Stores `text` as it is, for example bad JSON or an old version. No limits are checked. */
  seedRaw(key: string, text: string): void {
    this.store.set(key, text);
  }

  seedInput(name: string, value: string): void {
    assertInputName(name);
    this.store.set(name, value);
  }

  /** Every property, as stored text. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  /** The store's size: every key plus every value, in UTF-8 bytes. */
  bytesUsed(): number {
    let total = 0;
    for (const [key, value] of this.store) {
      total += utf8ByteLength(key) + utf8ByteLength(value);
    }
    return total;
  }

  private entryBytes(key: string): number {
    const value = this.store.get(key);
    return value === undefined ? 0 : utf8ByteLength(key) + utf8ByteLength(value);
  }

  private begin(method: StateMethod, args: readonly unknown[]): void {
    this.calls.push({ method, args });
    this.failures.take(method);
  }
}

function assertStateKey(key: string): void {
  if (!key.startsWith(STATE_PREFIX)) {
    throw stateError(`${key} isn't a state.* key`, key, 'bad_key');
  }
}

function assertInputName(name: string): void {
  if (name.startsWith(STATE_PREFIX) || name === SECRET_KEY) {
    throw stateError(`${name} isn't a user input`, name, 'bad_key');
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
