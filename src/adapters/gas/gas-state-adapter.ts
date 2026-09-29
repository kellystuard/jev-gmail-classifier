/**
 * `GasStateAdapter`: `StatePort` over Script Properties (Solution Design §3,
 * §5.2, §7.3; ADR-0007). The key rules and size limits are the ones
 * `FakeState` enforces, from `src/core/state-rules.ts`. Sharding isn't the
 * adapter's job: `src/app/sharded-state.ts` builds it on the six methods.
 *
 * **How it knows the store's size.** Script Properties has one 500 KB limit
 * for everything in it: `state.*` keys, user inputs and `JEV_API_KEY`. On the
 * first call of any method, the adapter reads the whole store once with
 * `getProperties()` into a map, and keeps the running total from then on.
 * Reads are served from the map. `set`, `delete` and `deleteInput` write
 * through to Script Properties first, then update the map and the total: if the
 * write throws, the map is unchanged. A `getProperties()` per `set` would read
 * up to 500 KB for each shard written.
 *
 * **Assumption.** Only one execution runs at a time, under the script lock
 * (ADR-0008), so nothing else writes `state.*` while an execution runs.
 * **E7 must take the lock before the first state call.** The user may edit a
 * property by hand in Project Settings mid-run. That's a few bytes at most, and
 * a `MANUAL_*` value is read by the next execution.
 *
 * Build one per execution (`src/entry/`), and don't keep it in a module-level
 * variable: the snapshot is only valid for one execution.
 *
 * Anything Apps Script throws (a service error, or Google's own limit error if
 * the store was changed outside the adapter) isn't caught. It reaches the
 * per-run boundary (SD §10.1). The adapter doesn't log, and it never exposes a
 * property value except through the port methods. It can't read `JEV_API_KEY`,
 * because `assertInputName` rejects it.
 */
import {
  assertInputName,
  assertStateKey,
  checkStateWrite,
  parseStateText,
  propertyBytes,
} from '../../core/state-rules.ts';
import type { JsonValue, StateKey, StatePort } from '../../ports/state-port.ts';

/** `PropertiesService.getScriptProperties()`, the methods this file uses. */
interface ScriptProperties {
  getProperties(): Record<string, string>;
  setProperty(key: string, value: string): void;
  deleteProperty(key: string): void;
}

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const PropertiesService: {
  getScriptProperties(): ScriptProperties;
};

export class GasStateAdapter implements StatePort {
  private readonly properties: ScriptProperties;
  private snapshot: Map<string, string> | undefined;
  private totalBytes: number;

  constructor() {
    this.properties = PropertiesService.getScriptProperties();
    this.snapshot = undefined;
    this.totalBytes = 0;
  }

  get(key: StateKey): unknown {
    assertStateKey(key);
    const text = this.store().get(key);
    return text === undefined ? undefined : parseStateText(key, text);
  }

  set(key: StateKey, value: JsonValue): void {
    assertStateKey(key);
    const store = this.store();
    const text = JSON.stringify(value);
    const total = checkStateWrite(key, text, this.totalBytes, this.currentBytes(key));
    this.properties.setProperty(key, text);
    store.set(key, text);
    this.totalBytes = total;
  }

  delete(key: StateKey): void {
    assertStateKey(key);
    this.remove(key);
  }

  keys(prefix: StateKey): readonly StateKey[] {
    assertStateKey(prefix);
    return [...this.store().keys()].filter((k): k is StateKey => k.startsWith(prefix)).sort();
  }

  getInput(name: string): string | undefined {
    assertInputName(name);
    return this.store().get(name);
  }

  deleteInput(name: string): void {
    assertInputName(name);
    this.remove(name);
  }

  /** Deletes `name` if it's stored. An absent name doesn't call Apps Script. */
  private remove(name: string): void {
    const store = this.store();
    if (!store.has(name)) {
      return;
    }
    const bytes = this.currentBytes(name);
    this.properties.deleteProperty(name);
    store.delete(name);
    this.totalBytes -= bytes;
  }

  private currentBytes(key: string): number {
    const text = this.store().get(key);
    return text === undefined ? 0 : propertyBytes(key, text);
  }

  /** The snapshot, read from Script Properties once, on first use. */
  private store(): Map<string, string> {
    if (this.snapshot === undefined) {
      const map = new Map<string, string>();
      let total = 0;
      for (const [key, text] of Object.entries(this.properties.getProperties())) {
        map.set(key, text);
        total += propertyBytes(key, text);
      }
      this.snapshot = map;
      this.totalBytes = total;
    }
    return this.snapshot;
  }
}
