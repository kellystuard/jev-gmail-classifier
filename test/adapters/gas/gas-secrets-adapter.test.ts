import { describe, expect, it } from 'vitest';

import { normalizeApiKey } from '../../../src/adapters/gas/gas-secrets-adapter.ts';

describe('normalizeApiKey', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['  ', undefined],
    [' test-key ', 'test-key'],
    ['\ttest-key\n', 'test-key'],
    ['test-key', 'test-key'],
  ])('%j becomes %j', (value, expected) => {
    expect(normalizeApiKey(value)).toBe(expected);
  });
});
