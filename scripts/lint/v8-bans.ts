/**
 * Apps Script V8 runtime bans (Engineering Standards §4, Solution Design §3).
 *
 * `SRC_RUNTIME_BANS` applies to every file in `src/`: features the Apps
 * Script runtime lacks, and the synchronous-only rule. #39 fills it.
 */
import type { Restrictions } from './restrictions.ts';

export const SRC_RUNTIME_BANS: Restrictions = {
  globals: [],
  properties: [],
  syntax: [],
  imports: [],
};
