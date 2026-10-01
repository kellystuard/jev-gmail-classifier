import { describe, expect, it } from 'vitest';

import { ENTRY_POINTS } from '../../src/entry/entry-points.ts';
import * as main from '../../src/entry/main.ts';

/** The fixture config `vitest.config.ts` embeds has three rules. */
const FIXTURE_RULE_COUNT = 3;

describe('entry points', () => {
  it('main.ts exports exactly the names the bundle footer calls', () => {
    expect(Object.keys(main).sort()).toEqual([...ENTRY_POINTS].sort());
  });

  it.each(ENTRY_POINTS)('%s is a function', (name) => {
    expect(main[name]).toBeTypeOf('function');
  });

  // onTrigger, install and uninstall need Apps Script's globals: the bundle
  // test (test/build/bundle.test.ts) runs them against stubs.
  it.each(['startManualRun', 'continueManualRun', 'cancelManualRun'] as const)(
    '%s is still a placeholder that loads the config (until E8)',
    (name) => {
      expect(main[name]()).toEqual({
        entry: name,
        status: 'placeholder',
        ruleCount: FIXTURE_RULE_COUNT,
      });
    },
  );
});
