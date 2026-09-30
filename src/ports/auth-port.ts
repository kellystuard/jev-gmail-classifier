import type { DeclaredScope } from '../core/declared-scopes.ts';
import type { Fail, Result } from '../core/result.ts';

/**
 * The scope preflight,
 * `ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizedScopes()`,
 * and `install`'s consent check, `ScriptApp.requireScopes` (Solution Design
 * §5.2, §6.7, §9; `spikes/27-missing-scope.md`). Owned by E7.
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
  missingScopes(): Result<
    { missing: readonly DeclaredScope[] },
    Fail<'unknown', { message: string }>
  >;

  /**
   * `ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, scopes)`: throws, via
   * Apps Script, when any of `scopes` isn't granted. Run from the editor, that
   * brings the consent screen back. Only `install` calls it, with
   * `INSTALL_REQUIRED_SCOPES` (SD §6.7, §9), and nothing catches the error.
   */
  requireScopes(scopes: readonly DeclaredScope[]): void;
}
