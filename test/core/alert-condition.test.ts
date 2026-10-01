import { describe, expect, it } from 'vitest';

import { ALERT_CONDITIONS } from '../../src/core/alert-condition.ts';

describe('ALERT_CONDITIONS', () => {
  it('is the seven conditions in a fixed order', () => {
    expect([...ALERT_CONDITIONS]).toEqual([
      'auth',
      'errored',
      'run_failures',
      'budget_reached',
      'scope_missing',
      'history_expired',
      'config_invalid',
    ]);
    expect(new Set(ALERT_CONDITIONS).size).toBe(ALERT_CONDITIONS.length);
  });
});
