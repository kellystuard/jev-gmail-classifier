import { describe, expect, it } from 'vitest';

import { uninstall } from '../../src/app/uninstall.ts';
import { RunAbortError } from '../../src/core/errors.ts';
import { fail } from '../../src/core/result.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';

const HANDLER = 'onTrigger';
const SCRIPTAPP = 'https://www.googleapis.com/auth/script.scriptapp';

const STATE_KEYS = [
  'state.position',
  'state.fallback',
  'state.installedAt',
  'state.budget',
  'state.jevErrorLabel',
  'state.runs',
  'state.gmailCalls',
  'state.queue.0',
  'state.queue.1',
  'state.queue.2',
];

function setup() {
  const ports = createFakePorts();
  for (const key of STATE_KEYS) {
    ports.state.seedRaw(key, '{"v":1}');
  }
  ports.state.seedRaw('JEV_API_KEY', 'secret-key');
  ports.state.seedInput('MANUAL_QUERY', 'in:inbox');
  ports.state.seedInput('MANUAL_TIMESPAN', '7d');
  ports.state.seedInput('RESET_POSITION', 'true');
  ports.trigger.seed({ handler: HANDLER, minutes: 10 });
  ports.trigger.seed({ handler: HANDLER, minutes: 5 });
  ports.trigger.seed({ handler: 'otherHandler', minutes: 15 });
  const kept = {
    JEV_API_KEY: 'secret-key',
    MANUAL_QUERY: 'in:inbox',
    MANUAL_TIMESPAN: '7d',
    RESET_POSITION: 'true',
  };
  return { ports, kept };
}

function run(ports: FakePorts) {
  return uninstall({ trigger: ports.trigger, state: ports.state, log: ports.log }, HANDLER);
}

describe('uninstall', () => {
  it('deletes the triggers and every state key, and leaves the rest', () => {
    const { ports, kept } = setup();
    const report = run(ports);
    expect(report).toEqual({ triggersDeleted: 2, keysDeleted: 10 });
    expect(ports.state.snapshot()).toEqual(kept);
    expect(ports.trigger.triggers).toEqual([{ handler: 'otherHandler', minutes: 15 }]);
  });

  it('deletes the triggers before it touches state', () => {
    const { ports } = setup();
    run(ports);
    expect(ports.trigger.calls.map((c) => c.method)).toEqual(['deleteTriggers']);
    expect(ports.state.calls[0]?.method).toBe('keys');

    const again = setup();
    again.ports.state.failNext('keys', new Error('boom'));
    expect(() => run(again.ports)).toThrow('boom');
    expect(again.ports.trigger.triggers).toEqual([{ handler: 'otherHandler', minutes: 15 }]);
  });

  it.each([
    [
      'the scope is revoked',
      (p: FakePorts) => {
        p.scopes.revoke(SCRIPTAPP);
      },
    ],
    [
      'the trigger port reports scope',
      (p: FakePorts) => {
        p.trigger.failNext('deleteTriggers', fail('scope', { message: 'no scope' }));
      },
    ],
  ])('stops before any state call when %s', (_name, arrange) => {
    const { ports } = setup();
    const before = ports.state.snapshot();
    arrange(ports);
    let thrown: unknown;
    try {
      run(ports);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunAbortError);
    expect(thrown instanceof RunAbortError && thrown.reason).toBe('scope_missing');
    expect(ports.state.calls).toEqual([]);
    expect(ports.state.snapshot()).toEqual(before);
    expect(ports.log.find('run.end')).toBeUndefined();
  });

  it('deletes corrupt values and odd keys without reading them', () => {
    const ports = createFakePorts();
    ports.state.seedRaw('state.position', '{"v":1,');
    ports.state.seedRaw('state.queue.0', '{"v":99}');
    ports.state.seedRaw('state.queue.x', '{}');
    expect(run(ports)).toEqual({ triggersDeleted: 0, keysDeleted: 3 });
    expect(ports.state.snapshot()).toEqual({});
    expect(ports.state.calls.map((c) => c.method)).not.toContain('get');
  });

  it('is idempotent', () => {
    const { ports, kept } = setup();
    run(ports);
    expect(run(ports)).toEqual({ triggersDeleted: 0, keysDeleted: 0 });
    expect(ports.state.snapshot()).toEqual(kept);
    expect(ports.log.all('run.end')).toHaveLength(2);
  });

  it('does nothing when nothing is installed', () => {
    const ports = createFakePorts();
    expect(run(ports)).toEqual({ triggersDeleted: 0, keysDeleted: 0 });
  });

  it('propagates a failing delete, and a second run finishes the job', () => {
    const { ports, kept } = setup();
    ports.state.failNext('delete', new Error('boom'), { key: 'state.queue.1' });
    expect(() => run(ports)).toThrow('boom');
    expect(ports.log.find('run.end')).toBeUndefined();
    const report = run(ports);
    expect(report.triggersDeleted).toBe(0);
    expect(ports.state.snapshot()).toEqual(kept);
  });

  it('logs one run.end with only the two counts', () => {
    const { ports } = setup();
    run(ports);
    expect(ports.log.events).toEqual([
      { level: 'info', event: 'run.end', fields: { triggersDeleted: 2, keysDeleted: 10 } },
    ]);
    const text = JSON.stringify(ports.log.events);
    expect(text).not.toContain('state.');
    expect(text).not.toContain('JEV_API_KEY');
    expect(text).not.toContain('secret-key');
  });
});
