import { describe, expect, it } from 'vitest';

import { createAlertCollector, logOnlyAlertSink } from '../../src/app/alerts.ts';

describe('createAlertCollector', () => {
  it('starts empty', () => {
    expect(createAlertCollector().collected()).toEqual({
      conditions: [],
      erroredThreadIds: [],
      missingScopes: [],
    });
  });

  it('de-duplicates conditions in first-seen order', () => {
    const alerts = createAlertCollector();
    alerts.add('history_expired');
    alerts.add('auth');
    alerts.add('history_expired');
    alerts.add('budget_reached');
    alerts.add('auth');
    expect(alerts.collected().conditions).toEqual(['history_expired', 'auth', 'budget_reached']);
  });

  it('gathers errored thread IDs and missing scopes, de-duplicated', () => {
    const alerts = createAlertCollector();
    alerts.add('errored', { threadIds: ['t1', 't2'] });
    alerts.add('scope_missing', { scopes: ['s1'] });
    alerts.add('errored', { threadIds: ['t2', 't3'] });
    alerts.add('scope_missing', { scopes: ['s1', 's2'] });
    alerts.add('errored');
    expect(alerts.collected()).toEqual({
      conditions: ['errored', 'scope_missing'],
      erroredThreadIds: ['t1', 't2', 't3'],
      missingScopes: ['s1', 's2'],
    });
  });

  it('ignores details that belong to another condition', () => {
    const alerts = createAlertCollector();
    alerts.add('auth', { threadIds: ['t1'], scopes: ['s1'] });
    alerts.add('errored', { scopes: ['s2'] });
    alerts.add('scope_missing', { threadIds: ['t2'] });
    expect(alerts.collected()).toEqual({
      conditions: ['auth', 'errored', 'scope_missing'],
      erroredThreadIds: [],
      missingScopes: [],
    });
  });

  describe('consecutiveFailures', () => {
    it('has no key at the start, or after run_failures without a count', () => {
      const alerts = createAlertCollector();
      expect(alerts.collected()).not.toHaveProperty('consecutiveFailures');
      alerts.add('run_failures');
      expect(alerts.collected()).toStrictEqual({
        conditions: ['run_failures'],
        erroredThreadIds: [],
        missingScopes: [],
      });
    });

    it('keeps the latest count given with run_failures', () => {
      const alerts = createAlertCollector();
      alerts.add('run_failures', { consecutiveFailures: 3 });
      expect(alerts.collected()).toStrictEqual({
        conditions: ['run_failures'],
        erroredThreadIds: [],
        missingScopes: [],
        consecutiveFailures: 3,
      });
      alerts.add('run_failures', { consecutiveFailures: 4 });
      expect(alerts.collected().consecutiveFailures).toBe(4);
      alerts.add('run_failures');
      alerts.add('run_failures', {});
      expect(alerts.collected().consecutiveFailures).toBe(4);
      expect(alerts.collected().conditions).toEqual(['run_failures']);
    });

    it('ignores a count given with another condition', () => {
      const alerts = createAlertCollector();
      alerts.add('auth', { consecutiveFailures: 9 });
      expect(alerts.collected()).toStrictEqual({
        conditions: ['auth'],
        erroredThreadIds: [],
        missingScopes: [],
      });
      alerts.add('run_failures', { consecutiveFailures: 3 });
      alerts.add('errored', { consecutiveFailures: 9 });
      expect(alerts.collected().consecutiveFailures).toBe(3);
    });

    it('does not change a snapshot with later adds', () => {
      const alerts = createAlertCollector();
      const empty = alerts.collected();
      alerts.add('run_failures', { consecutiveFailures: 3 });
      const first = alerts.collected();
      alerts.add('run_failures', { consecutiveFailures: 4 });
      expect(empty).not.toHaveProperty('consecutiveFailures');
      expect(first.consecutiveFailures).toBe(3);
      expect(alerts.collected().consecutiveFailures).toBe(4);
    });
  });

  it('adds every condition of a list with addAll', () => {
    const alerts = createAlertCollector();
    alerts.add('budget_reached');
    alerts.addAll(['history_expired', 'budget_reached', 'scope_missing']);
    alerts.addAll([]);
    expect(alerts.collected().conditions).toEqual([
      'budget_reached',
      'history_expired',
      'scope_missing',
    ]);
  });

  it('returns copies: later adds and changes to a snapshot do not leak', () => {
    const alerts = createAlertCollector();
    alerts.add('errored', { threadIds: ['t1'] });
    const first = alerts.collected();
    alerts.add('auth');
    alerts.add('errored', { threadIds: ['t2'] });
    expect(first).toEqual({ conditions: ['errored'], erroredThreadIds: ['t1'], missingScopes: [] });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately mutates a readonly snapshot, as a careless caller might
    (first.conditions as string[]).push('config_invalid');
    expect(alerts.collected().conditions).toEqual(['errored', 'auth']);
    expect(alerts.collected()).not.toBe(alerts.collected());
  });
});

describe('logOnlyAlertSink', () => {
  it('does nothing', () => {
    const alerts = createAlertCollector();
    alerts.add('auth');
    expect(() => {
      logOnlyAlertSink.deliver(alerts.collected());
    }).not.toThrow();
  });
});
