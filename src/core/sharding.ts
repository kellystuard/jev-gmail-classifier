/**
 * Pure planning for lists stored across numbered Script Properties keys
 * (Solution Design §7.3; epic #9 decisions 2 and 3). `src/app/sharded-state.ts`
 * does the reads and writes over `StatePort`.
 *
 * - A list lives under `<prefix><n>`, `n` = 0, 1, 2, …, and the prefix ends
 *   with `.` (`state.queue.0`, `state.queue.1`, …).
 * - Each shard's JSON text is at most `STATE_VALUE_MAX_BYTES` UTF-8 bytes.
 * - Reads sort shards by `n` numerically and drop later duplicates by ID.
 * - Writes follow `planShardWrites`, so a save that stops after any step
 *   never loses a stored item that is still in the list.
 */
import { StateError } from './errors.ts';
import { STATE_VALUE_MAX_BYTES, utf8ByteLength } from './state-limits.ts';

/** `0`, or a number with no leading zero. */
const SHARD_INDEX = /^(0|[1-9][0-9]*)$/;

/** The key of shard `n`: `` `${prefix}${n}` ``. */
export function shardKey<P extends string>(prefix: P, n: number): `${P}${string}` {
  return `${prefix}${String(n)}`;
}

/**
 * The shard number in `key`. The part after `prefix` must be `0` or a number
 * with no leading zero. Anything else is invalid state, never skipped: it
 * throws `StateError` `bad_key`.
 */
export function shardIndex(prefix: string, key: string): number {
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
  if (rest === undefined || !SHARD_INDEX.test(rest)) {
    throw new StateError(`${key} isn't a shard key under ${prefix}`, { key, reason: 'bad_key' });
  }
  const n = Number(rest);
  if (!Number.isSafeInteger(n)) {
    throw new StateError(`${key} has a shard number that's too large`, { key, reason: 'bad_key' });
  }
  return n;
}

export type SplitOptions<T> = {
  /** The list's key prefix, used in errors. */
  readonly prefix: string;
  /** The most shards the list may use. */
  readonly maxShards: number;
  /** The UTF-8 size of an empty shard's JSON text, for example `{"v":1,"items":[]}`. */
  readonly envelopeBytes: number;
  /** One item's JSON text, as it appears inside the shard. */
  readonly itemText: (item: T) => string;
};

/**
 * Packs `items`, in order and greedily, into as few shards as fit.
 *
 * A shard's size is `envelopeBytes`, plus each item's bytes, plus one byte per
 * comma between items: exactly its JSON text, because `JSON.stringify` joins
 * an array's items with commas. Each item is measured once.
 *
 * Throws `StateError` `too_large` when one item can't fit in a shard on its
 * own, or when the list needs more than `maxShards` shards. Callers keep their
 * lists under their caps, so either is invalid state. An empty list gives `[]`.
 */
export function splitIntoShards<T>(items: readonly T[], options: SplitOptions<T>): T[][] {
  const shards: T[][] = [];
  let current: T[] = [];
  let size = options.envelopeBytes;
  for (const item of items) {
    const bytes = utf8ByteLength(options.itemText(item));
    const alone = options.envelopeBytes + bytes;
    if (alone > STATE_VALUE_MAX_BYTES) {
      throw new StateError(`An item under ${options.prefix} is too large for one shard`, {
        key: options.prefix,
        reason: 'too_large',
        bytes: alone,
        limit: STATE_VALUE_MAX_BYTES,
      });
    }
    if (current.length > 0 && size + 1 + bytes > STATE_VALUE_MAX_BYTES) {
      shards.push(current);
      current = [];
      size = options.envelopeBytes;
    }
    size += current.length > 0 ? 1 + bytes : bytes;
    current.push(item);
  }
  if (current.length > 0) {
    shards.push(current);
  }
  if (shards.length > options.maxShards) {
    throw new StateError(
      `${options.prefix} needs ${String(shards.length)} shards, at most ${String(options.maxShards)}`,
      { key: options.prefix, reason: 'too_large' },
    );
  }
  return shards;
}

export type ShardEntry<T> = {
  readonly key: string;
  readonly items: readonly T[];
};

/**
 * Joins stored shards into one list: sorted by shard number numerically
 * (`keys()` sorts by code unit, so `10` would come before `2`), concatenated,
 * with later duplicates removed by `idOf`. A key that isn't a shard number
 * throws `StateError` `bad_key`.
 *
 * After a save that stopped part-way, this order can differ from the list's
 * own order. Callers that care re-sort.
 */
export function joinShards<T>(
  prefix: string,
  entries: readonly ShardEntry<T>[],
  idOf: (item: T) => string,
): T[] {
  const sorted = entries
    .map((entry) => ({ n: shardIndex(prefix, entry.key), items: entry.items }))
    .sort((a, b) => a.n - b.n);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const { items } of sorted) {
    for (const item of items) {
      const id = idOf(item);
      if (!seen.has(id)) {
        seen.add(id);
        out.push(item);
      }
    }
  }
  return out;
}

/** A shard as JSON text (to compare) and items (to know what it holds). */
export type PlannedShard<T> = {
  readonly text: string;
  readonly items: readonly T[];
};

/**
 * One write. A `set` of a new shard (`n` below the new shard count) writes
 * that shard. A `temporary` set holds items at risk, as they are stored now,
 * at an `n` past every stored and new shard; the final deletes remove it.
 */
export type ShardWrite<T> =
  | {
      readonly op: 'set';
      readonly n: number;
      readonly items: readonly T[];
      readonly temporary: boolean;
    }
  | { readonly op: 'delete'; readonly n: number };

/**
 * Orders the writes that replace the `stored` shards (by `n`, possibly with
 * gaps) with the `next` shards (`0` to `m - 1`), so that a save that stops
 * after any step loses nothing (epic #9 decision 3, option B, #210).
 *
 * **Invariant:** after every step, every item that was stored and is in the
 * new list (by `idOf`) is in at least one stored shard. An item that isn't in
 * the new list may vanish or come back; a surviving one never vanishes.
 *
 * 1. A new shard whose text equals the stored text at the same `n` gets no step.
 * 2. Repeatedly take the lowest pending `set` that keeps the invariant.
 *    Overwriting shard `n` is safe when each surviving item it holds now is in
 *    the new shard `n` or in another stored shard. Writing an absent key is
 *    always safe.
 * 3. When no pending `set` is safe (the moves form a cycle), first write a
 *    temporary shard, at one more than the highest `n` stored or planned, with
 *    the lowest pending shard's at-risk items as they are stored now. That
 *    `set` is then safe. The temporary shard is a subset of one stored shard,
 *    so it fits in one value.
 * 4. Last, delete every stored `n >= m`: the surplus and the temporary shards.
 *    By then every surviving item is in the new shards.
 *
 * Duplicate IDs in `next` are a caller bug and throw `Error`.
 */
export function planShardWrites<T>(
  stored: ReadonlyMap<number, PlannedShard<T>>,
  next: readonly PlannedShard<T>[],
  idOf: (item: T) => string,
): ShardWrite<T>[] {
  const nextIds = next.map((shard) => new Set(shard.items.map(idOf)));
  const survivors = new Set<string>();
  for (const shard of next) {
    for (const item of shard.items) {
      const id = idOf(item);
      if (survivors.has(id)) {
        throw new Error(`planShardWrites: duplicate ID ${id} in the new list`);
      }
      survivors.add(id);
    }
  }

  // What each stored shard holds now, and in how many shards each item is.
  const current = new Map<number, Set<string>>();
  const shardCount = new Map<string, number>();
  const hold = (n: number, ids: Set<string>): void => {
    const before = current.get(n);
    if (before !== undefined) {
      for (const id of before) {
        shardCount.set(id, (shardCount.get(id) ?? 1) - 1);
      }
    }
    current.set(n, ids);
    for (const id of ids) {
      shardCount.set(id, (shardCount.get(id) ?? 0) + 1);
    }
  };
  for (const [n, shard] of stored) {
    hold(n, new Set(shard.items.map(idOf)));
  }

  // Surviving items stored in shard `n` that overwriting it would lose.
  const atRisk = (n: number): Set<string> => {
    const risky = new Set<string>();
    const target = nextIds[n];
    for (const id of current.get(n) ?? []) {
      if (survivors.has(id) && !(target?.has(id) ?? false) && (shardCount.get(id) ?? 0) < 2) {
        risky.add(id);
      }
    }
    return risky;
  };

  const pending: number[] = [];
  next.forEach((shard, n) => {
    if (stored.get(n)?.text !== shard.text) {
      pending.push(n);
    }
  });

  const steps: ShardWrite<T>[] = [];
  let highest = Math.max(next.length - 1, ...stored.keys());
  const write = (n: number, items: readonly T[], temporary: boolean): void => {
    steps.push({ op: 'set', n, items, temporary });
    hold(n, new Set(items.map(idOf)));
  };

  while (pending.length > 0) {
    let index = pending.findIndex((n) => atRisk(n).size === 0);
    if (index === -1) {
      // A cycle: park the lowest pending shard's at-risk items first.
      index = 0;
      const n = pending[0] ?? 0;
      const risky = atRisk(n);
      const parked = (stored.get(n)?.items ?? []).filter((item) => risky.has(idOf(item)));
      highest++;
      write(highest, parked, true);
    }
    const [n] = pending.splice(index, 1);
    if (n === undefined) {
      break;
    }
    write(n, next[n]?.items ?? [], false);
  }

  for (const n of [...current.keys()].sort((a, b) => a - b)) {
    if (n >= next.length) {
      steps.push({ op: 'delete', n });
    }
  }
  return steps;
}
