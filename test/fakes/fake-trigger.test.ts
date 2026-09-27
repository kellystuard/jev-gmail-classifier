import { describe, expect, it } from 'vitest';

import { fail } from '../../src/core/result.ts';
import { FakeScopes } from './fake-scopes.ts';
import { FakeTrigger } from './fake-trigger.ts';

describe('FakeTrigger', () => {
  it('always leaves exactly one trigger for the handler', () => {
    const trigger = new FakeTrigger();
    trigger.seed({ handler: 'onTrigger', minutes: 5 });
    trigger.seed({ handler: 'onTrigger', minutes: 5 });
    trigger.seed({ handler: 'other', minutes: 30 });
    expect(trigger.replaceRecurringTrigger('onTrigger', 10)).toEqual({ ok: true });
    expect(trigger.triggers).toEqual([
      { handler: 'other', minutes: 30 },
      { handler: 'onTrigger', minutes: 10 },
    ]);
  });

  it('deletes every trigger for the handler and counts them', () => {
    const trigger = new FakeTrigger();
    trigger.seed({ handler: 'onTrigger', minutes: 5 });
    trigger.seed({ handler: 'onTrigger', minutes: 1 });
    trigger.seed({ handler: 'other', minutes: 30 });
    expect(trigger.deleteTriggers('onTrigger')).toEqual({ ok: true, deleted: 2 });
    expect(trigger.deleteTriggers('onTrigger')).toEqual({ ok: true, deleted: 0 });
    expect(trigger.triggers).toEqual([{ handler: 'other', minutes: 30 }]);
  });

  it('throws on an interval Apps Script does not allow', () => {
    const trigger = new FakeTrigger();
    // @ts-expect-error -- deliberately not an allowed interval, to test the runtime check
    expect(() => trigger.replaceRecurringTrigger('onTrigger', 7)).toThrow(/allowed interval/);
  });

  it('returns scope while script.scriptapp is revoked', () => {
    const scopes = new FakeScopes();
    const trigger = new FakeTrigger({ scopes });
    trigger.seed({ handler: 'onTrigger', minutes: 5 });
    scopes.revoke('https://www.googleapis.com/auth/script.scriptapp');
    expect(trigger.replaceRecurringTrigger('onTrigger', 10)).toMatchObject({
      ok: false,
      kind: 'scope',
    });
    expect(trigger.deleteTriggers('onTrigger')).toMatchObject({ ok: false, kind: 'scope' });
    expect(trigger.triggers).toEqual([{ handler: 'onTrigger', minutes: 5 }]);
  });

  it('uses injected failures and records calls', () => {
    const trigger = new FakeTrigger();
    trigger.failNext('deleteTriggers', fail('scope', { message: 'injected' }));
    trigger.failNext('replaceRecurringTrigger', new Error('Unexpected'));
    expect(trigger.deleteTriggers('onTrigger')).toMatchObject({
      kind: 'scope',
      message: 'injected',
    });
    expect(() => trigger.replaceRecurringTrigger('onTrigger', 5)).toThrow('Unexpected');
    expect(trigger.replaceRecurringTrigger('onTrigger', 5).ok).toBe(true);
    expect(trigger.calls.map((c) => c.method)).toEqual([
      'deleteTriggers',
      'replaceRecurringTrigger',
      'replaceRecurringTrigger',
    ]);
  });
});
