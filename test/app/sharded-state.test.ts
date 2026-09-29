import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  loadShardedList,
  saveShardedList,
  type ShardCodec,
  type ShardedListSpec,
} from '../../src/app/sharded-state.ts';
import { StateError } from '../../src/core/errors.ts';
import { defineStateCodec } from '../../src/core/state-codec.ts';
import { STATE_STORE_MAX_BYTES, utf8ByteLength } from '../../src/core/state-limits.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';
import { FakeRandom } from '../fakes/fake-random.ts';
import type { FakeState } from '../fakes/fake-state.ts';

type Item = { readonly id: string; readonly pad: string };

/**
 * A shard codec made the way #61 makes the queue's: a `StateCodec` from
 * `defineStateCodec` satisfies the structural `ShardCodec` type.
 */
const codec: ShardCodec<Item> = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    items: z.array(z.strictObject({ id: z.string(), pad: z.string() })),
  }),
});

const PREFIX = 'state.list.';
const spec: ShardedListSpec<Item> = {
  prefix: PREFIX,
  codec,
  idOf: (item) => item.id,
  maxShards: 40,
};

function item(id: string, bytes: number, char = 'x'): Item {
  return { id, pad: char.repeat(bytes) };
}

function items(count: number, bytes: number, from = 0): Item[] {
  return Array.from({ length: count }, (_, i) => item(`t${String(from + i)}`, bytes));
}

function freshState(snapshot: Record<string, string> = {}): FakeState {
  const { state } = createFakePorts();
  for (const [key, text] of Object.entries(snapshot)) {
    state.seedRaw(key, text);
  }
  return state;
}

function stored(list: readonly Item[]): FakeState {
  const state = freshState();
  saveShardedList(state, spec, list);
  return state;
}

function writes(state: FakeState, from = 0): string[] {
  return state.calls
    .slice(from)
    .filter((call) => call.method === 'set' || call.method === 'delete')
    .map((call) => `${call.method} ${String(call.args[0])}`);
}

function shardKeys(state: FakeState): string[] {
  return Object.keys(state.snapshot()).filter((key) => key.startsWith(PREFIX));
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('saveShardedList and loadShardedList', () => {
  it.each([
    ['no shards', 0, []],
    ['one shard', 3, ['state.list.0']],
    ['several shards', 10, ['state.list.0', 'state.list.1', 'state.list.2', 'state.list.3']],
  ])('round-trip a list in %s', (_name, count, keys) => {
    const list = items(count, 2500);
    const state = stored(list);
    expect(shardKeys(state)).toEqual(keys);
    expect(loadShardedList(state, spec)).toEqual(list);
  });

  it('stores each shard as {"v": 1, "items": [...]}', () => {
    const state = stored([item('a', 1), item('b', 2)]);
    expect(state.snapshot()).toEqual({
      'state.list.0': '{"v":1,"items":[{"id":"a","pad":"x"},{"id":"b","pad":"xx"}]}',
    });
  });

  it('reads more than ten shards in numeric order', () => {
    const list = items(24, 4000);
    const state = stored(list);
    expect(shardKeys(state)).toHaveLength(12);
    expect(loadShardedList(state, spec)).toEqual(list);
  });

  it('writes nothing when the same list is saved again', () => {
    const list = items(10, 2500);
    const state = stored(list);
    const before = state.calls.length;
    saveShardedList(state, spec, list);
    expect(writes(state, before)).toEqual([]);
  });

  it('writes only the changed shard when an item is appended', () => {
    const list = items(5, 2500);
    const state = stored(list);
    const before = state.calls.length;
    saveShardedList(state, spec, [...list, item('new', 10)]);
    expect(writes(state, before)).toEqual(['set state.list.1']);
  });

  it('deletes the surplus when the list shrinks, and every shard for an empty list', () => {
    const list = items(10, 2500);
    const state = stored(list);
    saveShardedList(state, spec, list.slice(0, 3));
    expect(shardKeys(state)).toEqual(['state.list.0']);
    saveShardedList(state, spec, []);
    expect(shardKeys(state)).toEqual([]);
  });

  it('leaves no temporary shard after a save that needed one', () => {
    // Two items per shard; the last item moves to the front, everything else shifts up.
    const list = items(6, 4000);
    const state = stored(list);
    const moved = [list[5], ...list.slice(0, 5)].filter((x) => x !== undefined);
    const before = state.calls.length;
    saveShardedList(state, spec, moved);
    expect(writes(state, before)).toEqual([
      'set state.list.3',
      'set state.list.0',
      'set state.list.2',
      'set state.list.1',
      'delete state.list.3',
    ]);
    expect(shardKeys(state)).toEqual(['state.list.0', 'state.list.1', 'state.list.2']);
    expect(loadShardedList(state, spec)).toEqual(moved);
  });

  it('throws too_large and writes nothing for a list over maxShards', () => {
    const state = stored(items(4, 4000));
    const before = state.snapshot();
    const callsBefore = state.calls.length;
    const error = caught(() => {
      saveShardedList(state, { ...spec, maxShards: 2 }, items(6, 4000));
    });
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'too_large', key: PREFIX });
    expect(state.calls.slice(callsBefore)).toEqual([]);
    expect(state.snapshot()).toEqual(before);
  });

  it('throws too_large and writes nothing for an item too large for a shard', () => {
    const state = stored(items(2, 100));
    const before = state.snapshot();
    const error = caught(() => {
      saveShardedList(state, spec, [item('big', 9200)]);
    });
    expect(error).toMatchObject({ reason: 'too_large', key: PREFIX });
    expect(state.snapshot()).toEqual(before);
  });

  it('throws on a duplicate ID and writes nothing', () => {
    const state = freshState();
    expect(() => {
      saveShardedList(state, spec, [item('a', 1), item('a', 2)]);
    }).toThrow('duplicate ID a');
    expect(writes(state)).toEqual([]);
  });

  it('loses no stored item when the store fills part-way through a save', () => {
    // [A B] is stored. Inserting a larger E ahead writes [B] to shard 1 first,
    // then grows shard 0 to [E A], which no longer fits in the store.
    const a = item('A', 4000);
    const b = item('B', 4000);
    const e = item('E', 4500);
    const state = stored([a, b]);
    const shard1 = JSON.stringify(codec.encode({ items: [b] }));
    const spare = 200;
    const fillerKey = 'state.filler';
    const filler =
      STATE_STORE_MAX_BYTES -
      spare -
      state.bytesUsed() -
      utf8ByteLength('state.list.1') -
      utf8ByteLength(shard1) -
      utf8ByteLength(fillerKey);
    state.seedRaw(fillerKey, JSON.stringify('f'.repeat(filler - 2)));
    const error = caught(() => {
      saveShardedList(state, spec, [e, a, b]);
    });
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'store_full', key: 'state.list.0' });
    expect(shardKeys(state)).toEqual(['state.list.0', 'state.list.1']);
    expect(loadShardedList(state, spec)).toEqual([a, b]);
  });

  it('throws parse for a shard with bad JSON, on load and on save, and leaves it as is', () => {
    const state = stored(items(3, 10));
    state.seedRaw('state.list.1', '{not json');
    const before = state.snapshot();
    expect(caught(() => loadShardedList(state, spec))).toMatchObject({
      reason: 'parse',
      key: 'state.list.1',
    });
    const callsBefore = state.calls.length;
    expect(
      caught(() => {
        saveShardedList(state, spec, items(1, 10));
      }),
    ).toMatchObject({ reason: 'parse' });
    expect(writes(state, callsBefore)).toEqual([]);
    expect(state.snapshot()).toEqual(before);
  });

  it('propagates what the codec throws, and resets nothing', () => {
    const state = stored(items(3, 10));
    state.seedRaw('state.list.0', '{"v":2,"items":[]}');
    const before = state.snapshot();
    expect(caught(() => loadShardedList(state, spec))).toMatchObject({
      reason: 'version',
      key: 'state.list.0',
    });
    expect(state.snapshot()).toEqual(before);
  });

  it.each(['state.list.x', 'state.list.01', 'state.list.'])(
    'throws bad_key for %s on load and on save, before reading any value',
    (key) => {
      const state = stored(items(3, 10));
      state.seedRaw(key, '{"v":1,"items":[]}');
      const before = state.snapshot();
      const callsBefore = state.calls.length;
      expect(caught(() => loadShardedList(state, spec))).toMatchObject({ reason: 'bad_key', key });
      expect(
        caught(() => {
          saveShardedList(state, spec, []);
        }),
      ).toMatchObject({ reason: 'bad_key', key });
      expect(state.calls.slice(callsBefore).map((call) => call.method)).toEqual(['keys', 'keys']);
      expect(state.snapshot()).toEqual(before);
    },
  );

  it('reads shards left with a gap and duplicates, keeping the first copy', () => {
    const state = freshState({
      'state.list.0': '{"v":1,"items":[{"id":"a","pad":"0"},{"id":"b","pad":"0"}]}',
      'state.list.2': '{"v":1,"items":[{"id":"b","pad":"2"},{"id":"c","pad":"2"}]}',
    });
    expect(loadShardedList(state, spec)).toEqual([
      { id: 'a', pad: '0' },
      { id: 'b', pad: '0' },
      { id: 'c', pad: '2' },
    ]);
  });
});

// Each generated case replays the save once per step; with coverage on, that
// takes a few seconds per mutation, so these tests get more than the default 5 s.
describe('a save that stops after any step', { timeout: 30_000 }, () => {
  type Mutation = (list: Item[], random: FakeRandom, fresh: () => string) => Item[];

  const pick = (random: FakeRandom, n: number): number => Math.floor(random.next() * n);
  const size = (random: FakeRandom): number => 300 + pick(random, 2200);
  const newItem = (random: FakeRandom, fresh: () => string): Item =>
    item(fresh(), size(random), pick(random, 4) === 0 ? 'é' : 'x');

  const insertAt = (list: Item[], index: number, added: Item[]): Item[] => [
    ...list.slice(0, index),
    ...added,
    ...list.slice(index),
  ];

  const mutations: Record<string, Mutation> = {
    'an insert at the front': (list, random, fresh) =>
      insertAt(
        list,
        0,
        Array.from({ length: 1 + pick(random, 3) }, () => newItem(random, fresh)),
      ),
    'an insert in the middle': (list, random, fresh) =>
      insertAt(list, pick(random, list.length + 1), [newItem(random, fresh)]),
    'a removal': (list, random) => list.filter((_, i) => i !== pick(random, list.length)),
    'several removals': (list, random) => list.filter(() => pick(random, 3) !== 0),
    'an item that grows': (list, random) => {
      const index = pick(random, list.length);
      return list.map((x, i) =>
        i === index ? { id: x.id, pad: x.pad + 'g'.repeat(500 + pick(random, 3000)) } : x,
      );
    },
    'every item growing a little': (list) => list.map((x) => ({ id: x.id, pad: `${x.pad}ggg` })),
    'an item that moves earlier': (list, random) => {
      const from = list.length - 1 - pick(random, Math.max(1, list.length / 3));
      const moved = list[from];
      const rest = list.filter((_, i) => i !== from);
      return moved === undefined ? rest : insertAt(rest, pick(random, from + 1), [moved]);
    },
    'an item that moves later': (list, random) => {
      const from = pick(random, Math.max(1, list.length / 3));
      const moved = list[from];
      const rest = list.filter((_, i) => i !== from);
      return moved === undefined
        ? rest
        : insertAt(rest, from + pick(random, rest.length - from + 1), [moved]);
    },
    'a shuffle': (list, random) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = pick(random, i + 1);
        const a = out[i];
        const b = out[j];
        if (a !== undefined && b !== undefined) {
          out[i] = b;
          out[j] = a;
        }
      }
      return out;
    },
    'growth by several shards': (list, random, fresh) => {
      let out = list;
      for (let i = 10 + pick(random, 20); i > 0; i--) {
        out = insertAt(out, pick(random, out.length + 1), [newItem(random, fresh)]);
      }
      return out;
    },
    'shrinking by several shards': (list, random) =>
      list.slice(pick(random, 3), Math.max(0, list.length - 10 - pick(random, 10))),
    'a mix': (list, random, fresh) => {
      const names = Object.keys(mutations).filter((name) => name !== 'a mix');
      let out = list;
      for (let i = 2 + pick(random, 3); i > 0; i--) {
        const name = names[pick(random, names.length)] ?? 'a removal';
        out = mutations[name]?.(out, random, fresh) ?? out;
      }
      return out;
    },
  };

  const storeFull = (): StateError =>
    new StateError('Injected store_full', { key: 'state.list.0', reason: 'store_full' });

  /** Checks the stored list after a stop: every item in both lists, nothing else, no copies. */
  function expectNothingLost(
    state: FakeState,
    oldList: readonly Item[],
    newList: readonly Item[],
    where: string,
  ): void {
    const loaded = loadShardedList(state, spec);
    const oldById = new Map(oldList.map((x) => [x.id, x]));
    const newById = new Map(newList.map((x) => [x.id, x]));
    const loadedIds = new Set(loaded.map((x) => x.id));
    expect(loadedIds.size, `${where}: duplicates`).toBe(loaded.length);
    for (const id of oldById.keys()) {
      if (newById.has(id)) {
        expect(loadedIds.has(id), `${where}: lost ${id}`).toBe(true);
      }
    }
    for (const x of loaded) {
      const versions = [oldById.get(x.id), newById.get(x.id)].filter((v) => v !== undefined);
      expect(versions, `${where}: unexpected ${x.id}`).toContainEqual(x);
    }
  }

  /** Stops the save at every `set` and every `delete`, and checks each stopped store. */
  function checkEveryStop(oldList: readonly Item[], newList: readonly Item[]): boolean {
    const seed = stored(oldList).snapshot();

    const clean = freshState(seed);
    saveShardedList(clean, spec, newList);
    expect(loadShardedList(clean, spec)).toEqual(newList);
    const cleanWrites = writes(clean);
    const sets = cleanWrites.filter((w) => w.startsWith('set ')).length;
    const deletes = cleanWrites.filter((w) => w.startsWith('delete ')).length;
    const newShards = stored(newList);
    expect(clean.snapshot()).toEqual(newShards.snapshot());

    for (const [method, count] of [
      ['set', sets],
      ['delete', deletes],
    ] as const) {
      for (let k = 0; k <= count; k++) {
        const where = `stop before ${method} ${String(k)}`;
        const state = freshState(seed);
        state.failNext(method, storeFull(), { after: k });
        if (k < count) {
          expect(() => {
            saveShardedList(state, spec, newList);
          }, where).toThrow('Injected store_full');
        } else {
          saveShardedList(state, spec, newList);
        }
        expectNothingLost(state, oldList, newList, where);
        // The next save from the stopped store finishes the job exactly.
        saveShardedList(state, spec, newList);
        expect(state.snapshot(), `${where}: resumed`).toEqual(newShards.snapshot());
      }
    }
    // A temporary shard is a set past the new last shard.
    const newCount = shardKeys(newShards).length;
    return cleanWrites.some(
      (w) => w.startsWith('set ') && Number(w.slice(`set ${PREFIX}`.length)) >= newCount,
    );
  }

  let temporaryCases = 0;

  it.each(Object.keys(mutations))('never loses a stored item after %s', (name) => {
    const mutate = mutations[name];
    if (mutate === undefined) {
      throw new Error(name);
    }
    for (let seed = 1; seed <= 8; seed++) {
      const random = new FakeRandom(seed * 7919 + name.length);
      let counter = 0;
      const fresh = (): string => `n${String(counter++)}`;
      const oldList = Array.from({ length: 4 + pick(random, 36) }, () => newItem(random, fresh));
      const newList = mutate(oldList, random, fresh);
      if (checkEveryStop(oldList, newList)) {
        temporaryCases++;
      }
    }
  });

  it('covers the cycle case, which needs a temporary shard', () => {
    const list = items(6, 4000);
    const moved = [list[5], ...list.slice(0, 5)].filter((x) => x !== undefined);
    expect(checkEveryStop(list, moved)).toBe(true);
    // The generated cases above needed one too.
    expect(temporaryCases).toBeGreaterThan(0);
  });
});
