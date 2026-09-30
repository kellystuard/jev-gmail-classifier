import { describe, expect, it } from 'vitest';

import { loadBudget, saveBudget } from '../../src/app/budget-store.ts';
import { StateError } from '../../src/core/errors.ts';
import { BUDGET_KEY } from '../../src/core/token-budget.ts';
import { FakeState } from '../fakes/fake-state.ts';

const TODAY = '2026-09-30';

describe('loadBudget', () => {
  it('returns today at 0 for an absent key, and writes nothing', () => {
    const state = new FakeState();
    expect(loadBudget(state, TODAY)).toEqual({ day: TODAY, inputTokens: 0 });
    expect(state.calls.filter((c) => c.method === 'set')).toHaveLength(0);
  });

  it('returns the stored count for today', () => {
    const state = new FakeState();
    state.set(BUDGET_KEY, { v: 1, day: TODAY, inputTokens: 42 });
    expect(loadBudget(state, TODAY)).toEqual({ day: TODAY, inputTokens: 42 });
  });

  it('starts another day from 0 without writing', () => {
    const state = new FakeState();
    state.set(BUDGET_KEY, { v: 1, day: '2026-09-29', inputTokens: 42 });
    const writes = state.calls.filter((c) => c.method === 'set').length;
    expect(loadBudget(state, TODAY)).toEqual({ day: TODAY, inputTokens: 0 });
    expect(state.calls.filter((c) => c.method === 'set')).toHaveLength(writes);
    expect(state.get(BUDGET_KEY)).toEqual({ v: 1, day: '2026-09-29', inputTokens: 42 });
  });

  it('throws StateError for a corrupt value and leaves it as it is', () => {
    const state = new FakeState();
    state.seedRaw(BUDGET_KEY, '{"v":1,"day":"today","inputTokens":-1}');
    expect(() => loadBudget(state, TODAY)).toThrow(StateError);
    expect(state.calls.filter((c) => c.method === 'set')).toHaveLength(0);
  });
});

describe('saveBudget', () => {
  it('writes the versioned value', () => {
    const state = new FakeState();
    saveBudget(state, { day: TODAY, inputTokens: 7 });
    expect(JSON.stringify(state.get(BUDGET_KEY))).toBe(
      '{"v":1,"day":"2026-09-30","inputTokens":7}',
    );
  });
});
