/**
 * Randomness, `Math.random` (Solution Design §5.2). Used for retry jitter
 * (§8.5).
 */
export interface RandomPort {
  /** A number in `[0, 1)`. */
  next(): number;
}
