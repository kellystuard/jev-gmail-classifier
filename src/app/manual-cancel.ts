import { dropManualWork } from '../core/work-queue.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';

import { deleteManualJob, loadManualJob } from './manual-job-store.ts';
import { loadQueue, saveQueue } from './queue-store.ts';

export type CancelDeps = { readonly state: StatePort; readonly log: LogPort };
export type CancelReason = 'cancelled' | 'replaced';
/** JSON-serializable: `cancelManualRun` returns it to the editor. */
export type CancelReport = { readonly cancelled: boolean; readonly removed: number };

/**
 * Cancels the manual job (Solution Design §6.6): removes every queued manual
 * item, clears `applyMoves` on the items that stay, deletes `state.manual` and
 * logs `manual.cancelled`. It undoes nothing already applied.
 *
 * The queue is saved before the job is deleted: a crash between the two leaves
 * a job with no queued items (the next execution refills it, and the cancel can
 * be run again), never manual items with no job. With no job it still drops
 * stray manual items. A corrupt job or queue throws `StateError` before
 * anything is written, and a failing write throws with nothing logged; neither
 * is reset (ADR-0007). A second call writes nothing.
 *
 * It makes no Gmail, Jev, auth or secrets call, and leaves the `MANUAL_*`
 * inputs alone.
 */
export function cancelManualJob(deps: CancelDeps, reason: CancelReason): CancelReport {
  const job = loadManualJob(deps.state);
  const dropped = dropManualWork(loadQueue(deps.state));
  saveQueue(deps.state, dropped.queue);
  if (job !== undefined) {
    deleteManualJob(deps.state);
  }
  const removed = dropped.removed;
  if (job === undefined) {
    deps.log.info('manual.cancelled', { reason, job: 'none', removed });
  } else {
    deps.log.info('manual.cancelled', {
      reason,
      query: job.query,
      applyMoves: job.applyMoves,
      startedAt: job.startedAt,
      executions: job.executions,
      removed,
      ...job.counts,
      labels: job.labels,
      moves: job.moves,
      otherLabels: job.otherLabels,
      otherMoves: job.otherMoves,
    });
  }
  return { cancelled: job !== undefined, removed };
}
