import { describe, expect, it } from 'vitest';

import { fail } from '../../src/core/result.ts';
import { FakeMail, MAIL_QUOTA_MESSAGE } from './fake-mail.ts';
import { FakeScopes, SCOPE_ERROR_MESSAGE } from './fake-scopes.ts';

describe('FakeMail', () => {
  it('records sent mail', () => {
    const mail = new FakeMail();
    expect(mail.send('owner@example.com', 'Jev alert', 'Text')).toEqual({ ok: true });
    expect(mail.sent).toEqual([{ to: 'owner@example.com', subject: 'Jev alert', body: 'Text' }]);
  });

  it('returns scope while script.send_mail is revoked', () => {
    const scopes = new FakeScopes();
    const mail = new FakeMail({ scopes });
    scopes.revoke('https://www.googleapis.com/auth/script.send_mail');
    expect(mail.send('owner@example.com', 's', 'b')).toEqual({
      ok: false,
      kind: 'scope',
      message: SCOPE_ERROR_MESSAGE,
    });
    expect(mail.sent).toEqual([]);
    scopes.grant('https://www.googleapis.com/auth/script.send_mail');
    expect(mail.send('owner@example.com', 's', 'b').ok).toBe(true);
  });

  it('returns quota once the daily quota is used up', () => {
    const mail = new FakeMail({ dailyQuota: 1 });
    expect(mail.send('owner@example.com', 'one', 'b').ok).toBe(true);
    expect(mail.send('owner@example.com', 'two', 'b')).toEqual({
      ok: false,
      kind: 'quota',
      message: MAIL_QUOTA_MESSAGE,
    });
    expect(mail.sent).toHaveLength(1);
  });

  it('uses injected failures first, then works again', () => {
    const mail = new FakeMail();
    mail.failNext('send', fail('quota', { message: 'injected' }), { times: 2 });
    mail.failNext('send', new Error('Unexpected'));
    expect(mail.send('a@example.com', 's', 'b')).toMatchObject({ kind: 'quota' });
    expect(mail.send('a@example.com', 's', 'b')).toMatchObject({ kind: 'quota' });
    expect(() => mail.send('a@example.com', 's', 'b')).toThrow('Unexpected');
    expect(mail.send('a@example.com', 's', 'b').ok).toBe(true);
    expect(mail.calls).toHaveLength(4);
  });
});
