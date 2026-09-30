import { describe, expect, it } from 'vitest';

import { ingest } from '../../src/app/ingest.ts';
import { type AlertCollector, createAlertCollector } from '../../src/app/alerts.ts';
import { install } from '../../src/app/install.ts';
import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import type { AlertCondition } from '../../src/core/alert-condition.ts';
import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { RunAbortError, StateError, UnexpectedResponseError } from '../../src/core/errors.ts';
import { FALLBACK_KEY } from '../../src/core/history-fallback.ts';
import { INSTALLED_AT_KEY } from '../../src/core/install-record.ts';
import { decodePosition, encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import { fail } from '../../src/core/result.ts';
import { INSTALL_REQUIRED_SCOPES } from '../../src/core/scope-features.ts';
import type { WorkItem } from '../../src/core/work-queue.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';
import { SCOPE_ERROR_MESSAGE } from '../fakes/fake-scopes.ts';

const [MODIFY, EXTERNAL, SCRIPTAPP, SEND_MAIL] = DECLARED_SCOPES;
const HANDLER = 'onTrigger';
const FALLBACK_TEXT = '{"v":1,"placeholder":true}';

const CONFIG: Config = loadConfig({
  defaultThreshold: 0.8,
  triggerIntervalMinutes: 10,
  rules: [{ id: 'bill', question: 'Is this email a bill?', label: 'Bill' }],
});

type Added = { condition: AlertCondition; scopes?: readonly string[] };

/** The real collector, plus a record of each `add` call. */
function collector(): AlertCollector & { added: Added[] } {
  const real = createAlertCollector();
  const added: Added[] = [];
  return {
    added,
    add(condition, details) {
      added.push({
        condition,
        ...(details?.scopes === undefined ? {} : { scopes: [...details.scopes] }),
      });
      real.add(condition, details);
    },
    addAll: (conditions) => {
      for (const condition of conditions) added.push({ condition });
      real.addAll(conditions);
    },
    collected: () => real.collected(),
  };
}

function setup(options: Parameters<typeof createFakePorts>[0] = {}) {
  const p = createFakePorts({ gmail: { historyId: 1000 }, ...options });
  const alerts = collector();
  const run = () => install({ config: CONFIG, alerts }, p, HANDLER);
  return { p, alerts, run };
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function seedPosition(p: FakePorts, historyId: string, savedAt = 1): void {
  p.state.set(POSITION_KEY, encodePosition({ historyId, savedAt }));
}

const ITEMS: WorkItem[] = [
  { threadId: 'a', source: 'scheduled', enqueuedAt: 1, strikes: 0 },
  { threadId: 'b', source: 'scheduled', enqueuedAt: 2, strikes: 1 },
];

function queueText(p: FakePorts): Record<string, string> {
  return Object.fromEntries(
    Object.entries(p.state.snapshot()).filter(([key]) => key.startsWith('state.queue')),
  );
}

function getProfileCalls(p: FakePorts): number {
  return p.gmail.calls.filter((c) => c.method === 'getProfile').length;
}

describe('install', () => {
  it('1. first install: sets the position, records the time and creates the trigger', () => {
    const { p, alerts, run } = setup();
    const report = run();

    expect(report).toEqual({
      position: 'set',
      historyId: '1000',
      triggerMinutes: 10,
      missingScopes: [],
    });
    expect(decodePosition(p.state.get(POSITION_KEY))).toEqual({
      historyId: '1000',
      savedAt: p.clock.now(),
    });
    expect(p.state.snapshot()[INSTALLED_AT_KEY]).toBe(`{"v":1,"at":${String(p.clock.now())}}`);
    expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
    expect(alerts.added).toEqual([]);
    expect(p.log.events).toEqual([
      {
        level: 'info',
        event: 'run.end',
        fields: { position: 'set', historyId: '1000', triggerMinutes: 10 },
      },
    ]);
  });

  it('1a. asks for the three essential scopes first', () => {
    const { p, run } = setup();
    run();
    expect(p.auth.calls[0]).toEqual({
      method: 'requireScopes',
      args: [[MODIFY, EXTERNAL, SCRIPTAPP]],
    });
    expect(INSTALL_REQUIRED_SCOPES).toEqual([MODIFY, EXTERNAL, SCRIPTAPP]);
    expect(p.auth.calls.map((c) => c.method)).toEqual(['requireScopes', 'missingScopes']);
  });

  it('2. re-install keeps the position and the queue, and replaces the triggers', () => {
    const { p, run } = setup();
    seedPosition(p, '500');
    saveQueue(p.state, ITEMS);
    p.trigger.seed({ handler: HANDLER, minutes: 5 });
    p.trigger.seed({ handler: HANDLER, minutes: 5 });
    const positionBefore = p.state.snapshot()[POSITION_KEY];
    const queueBefore = queueText(p);
    p.clock.advance(60_000);

    const report = run();

    expect(report).toEqual({
      position: 'kept',
      historyId: '500',
      triggerMinutes: 10,
      missingScopes: [],
    });
    expect(p.state.snapshot()[POSITION_KEY]).toBe(positionBefore);
    expect(queueText(p)).toEqual(queueBefore);
    expect(loadQueue(p.state)).toEqual(ITEMS);
    expect(getProfileCalls(p)).toBe(0);
    expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
    expect(p.state.snapshot()[INSTALLED_AT_KEY]).toBe(`{"v":1,"at":${String(p.clock.now())}}`);
  });

  it('3. re-install leaves a running fallback alone', () => {
    const { p, run } = setup();
    seedPosition(p, '500');
    p.state.seedRaw(FALLBACK_KEY, FALLBACK_TEXT);
    expect(run().position).toBe('kept');
    expect(p.state.snapshot()[FALLBACK_KEY]).toBe(FALLBACK_TEXT);
  });

  it.each(['true', ' TRUE ', 'True'])('4. RESET_POSITION=%j resets the position', (value) => {
    const { p, run } = setup();
    seedPosition(p, '500');
    p.state.seedRaw(FALLBACK_KEY, FALLBACK_TEXT);
    saveQueue(p.state, ITEMS);
    const queueBefore = queueText(p);
    p.state.seedInput('RESET_POSITION', value);

    const report = run();

    expect(report.position).toBe('reset');
    expect(report.historyId).toBe('1000');
    expect(decodePosition(p.state.get(POSITION_KEY)).historyId).toBe('1000');
    expect(p.state.snapshot()).not.toHaveProperty(FALLBACK_KEY);
    expect(p.state.getInput('RESET_POSITION')).toBeUndefined();
    expect(queueText(p)).toEqual(queueBefore);

    const writes = p.state.calls
      .filter((c) => ['set', 'delete', 'deleteInput'].includes(c.method))
      .filter((c) => c.args[0] !== INSTALLED_AT_KEY && !String(c.args[0]).startsWith('state.queue'))
      .map((c) => `${c.method}(${String(c.args[0])})`);
    expect(writes).toEqual([
      `set(${POSITION_KEY})`, // seeded
      `delete(${FALLBACK_KEY})`,
      `set(${POSITION_KEY})`,
      'deleteInput(RESET_POSITION)',
    ]);
    expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
    expect(p.log.find('run.end')?.level).toBe('info');
  });

  it('4a. replaces the trigger after the reset writes', () => {
    const order: string[] = [];
    const { p, run } = setup();
    seedPosition(p, '500');
    p.state.seedInput('RESET_POSITION', 'true');
    const deleteInput = p.state.deleteInput.bind(p.state);
    p.state.deleteInput = (name) => {
      order.push('deleteInput');
      deleteInput(name);
    };
    const replace = p.trigger.replaceRecurringTrigger.bind(p.trigger);
    p.trigger.replaceRecurringTrigger = (handler, minutes) => {
      order.push('trigger');
      return replace(handler, minutes);
    };
    run();
    expect(order).toEqual(['deleteInput', 'trigger']);
  });

  it.each(['yes', 'false', '1'])('5. ignores RESET_POSITION=%j with a warning', (value) => {
    const { p, run } = setup();
    seedPosition(p, '500');
    p.state.seedInput('RESET_POSITION', value);

    const report = run();

    expect(report.position).toBe('kept');
    expect(report.historyId).toBe('500');
    expect(p.state.getInput('RESET_POSITION')).toBe(value);
    const end = p.log.find('run.end');
    expect(end?.level).toBe('warn');
    expect(end?.fields['resetPositionIgnored']).toBe(true);
    expect(JSON.stringify(p.log.events)).not.toContain(`"${value}"`);
  });

  it.each(['', '  '])('5a. treats RESET_POSITION=%j as unset, silently', (value) => {
    const { p, run } = setup();
    seedPosition(p, '500');
    p.state.seedInput('RESET_POSITION', value);

    expect(run().position).toBe('kept');
    const end = p.log.find('run.end');
    expect(end?.level).toBe('info');
    expect(end?.fields).not.toHaveProperty('resetPositionIgnored');
  });

  it('6. deletes a stray fallback when it sets a position', () => {
    const { p, run } = setup();
    p.state.seedRaw(FALLBACK_KEY, FALLBACK_TEXT);
    expect(run().position).toBe('set');
    expect(p.state.snapshot()).not.toHaveProperty(FALLBACK_KEY);
    expect(decodePosition(p.state.get(POSITION_KEY)).historyId).toBe('1000');
  });

  it('7. a corrupt position stops install before the trigger; RESET_POSITION=true replaces it', () => {
    const { p, run } = setup();
    p.state.seedRaw(POSITION_KEY, '{"v":1,');

    const error = caught(run);
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: POSITION_KEY, reason: 'parse' });
    expect(p.trigger.triggers).toEqual([]);
    expect(p.trigger.calls).toEqual([]);

    p.state.seedInput('RESET_POSITION', 'true');
    expect(run()).toMatchObject({ position: 'reset', historyId: '1000' });
    expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
  });

  it('8. a missing key stops install before any write', () => {
    const { p, alerts, run } = setup({ jevApiKey: undefined });

    const error = caught(run);
    expect(error).toBeInstanceOf(RunAbortError);
    expect(error).toMatchObject({ reason: 'missing_key' });
    expect(messageOf(error)).toContain('set JEV_API_KEY in Script Properties');
    expect(p.state.snapshot()).toEqual({});
    expect(p.trigger.calls).toEqual([]);
    expect(getProfileCalls(p)).toBe(0);
    expect(alerts.added).toEqual([]);
  });

  describe('9. each missing scope', () => {
    it.each([MODIFY, EXTERNAL, SCRIPTAPP])(
      'requireScopes stops install without %s, before the scope check',
      (scope) => {
        const { p, alerts, run } = setup();
        p.scopes.revoke(scope);

        expect(run).toThrow(new Error(SCOPE_ERROR_MESSAGE));
        expect(p.auth.calls.map((c) => c.method)).toEqual(['requireScopes']);
        expect(p.state.snapshot()).toEqual({});
        expect(p.state.calls.filter((c) => c.method !== 'get')).toEqual([]);
        expect(p.trigger.calls).toEqual([]);
        expect(getProfileCalls(p)).toBe(0);
        expect(alerts.added).toEqual([]);
      },
    );

    it.each([MODIFY, SCRIPTAPP])('the scope check backstop stops install without %s', (scope) => {
      const { p, alerts } = setup();
      p.scopes.revoke(scope);
      // As if requireScopes had passed (the backstop behind it).
      p.auth.requireScopes = () => undefined;

      const error = caught(() => install({ config: CONFIG, alerts }, p, HANDLER));
      expect(error).toBeInstanceOf(RunAbortError);
      expect(error).toMatchObject({ reason: 'scope_missing' });
      expect(messageOf(error)).toContain(scope);
      expect(messageOf(error)).toContain('grant it and run install again');
      expect(p.state.snapshot()).toEqual({});
      expect(p.trigger.calls).toEqual([]);
      expect(p.log.find('scope_missing')?.fields['scope']).toBe(scope);
      expect(alerts.added).toEqual([{ condition: 'scope_missing', scopes: [scope] }]);
    });

    it('carries on without script.send_mail, with it in missingScopes', () => {
      const { p, alerts, run } = setup();
      p.scopes.revoke(SEND_MAIL);

      const report = run();
      expect(report.missingScopes).toEqual([SEND_MAIL]);
      expect(report.position).toBe('set');
      expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
      expect(p.log.find('scope_missing')?.fields['scope']).toBe(SEND_MAIL);
      expect(alerts.added).toEqual([{ condition: 'scope_missing', scopes: [SEND_MAIL] }]);
      expect(alerts.collected()).toMatchObject({
        conditions: ['scope_missing'],
        missingScopes: [SEND_MAIL],
      });
      const end = p.log.find('run.end');
      expect(end?.level).toBe('warn');
      expect(end?.fields['missingScopes']).toEqual([SEND_MAIL]);
    });

    it('carries on without script.external_request if requireScopes let it through', () => {
      const { p, alerts } = setup();
      p.scopes.revoke(EXTERNAL);
      p.auth.requireScopes = () => undefined;

      const report = install({ config: CONFIG, alerts }, p, HANDLER);
      expect(report.missingScopes).toEqual([EXTERNAL]);
      expect(p.trigger.triggers).toHaveLength(1);
      expect(p.log.find('run.end')?.level).toBe('warn');
      expect(alerts.added).toEqual([{ condition: 'scope_missing', scopes: [EXTERNAL] }]);
    });
  });

  it('10. an unknown scope state carries on and adds the alert', () => {
    const { p, alerts, run } = setup();
    p.auth.failWith('boom');

    const report = run();
    expect(report.missingScopes).toEqual([]);
    expect(report.position).toBe('set');
    expect(alerts.added).toEqual([{ condition: 'scope_missing' }]);
    expect(p.log.find('scope_missing')?.fields['scope']).toBe('unknown');
    expect(p.log.find('run.end')?.level).toBe('info');
  });

  describe('11. getProfile fails', () => {
    it('with scope: RunAbortError scope_missing, nothing more written', () => {
      const { p, alerts, run } = setup();
      p.state.seedRaw(FALLBACK_KEY, FALLBACK_TEXT);
      p.gmail.failNext('getProfile', fail('scope', { message: SCOPE_ERROR_MESSAGE }));

      const error = caught(run);
      expect(error).toBeInstanceOf(RunAbortError);
      expect(error).toMatchObject({ reason: 'scope_missing' });
      expect(p.state.snapshot()).not.toHaveProperty(POSITION_KEY);
      expect(p.state.snapshot()[FALLBACK_KEY]).toBe(FALLBACK_TEXT);
      expect(p.trigger.calls).toEqual([]);
      expect(alerts.added).toEqual([{ condition: 'scope_missing', scopes: [MODIFY] }]);

      expect(run().position).toBe('set');
      expect(p.trigger.triggers).toHaveLength(1);
    });

    it('with rate_limited: UnexpectedResponseError, nothing more written', () => {
      const { p, run } = setup();
      p.state.seedRaw(FALLBACK_KEY, FALLBACK_TEXT);
      p.gmail.failNext('getProfile', FakeGmail.rateLimited());

      const error = caught(run);
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(error).toMatchObject({ service: 'gmail', reason: 'rate_limited' });
      expect(messageOf(error)).toContain('run install again');
      expect(p.state.snapshot()).not.toHaveProperty(POSITION_KEY);
      expect(p.state.snapshot()[FALLBACK_KEY]).toBe(FALLBACK_TEXT);
      expect(p.trigger.calls).toEqual([]);

      expect(run().position).toBe('set');
      expect(p.trigger.triggers).toHaveLength(1);
    });
  });

  it('12. a trigger scope failure keeps the saved position; install again creates the trigger', () => {
    const { p, alerts, run } = setup();
    p.trigger.failNext('replaceRecurringTrigger', fail('scope', { message: SCOPE_ERROR_MESSAGE }));

    const error = caught(run);
    expect(error).toBeInstanceOf(RunAbortError);
    expect(error).toMatchObject({ reason: 'scope_missing' });
    expect(decodePosition(p.state.get(POSITION_KEY)).historyId).toBe('1000');
    expect(p.trigger.triggers).toEqual([]);
    expect(alerts.added).toEqual([{ condition: 'scope_missing', scopes: [SCRIPTAPP] }]);

    p.gmail.deliver();
    const report = run();
    expect(report).toMatchObject({ position: 'kept', historyId: '1000' });
    expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
  });

  it('13. a crash mid-reset leaves RESET_POSITION set; install again completes the reset', () => {
    const { p, run } = setup();
    seedPosition(p, '500');
    p.state.seedInput('RESET_POSITION', 'true');
    p.state.failNext('set', new Error('boom'), { key: POSITION_KEY });

    expect(run).toThrow('boom');
    expect(p.state.getInput('RESET_POSITION')).toBe('true');
    expect(p.trigger.calls).toEqual([]);

    const report = run();
    expect(report).toMatchObject({ position: 'reset', historyId: '1000' });
    expect(p.state.getInput('RESET_POSITION')).toBeUndefined();
    expect(p.trigger.triggers).toEqual([{ handler: HANDLER, minutes: 10 }]);
  });

  it('14. re-running install neither skips nor duplicates mail', () => {
    const { p, run } = setup();
    run();
    const { threadId } = p.gmail.deliver();
    p.clock.advance(60_000);
    run();

    const first = ingest(p, loadQueue(p.state));
    expect(first.result.counts.queued).toBe(1);
    expect(first.queue.map((item) => item.threadId)).toEqual([threadId]);
    expect(loadQueue(p.state).map((item) => item.threadId)).toEqual([threadId]);

    const second = ingest(p, loadQueue(p.state));
    expect(second.result.counts.queued).toBe(0);
    expect(second.result.counts.merged).toBe(0);
    expect(loadQueue(p.state)).toHaveLength(1);
  });

  it('15. never logs the key or a state value', () => {
    const { p, run } = setup();
    seedPosition(p, '500', 1_234_567);
    p.state.seedRaw(FALLBACK_KEY, FALLBACK_TEXT);
    p.state.seedInput('RESET_POSITION', 'true');
    p.scopes.revoke(SEND_MAIL);
    run();
    run();

    const logged = JSON.stringify(p.log.events);
    expect(logged).not.toContain('test-key');
    expect(logged).not.toContain('placeholder');
    expect(logged).not.toContain('1234567');
    for (const text of Object.values(p.state.snapshot())) {
      expect(logged).not.toContain(text);
    }
  });
});
