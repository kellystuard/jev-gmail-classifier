import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL, labelAncestors } from '../../src/core/label-path.ts';

describe('labelAncestors', () => {
  it.each([
    ['A', ['A']],
    ['A/B/C', ['A', 'A/B', 'A/B/C']],
    [JEV_ERROR_LABEL, ['Jev', 'Jev/Error']],
    ['A / B', ['A', 'A/B']],
  ])('%j gives %j', (name, expected) => {
    expect(labelAncestors(name)).toEqual(expected);
  });

  it.each(['', 'A//B', '/A', 'A/', ' '])('throws InvalidArgumentError for %j', (name) => {
    expect(() => labelAncestors(name)).toThrow(InvalidArgumentError);
  });
});
