/**
 * Recognizes a missing OAuth scope in an Apps Script error message (Solution
 * Design §9). Shared by the Gmail and HTTP adapters. Pure, with no Apps Script
 * globals.
 *
 * The fragments come from E1 (#27, `spikes/27-missing-scope.md`). Only the
 * all-granted state was run there, so the per-scope error text is **not
 * observed** yet (#125 confirms it). Anything unmatched follows the caller's
 * normal rules.
 */

/** Message fragments that mean a missing OAuth scope, in lower case. */
const SCOPE_FRAGMENTS: readonly string[] = [
  // Documented for trigger runs.
  'authorization is required to perform that action',
  // The Gmail API's 403.
  'insufficient authentication scopes',
  'specified permissions are not sufficient',
];

/** Whether `message` contains any scope fragment, ignoring case. */
export function isScopeErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return SCOPE_FRAGMENTS.some((fragment) => lower.includes(fragment));
}
