import { describe, expect, it } from 'vitest';

import { deleteManualJob, loadManualJob, saveManualJob } from '../../src/app/manual-job-store.ts';
import { StateError } from '../../src/core/errors.ts';
import { MANUAL_KEY, advanceCursor, newManualJob } from '../../src/core/manual-job.ts';
import { FakeState } from '../fakes/fake-state.ts';

const job = advanceCursor(newManualJob({ query: 'label:x', applyMoves: true, startedAt: 5 }), {
  idsOnPage: 2,
  queued: 2,
  merged: 0,
  nextPageToken: 'tok',
});

describe('loadManualJob', () => {
  it('returns undefined for an absent key', () => {
    expect(loadManualJob(new FakeState())).toBeUndefined();
  });

  it('loads what was saved', () => {
    const state = new FakeState();
    saveManualJob(state, job);
    expect(loadManualJob(state)).toEqual(job);
  });

  it('throws StateError for a corrupt value and leaves it as it was', () => {
    const state = new FakeState();
    state.seedRaw(MANUAL_KEY, '{"v":1,"query":""}');
    const before = state.snapshot();
    expect(() => loadManualJob(state)).toThrow(StateError);
    expect(state.snapshot()).toEqual(before);
    expect(state.calls.filter((c) => c.method === 'set' || c.method === 'delete')).toHaveLength(0);
  });
});

describe('deleteManualJob', () => {
  it('removes the job', () => {
    const state = new FakeState();
    saveManualJob(state, job);
    deleteManualJob(state);
    expect(loadManualJob(state)).toBeUndefined();
  });

  it('is fine when the key is absent', () => {
    expect(() => {
      deleteManualJob(new FakeState());
    }).not.toThrow();
  });
});

describe('saveManualJob', () => {
  it('propagates a StateError from the port', () => {
    const state = new FakeState();
    state.failNext('set', new StateError('boom', { key: MANUAL_KEY, reason: 'too_large' }));
    expect(() => {
      saveManualJob(state, job);
    }).toThrow(StateError);
  });
});
