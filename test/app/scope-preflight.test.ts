import { describe, expect, it } from 'vitest';
import { checkScopes } from '../../src/app/scope-preflight.ts';
import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { SCOPE_FEATURES } from '../../src/core/scope-features.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';

const ALL_ON = { gmail: true, classify: true, trigger: true, alertMail: true };
const [MODIFY, , , SEND_MAIL] = DECLARED_SCOPES;

describe('checkScopes', () => {
  it('reports nothing when every scope is granted', () => {
    const p = createFakePorts();
    const check = checkScopes(p);
    expect(check).toEqual({ missing: [], can: ALL_ON, alerts: [] });
    expect(check).not.toHaveProperty('unknown');
    expect(p.log.events).toEqual([]);
    expect(p.auth.calls).toHaveLength(1);
  });

  it.each([
    [DECLARED_SCOPES[0], 'gmail'],
    [DECLARED_SCOPES[1], 'classify'],
    [DECLARED_SCOPES[2], 'trigger'],
    [DECLARED_SCOPES[3], 'alertMail'],
  ] as const)('reports %s revoked alone', (scope, flag) => {
    const p = createFakePorts();
    p.scopes.revoke(scope);
    const check = checkScopes(p);
    expect(check.missing).toEqual([scope]);
    expect(check.can).toEqual({ ...ALL_ON, [flag]: false });
    expect(check.alerts).toEqual(['scope_missing']);
    expect(p.log.events).toEqual([
      {
        level: 'warn',
        event: 'scope_missing',
        fields: {
          scope,
          feature: SCOPE_FEATURES[scope].feature,
          disables: SCOPE_FEATURES[scope].disables,
        },
      },
    ]);
  });

  it('logs one event per missing scope in declared order, with one alert condition', () => {
    const p = createFakePorts({ grantedScopes: DECLARED_SCOPES.slice(1, 3) });
    const check = checkScopes(p);
    expect(check.missing).toEqual([MODIFY, SEND_MAIL]);
    expect(p.log.all('scope_missing').map((e) => e.fields.scope)).toEqual([MODIFY, SEND_MAIL]);
    expect(check.alerts).toEqual(['scope_missing']);
  });

  it('turns every feature off when nothing is granted', () => {
    const p = createFakePorts({ grantedScopes: [] });
    const check = checkScopes(p);
    expect(check.missing).toEqual([...DECLARED_SCOPES]);
    expect(check.can).toEqual({ gmail: false, classify: false, trigger: false, alertMail: false });
    expect(p.log.all('scope_missing')).toHaveLength(4);
  });

  it('treats a failed check as unknown: every feature stays on', () => {
    const message = 'Authorization is required to perform that action.';
    const p = createFakePorts();
    p.auth.failWith(message);
    const check = checkScopes(p);
    expect(check).toEqual({
      missing: [],
      unknown: { message },
      can: ALL_ON,
      alerts: ['scope_missing'],
    });
    expect(p.log.events).toEqual([
      {
        level: 'warn',
        event: 'scope_missing',
        fields: { scope: 'unknown', errorMessage: message },
      },
    ]);
  });

  it('calls nothing but the auth port', () => {
    const p = createFakePorts({ grantedScopes: [] });
    checkScopes(p);
    for (const port of [p.gmail, p.http, p.trigger, p.mail, p.state]) {
      expect(port.calls).toEqual([]);
    }
  });
});
