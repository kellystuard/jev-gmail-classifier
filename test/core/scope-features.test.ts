import { describe, expect, it } from 'vitest';
import { DECLARED_SCOPES } from '../../src/core/declared-scopes.ts';
import { SCOPE_FEATURES, availableFeatures } from '../../src/core/scope-features.ts';

const ALL_ON = { gmail: true, classify: true, trigger: true, alertMail: true };

describe('SCOPE_FEATURES', () => {
  it('has one row per declared scope, with the documented features', () => {
    expect(Object.keys(SCOPE_FEATURES)).toEqual([...DECLARED_SCOPES]);
    expect(DECLARED_SCOPES.map((scope) => SCOPE_FEATURES[scope].feature)).toEqual([
      'gmail',
      'classify',
      'trigger',
      'alert_mail',
    ]);
    for (const scope of DECLARED_SCOPES) {
      expect(SCOPE_FEATURES[scope].disables.length).toBeGreaterThan(0);
    }
  });
});

describe('availableFeatures', () => {
  it('turns everything on when nothing is missing', () => {
    expect(availableFeatures([])).toEqual(ALL_ON);
  });

  it.each([
    [DECLARED_SCOPES[0], 'gmail'],
    [DECLARED_SCOPES[1], 'classify'],
    [DECLARED_SCOPES[2], 'trigger'],
    [DECLARED_SCOPES[3], 'alertMail'],
  ] as const)('turns off only the feature of %s', (scope, flag) => {
    expect(availableFeatures([scope])).toEqual({ ...ALL_ON, [flag]: false });
  });

  it('turns everything off when all are missing, in any order, with duplicates', () => {
    const off = { gmail: false, classify: false, trigger: false, alertMail: false };
    expect(availableFeatures(DECLARED_SCOPES)).toEqual(off);
    expect(availableFeatures([...DECLARED_SCOPES].reverse())).toEqual(off);
    expect(availableFeatures([...DECLARED_SCOPES, ...DECLARED_SCOPES])).toEqual(off);
  });
});
