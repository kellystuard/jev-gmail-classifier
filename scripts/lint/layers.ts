/**
 * Layer boundaries (Engineering Standards §3, Solution Design §4.1).
 *
 * `LAYERS` holds one target per layer folder in `src/` (plus `scripts/` and
 * `test/` where they need rules), and `EVERYWHERE` holds what no linted file
 * may do. #38 fills both. Mark the strictest target (`src/core`) with
 * `strictest: true`: `buildRestrictionConfig()` also applies its lists to
 * `src/` files outside every layer folder.
 */
import type { LintTarget, Restrictions } from './restrictions.ts';

export const LAYERS: readonly LintTarget[] = [];

export const EVERYWHERE: Restrictions = {
  globals: [],
  properties: [],
  syntax: [],
  imports: [],
};
