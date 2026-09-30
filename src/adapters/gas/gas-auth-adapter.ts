/**
 * `GasAuthAdapter`: `AuthPort` over
 * `ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizedScopes()`
 * (Solution Design §5.2, §9; epic #13 decision 14; `spikes/27-missing-scope.md`).
 *
 * It asks Apps Script on every call, with no cache. It never throws and never
 * logs: the caller (`checkScopes`) logs and alerts.
 */
import { DECLARED_SCOPES, type DeclaredScope } from '../../core/declared-scopes.ts';
import { fail, ok, type Fail, type Result } from '../../core/result.ts';
import type { AuthPort } from '../../ports/auth-port.ts';

/**
 * There is no Apps Script type package (epic decision 15), and `declare const`
 * emits nothing: the global is Apps Script's.
 */
declare const ScriptApp: {
  readonly AuthMode: { readonly FULL: unknown };
  getAuthorizationInfo(authMode: unknown): { getAuthorizedScopes(): unknown };
};

type MissingScopesResult = Result<
  { missing: readonly DeclaredScope[] },
  Fail<'unknown', { message: string }>
>;

/**
 * Pure: `DECLARED_SCOPES` minus `authorized`, in declared order. Only the
 * string entries of the array count, compared exactly.
 */
export function missingFromAuthorized(authorized: unknown): MissingScopesResult {
  if (!Array.isArray(authorized)) {
    return fail('unknown', { message: 'getAuthorizedScopes returned no array' });
  }
  const granted = new Set<string>(
    authorized.filter((entry): entry is string => typeof entry === 'string'),
  );
  return ok({ missing: DECLARED_SCOPES.filter((scope) => !granted.has(scope)) });
}

export class GasAuthAdapter implements AuthPort {
  missingScopes(): MissingScopesResult {
    try {
      const authorized = ScriptApp.getAuthorizationInfo(
        ScriptApp.AuthMode.FULL,
      ).getAuthorizedScopes();
      return missingFromAuthorized(authorized);
    } catch (error) {
      return fail('unknown', { message: error instanceof Error ? error.message : String(error) });
    }
  }
}
