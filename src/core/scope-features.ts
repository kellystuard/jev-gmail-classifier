/**
 * The map from each declared scope to the feature it enables (Solution Design
 * §9 "Scope preflight"; epic #13 decisions 9 and 10). Pure: the preflight in
 * `src/app/scope-preflight.ts` uses it, and callers skip a disabled feature
 * before calling it.
 */
import type { DeclaredScope } from './declared-scopes.ts';

export type ScopeFeature = 'gmail' | 'classify' | 'trigger' | 'alert_mail';

/**
 * The scopes `install` insists on with `AuthPort.requireScopes` (SD §6.7, §9;
 * epic #13 decision 11, option A), in declared order: nothing useful works
 * without reading Gmail, calling Jev and the trigger. `script.send_mail` stays
 * optional: without it, alerts are only logged.
 */
export const INSTALL_REQUIRED_SCOPES: readonly DeclaredScope[] = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.scriptapp',
];

/**
 * A `Record<DeclaredScope, …>`: adding a scope to `DECLARED_SCOPES` without a
 * row fails the typecheck. `disables` is short and stable: it goes into the
 * `scope_missing` log event and E9's alert.
 */
export const SCOPE_FEATURES: Readonly<
  Record<DeclaredScope, { readonly feature: ScopeFeature; readonly disables: string }>
> = {
  'https://www.googleapis.com/auth/gmail.modify': {
    feature: 'gmail',
    disables: 'everything: reading history and threads, labels and moves',
  },
  'https://www.googleapis.com/auth/script.external_request': {
    feature: 'classify',
    disables: 'classification: nothing is sent to Jev; new mail is still queued',
  },
  'https://www.googleapis.com/auth/script.scriptapp': {
    feature: 'trigger',
    disables: "install and uninstall can't create or remove the trigger",
  },
  'https://www.googleapis.com/auth/script.send_mail': {
    feature: 'alert_mail',
    disables: 'alert email: alerts are only logged',
  },
};

export type FeatureAvailability = {
  /** `gmail.modify`. */
  readonly gmail: boolean;
  /** `script.external_request`. */
  readonly classify: boolean;
  /** `script.scriptapp`. */
  readonly trigger: boolean;
  /** `script.send_mail`. */
  readonly alertMail: boolean;
};

/** Every feature on, except those whose scope is in `missing`. */
export function availableFeatures(missing: readonly DeclaredScope[]): FeatureAvailability {
  const off = new Set<ScopeFeature>(missing.map((scope) => SCOPE_FEATURES[scope].feature));
  return {
    gmail: !off.has('gmail'),
    classify: !off.has('classify'),
    trigger: !off.has('trigger'),
    alertMail: !off.has('alert_mail'),
  };
}
