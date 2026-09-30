import { describe, expect, it } from 'vitest';

import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { FakeAuth } from './fake-auth.ts';
import { FakeScopes, SCOPE_ERROR_MESSAGE } from './fake-scopes.ts';

describe('FakeAuth', () => {
  it('reports nothing missing when every declared scope is granted', () => {
    expect(new FakeAuth().missingScopes()).toEqual({ ok: true, missing: [] });
  });

  it('reports revoked scopes as missing, in declared order', () => {
    const scopes = new FakeScopes();
    const auth = new FakeAuth({ scopes });
    scopes.revoke('https://www.googleapis.com/auth/script.send_mail');
    scopes.revoke('https://www.googleapis.com/auth/gmail.modify');
    expect(auth.missingScopes()).toEqual({
      ok: true,
      missing: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/script.send_mail',
      ],
    });
  });

  it('reports every scope missing when none is granted', () => {
    const auth = new FakeAuth({ scopes: new FakeScopes([]) });
    expect(auth.missingScopes()).toEqual({ ok: true, missing: [...DECLARED_SCOPES] });
  });

  it('fails the next call with unknown after failWith', () => {
    const auth = new FakeAuth();
    auth.failWith('Authorization is required to perform that action.');
    expect(auth.missingScopes()).toEqual({
      ok: false,
      kind: 'unknown',
      message: 'Authorization is required to perform that action.',
    });
    expect(auth.missingScopes().ok).toBe(true);
    expect(auth.calls).toHaveLength(2);
  });
});

describe('FakeAuth.requireScopes', () => {
  const [MODIFY, EXTERNAL, , SEND_MAIL] = DECLARED_SCOPES;

  it('records the call and returns when every listed scope is granted', () => {
    const scopes = new FakeScopes();
    scopes.revoke(SEND_MAIL);
    const auth = new FakeAuth({ scopes });
    expect(() => {
      auth.requireScopes([MODIFY, EXTERNAL]);
    }).not.toThrow();
    expect(auth.calls).toEqual([{ method: 'requireScopes', args: [[MODIFY, EXTERNAL]] }]);
  });

  it('throws the authorization error when a listed scope is revoked', () => {
    const scopes = new FakeScopes();
    scopes.revoke(EXTERNAL);
    const auth = new FakeAuth({ scopes });
    expect(() => {
      auth.requireScopes([MODIFY, EXTERNAL]);
    }).toThrow(new Error(SCOPE_ERROR_MESSAGE));
    expect(auth.calls).toHaveLength(1);
  });

  it('is not affected by failWith', () => {
    const auth = new FakeAuth();
    auth.failWith('boom');
    auth.requireScopes([MODIFY]);
    expect(auth.missingScopes().ok).toBe(false);
  });
});
