import type { RandomPort } from '../../src/ports/random-port.ts';

/**
 * A deterministic random source: a seeded mulberry32 generator, or a fixed
 * sequence of values that repeats.
 */
export class FakeRandom implements RandomPort {
  private state: number;
  private values: readonly number[] | undefined = undefined;
  private index = 0;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** Returns `values` in order, then repeats them. Each must be in `[0, 1)`. */
  static sequence(values: readonly number[]): FakeRandom {
    if (values.length === 0) {
      throw new Error('FakeRandom.sequence: needs at least one value');
    }
    for (const value of values) {
      if (!(value >= 0 && value < 1)) {
        throw new Error(`FakeRandom.sequence: ${String(value)} is outside [0, 1)`);
      }
    }
    const random = new FakeRandom();
    random.values = [...values];
    return random;
  }

  next(): number {
    if (this.values !== undefined) {
      const value = this.values[this.index % this.values.length] ?? 0;
      this.index++;
      return value;
    }
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
