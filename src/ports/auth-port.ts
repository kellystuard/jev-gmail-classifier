import type { DeclaredScope } from '../core/declared-scopes.ts';
import type { Fail, Result } from '../core/result.ts';

/**
 * The scope preflight,
 * `ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizedScopes()`
 * (Solution Design §5.2, §9; `spikes/27-missing-scope.md`). Owned by E7, which
 * refines it.
 *
 * The declared scopes are `DECLARED_SCOPES` in `src/core/declared-scopes.ts`,
 * which mirrors the manifest. The adapter imports that constant; it isn't an
 * argument.
 */
export interface AuthPort {
  /**
   * The declared scopes minus the authorized ones, in declared order. `unknown`
   * if the call throws: the caller alerts and relies on the per-action `scope`
   * results.
   */
  missingScopes(): Result<{ missing: readonly DeclaredScope[] }, Fail<'unknown', { message: string }>>;
}
