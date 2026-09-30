import { describe, expect, it } from 'vitest';

import { createAlertCollector } from '../../src/app/alerts.ts';
import { runPreflight } from '../../src/app/run-preflight.ts';
import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { RunAbortError, StateError } from '../../src/core/errors.ts';
import { BUDGET_KEY } from '../../src/core/token-budget.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';

const CONFIG = { dailyTokenBudget: 1000 };
const TODAY = '2026-09-26';
const ALL_ON = { gmail: true, classify: true, trigger: true, alertMail: true };

describe('runPreflight', () => {
  it('returns the key with nothing missing and the budget left', () => {
    const p = createFakePorts();
    const alerts = createAlertCollector();
    const result = runPreflight(p, CONFIG, alerts);
    expect(result.apiKey).toBe('test-key');
    expect(result.scopes.missing).toEqual([]);
    expect(result.scopes.can).toEqual(ALL_ON);
    expect(result.budgetReached).toBe(false);
    expect(alerts.collected().conditions).toEqual([]);
    expect(p.log.events).toEqual([]);
    expect(p.state.snapshot()).toEqual({});
  });

  describe('missing key', () => {
    const cases = [
      ['never set', () => createFakePorts({ jevApiKey: undefined })],
      [
        'cleared',
        () => {
          const p = createFakePorts();
          p.secrets.clear();
          return p;
        },
      ],
    ] as const;

    it.each(cases)('throws missing_key before any call (%s)', (_name, make) => {
      const p = make();
      p.auth.failWith('must not be called');
      const before = p.state.snapshot();
      const alerts = createAlertCollector();
      let caught: unknown;
      try {
        runPreflight(p, CONFIG, alerts);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RunAbortError);
      expect(caught).toMatchObject({ reason: 'missing_key' });
      expect(p.auth.calls).toEqual([]);
      expect(p.state.calls).toEqual([]);
      expect(p.state.snapshot()).toEqual(before);
      expect(p.gmail.calls).toEqual([]);
      expect(p.http.calls).toEqual([]);
      expect(p.log.events).toEqual([]);
      expect(alerts.collected().conditions).toEqual([]);
    });
  });

  describe('scopes', () => {
    it.each([
      [DECLARED_SCOPES[0], 'gmail'],
      [DECLARED_SCOPES[1], 'classify'],
      [DECLARED_SCOPES[2], 'trigger'],
      [DECLARED_SCOPES[3], 'alertMail'],
    ] as const)('alerts once when %s is missing', (scope, flag) => {
      const p = createFakePorts();
      p.scopes.revoke(scope);
      const alerts = createAlertCollector();
      const result = runPreflight(p, CONFIG, alerts);
      expect(result.scopes.missing).toEqual([scope]);
      expect(result.scopes.can).toEqual({ ...ALL_ON, [flag]: false });
      expect(alerts.collected()).toEqual({
        conditions: ['scope_missing'],
        erroredThreadIds: [],
        missingScopes: [scope],
      });
      expect(p.log.all('scope_missing')).toHaveLength(1);
    });

    it('lists both scopes in one condition when two are missing', () => {
      const p = createFakePorts({ grantedScopes: DECLARED_SCOPES.slice(1, 3) });
      const alerts = createAlertCollector();
      runPreflight(p, CONFIG, alerts);
      const collected = alerts.collected();
      expect(collected.conditions).toEqual(['scope_missing']);
      expect(collected.missingScopes).toEqual([DECLARED_SCOPES[0], DECLARED_SCOPES[3]]);
    });

    it('treats an unknown state as every feature on, with the alert, and no throw', () => {
      const p = createFakePorts();
      p.auth.failWith('boom');
      const alerts = createAlertCollector();
      const result = runPreflight(p, CONFIG, alerts);
      expect(result.scopes.unknown).toEqual({ message: 'boom' });
      expect(result.scopes.can).toEqual(ALL_ON);
      expect(alerts.collected().conditions).toEqual(['scope_missing']);
      expect(alerts.collected().missingScopes).toEqual([]);
      expect(p.log.all('scope_missing')).toHaveLength(1);
    });

    it('still checks the budget when script.external_request is missing', () => {
      const p = createFakePorts();
      p.scopes.revoke(DECLARED_SCOPES[1]);
      p.state.set(BUDGET_KEY, { v: 1, day: TODAY, inputTokens: 1000 });
      const alerts = createAlertCollector();
      const result = runPreflight(p, CONFIG, alerts);
      expect(result.scopes.can.classify).toBe(false);
      expect(result.budgetReached).toBe(true);
      expect(alerts.collected().conditions).toEqual(['scope_missing', 'budget_reached']);
    });
  });

  describe('budget', () => {
    it('is reached at the limit: alert, one budget.reached, nothing written', () => {
      const p = createFakePorts();
      p.state.set(BUDGET_KEY, { v: 1, day: TODAY, inputTokens: 1000 });
      const before = p.state.snapshot();
      const writes = p.state.calls.filter((c) => c.method === 'set').length;
      const alerts = createAlertCollector();
      const result = runPreflight(p, CONFIG, alerts);
      expect(result.budgetReached).toBe(true);
      expect(alerts.collected().conditions).toEqual(['budget_reached']);
      expect(p.log.events).toEqual([
        {
          level: 'warn',
          event: 'budget.reached',
          fields: { day: TODAY, inputTokens: 1000, dailyTokenBudget: 1000 },
        },
      ]);
      expect(p.state.snapshot()).toEqual(before);
      expect(p.state.calls.filter((c) => c.method === 'set')).toHaveLength(writes);
    });

    it('is not reached below the limit', () => {
      const p = createFakePorts();
      p.state.set(BUDGET_KEY, { v: 1, day: TODAY, inputTokens: 999 });
      const result = runPreflight(p, CONFIG, createAlertCollector());
      expect(result.budgetReached).toBe(false);
      expect(p.log.events).toEqual([]);
    });

    it("does not count yesterday's budget at the limit", () => {
      const p = createFakePorts();
      p.state.set(BUDGET_KEY, { v: 1, day: '2026-09-25', inputTokens: 1000 });
      const alerts = createAlertCollector();
      expect(runPreflight(p, CONFIG, alerts).budgetReached).toBe(false);
      expect(alerts.collected().conditions).toEqual([]);
    });

    it('moves the day with the time zone', () => {
      // 12:00 UTC is already 2026-09-27 in Kiritimati (UTC+14).
      const p = createFakePorts({ timeZone: 'Pacific/Kiritimati' });
      p.state.set(BUDGET_KEY, { v: 1, day: TODAY, inputTokens: 1000 });
      expect(runPreflight(p, CONFIG, createAlertCollector()).budgetReached).toBe(false);

      const q = createFakePorts({ timeZone: 'Pacific/Kiritimati' });
      q.state.set(BUDGET_KEY, { v: 1, day: '2026-09-27', inputTokens: 1000 });
      expect(runPreflight(q, CONFIG, createAlertCollector()).budgetReached).toBe(true);
    });

    it('throws StateError for a corrupt state.budget and writes nothing', () => {
      const p = createFakePorts();
      p.state.seedRaw(BUDGET_KEY, '{not json');
      const before = p.state.snapshot();
      expect(() => runPreflight(p, CONFIG, createAlertCollector())).toThrow(StateError);
      expect(p.state.snapshot()).toEqual(before);
      expect(p.state.calls.filter((c) => c.method === 'set')).toHaveLength(0);
    });
  });

  it('never logs the API key', () => {
    const p = createFakePorts({ jevApiKey: 'secret-key-123' });
    p.scopes.revoke(DECLARED_SCOPES[3]);
    p.state.set(BUDGET_KEY, { v: 1, day: TODAY, inputTokens: 5000 });
    const result = runPreflight(p, CONFIG, createAlertCollector());
    expect(result.apiKey).toBe('secret-key-123');
    expect(p.log.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(p.log.events)).not.toContain('secret-key-123');
  });
});
