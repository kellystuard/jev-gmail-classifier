import { describe, expect, it } from 'vitest';

import { FakeRandom } from './fake-random.ts';

function take(random: FakeRandom, n: number): number[] {
  return Array.from({ length: n }, () => random.next());
}

describe('FakeRandom', () => {
  it('gives the same sequence for the same seed', () => {
    expect(take(new FakeRandom(42), 5)).toEqual(take(new FakeRandom(42), 5));
  });

  it('gives a different sequence for a different seed', () => {
    expect(take(new FakeRandom(1), 5)).not.toEqual(take(new FakeRandom(2), 5));
  });

  it('stays in [0, 1)', () => {
    for (const value of take(new FakeRandom(7), 1000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('returns a fixed sequence in order and repeats it', () => {
    expect(take(FakeRandom.sequence([0.1, 0.9]), 5)).toEqual([0.1, 0.9, 0.1, 0.9, 0.1]);
  });

  it.each([[[1]], [[-0.1]], [[]]])('rejects the sequence %j', (values) => {
    expect(() => FakeRandom.sequence(values)).toThrow();
  });
});
