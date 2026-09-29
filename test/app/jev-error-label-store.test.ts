import { describe, expect, it } from 'vitest';

import {
  readJevErrorLabelIds,
  rememberJevErrorLabelId,
} from '../../src/app/jev-error-label-store.ts';
import { StateError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL_KEY, JEV_ERROR_LABEL_MAX_IDS } from '../../src/core/jev-error-label.ts';
import { FakeState } from '../fakes/fake-state.ts';

function sets(state: FakeState) {
  return state.calls.filter((c) => c.method === 'set');
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('readJevErrorLabelIds', () => {
  it('reads [] from an absent key', () => {
    const state = new FakeState();
    expect(readJevErrorLabelIds(state)).toEqual([]);
    expect(state.calls.map((c) => c.method)).toEqual(['get']);
  });

  it('reads the stored IDs, oldest first', () => {
    const state = new FakeState();
    state.seedRaw(JEV_ERROR_LABEL_KEY, '{"v":1,"ids":["Label_12","Label_40"]}');
    expect(readJevErrorLabelIds(state)).toEqual(['Label_12', 'Label_40']);
  });
});

describe('rememberJevErrorLabelId', () => {
  it('writes {v: 1, ids: [id]} into an absent key, and returns the list', () => {
    const state = new FakeState();
    expect(rememberJevErrorLabelId(state, 'Label_12')).toEqual(['Label_12']);
    expect(state.get(JEV_ERROR_LABEL_KEY)).toEqual({ v: 1, ids: ['Label_12'] });
    expect(sets(state)).toHaveLength(1);
  });

  it('adds a new ID last', () => {
    const state = new FakeState();
    rememberJevErrorLabelId(state, 'Label_12');
    expect(rememberJevErrorLabelId(state, 'Label_40')).toEqual(['Label_12', 'Label_40']);
    expect(readJevErrorLabelIds(state)).toEqual(['Label_12', 'Label_40']);
  });

  it('makes no set call for the newest ID again', () => {
    const state = new FakeState();
    rememberJevErrorLabelId(state, 'Label_12');
    rememberJevErrorLabelId(state, 'Label_40');
    const before = sets(state).length;
    expect(rememberJevErrorLabelId(state, 'Label_40')).toEqual(['Label_12', 'Label_40']);
    expect(sets(state)).toHaveLength(before);
  });

  it('moves an older known ID last, which is a change and is written', () => {
    const state = new FakeState();
    rememberJevErrorLabelId(state, 'Label_12');
    rememberJevErrorLabelId(state, 'Label_40');
    expect(rememberJevErrorLabelId(state, 'Label_12')).toEqual(['Label_40', 'Label_12']);
    expect(readJevErrorLabelIds(state)).toEqual(['Label_40', 'Label_12']);
  });

  it('holds the cap of 10 through the store, dropping the oldest', () => {
    const state = new FakeState();
    for (let i = 1; i <= JEV_ERROR_LABEL_MAX_IDS + 2; i += 1) {
      rememberJevErrorLabelId(state, `Label_${String(i)}`);
    }
    const ids = readJevErrorLabelIds(state);
    expect(ids).toHaveLength(JEV_ERROR_LABEL_MAX_IDS);
    expect(ids[0]).toBe('Label_3');
    expect(ids[ids.length - 1]).toBe('Label_12');
  });

  it('throws StateError for an invalid ID, and writes nothing', () => {
    const state = new FakeState();
    const error = thrown(() => rememberJevErrorLabelId(state, ''));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'schema' });
    expect(sets(state)).toEqual([]);
  });

  it.each<[string, string]>([
    ['a wrong v', '{"v":2,"ids":["Label_1"]}'],
    ['a bad shape', '{"v":1,"ids":[1]}'],
    [
      '11 IDs',
      JSON.stringify({ v: 1, ids: Array.from({ length: 11 }, (_, i) => `L${String(i)}`) }),
    ],
  ])(
    'throws StateError from both functions for %s, and leaves the stored text unchanged',
    (_name, text) => {
      const state = new FakeState();
      state.seedRaw(JEV_ERROR_LABEL_KEY, text);
      expect(thrown(() => readJevErrorLabelIds(state))).toBeInstanceOf(StateError);
      expect(thrown(() => rememberJevErrorLabelId(state, 'Label_9'))).toBeInstanceOf(StateError);
      expect(sets(state)).toEqual([]);
      expect(JSON.stringify(state.get(JEV_ERROR_LABEL_KEY))).toBe(text);
    },
  );
});
