import { DECLARED_SCOPES, type DeclaredScope } from '../../src/core/declared-scopes.ts';
import { type Fail, type Result, fail, ok } from '../../src/core/result.ts';
import type { AuthPort } from '../../src/ports/auth-port.ts';
import { FakeScopes, SCOPE_ERROR_MESSAGE } from './fake-scopes.ts';
import type { FakeCall } from './failure-queue.ts';

/**
 * The scope preflight (the declared scopes `FakeScopes` doesn't grant, in
 * declared order) and `requireScopes` (throws when a listed scope isn't granted).
 */
export class FakeAuth implements AuthPort {
  readonly calls: FakeCall<'missingScopes' | 'requireScopes'>[] = [];
  private readonly scopes: FakeScopes;
  private nextError: string | undefined = undefined;

  constructor(options: { readonly scopes?: FakeScopes } = {}) {
    this.scopes = options.scopes ?? new FakeScopes();
  }

  missingScopes(): Result<
    { missing: readonly DeclaredScope[] },
    Fail<'unknown', { message: string }>
  > {
    this.calls.push({ method: 'missingScopes', args: [] });
    if (this.nextError !== undefined) {
      const message = this.nextError;
      this.nextError = undefined;
      return fail('unknown', { message });
    }
    return ok({ missing: DECLARED_SCOPES.filter((scope) => !this.scopes.has(scope)) });
  }

  /**
   * Records the call, then throws `Error(SCOPE_ERROR_MESSAGE)` if any listed
   * scope isn't granted, as `ScriptApp.requireScopes` does. `failWith`
   * doesn't affect it.
   */
  requireScopes(scopes: readonly DeclaredScope[]): void {
    this.calls.push({ method: 'requireScopes', args: [[...scopes]] });
    if (scopes.some((scope) => !this.scopes.has(scope))) {
      throw new Error(SCOPE_ERROR_MESSAGE);
    }
  }

  /** The next `missingScopes` call fails as if `getAuthorizationInfo` threw `message`. */
  failWith(message: string): void {
    this.nextError = message;
  }
}
