import { DECLARED_SCOPES, type DeclaredScope } from '../../src/core/declared-scopes.ts';
import { type Fail, fail } from '../../src/core/result.ts';

/** The message a fake returns for a call whose scope is revoked (Solution Design §9). */
export const SCOPE_ERROR_MESSAGE = 'Authorization is required to perform that action.';

/**
 * The scopes the fake user has granted, shared by every Google-facing fake.
 * It starts with every declared scope granted.
 */
export class FakeScopes {
  private readonly granted: Set<DeclaredScope>;

  constructor(granted: readonly DeclaredScope[] = DECLARED_SCOPES) {
    this.granted = new Set(granted);
  }

  has(scope: DeclaredScope): boolean {
    return this.granted.has(scope);
  }

  grant(scope: DeclaredScope): void {
    this.granted.add(scope);
  }

  revoke(scope: DeclaredScope): void {
    this.granted.delete(scope);
  }

  /** The `scope` failure if `scope` is revoked, otherwise `undefined`. */
  failureFor(scope: DeclaredScope): Fail<'scope', { message: string }> | undefined {
    return this.has(scope) ? undefined : fail('scope', { message: SCOPE_ERROR_MESSAGE });
  }
}
