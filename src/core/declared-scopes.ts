/**
 * The OAuth scopes the script declares, in the order of `oauthScopes` in the
 * repo-root `appsscript.json` (Solution Design §9, ADR-0003).
 *
 * The manifest is the source of truth. `test/manifest.test.ts` fails if this
 * list and the manifest differ. Changing the scope list needs a new ADR.
 */
export const DECLARED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.send_mail',
] as const;

export type DeclaredScope = (typeof DECLARED_SCOPES)[number];
