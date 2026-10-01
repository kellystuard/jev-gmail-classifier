/**
 * Starts a manual job from the `MANUAL_*` Script Properties (Solution Design
 * §6.6; epic #14 decision 4). It reads the four inputs, validates them,
 * refuses or replaces an unfinished job, saves the new job in `state.manual`,
 * deletes all four inputs and logs `manual.started`. It makes no Gmail, Jev,
 * auth or secrets call, reads no config, and takes no lock: `runEntry` does.
 *
 * A refusal is a result (`manual.rejected` at `warn`, nothing written, the
 * inputs kept so the user can fix one value and run again). A corrupt
 * `state.manual` or queue, or a failing write, throws `StateError` and resets
 * nothing (ADR-0007); the inputs stay.
 *
 * Crash safety: the write order is cancel, save the job, delete the inputs,
 * log. A crash after the cancel leaves no job and the inputs in place, so
 * running again starts the job. A crash after the save leaves the new job and
 * the inputs: the job continues in spare time, and running again is refused
 * with `job_unfinished` or, with `MANUAL_REPLACE=true` still set, replaces the
 * job with the same query and a fresh bound. Both are harmless.
 */
import {
  MANUAL_APPLY_MOVES_INPUT,
  MANUAL_INPUT_NAMES,
  MANUAL_QUERY_INPUT,
  MANUAL_REPLACE_INPUT,
  MANUAL_TIMESPAN_INPUT,
  type ManualInputRejection,
  parseManualInputs,
} from '../core/manual-input.ts';
import { type ManualJob, newManualJob } from '../core/manual-job.ts';
import { dropManualWork } from '../core/work-queue.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';

import { cancelManualJob } from './manual-cancel.ts';
import { loadManualJob, saveManualJob } from './manual-job-store.ts';
import { loadQueue, saveQueue } from './queue-store.ts';

export type ManualStartDeps = {
  readonly state: StatePort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

export type ManualStartRejection = ManualInputRejection | 'job_unfinished';

export type ManualStartResult =
  | { readonly started: true; readonly job: ManualJob }
  | { readonly started: false; readonly reason: ManualStartRejection };

export function startManualJob(deps: ManualStartDeps): ManualStartResult {
  const { state, clock, log } = deps;
  const raw = {
    query: state.getInput(MANUAL_QUERY_INPUT),
    timespan: state.getInput(MANUAL_TIMESPAN_INPUT),
    applyMoves: state.getInput(MANUAL_APPLY_MOVES_INPUT),
    replace: state.getInput(MANUAL_REPLACE_INPUT),
  };
  const now = clock.now();

  const parsed = parseManualInputs(raw, now);
  if (!parsed.ok) {
    log.warn('manual.rejected', { reason: parsed.kind });
    return { started: false, reason: parsed.kind };
  }

  const existing = loadManualJob(state);
  let replaced = false;
  if (existing === undefined) {
    // Stray manual items with no job (state.manual deleted by hand) would run
    // with the old job's applyMoves.
    const queue = loadQueue(state);
    const dropped = dropManualWork(queue);
    if (dropped.queue !== queue) saveQueue(state, dropped.queue);
  } else if (parsed.replace) {
    cancelManualJob({ state, log }, 'replaced');
    replaced = true;
  } else {
    log.warn('manual.rejected', {
      reason: 'job_unfinished',
      query: existing.query,
      startedAt: existing.startedAt,
      classified: existing.counts.classified,
    });
    return { started: false, reason: 'job_unfinished' };
  }

  const job = newManualJob({ query: parsed.query, applyMoves: parsed.applyMoves, startedAt: now });
  saveManualJob(state, job);
  for (const name of MANUAL_INPUT_NAMES) state.deleteInput(name);

  log.info('manual.started', {
    query: job.query,
    applyMoves: job.applyMoves,
    replaced,
    ...(parsed.timespan === undefined || parsed.after === undefined
      ? {}
      : { timespan: parsed.timespan, after: parsed.after }),
  });
  return { started: true, job };
}
