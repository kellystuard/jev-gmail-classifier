/**
 * The per-thread error boundary (Solution Design §6.4 step 6, §10.1; epic #12
 * decision 8; task #110).
 *
 * `settleThread` takes one entry of `sendJevRequests` and the thread's work
 * item, and returns the new queue and what happened: `interpretResponse` →
 * `decideOutcome` → `applyDecision` for an answer, or `strikeOrError` for a
 * failure. It logs the `thread.*` events (SD §10.5) and returns the alert
 * conditions; it saves nothing (decision 10) and sends nothing (E9).
 *
 * It never throws for a thread, except `RunAbortError` and `StateError`
 * (invalid state stops the run). Jev's `auth` and `config` results don't throw
 * either: they come back as `abort`, so E7 settles the rest of the chunk (the
 * answers already paid for are applied) and then throws `RunAbortError`. A
 * Gmail `rate_limited` comes back as `stopGmail`.
 */
import type { Config, MoveDestination } from '../config/schema.ts';
import type { AlertCondition } from '../core/alert-condition.ts';
import { assertNever } from '../core/assert-never.ts';
import { decideOutcome, movesAllowed } from '../core/decide.ts';
import {
  InvalidArgumentError,
  JevClassifierError,
  RunAbortError,
  StateError,
} from '../core/errors.ts';
import { interpretResponse } from '../core/jev-response.ts';
import type { LogFields, LogValue } from '../core/log-fields.ts';
import type { TruncationStats } from '../core/truncation.ts';
import { dequeue, type WorkItem, type WorkQueue } from '../core/work-queue.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { applyDecision, type AppliedChange } from './apply-decision.ts';
import { type JevErrorCause, strikeOrError } from './jev-error.ts';
import type { JevSendEntry } from './jev-sender.ts';
import type { LabelCache } from './label-cache.ts';

export type SettleContext = {
  readonly item: WorkItem;
  /** The current queue; it must hold `item`. */
  readonly queue: WorkQueue;
  /** From E7's full read, for `thread.classified` only. */
  readonly subject?: string;
  readonly from?: string;
  /** From `threadToState`, present only when `state` was cut. */
  readonly truncated?: TruncationStats;
};

export type SettleDeps = {
  readonly config: { readonly rules: Config['rules']; readonly defaultThreshold: number };
  readonly gmail: GmailPort;
  readonly labels: LabelCache;
  /** Holds `state.jevErrorLabel`. */
  readonly state: StatePort;
  readonly log: LogPort;
};

export type ThreadOutcome = 'classified' | 'struck' | 'errored' | 'untouched' | 'gone';

export type ThreadSettlement = {
  /** The new queue. Never saved here: E7 saves it after the chunk (decision 10). */
  readonly queue: WorkQueue;
  /**
   * `classified`: answered and applied, item removed. `struck`: strike 1 or 2
   * recorded, item still queued. `errored`: `Jev/Error` added, item removed.
   * `untouched`: the input queue, unchanged. `gone`: the thread no longer
   * exists, item removed.
   */
  readonly outcome: ThreadOutcome;
  /** `errored` for a new `Jev/Error`, `scope_missing` for a missing scope; E7 collects them, E9 sends them. */
  readonly alerts: readonly AlertCondition[];
  /** `classified` only: what `applyDecision` applied (E8 counts moves per destination from it). */
  readonly applied?: AppliedChange;
  readonly moveSkipped?: 'scope';
  readonly labelsSkipped?: 'scope';
  /** The new strike count, when a strike was recorded. */
  readonly strikes?: number;
  /** Jev said 401/402/403 (`auth`) or unknown model (`config_invalid`). E7 settles the rest of the chunk, then throws `RunAbortError`. */
  readonly abort?: 'auth' | 'config_invalid';
  /** Gmail's per-user rate limit: E7 stops Gmail work for this run. */
  readonly stopGmail?: 'rate_limited';
};

/** Why a strike (or `Jev/Error`) was asked for, for `thread.failed` and `thread.errored`. */
type StrikeRequest = {
  readonly cause: JevErrorCause;
  /** `retryable`, `transport`, `failed_precondition`, `invalid`, or an exception's name. */
  readonly reason: string;
  /** `status`, `errorType`, `requestId`, or an exception's log fields. */
  readonly fields: LogFields;
};

/** Set once a `strikeOrError` call has started, so the boundary never strikes twice. */
type Attempt = { strike?: StrikeRequest };

/**
 * Settles one thread. Everything after the preconditions runs inside the
 * per-thread boundary: an exception other than `RunAbortError` and
 * `StateError` is one strike, and never stops the chunk.
 *
 * @throws InvalidArgumentError when `entry.id` isn't `context.item.threadId`,
 *   or `context.queue` doesn't hold the item (a caller bug).
 * @throws RunAbortError, StateError from any dependency.
 */
export function settleThread(
  entry: JevSendEntry,
  context: SettleContext,
  deps: SettleDeps,
): ThreadSettlement {
  const { threadId } = context.item;
  if (entry.id !== threadId) {
    throw new InvalidArgumentError('The Jev entry is for another thread', {
      argument: 'entry',
      reason: 'id_mismatch',
    });
  }
  if (!context.queue.some((item) => item.threadId === threadId)) {
    throw new InvalidArgumentError('The work item is not in the queue', {
      argument: 'context',
      reason: 'item_not_queued',
    });
  }

  const attempt: Attempt = {};
  try {
    return settle(entry, context, deps, attempt);
  } catch (error) {
    rethrowIfRunStopping(error);
    if (attempt.strike !== undefined) {
      // `strikeOrError` threw (adding `Jev/Error` failed unexpectedly): never
      // a second strike (#109). The thread is sent again next run.
      return markFailedByException(error, attempt.strike, context, deps);
    }
    return strikeForException(error, context, deps);
  }
}

/**
 * One strike for an exception thrown while handling this thread, logged as
 * `thread.failed` exactly as `settleThread`'s boundary does (E7's
 * `processChunk` uses it for an exception while reading the thread or building
 * its request; epic #13 decision 5). Rethrows `RunAbortError` and
 * `StateError` (the given error, or one thrown while striking). If striking
 * throws anything else: `untouched`, the input queue, and `thread.failed`
 * with `jevError: 'exception'`. Never strikes twice.
 *
 * @throws RunAbortError, StateError as above.
 */
export function strikeForException(
  error: unknown,
  context: SettleContext,
  deps: SettleDeps,
): ThreadSettlement {
  rethrowIfRunStopping(error);
  const strike: StrikeRequest = { cause: 'strike', ...exceptionFields(error) };
  try {
    return strikeThread(strike, context, deps, {});
  } catch (strikeError) {
    rethrowIfRunStopping(strikeError);
    return markFailedByException(strikeError, strike, context, deps);
  }
}

/** The whole settlement, inside the boundary. */
function settle(
  entry: JevSendEntry,
  context: SettleContext,
  deps: SettleDeps,
  attempt: Attempt,
): ThreadSettlement {
  const untouched: ThreadSettlement = { queue: context.queue, outcome: 'untouched', alerts: [] };
  if ('notSent' in entry) {
    return untouched;
  }
  if ('scope' in entry) {
    return { ...untouched, alerts: ['scope_missing'] };
  }
  if ('transport' in entry) {
    if (entry.unretried !== undefined) {
      return untouched;
    }
    return strikeThread(
      { cause: 'strike', reason: 'transport', fields: {} },
      context,
      deps,
      attempt,
    );
  }

  const result = interpretResponse(
    entry.response,
    deps.config.rules.map((rule) => rule.id),
  );
  if (result.ok) {
    return classify(result, context, deps, attempt);
  }
  switch (result.kind) {
    case 'invalid':
      return strikeThread(
        {
          cause: 'invalid',
          reason: 'invalid',
          fields: withoutUndefined({
            status: result.status,
            errorType: result.errorType,
            requestId: result.requestId,
          }),
        },
        context,
        deps,
        attempt,
      );
    case 'retryable':
      if (entry.unretried !== undefined) {
        return untouched;
      }
      return strikeThread(
        {
          cause: 'strike',
          reason: 'retryable',
          fields: withoutUndefined({ status: result.status, requestId: result.requestId }),
        },
        context,
        deps,
        attempt,
      );
    case 'auth':
      return { ...untouched, abort: 'auth' };
    case 'config':
      return { ...untouched, abort: 'config_invalid' };
    case 'scope':
      return { ...untouched, alerts: ['scope_missing'] };
    default:
      return assertNever(result);
  }
}

type Answered = {
  readonly answers: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly requestId?: string;
  readonly model: string;
};

/** Decide, apply, dequeue and log `thread.classified`. */
function classify(
  result: Answered,
  context: SettleContext,
  deps: SettleDeps,
  attempt: Attempt,
): ThreadSettlement {
  const { item } = context;
  const decision = decideOutcome(deps.config, result.answers, {
    movesAllowed: movesAllowed(item),
  });
  const applied = applyDecision(item.threadId, decision, deps);
  if (!applied.ok) {
    switch (applied.kind) {
      case 'rate_limited':
        // The answers are lost; the thread is sent again next run.
        return {
          queue: context.queue,
          outcome: 'untouched',
          alerts: [],
          stopGmail: 'rate_limited',
        };
      case 'not_found':
        return gone(context, deps);
      case 'failed_precondition':
        return strikeThread(
          { cause: 'strike', reason: 'failed_precondition', fields: {} },
          context,
          deps,
          attempt,
        );
      default:
        return assertNever(applied);
    }
  }

  const { moveSkipped, labelsSkipped } = applied;
  deps.log.info(
    'thread.classified',
    withoutUndefined({
      threadId: item.threadId,
      source: item.source,
      subject: context.subject,
      from: context.from,
      probabilities: { ...result.answers },
      fired: decision.fired,
      actions: actionsOf(applied.applied),
      moveSkipped,
      labelsSkipped,
      truncated:
        context.truncated === undefined
          ? undefined
          : {
              messagesDropped: context.truncated.messagesDropped,
              bodiesDropped: context.truncated.bodiesDropped,
              charsDropped: context.truncated.charsDropped,
            },
      requestId: result.requestId,
      model: result.model,
      inputTokens: result.inputTokens,
    }),
  );
  const scopeMissing = moveSkipped !== undefined || labelsSkipped !== undefined;
  return {
    queue: dequeue(context.queue, item.threadId),
    outcome: 'classified',
    alerts: scopeMissing ? ['scope_missing'] : [],
    applied: applied.applied,
    ...(moveSkipped === undefined ? {} : { moveSkipped }),
    ...(labelsSkipped === undefined ? {} : { labelsSkipped }),
  };
}

/** `label:<name>` for each label added, in order, then `move:<kind>` or `move:label:<name>`. */
function actionsOf(applied: AppliedChange): string[] {
  const actions = applied.labels.map((name) => `label:${name}`);
  if (applied.move !== undefined) {
    actions.push(`move:${moveName(applied.move)}`);
  }
  return actions;
}

function moveName(move: MoveDestination): string {
  return move.kind === 'label' ? `label:${move.label}` : move.kind;
}

/** A strike or `Jev/Error` through `strikeOrError`, mapped into a settlement and logged. */
function strikeThread(
  request: StrikeRequest,
  context: SettleContext,
  deps: SettleDeps,
  attempt: Attempt,
): ThreadSettlement {
  attempt.strike = request;
  const { threadId, source } = context.item;
  const outcome = strikeOrError(context.queue, threadId, request.cause, deps);
  const failed = { ...request.fields, threadId, source, reason: request.reason };

  switch (outcome.outcome) {
    case 'struck':
      deps.log.warn('thread.failed', { ...failed, ...strikesField(outcome.strikes) });
      return {
        queue: outcome.queue,
        outcome: 'struck',
        alerts: outcome.alerts,
        ...strikesField(outcome.strikes),
      };
    case 'errored':
      if (request.cause === 'strike') {
        deps.log.warn('thread.failed', { ...failed, ...strikesField(outcome.strikes) });
      }
      deps.log.warn('thread.errored', {
        ...pick(request.fields, ['status', 'errorType', 'requestId']),
        threadId,
        source,
        reason: request.cause === 'invalid' ? 'invalid' : 'strikes',
      });
      return {
        queue: outcome.queue,
        outcome: 'errored',
        alerts: outcome.alerts,
        ...strikesField(outcome.strikes),
      };
    case 'untouched':
      // Adding `Jev/Error` failed: nothing recorded, the thread is sent again next run.
      deps.log.warn('thread.failed', {
        ...failed,
        ...(outcome.markFailed === undefined ? {} : { jevError: outcome.markFailed }),
      });
      return {
        queue: context.queue,
        outcome: 'untouched',
        alerts: outcome.alerts,
        ...(outcome.stopGmail === undefined ? {} : { stopGmail: outcome.stopGmail }),
      };
    case 'gone':
      return gone(context, deps);
    default:
      return assertNever(outcome.outcome);
  }
}

/** The thread was deleted: dequeue it and log `thread.skipped`. */
function gone(context: SettleContext, deps: SettleDeps): ThreadSettlement {
  const { threadId, source } = context.item;
  deps.log.info('thread.skipped', { threadId, source, reason: 'not_found' });
  return { queue: dequeue(context.queue, threadId), outcome: 'gone', alerts: [] };
}

/** `strikeOrError` threw: the input queue, unchanged, and one `thread.failed`. */
function markFailedByException(
  error: unknown,
  request: StrikeRequest,
  context: SettleContext,
  deps: SettleDeps,
): ThreadSettlement {
  const { threadId, source } = context.item;
  deps.log.warn('thread.failed', {
    ...request.fields,
    // The exception from marking wins over a first exception's fields; that
    // one's name stays in `reason`.
    ...exceptionFields(error).fields,
    threadId,
    source,
    reason: request.reason,
    jevError: 'exception',
  });
  return { queue: context.queue, outcome: 'untouched', alerts: [] };
}

function rethrowIfRunStopping(error: unknown): void {
  if (error instanceof RunAbortError || error instanceof StateError) {
    throw error;
  }
}

/**
 * An exception as `reason` (its name, `unknown` for a non-`Error`) and log
 * fields: `toLogFields()` for a `JevClassifierError`, with its own `reason`
 * renamed `errorReason`; `error` and `errorMessage` for another `Error`. Never
 * a stack or a cause of a non-classifier error, and never a subject or sender.
 */
function exceptionFields(error: unknown): { reason: string; fields: LogFields } {
  if (error instanceof JevClassifierError) {
    return { reason: error.name, fields: safeErrorFields(error.toLogFields()) };
  }
  if (error instanceof Error) {
    return { reason: error.name, fields: { error: error.name, errorMessage: error.message } };
  }
  return { reason: 'unknown', fields: {} };
}

/** Drops `subject` and `from` (never in `thread.failed`) and renames `reason` to `errorReason`, so it can't hide ours. */
function safeErrorFields(fields: LogFields): LogFields {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'subject' || key === 'from') {
      continue;
    }
    out[key === 'reason' ? 'errorReason' : key] = value;
  }
  return out;
}

function strikesField(strikes: number | undefined): { strikes?: number } {
  return strikes === undefined ? {} : { strikes };
}

function pick(fields: LogFields, keys: readonly string[]): LogFields {
  const out: Record<string, LogValue> = {};
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function withoutUndefined(fields: Readonly<Record<string, LogValue | undefined>>): LogFields {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
