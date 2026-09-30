/**
 * Applies a thread's outcome (Solution Design §6.5, "Apply"; epic #12 decision 5):
 * every firing label and at most one move, in **one** `threads.modify`. Label
 * names are resolved to IDs through the run's `LabelCache` before the call. A
 * stale ID gets one refresh and one retry.
 *
 * No logging here: `settleThread` logs `thread.classified` with `applied`, and
 * the cache logs `label.created`.
 */
import type { MoveDestination } from '../config/schema.ts';
import type { Decision } from '../core/decide.ts';
import { UnexpectedResponseError } from '../core/errors.ts';
import { type Fail, ok, type Result } from '../core/result.ts';
import { buildThreadChange, type LabelIdChange } from '../core/thread-change.ts';
import type { GmailFailure, GmailPort } from '../ports/gmail-port.ts';
import type { LabelCache } from './label-cache.ts';

export type ApplyDeps = { readonly gmail: GmailPort; readonly labels: LabelCache };

export type AppliedChange = {
  /** Label names added (the decision's labels; not the move's label). */
  readonly labels: readonly string[];
  /** Absent when no move was applied. */
  readonly move?: MoveDestination;
};

export type ApplyFailure =
  GmailFailure | Fail<'not_found'> | Fail<'failed_precondition', { message: string }>;

/**
 * Resolves the IDs, then makes one `modifyThread` (none when there is nothing
 * to apply). `scope`, `rate_limited`, `not_found` and `failed_precondition`
 * are returned for the per-thread boundary. A second `invalid_label` throws
 * `UnexpectedResponseError` (`reason: 'invalid_label'`).
 */
export function applyDecision(
  threadId: string,
  decision: Pick<Decision, 'labels' | 'move'>,
  deps: ApplyDeps,
): Result<{ applied: AppliedChange }, ApplyFailure> {
  const destination = decision.move?.destination;
  const applied: AppliedChange =
    destination === undefined
      ? { labels: decision.labels }
      : { labels: decision.labels, move: destination };
  if (decision.labels.length === 0 && destination === undefined) {
    return ok({ applied });
  }

  const first = resolveChange(decision.labels, destination, deps.labels);
  if (!first.ok) {
    return first;
  }
  const modified = deps.gmail.modifyThread(threadId, first.change);
  if (modified.ok) {
    return ok({ applied });
  }
  if (modified.kind !== 'invalid_label') {
    return modified;
  }

  // A label was deleted or renamed since the cache loaded.
  const refreshed = deps.labels.refresh();
  if (!refreshed.ok) {
    return refreshed;
  }
  const second = resolveChange(decision.labels, destination, deps.labels);
  if (!second.ok) {
    return second;
  }
  const retried = deps.gmail.modifyThread(threadId, second.change);
  if (retried.ok) {
    return ok({ applied });
  }
  if (retried.kind === 'invalid_label') {
    throw new UnexpectedResponseError(
      'Gmail rejected a label ID after the label cache was refreshed',
      { service: 'gmail', reason: 'invalid_label' },
    );
  }
  return retried;
}

/** Every ID, before any `modifyThread`: the decision's labels, then a `label:<name>` move's. */
function resolveChange(
  names: readonly string[],
  destination: MoveDestination | undefined,
  labels: LabelCache,
): Result<{ change: LabelIdChange }, GmailFailure> {
  const ids: string[] = [];
  for (const name of names) {
    const resolved = labels.idFor(name);
    if (!resolved.ok) {
      return resolved;
    }
    ids.push(resolved.id);
  }
  if (destination?.kind === 'label') {
    const resolved = labels.idFor(destination.label);
    if (!resolved.ok) {
      return resolved;
    }
    return ok({ change: buildThreadChange(ids, destination, resolved.id) });
  }
  return ok({ change: buildThreadChange(ids, destination) });
}
