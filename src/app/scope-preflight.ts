/**
 * The scope preflight (Solution Design §9; epic #13 decisions 9 and 10). Asks
 * `AuthPort.missingScopes()` once, logs `scope_missing` for each missing scope
 * and returns which features the caller may use. It returns its alert
 * condition instead of taking a collector: the caller (`runPreflight`,
 * `install`) adds it, like `ingest` and `processChunk` return theirs.
 *
 * It doesn't catch a throw from the port; that reaches the per-run boundary.
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import type { DeclaredScope } from '../core/declared-scopes.ts';
import {
  type FeatureAvailability,
  SCOPE_FEATURES,
  availableFeatures,
} from '../core/scope-features.ts';
import type { AuthPort } from '../ports/auth-port.ts';
import type { LogPort } from '../ports/log-port.ts';

export type ScopeCheck = {
  /** Declared order; `[]` when `unknown`. */
  readonly missing: readonly DeclaredScope[];
  /** Set when `missingScopes()` failed: the state is unknown. */
  readonly unknown?: { readonly message: string };
  readonly can: FeatureAvailability;
  /** `['scope_missing']` when anything is missing or unknown, else `[]`. */
  readonly alerts: readonly AlertCondition[];
};

export function checkScopes(deps: { readonly auth: AuthPort; readonly log: LogPort }): ScopeCheck {
  const result = deps.auth.missingScopes();
  if (!result.ok) {
    deps.log.warn('scope_missing', { scope: 'unknown', errorMessage: result.message });
    // Unknown leaves every feature on: the per-action `scope` results are the fallback.
    return {
      missing: [],
      unknown: { message: result.message },
      can: availableFeatures([]),
      alerts: ['scope_missing'],
    };
  }
  const { missing } = result;
  for (const scope of missing) {
    const { feature, disables } = SCOPE_FEATURES[scope];
    deps.log.warn('scope_missing', { scope, feature, disables });
  }
  return {
    missing,
    can: availableFeatures(missing),
    alerts: missing.length > 0 ? ['scope_missing'] : [],
  };
}
