/**
 * Reads and writes a list stored across numbered `state.*` keys (Solution
 * Design §7.3; epic #9 decisions 2 and 3). Sharding isn't a port method: it's
 * built here on `StatePort`'s `get`, `set`, `delete` and `keys`, with the pure
 * planning in `src/core/sharding.ts`.
 *
 * Nothing here logs: the caller does.
 */
import { StateError } from '../core/errors.ts';
import {
  joinShards,
  type PlannedShard,
  planShardWrites,
  shardIndex,
  shardKey,
  splitIntoShards,
} from '../core/sharding.ts';
import { STATE_VALUE_MAX_BYTES, utf8ByteLength } from '../core/state-limits.ts';
import type { JsonValue, StateKey, StatePort } from '../ports/state-port.ts';

/**
 * Encodes and decodes one shard, `{"v": <n>, "items": [...]}`. `encode` must
 * put each item into `items` as `JSON.stringify(item)` would write it, because
 * shards are sized from the items' own JSON text. A `StateCodec<{ items: T[] }>`
 * from `defineStateCodec` satisfies this type.
 */
export type ShardCodec<T> = {
  encode(value: { readonly items: readonly T[] }): JsonValue;
  decode(key: string, raw: unknown): { readonly items: readonly T[] };
};

export type ShardedListSpec<T> = {
  /** Ends with `.`, for example `state.queue.`. */
  readonly prefix: StateKey;
  readonly codec: ShardCodec<T>;
  /** An item's unique ID, used to remove duplicates and to plan safe writes. */
  readonly idOf: (item: T) => string;
  /** The most shards the list may use. More throws `StateError` `too_large`. */
  readonly maxShards: number;
};

/**
 * The stored list: every shard under the prefix, sorted by `n` numerically,
 * concatenated, with later duplicates removed by ID. After a save that stopped
 * part-way, the order can differ from the order saved; callers re-sort.
 *
 * Throws `StateError` `bad_key` for a key under the prefix that isn't a shard
 * number, `parse` for bad JSON, or whatever the codec throws. Nothing is reset.
 */
export function loadShardedList<T>(state: StatePort, spec: ShardedListSpec<T>): T[] {
  const shards = readShards(state, spec);
  return joinShards(
    spec.prefix,
    [...shards.values()].map(({ key, items }) => ({ key, items })),
    spec.idOf,
  );
}

/**
 * Saves `items` as the whole list. Unchanged shards aren't written, the writes
 * are ordered so that a save that stops after any step never loses a stored
 * item that is still in `items` (it may leave a duplicate, or bring back a
 * removed item), and surplus shards are deleted last. An empty list deletes
 * every shard.
 *
 * Throws `StateError` `too_large`, and writes nothing, when an item doesn't
 * fit in one shard or the list needs more than `spec.maxShards`. A throw from
 * the port (for example `store_full`) stops the save and propagates; the
 * steps already applied keep the guarantee above.
 */
export function saveShardedList<T>(
  state: StatePort,
  spec: ShardedListSpec<T>,
  items: readonly T[],
): void {
  const split = splitIntoShards(items, {
    prefix: spec.prefix,
    maxShards: spec.maxShards,
    envelopeBytes: utf8ByteLength(JSON.stringify(spec.codec.encode({ items: [] }))),
    itemText: (item) => JSON.stringify(item),
  });
  const values = split.map((shard) => spec.codec.encode({ items: shard }));
  const next = split.map((shard, n): PlannedShard<T> => {
    const text = JSON.stringify(values[n]);
    const bytes = utf8ByteLength(text);
    if (bytes > STATE_VALUE_MAX_BYTES) {
      // Only a codec that doesn't write items as `JSON.stringify` does gets here.
      throw new StateError(`Shard ${String(n)} under ${spec.prefix} is too large`, {
        key: shardKey(spec.prefix, n),
        reason: 'too_large',
        bytes,
        limit: STATE_VALUE_MAX_BYTES,
      });
    }
    return { text, items: shard };
  });

  const stored = readShards(state, spec);
  for (const step of planShardWrites(stored, next, spec.idOf)) {
    const key = shardKey(spec.prefix, step.n);
    if (step.op === 'delete') {
      state.delete(key);
    } else {
      // A new shard reuses the value it was measured with; a temporary one is encoded here.
      const measured = step.temporary ? undefined : values[step.n];
      state.set(key, measured ?? spec.codec.encode({ items: step.items }));
    }
  }
}

type StoredShard<T> = PlannedShard<T> & { readonly key: StateKey };

/** Every stored shard by `n`: its key, its JSON text as stored, and its decoded items. */
function readShards<T>(state: StatePort, spec: ShardedListSpec<T>): Map<number, StoredShard<T>> {
  const keys = state.keys(spec.prefix);
  // Check every key before reading any value, so a stray key is reported as such.
  const indexed = keys.map((key) => ({ key, n: shardIndex(spec.prefix, key) }));
  const shards = new Map<number, StoredShard<T>>();
  for (const { key, n } of indexed) {
    const raw = state.get(key);
    const { items } = spec.codec.decode(key, raw);
    // Text written by `JSON.stringify` round-trips through `JSON.parse`.
    shards.set(n, { key, text: JSON.stringify(raw), items });
  }
  return shards;
}
