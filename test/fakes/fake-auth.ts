import { DECLARED_SCOPES, type DeclaredScope } from '../../src/core/declared-scopes.ts';
import { type Fail, type Result, fail, ok } from '../../src/core/result.ts';
import type { AuthPort } from '../../src/ports/auth-port.ts';
import { FakeScopes } from './fake-scopes.ts';
import type { FakeCall } from './failure-queue.ts';

/** The scope preflight: the declared scopes `FakeScopes` doesn't grant, in declared order. */
export class FakeAuth implements AuthPort {
  readonly calls: FakeCall<'missingScopes'>[] = [];
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

  /** The next call fails as if `getAuthorizationInfo` threw `message`. */
  failWith(message: string): void {
    this.nextError = message;
  }
}
