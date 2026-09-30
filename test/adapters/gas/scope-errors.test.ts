import { describe, expect, it } from 'vitest';

import { isScopeErrorMessage } from '../../../src/adapters/gas/scope-errors.ts';

// The fragments from E1 (#27, SD §9), as Apps Script writes them.
const SCOPE_FRAGMENTS = [
  'Authorization is required to perform that action',
  'insufficient authentication scopes',
  'Specified permissions are not sufficient',
];

describe('isScopeErrorMessage', () => {
  it.each(SCOPE_FRAGMENTS)('matches a message containing %j', (fragment) => {
    expect(isScopeErrorMessage(`Exception: ${fragment}.`)).toBe(true);
  });

  it.each(SCOPE_FRAGMENTS)('ignores case for %j', (fragment) => {
    expect(isScopeErrorMessage(fragment.toUpperCase())).toBe(true);
    expect(isScopeErrorMessage(fragment.toLowerCase())).toBe(true);
  });

  it('does not match other messages', () => {
    expect(isScopeErrorMessage('DNS error: https://jev-smoke.invalid/')).toBe(false);
    expect(isScopeErrorMessage('')).toBe(false);
  });
});
