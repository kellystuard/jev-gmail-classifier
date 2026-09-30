/**
 * Strikes and the `Jev/Error` outcome (Solution Design §6.4 step 6, §7.4;
 * PDD §4.6; epic #12 decision 6).
 *
 * - `markJevError` adds `Jev/Error` to one thread. It remembers the label's ID
 *   in `state.jevErrorLabel` **before** labelling, so a later `labelRemoved`
 *   record for that ID is always recognized (SD §7.3).
 * - `strikeOrError` records a strike, or adds `Jev/Error` on the third strike,
 *   or at once for an invalid request. It never decides *which* results earn
 *   a strike: `settleThread` does, and calls it.
 *
 * Neither saves the queue (decision 10) nor logs: `settleThread` logs, and the
 * label cache logs `label.created`. Neither catches: an exception reaches the
 * per-thread boundary (ES §5).
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import { JevClassifierError, UnexpectedResponseError } from '../core/errors.ts';
import { JEV_ERROR_LABEL } from '../core/label-path.ts';
import { type Fail, ok, type Result } from '../core/result.ts';
import { buildThreadChange } from '../core/thread-change.ts';
import { addStrike, dequeue, MAX_STORED_STRIKES, type WorkQueue } from '../core/work-queue.ts';
import type { GmailFailure, GmailPort } from '../ports/gmail-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { rememberJevErrorLabelId } from './jev-error-label-store.ts';
import type { LabelCache } from './label-cache.ts';

export type JevErrorDeps = {
  readonly gmail: GmailPort;
  readonly labels: LabelCache;
  /** Holds `state.jevErrorLabel`. */
  readonly state: StatePort;
};

export type MarkJevErrorResult = Result<
  { readonly labelId: string },
  GmailFailure | Fail<'not_found'> | Fail<'failed_precondition', { message: string }>
>;

/**
 * Adds `Jev/Error` to the thread, and nothing else: no move, no label removed.
 *
 * Resolves the ID through the cache (creating `Jev`, then `Jev/Error`, when
 * missing), remembers it, then makes one `modifyThread`. A stale ID
 * (`invalid_label`) gets one refresh, the new ID is remembered, and the call
 * is retried once; a second `invalid_label` throws `UnexpectedResponseError`
 * (`reason: 'invalid_label'`). A corrupt `state.jevErrorLabel` throws
 * `StateError` before the thread is labelled. Every other failure is returned.
 */
export function markJevError(threadId: string, deps: JevErrorDeps): MarkJevErrorResult {
  const first = resolveAndRemember(deps);
  if (!first.ok) {
    return first;
  }
  const modified = deps.gmail.modifyThread(threadId, buildThreadChange([first.id], undefined));
  if (modified.ok) {
    return ok({ labelId: first.id });
  }
  if (modified.kind !== 'invalid_label') {
    return modified;
  }

  // The label was deleted or renamed since the cache loaded.
  const refreshed = deps.labels.refresh();
  if (!refreshed.ok) {
    return refreshed;
  }
  const second = resolveAndRemember(deps);
  if (!second.ok) {
    return second;
  }
  const retried = deps.gmail.modifyThread(threadId, buildThreadChange([second.id], undefined));
  if (retried.ok) {
    return ok({ labelId: second.id });
  }
  if (retried.kind === 'invalid_label') {
    throw new UnexpectedResponseError(
      'Gmail rejected the Jev/Error label ID after the label cache was refreshed',
      { service: 'gmail', reason: 'invalid_label' },
    );
  }
  return retried;
}

/** The `Jev/Error` ID, remembered in `state.jevErrorLabel` before any thread gets it. */
function resolveAndRemember(deps: JevErrorDeps): Result<{ id: string }, GmailFailure> {
  const resolved = deps.labels.idFor(JEV_ERROR_LABEL);
  if (!resolved.ok) {
    return resolved;
  }
  rememberJevErrorLabelId(deps.state, resolved.id);
  return ok({ id: resolved.id });
}

/** `strike`: a failure that earns a strike. `invalid`: a 422 or the 400 `max_tokens_exceeded`. */
export type JevErrorCause = 'strike' | 'invalid';

export type StrikeOutcome = {
  readonly queue: WorkQueue;
  /**
   * `struck`: strike 1 or 2 recorded, item still queued.
   * `errored`: `Jev/Error` added, item removed.
   * `untouched`: adding `Jev/Error` failed (`markFailed` says why); `queue` is the input queue, unchanged.
   * `gone`: the thread no longer exists (`not_found`); item removed.
   */
  readonly outcome: 'struck' | 'errored' | 'untouched' | 'gone';
  /** The new count (1–3), only when a strike was recorded (`struck`, or `errored` by strikes). */
  readonly strikes?: number;
  /** `['errored']` for `errored`, `['scope_missing']` when adding the label hit a missing scope, else `[]`. */
  readonly alerts: readonly AlertCondition[];
  /** Adding `Jev/Error` hit the per-user rate limit: E7 stops Gmail work for the run. */
  readonly stopGmail?: 'rate_limited';
  /** Why `Jev/Error` couldn't be added, for `untouched`. */
  readonly markFailed?: 'rate_limited' | 'scope' | 'failed_precondition';
  /** The `Jev/Error` label's ID, for `errored`. */
  readonly labelId?: string;
};

/**
 * Records a strike, or adds `Jev/Error`.
 *
 * - `strike`: a new count of 1 or 2 is `struck`, with no Gmail call. The third
 *   strike adds `Jev/Error`.
 * - `invalid`: adds `Jev/Error` whatever the count.
 *
 * When `Jev/Error` can't be added (`rate_limited`, `scope`,
 * `failed_precondition`), the **input** queue is returned: the strike isn't
 * recorded and the item stays, so the thread is sent again next run and no
 * error is lost. `not_found` removes the item (`gone`). An exception from
 * `markJevError` propagates. The input queue is never changed; a thread that
 * isn't queued throws `JevClassifierError` (a caller bug).
 */
export function strikeOrError(
  queue: WorkQueue,
  threadId: string,
  cause: JevErrorCause,
  deps: JevErrorDeps,
): StrikeOutcome {
  if (!queue.some((item) => item.threadId === threadId)) {
    throw new JevClassifierError('No work item is queued for this thread', { threadId });
  }

  let errored: { readonly queue: WorkQueue; readonly strikes?: number };
  if (cause === 'strike') {
    const struck = addStrike(queue, threadId);
    if (struck.strikes <= MAX_STORED_STRIKES) {
      return { queue: struck.queue, outcome: 'struck', strikes: struck.strikes, alerts: [] };
    }
    errored = struck;
  } else {
    errored = { queue: dequeue(queue, threadId) };
  }

  const marked = markJevError(threadId, deps);
  if (marked.ok) {
    return {
      ...errored,
      outcome: 'errored',
      alerts: ['errored'],
      labelId: marked.labelId,
    };
  }
  switch (marked.kind) {
    case 'not_found':
      return { queue: dequeue(queue, threadId), outcome: 'gone', alerts: [] };
    case 'rate_limited':
      return {
        queue,
        outcome: 'untouched',
        alerts: [],
        stopGmail: 'rate_limited',
        markFailed: 'rate_limited',
      };
    case 'scope':
      return { queue, outcome: 'untouched', alerts: ['scope_missing'], markFailed: 'scope' };
    case 'failed_precondition':
      return { queue, outcome: 'untouched', alerts: [], markFailed: 'failed_precondition' };
  }
}
