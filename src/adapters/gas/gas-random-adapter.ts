/**
 * `GasRandomAdapter`: `RandomPort` over `Math.random()` (Solution Design §5.2,
 * §8.5; epic #13 decision 13). Used for retry jitter. Thin on purpose: covered
 * by `docs/smoke-test.md`, not by unit tests (Engineering Standards §8).
 */
import type { RandomPort } from '../../ports/random-port.ts';

export class GasRandomAdapter implements RandomPort {
  next(): number {
    return Math.random();
  }
}
