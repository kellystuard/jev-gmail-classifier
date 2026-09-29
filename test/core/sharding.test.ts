import { describe, expect, it } from 'vitest';

import { StateError } from '../../src/core/errors.ts';
import {
  joinShards,
  type PlannedShard,
  planShardWrites,
  type ShardWrite,
  shardIndex,
  shardKey,
  splitIntoShards,
} from '../../src/core/sharding.ts';
import { STATE_VALUE_MAX_BYTES, utf8ByteLength } from '../../src/core/state-limits.ts';
import { FakeRandom } from '../fakes/fake-random.ts';

const PREFIX = 'state.list.';
const ENVELOPE = '{"v":1,"items":[]}';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** The shard's real JSON text, as the app layer writes it. */
function shardText(items: readonly unknown[]): string {
  return JSON.stringify({ v: 1, items });
}

function split(items: readonly string[], maxShards = 24): string[][] {
  return splitIntoShards(items, {
    prefix: PREFIX,
    maxShards,
    envelopeBytes: utf8ByteLength(ENVELOPE),
    itemText: (item) => JSON.stringify(item),
  });
}

describe('shardKey', () => {
  it('appends n to the prefix', () => {
    expect(shardKey(PREFIX, 0)).toBe('state.list.0');
    expect(shardKey(PREFIX, 12)).toBe('state.list.12');
  });
});

describe('shardIndex', () => {
  it.each([
    ['state.list.0', 0],
    ['state.list.2', 2],
    ['state.list.10', 10],
    ['state.list.123', 123],
  ])('reads %s as %i', (key, n) => {
    expect(shardIndex(PREFIX, key)).toBe(n);
  });

  it.each([
    ['a word', 'state.list.x'],
    ['a leading zero', 'state.list.01'],
    ['nothing after the prefix', 'state.list.'],
    ['a sign', 'state.list.-1'],
    ['a decimal', 'state.list.1.5'],
    ['a trailing space', 'state.list.1 '],
    ['a number too large to be exact', 'state.list.99999999999999999999'],
    ['another prefix', 'state.other.1'],
  ])('rejects %s with StateError bad_key', (_name, key) => {
    const error = caught(() => shardIndex(PREFIX, key));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'bad_key', key });
  });
});

describe('splitIntoShards', () => {
  const envelope = utf8ByteLength(ENVELOPE);
  // Two string items fill a shard exactly when their lengths add up to this:
  // envelope + (a + 2) + 1 + (b + 2) = limit.
  const pairChars = STATE_VALUE_MAX_BYTES - envelope - 5;

  it('gives no shards for an empty list', () => {
    expect(split([])).toEqual([]);
  });

  it.each([
    ['ASCII', 'a', 1],
    ['2-byte characters', 'é', 2],
    ['3-byte characters', '€', 3],
    ['4-byte characters', '😀', 4],
  ])(
    'fills a shard to exactly the limit with %s, and one byte more starts a new shard',
    (_name, char, bytesPerChar) => {
      const first = char.repeat(Math.floor(2000 / bytesPerChar));
      const firstBytes = utf8ByteLength(first);
      const rest = pairChars - firstBytes;
      const exact = [first, 'b'.repeat(rest)];
      const exactShards = split(exact);
      expect(exactShards).toEqual([exact]);
      expect(utf8ByteLength(shardText(exactShards[0] ?? []))).toBe(STATE_VALUE_MAX_BYTES);

      const over = [first, 'b'.repeat(rest + 1)];
      expect(split(over)).toEqual([[over[0]], [over[1]]]);
    },
  );

  it('counts UTF-8 bytes, not code units', () => {
    // 4,600 code units (fits by length) but 9,200 bytes: too large on its own.
    const item = 'é'.repeat(4600);
    expect(item.length + envelope + 2).toBeLessThan(STATE_VALUE_MAX_BYTES);
    const error = caught(() => split([item]));
    expect(error).toMatchObject({ reason: 'too_large', key: PREFIX });
  });

  it('allows exactly maxShards shards and throws too_large for one more', () => {
    const big = (c: string): string => c.repeat(5000);
    expect(split([big('a'), big('b'), big('c')], 3)).toHaveLength(3);
    const error = caught(() => split([big('a'), big('b'), big('c'), big('d')], 3));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({
      reason: 'too_large',
      key: PREFIX,
      message: 'state.list. needs 4 shards, at most 3',
    });
  });

  it('throws too_large for one item that fits in no shard', () => {
    const fits = 'a'.repeat(STATE_VALUE_MAX_BYTES - envelope - 2);
    expect(split([fits])).toEqual([[fits]]);
    const error = caught(() => split(['small', `${fits}a`]));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({
      reason: 'too_large',
      key: PREFIX,
      bytes: STATE_VALUE_MAX_BYTES + 1,
      limit: STATE_VALUE_MAX_BYTES,
    });
  });

  it('measures each item once', () => {
    let calls = 0;
    const items = ['a', 'b', 'c', 'd'];
    splitIntoShards(items, {
      prefix: PREFIX,
      maxShards: 24,
      envelopeBytes: envelope,
      itemText: (item) => {
        calls++;
        return JSON.stringify(item);
      },
    });
    expect(calls).toBe(items.length);
  });

  it('packs generated lists greedily, in order, with every real shard text within the limit', () => {
    const random = new FakeRandom(7);
    const chars = ['a', 'é', '€', '😀', '"', '\\', '\n'];
    for (let round = 0; round < 50; round++) {
      const items: string[] = [];
      const count = Math.floor(random.next() * 40);
      for (let i = 0; i < count; i++) {
        const char = chars[Math.floor(random.next() * chars.length)] ?? 'a';
        items.push(char.repeat(1 + Math.floor(random.next() * 2000)));
      }
      const shards = split(items, 100);
      expect(shards.flat()).toEqual(items);
      shards.forEach((shard, n) => {
        expect(shard.length).toBeGreaterThan(0);
        expect(utf8ByteLength(shardText(shard))).toBeLessThanOrEqual(STATE_VALUE_MAX_BYTES);
        const following = shards[n + 1]?.[0];
        if (following !== undefined) {
          // Greedy: the next shard's first item didn't fit in this one.
          expect(utf8ByteLength(shardText([...shard, following]))).toBeGreaterThan(
            STATE_VALUE_MAX_BYTES,
          );
        }
      });
    }
  });
});

describe('joinShards', () => {
  type Item = { readonly id: string; readonly from: number };
  const idOf = (item: Item): string => item.id;

  it('orders shards numerically, not by code unit', () => {
    const entries = ['0', '1', '10', '2'].map((n) => ({
      key: `${PREFIX}${n}`,
      items: [{ id: `t${n}`, from: Number(n) }],
    }));
    expect(joinShards(PREFIX, entries, idOf).map((item) => item.id)).toEqual([
      't0',
      't1',
      't2',
      't10',
    ]);
  });

  it('keeps the first of duplicate IDs, in shard order', () => {
    const entries = [
      { key: `${PREFIX}2`, items: [{ id: 'a', from: 2 }] },
      { key: `${PREFIX}0`, items: [{ id: 'b', from: 0 }] },
      {
        key: `${PREFIX}1`,
        items: [
          { id: 'a', from: 1 },
          { id: 'c', from: 1 },
        ],
      },
    ];
    expect(joinShards(PREFIX, entries, idOf)).toEqual([
      { id: 'b', from: 0 },
      { id: 'a', from: 1 },
      { id: 'c', from: 1 },
    ]);
  });

  it('gives an empty list for no shards', () => {
    expect(joinShards(PREFIX, [], idOf)).toEqual([]);
  });

  it('throws bad_key for a key that is not a shard number', () => {
    const error = caught(() => joinShards(PREFIX, [{ key: `${PREFIX}x`, items: [] }], idOf));
    expect(error).toMatchObject({ reason: 'bad_key', key: 'state.list.x' });
  });
});

describe('planShardWrites', () => {
  const id = (item: string): string => item.replace(/'+$/, '');

  function planned(items: readonly string[]): PlannedShard<string> {
    return { text: shardText(items), items };
  }

  function storedOf(shards: Record<number, readonly string[]>): Map<number, PlannedShard<string>> {
    return new Map(Object.entries(shards).map(([n, items]) => [Number(n), planned(items)]));
  }

  function describeSteps(steps: readonly ShardWrite<string>[]): string[] {
    return steps.map((step) =>
      step.op === 'delete'
        ? `delete ${String(step.n)}`
        : `set ${String(step.n)}${step.temporary ? ` temporary [${step.items.join(' ')}]` : ''}`,
    );
  }

  function plan(stored: Record<number, readonly string[]>, next: readonly string[][]): string[] {
    const storedMap = storedOf(stored);
    const steps = planShardWrites(storedMap, next.map(planned), id);
    expectSafe(storedMap, next, steps);
    return describeSteps(steps);
  }

  /**
   * Applies `steps` one at a time and checks the invariant after each, then
   * that the result is exactly the new shards.
   */
  function expectSafe(
    stored: ReadonlyMap<number, PlannedShard<string>>,
    next: readonly (readonly string[])[],
    steps: readonly ShardWrite<string>[],
  ): void {
    const survivors = new Set(next.flat().map(id));
    const mustKeep = [...stored.values()]
      .flatMap((shard) => shard.items.map(id))
      .filter((itemId) => survivors.has(itemId));
    const store = new Map([...stored].map(([n, shard]) => [n, shard.items]));
    steps.forEach((step, index) => {
      if (step.op === 'delete') {
        store.delete(step.n);
      } else {
        store.set(step.n, step.items);
      }
      const present = new Set([...store.values()].flat().map(id));
      for (const itemId of mustKeep) {
        expect(present.has(itemId), `${itemId} lost after step ${String(index)}`).toBe(true);
      }
    });
    expect(Object.fromEntries(store)).toEqual(
      Object.fromEntries(next.map((items, n) => [n, items])),
    );
  }

  it('plans nothing when nothing changed', () => {
    expect(plan({ 0: ['A', 'B'], 1: ['C'] }, [['A', 'B'], ['C']])).toEqual([]);
  });

  it('plans nothing for an empty list with nothing stored', () => {
    expect(plan({}, [])).toEqual([]);
  });

  it('writes only the last shard when one item is appended to it', () => {
    expect(
      plan({ 0: ['A', 'B'], 1: ['C'] }, [
        ['A', 'B'],
        ['C', 'D'],
      ]),
    ).toEqual(['set 1']);
  });

  it('writes a changed item in place', () => {
    expect(plan({ 0: ['A', 'B'], 1: ['C'] }, [["A'", 'B'], ['C']])).toEqual(['set 0']);
  });

  it('deletes the surplus last', () => {
    expect(plan({ 0: ['A', 'B'], 1: ['C', 'D'], 2: ['E'] }, [['A', 'C']])).toEqual([
      'set 0',
      'delete 1',
      'delete 2',
    ]);
  });

  it('deletes every shard for an empty list', () => {
    expect(plan({ 0: ['A'], 1: ['B'] }, [])).toEqual(['delete 0', 'delete 1']);
  });

  it('writes back to front when an item is inserted ahead (the #210 example)', () => {
    expect(plan({ 0: ['A', 'B'], 1: ['C', 'D'] }, [['E', 'A'], ['B', 'C'], ['D']])).toEqual([
      'set 2',
      'set 1',
      'set 0',
    ]);
  });

  it('writes front to back when an item is removed', () => {
    expect(
      plan({ 0: ['A', 'B'], 1: ['C', 'D'], 2: ['E'] }, [
        ['A', 'C'],
        ['D', 'E'],
      ]),
    ).toEqual(['set 0', 'set 1', 'delete 2']);
  });

  it('breaks a cycle with one temporary shard, deleted at the end', () => {
    // F moves from the last shard to the first; everything else shifts up.
    expect(
      plan({ 0: ['A', 'B'], 1: ['C', 'D'], 2: ['E', 'F'] }, [
        ['F', 'A'],
        ['B', 'C'],
        ['D', 'E'],
      ]),
    ).toEqual(['set 3 temporary [B]', 'set 0', 'set 2', 'set 1', 'delete 3']);
  });

  it('parks the at-risk items as they are stored now', () => {
    expect(
      plan({ 0: ['A', 'B'], 1: ['C', 'D'] }, [
        ["D'", 'A'],
        ["B'", 'C'],
      ]),
    ).toEqual(['set 2 temporary [B]', 'set 0', 'set 1', 'delete 2']);
  });

  it('handles a gap in the stored shard numbers', () => {
    expect(
      plan({ 0: ['A', 'B'], 2: ['C'] }, [
        ['A', 'B'],
        ['C', 'D'],
      ]),
    ).toEqual(['set 1', 'delete 2']);
  });

  it('puts a temporary shard past the highest stored shard, gaps included', () => {
    expect(
      plan({ 0: ['A', 'B'], 1: ['C', 'D'], 3: ['X'] }, [
        ['D', 'A'],
        ['B', 'C'],
      ]),
    ).toEqual(['set 4 temporary [B]', 'set 0', 'set 1', 'delete 3', 'delete 4']);
  });

  it('counts a duplicate left by an earlier stop as a copy', () => {
    // B is in shards 0 and 2 after an earlier stop, so shard 0 is safe to overwrite.
    expect(plan({ 0: ['A', 'B'], 1: ['C'], 2: ['B'] }, [['C', 'A'], ['B']])).toEqual([
      'set 0',
      'set 1',
      'delete 2',
    ]);
  });

  it.each([
    ['in different shards', [['A', 'B'], ["A'"]]],
    ['in the same shard', [['A', "A'"]]],
  ])('throws on a duplicate ID in the new list, %s', (_name, next) => {
    expect(() => planShardWrites(new Map(), next.map(planned), id)).toThrow(
      'planShardWrites: duplicate ID A in the new list',
    );
  });

  it('keeps every surviving item through every step, for generated lists', () => {
    const random = new FakeRandom(11);
    const pick = (n: number): number => Math.floor(random.next() * n);
    let usedTemporary = 0;
    for (let round = 0; round < 500; round++) {
      // Stored shards, maybe with gaps and duplicates from an earlier stop.
      const ids = Array.from({ length: 1 + pick(20) }, (_, i) => String.fromCharCode(65 + i));
      const stored: Record<number, string[]> = {};
      let n = 0;
      for (let i = 0; i < ids.length;) {
        const size = 1 + pick(4);
        stored[n] = ids.slice(i, i + size);
        i += size;
        n += 1 + (pick(5) === 0 ? 1 : 0);
      }
      if (pick(4) === 0) {
        const any = ids[pick(ids.length)] ?? 'A';
        stored[n] = [any];
      }
      // The new list: drop, change and add items, and shuffle some.
      const nextItems = ids
        .filter(() => pick(5) !== 0)
        .map((item) => (pick(4) === 0 ? `${item}'` : item));
      for (let i = pick(4); i > 0; i--) {
        nextItems.splice(pick(nextItems.length + 1), 0, `N${String(round)}_${String(i)}`);
      }
      for (let i = pick(4); i > 0; i--) {
        const [moved] = nextItems.splice(pick(nextItems.length), 1);
        if (moved !== undefined) {
          nextItems.splice(pick(nextItems.length + 1), 0, moved);
        }
      }
      const next: string[][] = [];
      for (let i = 0; i < nextItems.length;) {
        const size = 1 + pick(4);
        next.push(nextItems.slice(i, i + size));
        i += size;
      }
      const storedMap = storedOf(stored);
      const steps = planShardWrites(storedMap, next.map(planned), id);
      expectSafe(storedMap, next, steps);
      if (steps.some((step) => step.op === 'set' && step.temporary)) {
        usedTemporary++;
      }
    }
    expect(usedTemporary).toBeGreaterThan(0);
  });
});
