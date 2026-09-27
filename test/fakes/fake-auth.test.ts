import { describe, expect, it } from 'vitest';

import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { FakeAuth } from './fake-auth.ts';
import { FakeScopes } from './fake-scopes.ts';

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
