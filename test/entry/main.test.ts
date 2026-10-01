import { describe, expect, it } from 'vitest';

import { ENTRY_POINTS } from '../../src/entry/entry-points.ts';
import * as main from '../../src/entry/main.ts';

describe('entry points', () => {
  it('main.ts exports exactly the names the bundle footer calls', () => {
    expect(Object.keys(main).sort()).toEqual([...ENTRY_POINTS].sort());
  });

  it.each(ENTRY_POINTS)('%s is a function', (name) => {
    expect(main[name]).toBeTypeOf('function');
  });

  // All six need Apps Script's globals: the bundle test
  // (test/build/bundle.test.ts) runs them against stubs.
});
