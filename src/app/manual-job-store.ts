/**
 * Reads and writes `state.manual` over `StatePort` (Solution Design §6.6,
 * §7.3; epic #14 decision 5). The codec and the pure updates are in
 * `src/core/manual-job.ts`; `core/` can't import `ports/`.
 *
 * Nothing here logs: the caller does.
 */
import {
  type ManualJob,
  MANUAL_KEY,
  decodeManualJob,
  encodeManualJob,
} from '../core/manual-job.ts';
import type { StatePort } from '../ports/state-port.ts';

/**
 * The unfinished job, or `undefined` when the key is absent. Throws
 * `StateError` if the stored value doesn't decode, and never resets or
 * rewrites it.
 */
export function loadManualJob(state: StatePort): ManualJob | undefined {
  const raw = state.get(MANUAL_KEY);
  return raw === undefined ? undefined : decodeManualJob(raw);
}

/** Writes `state.manual`. A `StateError` from the port propagates. */
export function saveManualJob(state: StatePort, job: ManualJob): void {
  state.set(MANUAL_KEY, encodeManualJob(job));
}

/** Deletes `state.manual`: the job is finished or cancelled. An absent key is fine. */
export function deleteManualJob(state: StatePort): void {
  state.delete(MANUAL_KEY);
}
