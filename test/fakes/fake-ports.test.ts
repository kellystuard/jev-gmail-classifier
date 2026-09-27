import { describe, expect, it } from 'vitest';

import type { AuthPort } from '../../src/ports/auth-port.ts';
import type { ClockPort } from '../../src/ports/clock-port.ts';
import type { HttpPort } from '../../src/ports/http-port.ts';
import type { LockPort } from '../../src/ports/lock-port.ts';
import type { LogPort } from '../../src/ports/log-port.ts';
import type { MailPort } from '../../src/ports/mail-port.ts';
import type { RandomPort } from '../../src/ports/random-port.ts';
import type { SecretsPort } from '../../src/ports/secrets-port.ts';
import type { StatePort } from '../../src/ports/state-port.ts';
import type { TriggerPort } from '../../src/ports/trigger-port.ts';
import { createFakePorts } from './fake-ports.ts';

describe('createFakePorts', () => {
  it('returns a fake for each port but Gmail (#194)', () => {
    const ports = createFakePorts();
    const typed: {
      http: HttpPort;
      state: StatePort;
      secrets: SecretsPort;
      lock: LockPort;
      clock: ClockPort;
      random: RandomPort;
      log: LogPort;
      mail: MailPort;
      trigger: TriggerPort;
      auth: AuthPort;
    } = ports;
    expect(Object.keys(typed).sort()).toEqual([
      'auth',
      'clock',
      'http',
      'lock',
      'log',
      'mail',
      'random',
      'scopes',
      'secrets',
      'state',
      'trigger',
    ]);
  });

  it('starts at a fixed time with a test key and every scope granted', () => {
    const ports = createFakePorts();
    expect(ports.clock.now()).toBe(Date.UTC(2026, 8, 26, 12));
    expect(ports.clock.timeZone()).toBe('Etc/UTC');
    expect(ports.secrets.getJevApiKey()).toBe('test-key');
    expect(ports.auth.missingScopes()).toEqual({ ok: true, missing: [] });
  });

  it('shares one clock between HTTP and the caller', () => {
    const ports = createFakePorts({ now: 0, httpLatencyMs: 1000 });
    ports.http.respond(() => true, [{ status: 200 }]);
    ports.http.sendAll([{ url: 'https://example.com', method: 'get', headers: {} }]);
    ports.clock.sleep(5);
    expect(ports.clock.now()).toBe(1005);
  });

  it('shares one set of scopes across the Google-facing fakes', () => {
    const ports = createFakePorts();
    ports.scopes.revoke('https://www.googleapis.com/auth/script.send_mail');
    expect(ports.mail.send('owner@example.com', 's', 'b')).toMatchObject({
      ok: false,
      kind: 'scope',
    });
    expect(ports.trigger.deleteTriggers('onTrigger').ok).toBe(true);
    expect(ports.auth.missingScopes()).toEqual({
      ok: true,
      missing: ['https://www.googleapis.com/auth/script.send_mail'],
    });
  });

  it('takes options for the key, scopes and seed', () => {
    const ports = createFakePorts({ jevApiKey: undefined, grantedScopes: [], seed: 3 });
    expect(ports.secrets.getJevApiKey()).toBeUndefined();
    expect(
      ports.http.sendAll([{ url: 'https://example.com', method: 'get', headers: {} }])[0],
    ).toMatchObject({
      kind: 'scope',
    });
    expect(ports.random.next()).toBe(createFakePorts({ seed: 3 }).random.next());
  });
});
