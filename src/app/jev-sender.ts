/**
 * The Jev sender: a chunk's requests through `HttpPort`, in batches, with
 * retries in rounds (Solution Design §8.5; epic #11 decisions 3, 7 and 8;
 * task #96).
 *
 * Requests are split, in input order, into batches of at most
 * `MAX_REQUESTS_PER_FETCHALL`. Each batch runs all its rounds (one `sendAll`
 * each) before the next batch starts. After a round, the retryable ones
 * (`classifyJevResponse` says `retryable`, or a network error) are retried
 * after one sleep, the largest of their `retryDelay`s, up to `MAX_ATTEMPTS`
 * attempts. Every other response is final.
 *
 * - **Time.** A batch starts only if `remainingMs()` is at least the round
 *   estimate, and a retry round only if it's at least the sleep plus the
 *   estimate. The estimate is `INITIAL_ROUND_ESTIMATE_MS` until a round has
 *   been timed, then the longest round seen in this call.
 * - **Stops.** A round with an `auth`, `config` or `scope` result, or an
 *   outage round (`isJevOutageRound`), ends the call: nothing more is sent.
 * - **Never throws for a response.** Bodies aren't parsed here (except
 *   `usageInputTokens` and the two classification rows that read an error
 *   body); `interpretResponse` runs later, per thread, in E7. Whatever
 *   `http.sendAll` itself throws isn't caught: it reaches the per-run boundary.
 * - **Logs** `jev.batch` (`info`) for each batch it started, and `jev.outage`
 *   (`warn`) for an outage round. Never an ID, a body, a header or the key.
 *
 * #100 adds the daily budget at the two per-batch seams: `beforeBatch` and
 * `afterBatch`.
 */
import type { AlertCondition } from '../core/alert-condition.ts';
import { InvalidArgumentError, UnexpectedResponseError } from '../core/errors.ts';
import { JEV_ENDPOINT, type JevRequestBody } from '../core/jev-request.ts';
import { usageInputTokens } from '../core/jev-response.ts';
import {
  classifyJevResponse,
  isJevOutageRound,
  type JevHttpResponse,
  type JevResponseClass,
  type JevRoundOutcome,
} from '../core/jev-status.ts';
import { MAX_ATTEMPTS, parseRetryAfter, retryDelay } from '../core/retry-delay.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { HttpPort, HttpRequest, HttpResult } from '../ports/http-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { RandomPort } from '../ports/random-port.ts';

/** SD §8.5: the most requests in one `sendAll` (`fetchAll`). A starting value; #97 settles it. */
export const MAX_REQUESTS_PER_FETCHALL = 20;

/**
 * SD §8.5: the round-time estimate before any round of a call has been timed.
 * From #90's latency figures (`test/fixtures/jev/README.md`): the slowest
 * round measured was 625 ms (5 concurrent requests of about 29,600 tokens),
 * doubled and rounded up to a whole second is 2,000 ms, and the floor of
 * 5,000 ms wins, leaving room for `fetchAll`'s own overhead and a batch of 20
 * large requests, which no measurement covers.
 */
export const INITIAL_ROUND_ESTIMATE_MS = 5000;

/** One request to send. `id` is the thread ID, unique in the call. */
export type JevSendRequest = { readonly id: string; readonly body: JevRequestBody };

export type JevSendDeps = {
  readonly http: HttpPort;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly log: LogPort;
  /** Non-blank. The caller read it from `SecretsPort` (decision 9). Only ever in the `Authorization` header. */
  readonly apiKey: string;
  /** The time left for sending, in ms: E7's `Deadline`. */
  readonly remainingMs: () => number;
};

/**
 * Why the call stopped sending before the end:
 * - `deadline`: a batch or a retry round didn't fit in `remainingMs()`;
 * - `auth`: a 401, 402 or 403 (E7 throws `RunAbortError('auth')`);
 * - `config`: the unknown-model response (E7 throws `RunAbortError('config_invalid')`);
 * - `scope`: `script.external_request` isn't granted (E7 alerts `scope_missing`);
 * - `outage`: a round of at least 2 in which everything was a 5xx or a network
 *   error. Nothing is struck; E7 leaves the items queued.
 */
export type JevSendStop = 'deadline' | 'auth' | 'config' | 'scope' | 'outage';

/**
 * Why an entry that was still retryable, with attempts left, wasn't retried:
 * - `deadline`: the retry round didn't fit in the time left;
 * - `retry_after`: the response asked for a wait over 60 s;
 * - `stopped`: the same round had an `auth`, `config` or `scope` result.
 */
export type JevUnretried = 'deadline' | 'retry_after' | 'stopped';

/**
 * One request's outcome:
 * - `response`: its final HTTP response, any class, after `attempts` sends
 *   (a retryable one when the attempts ran out, or with `unretried`);
 * - `transport`: its last attempt was a network error;
 * - `scope`: `HttpPort` refused it for a missing scope;
 * - `notSent`: it has no final result, because the call stopped (for an
 *   outage, the requests of the outage round too, although they were sent).
 */
export type JevSendEntry =
  | {
      readonly id: string;
      readonly response: JevHttpResponse;
      readonly attempts: number;
      readonly unretried?: JevUnretried;
    }
  | {
      readonly id: string;
      readonly transport: true;
      readonly attempts: number;
      readonly unretried?: JevUnretried;
    }
  | { readonly id: string; readonly scope: true }
  | { readonly id: string; readonly notSent: JevSendStop };

export type JevSendResult = {
  /** One per request, in input order. */
  readonly entries: readonly JevSendEntry[];
  /**
   * Set when sending stopped early. A hard stop (`auth`, `config`, `scope`,
   * `outage`, or a batch that didn't fit) ends the call; `deadline` is also
   * set when only a retry round was skipped, even if later batches went out.
   */
  readonly stopped?: JevSendStop;
  /** The sum of `usageInputTokens` over every final 200: Jev billed them all. */
  readonly inputTokens: number;
  /** Always empty here; #100 adds `budget_reached`. */
  readonly alerts: readonly AlertCondition[];
};

/** The stops a round can cause, in the order they win when a round has several. */
const ROUND_STOP_ORDER = ['auth', 'config', 'scope'] as const;
type RoundStop = (typeof ROUND_STOP_ORDER)[number];

/** The last outcome of a request that was sent. */
type Last =
  | {
      readonly kind: 'response';
      readonly response: JevHttpResponse;
      readonly cls: JevResponseClass;
    }
  | { readonly kind: 'transport' }
  | { readonly kind: 'scope' };

/** A request whose last outcome is retryable. */
type Retryable = { readonly index: number; readonly retryAfterMs: number | undefined };

/** Counts for `jev.batch`, by final outcome. */
type BatchCounts = {
  success: number;
  invalid: number;
  auth: number;
  config: number;
  exceptional: number;
  retryable: number;
  transport: number;
  scope: number;
  outage: number;
};

/** What a batch did. */
type BatchRun = {
  readonly stop?: RoundStop | 'outage';
  /** A retry round was skipped for time. */
  readonly deadline: boolean;
  readonly rounds: number;
  readonly attempts: number;
  readonly sleptMs: number;
};

/** The call's mutable state, shared by the batch helpers. */
type Call = {
  readonly deps: JevSendDeps;
  readonly requests: readonly JevSendRequest[];
  readonly httpRequests: readonly HttpRequest[];
  readonly entries: (JevSendEntry | undefined)[];
  /** The longest round timed in this call, or `undefined` before the first. */
  longestRoundMs: number | undefined;
  inputTokens: number;
};

/**
 * Sends every request and returns one entry per request, in input order.
 *
 * @throws InvalidArgumentError for a blank `apiKey` (argument `apiKey`) or a
 *   repeated `id` (argument `requests`). Nothing else is thrown on purpose;
 *   what `http.sendAll` throws passes through.
 */
export function sendJevRequests(
  requests: readonly JevSendRequest[],
  deps: JevSendDeps,
): JevSendResult {
  const apiKey = deps.apiKey.trim();
  if (apiKey === '') {
    throw new InvalidArgumentError('apiKey must not be blank', {
      argument: 'apiKey',
      reason: 'blank',
    });
  }
  if (new Set(requests.map((r) => r.id)).size !== requests.length) {
    throw new InvalidArgumentError('every request id must be unique', {
      argument: 'requests',
      reason: 'duplicate_id',
    });
  }

  const call: Call = {
    deps,
    requests,
    // Serialized once: a retry re-sends the same object.
    httpRequests: requests.map((r) => toHttpRequest(r.body, apiKey)),
    entries: requests.map(() => undefined),
    longestRoundMs: undefined,
    inputTokens: 0,
  };

  let stopped: JevSendStop | undefined;
  let batch = 0;
  for (let start = 0; start < requests.length; start += MAX_REQUESTS_PER_FETCHALL) {
    const indices = range(start, Math.min(start + MAX_REQUESTS_PER_FETCHALL, requests.length));
    const stop = beforeBatch(call);
    if (stop !== undefined) {
      stopped = stop;
      markNotSent(call, start, stop);
      break;
    }
    batch++;
    const run = runBatch(call, batch, indices);
    afterBatch(call, batch, indices, run);
    if (run.stop !== undefined) {
      stopped = run.stop;
      markNotSent(call, start + indices.length, run.stop);
      break;
    }
    if (run.deadline) {
      stopped = 'deadline';
    }
  }

  return {
    entries: call.entries.map((entry, i) => entry ?? notSentEntry(call, i, stopped)),
    ...(stopped === undefined ? {} : { stopped }),
    inputTokens: call.inputTokens,
    alerts: [],
  };
}

/**
 * The check before each batch: a stop reason, or `undefined` to send it.
 * Today only the time rule; #100 puts the budget check first.
 */
function beforeBatch(call: Call): JevSendStop | undefined {
  if (call.deps.remainingMs() < roundEstimate(call)) {
    return 'deadline';
  }
  return undefined;
}

/**
 * After each batch that was started: adds its billed tokens and logs
 * `jev.batch`. #100 adds the batch's tokens to the budget and saves it here.
 */
function afterBatch(call: Call, batch: number, indices: readonly number[], run: BatchRun): void {
  let batchTokens = 0;
  const counts: BatchCounts = {
    success: 0,
    invalid: 0,
    auth: 0,
    config: 0,
    exceptional: 0,
    retryable: 0,
    transport: 0,
    scope: 0,
    outage: 0,
  };
  for (const i of indices) {
    const entry = call.entries[i];
    if (entry === undefined) {
      continue;
    }
    if ('response' in entry) {
      batchTokens += usageInputTokens(entry.response);
      counts[classifyJevResponse(entry.response)]++;
    } else if ('transport' in entry) {
      counts.transport++;
    } else if ('scope' in entry) {
      counts.scope++;
    } else if (entry.notSent === 'outage') {
      counts.outage++;
    }
  }
  call.inputTokens += batchTokens;
  call.deps.log.info('jev.batch', {
    batch,
    requests: indices.length,
    rounds: run.rounds,
    attempts: run.attempts,
    sleptMs: run.sleptMs,
    inputTokens: batchTokens,
    ...counts,
  });
}

/** Runs one batch's rounds and sets its entries (all but an outage's). */
function runBatch(call: Call, batch: number, indices: readonly number[]): BatchRun {
  const { http, clock, random, log } = call.deps;
  const lasts = new Map<number, Last>();
  let pending = indices;
  let rounds = 0;
  let attempts = 0;
  let sleptMs = 0;

  for (let attempt = 1; ; attempt++) {
    const before = clock.now();
    const results = http.sendAll(pending.map((i) => at(call.httpRequests, i)));
    if (results.length !== pending.length) {
      // `HttpPort.sendAll` returns one result per request: anything else is an adapter bug.
      throw new UnexpectedResponseError(
        'sendAll returned a result count unlike the request count',
        {
          service: 'jev',
          reason: 'result_count_mismatch',
        },
      );
    }
    const roundMs = clock.now() - before;
    call.longestRoundMs = Math.max(call.longestRoundMs ?? 0, roundMs);
    rounds++;
    attempts += pending.length;

    const retryables: Retryable[] = [];
    const roundStops = new Set<RoundStop>();
    const outcomes: JevRoundOutcome[] = [];
    pending.forEach((index, k) => {
      const last = toLast(at(results, k));
      lasts.set(index, last);
      if (last.kind === 'scope') {
        roundStops.add('scope');
        return;
      }
      if (last.kind === 'transport') {
        outcomes.push({ transport: true });
        retryables.push({ index, retryAfterMs: undefined });
        return;
      }
      outcomes.push(last.response);
      if (last.cls === 'retryable') {
        retryables.push({
          index,
          retryAfterMs: parseRetryAfter(last.response.headers, clock.now()),
        });
      } else if (last.cls === 'auth' || last.cls === 'config') {
        roundStops.add(last.cls);
      }
    });

    const roundStop = ROUND_STOP_ORDER.find((stop) => roundStops.has(stop));
    if (roundStop === undefined && isJevOutageRound(outcomes)) {
      // Nothing from this round is final: nothing may be struck for an outage.
      for (const index of pending) {
        call.entries[index] = { id: idAt(call, index), notSent: 'outage' };
      }
      log.warn('jev.outage', {
        batch,
        requests: pending.length,
        serverErrors: outcomes.filter((o) => !('transport' in o)).length,
        transport: outcomes.filter((o) => 'transport' in o).length,
      });
      return { stop: 'outage', deadline: false, rounds, attempts, sleptMs };
    }

    const unretried = new Map<number, JevUnretried>();
    const next: number[] = [];
    let sleepMs = 0;
    for (const { index, retryAfterMs } of retryables) {
      if (roundStop !== undefined) {
        unretried.set(index, 'stopped');
      } else if (attempt < MAX_ATTEMPTS) {
        const delay = retryDelay(attempt, retryAfterMs, random);
        if (delay === undefined) {
          unretried.set(index, 'retry_after');
        } else {
          next.push(index);
          sleepMs = Math.max(sleepMs, delay);
        }
      }
      // At MAX_ATTEMPTS it's final as it is, with no `unretried`.
    }

    let deadline = false;
    if (next.length > 0 && call.deps.remainingMs() < sleepMs + roundEstimate(call)) {
      for (const index of next) {
        unretried.set(index, 'deadline');
      }
      next.length = 0;
      deadline = true;
    }

    if (next.length === 0) {
      finalize(call, lasts, attempt, indices, [], unretried);
      return {
        ...(roundStop === undefined ? {} : { stop: roundStop }),
        deadline,
        rounds,
        attempts,
        sleptMs,
      };
    }
    finalize(call, lasts, attempt, indices, next, unretried);
    clock.sleep(sleepMs);
    sleptMs += sleepMs;
    pending = next;
  }
}

/**
 * Sets the entry of every request in the batch that has a last outcome, isn't
 * in `open` (still being retried) and has no entry yet. Requests leave
 * `pending` once and never return, so each is set once, with the number of
 * the attempt it was last sent in.
 */
function finalize(
  call: Call,
  lasts: ReadonlyMap<number, Last>,
  attempt: number,
  indices: readonly number[],
  open: readonly number[],
  unretried: ReadonlyMap<number, JevUnretried> = new Map(),
): void {
  const stillOpen = new Set(open);
  for (const index of indices) {
    const last = lasts.get(index);
    if (last === undefined || stillOpen.has(index) || call.entries[index] !== undefined) {
      continue;
    }
    call.entries[index] = toEntry(idAt(call, index), last, attempt, unretried.get(index));
  }
}

function toEntry(
  id: string,
  last: Last,
  attempts: number,
  unretried: JevUnretried | undefined,
): JevSendEntry {
  const extra = unretried === undefined ? {} : { unretried };
  switch (last.kind) {
    case 'scope':
      return { id, scope: true };
    case 'transport':
      return { id, transport: true, attempts, ...extra };
    case 'response':
      return { id, response: last.response, attempts, ...extra };
  }
}

function toLast(result: HttpResult): Last {
  if (!result.ok) {
    return result.kind === 'scope' ? { kind: 'scope' } : { kind: 'transport' };
  }
  const response: JevHttpResponse = {
    status: result.status,
    headers: result.headers,
    body: result.body,
  };
  return { kind: 'response', response, cls: classifyJevResponse(response) };
}

/** The estimate `remainingMs()` is checked against, before a batch or a retry round. */
function roundEstimate(call: Call): number {
  return call.longestRoundMs ?? INITIAL_ROUND_ESTIMATE_MS;
}

function markNotSent(call: Call, from: number, stop: JevSendStop): void {
  for (let i = from; i < call.requests.length; i++) {
    call.entries[i] ??= { id: idAt(call, i), notSent: stop };
  }
}

/** Every entry is set before the call returns; this is only a type-level fallback. */
function notSentEntry(call: Call, index: number, stopped: JevSendStop | undefined): JevSendEntry {
  return { id: idAt(call, index), notSent: stopped ?? 'deadline' };
}

function toHttpRequest(body: JevRequestBody, apiKey: string): HttpRequest {
  return {
    url: JEV_ENDPOINT,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify(body),
  };
}

function idAt(call: Call, index: number): string {
  return at(call.requests, index).id;
}

/** `array[index]` for an index known to be in range. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`index ${String(index)} is out of range`);
  }
  return value;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    out.push(i);
  }
  return out;
}
