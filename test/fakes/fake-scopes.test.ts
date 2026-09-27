import { describe, expect, it } from 'vitest';

import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { FakeScopes, SCOPE_ERROR_MESSAGE } from './fake-scopes.ts';

describe('FakeScopes', () => {
  it('starts with every declared scope granted', () => {
    const scopes = new FakeScopes();
    for (const scope of DECLARED_SCOPES) {
      expect(scopes.has(scope)).toBe(true);
      expect(scopes.failureFor(scope)).toBeUndefined();
    }
  });

  it('revokes and grants a scope', () => {
    const scopes = new FakeScopes();
    const scope = 'https://www.googleapis.com/auth/gmail.modify';
    scopes.revoke(scope);
    expect(scopes.has(scope)).toBe(false);
    expect(scopes.failureFor(scope)).toEqual({
      ok: false,
      kind: 'scope',
      message: SCOPE_ERROR_MESSAGE,
    });
    scopes.grant(scope);
    expect(scopes.has(scope)).toBe(true);
  });
});
