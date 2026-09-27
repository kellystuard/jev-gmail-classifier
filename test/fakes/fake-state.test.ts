import { describe, expect, it } from 'vitest';

import { StateError } from '../../src/core/errors.ts';
import { STATE_STORE_MAX_BYTES, STATE_VALUE_MAX_BYTES } from '../../src/core/state-limits.ts';
import type { StateKey } from '../../src/ports/state-port.ts';
import { FakeState } from './fake-state.ts';

/** A JSON string value whose JSON text is exactly `bytes` long. */
function jsonOfBytes(bytes: number): string {
  return 'x'.repeat(bytes - 2);
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('FakeState', () => {
  it('stores JSON under state.* keys and reads it back', () => {
    const state = new FakeState();
    state.set('state.position', { v: 1, historyId: '100', savedAt: 5 });
    expect(state.get('state.position')).toEqual({ v: 1, historyId: '100', savedAt: 5 });
    expect(state.snapshot()).toEqual({ 'state.position': '{"v":1,"historyId":"100","savedAt":5}' });
    expect(state.get('state.missing')).toBeUndefined();
    state.delete('state.position');
    state.delete('state.position');
    expect(state.get('state.position')).toBeUndefined();
  });

  it('lists keys by prefix, sorted', () => {
    const state = new FakeState();
    for (const key of [
      'state.queue.2',
      'state.queue.10',
      'state.budget',
      'state.queue.1',
    ] as const) {
      state.set(key, { v: 1 });
    }
    state.seedInput('MANUAL_QUERY', 'from:x');
    expect(state.keys('state.queue.')).toEqual([
      'state.queue.1',
      'state.queue.10',
      'state.queue.2',
    ]);
    expect(state.keys('state.')).toHaveLength(4);
  });

  it('reads and deletes plain user inputs', () => {
    const state = new FakeState();
    state.seedInput('MANUAL_QUERY', 'label:old');
    expect(state.getInput('MANUAL_QUERY')).toBe('label:old');
    expect(state.getInput('RESET_POSITION')).toBeUndefined();
    state.deleteInput('MANUAL_QUERY');
    expect(state.getInput('MANUAL_QUERY')).toBeUndefined();
  });

  it.each([
    [
      'get with a non-state key',
      // @ts-expect-error -- deliberately not a state.* key, to test the runtime check
      (s: FakeState) => s.get('queue'),
    ],
    [
      'set with a non-state key',
      (s: FakeState) => {
        // @ts-expect-error -- deliberately not a state.* key, to test the runtime check
        s.set('JEV_API_KEY', 1);
      },
    ],
    ['getInput with a state key', (s: FakeState) => s.getInput('state.position')],
    ['getInput for the API key', (s: FakeState) => s.getInput('JEV_API_KEY')],
    [
      'deleteInput with a state key',
      (s: FakeState) => {
        s.deleteInput('state.position');
      },
    ],
  ])('throws StateError bad_key for %s', (_name, misuse) => {
    const error = caught(() => misuse(new FakeState()));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'bad_key' });
  });

  it('throws StateError parse for text that is not JSON', () => {
    const state = new FakeState();
    state.seedRaw('state.runs', '{not json');
    const error = caught(() => state.get('state.runs'));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: 'state.runs', reason: 'parse' });
  });

  it('accepts a value of exactly 9 KB and rejects one byte more, leaving the store unchanged', () => {
    const state = new FakeState();
    state.set('state.queue.0', jsonOfBytes(STATE_VALUE_MAX_BYTES));
    const before = state.snapshot();
    const error = caught(() => {
      state.set('state.queue.0', jsonOfBytes(STATE_VALUE_MAX_BYTES + 1));
    });
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({
      reason: 'too_large',
      bytes: STATE_VALUE_MAX_BYTES + 1,
      limit: STATE_VALUE_MAX_BYTES,
    });
    expect(state.snapshot()).toEqual(before);
  });

  it('counts value size in UTF-8 bytes', () => {
    const state = new FakeState();
    // 3 bytes per character: 3072 of them plus the quotes is 9218 bytes.
    const error = caught(() => {
      state.set('state.queue.0', '€'.repeat(3072));
    });
    expect(error).toMatchObject({ reason: 'too_large' });
  });

  it('rejects a write that takes the store over 500 KB, counting keys and values', () => {
    const state = new FakeState();
    const perEntry = STATE_VALUE_MAX_BYTES;
    let n = 0;
    // Fill with 9 KB values until one more wouldn't fit.
    while (
      state.bytesUsed() + `state.queue.${String(n)}`.length + perEntry <=
      STATE_STORE_MAX_BYTES
    ) {
      state.set(`state.queue.${String(n)}`, jsonOfBytes(perEntry));
      n++;
    }
    const before = state.snapshot();
    const key: StateKey = `state.queue.${String(n)}`;
    const room = STATE_STORE_MAX_BYTES - state.bytesUsed() - key.length;
    const error = caught(() => {
      state.set(key, jsonOfBytes(room + 1));
    });
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'store_full', limit: STATE_STORE_MAX_BYTES });
    expect(state.snapshot()).toEqual(before);
    // Exactly filling the store is allowed.
    state.set(key, jsonOfBytes(room));
    expect(state.bytesUsed()).toBe(STATE_STORE_MAX_BYTES);
  });

  it('counts an overwrite as replacing the old value', () => {
    const state = new FakeState();
    state.set('state.budget', jsonOfBytes(100));
    const used = state.bytesUsed();
    state.set('state.budget', jsonOfBytes(50));
    expect(state.bytesUsed()).toBe(used - 50);
  });

  it('can fail the next set without changing anything, and records calls', () => {
    const state = new FakeState();
    state.set('state.position', { v: 1 });
    state.failNext('set', new Error('Service unavailable'));
    expect(() => {
      state.set('state.position', { v: 2 });
    }).toThrow('Service unavailable');
    expect(state.get('state.position')).toEqual({ v: 1 });
    state.set('state.position', { v: 3 });
    expect(state.get('state.position')).toEqual({ v: 3 });
    expect(state.calls.map((c) => c.method)).toEqual(['set', 'set', 'get', 'set', 'get']);
  });
});
