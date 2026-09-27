import { fail, ok } from '../../src/core/result.ts';
import type { HttpPort, HttpRequest, HttpResult } from '../../src/ports/http-port.ts';
import type { FakeClock } from './fake-clock.ts';
import { FakeScopes } from './fake-scopes.ts';
import { type FailNextOptions, type FakeCall, FailureQueue } from './failure-queue.ts';

/** A scripted response: a status with optional headers and body, or a transport error. */
export type FakeHttpResponse =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | { readonly transport: string };

type Route = {
  readonly match: (request: HttpRequest) => boolean;
  readonly responses: readonly FakeHttpResponse[];
  used: number;
};

type HttpFailure = Extract<HttpResult, { ok: false }>;

export type FakeHttpOptions = {
  readonly scopes?: FakeScopes;
  readonly clock?: FakeClock;
  /** Added to the clock once per `sendAll` batch: `fetchAll` runs requests concurrently. */
  readonly latencyMs?: number;
};

const EXTERNAL_REQUEST_SCOPE = 'https://www.googleapis.com/auth/script.external_request';

/**
 * `UrlFetchApp.fetchAll`. A test registers routes; each matching request uses
 * the route's next response, and the last one repeats. So `[429, 429, 200]`
 * answers the first attempt 429, the retry 429 and the third attempt 200. A
 * request that matches no route throws.
 */
export class FakeHttp implements HttpPort {
  readonly calls: FakeCall<'sendAll'>[] = [];
  /** Every batch sent, in order. */
  readonly batches: (readonly HttpRequest[])[] = [];
  private readonly routes: Route[] = [];
  private readonly scopes: FakeScopes;
  private readonly clock: FakeClock | undefined;
  private readonly latencyMs: number;
  private readonly failures = new FailureQueue<'sendAll', HttpFailure>();

  constructor(options: FakeHttpOptions = {}) {
    this.scopes = options.scopes ?? new FakeScopes();
    this.clock = options.clock;
    this.latencyMs = options.latencyMs ?? 0;
  }

  /**
   * Answers requests that `match` accepts with `responses`, one per request,
   * repeating the last. Routes are tried in the order they were added.
   */
  respond(match: (request: HttpRequest) => boolean, responses: readonly FakeHttpResponse[]): void {
    if (responses.length === 0) {
      throw new Error('FakeHttp.respond: needs at least one response');
    }
    this.routes.push({ match, responses, used: 0 });
  }

  sendAll(requests: readonly HttpRequest[]): readonly HttpResult[] {
    this.calls.push({ method: 'sendAll', args: [requests] });
    this.batches.push([...requests]);
    if (requests.length === 0) {
      return [];
    }
    this.clock?.advance(this.latencyMs);
    const failure = this.failures.take('sendAll') ?? this.scopes.failureFor(EXTERNAL_REQUEST_SCOPE);
    if (failure !== undefined) {
      return requests.map(() => failure);
    }
    return requests.map((request) => toResult(this.nextResponse(request)));
  }

  /**
   * Makes the next batch fail: a `Fail` becomes every request's result, and an
   * `Error` is thrown by `sendAll` itself.
   */
  failNext(method: 'sendAll', failure: HttpFailure | Error, options: FailNextOptions = {}): void {
    this.failures.add(method, failure, options);
  }

  private nextResponse(request: HttpRequest): FakeHttpResponse {
    const route = this.routes.find((r) => r.match(request));
    if (route === undefined) {
      throw new Error(`FakeHttp: no route matches ${request.method.toUpperCase()} ${request.url}`);
    }
    const response = route.responses[Math.min(route.used, route.responses.length - 1)];
    route.used++;
    if (response === undefined) {
      throw new Error('FakeHttp: route has no responses');
    }
    return response;
  }
}

function toResult(response: FakeHttpResponse): HttpResult {
  if ('transport' in response) {
    return fail('transport', { message: response.transport });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return ok({ status: response.status, headers, body: response.body ?? '' });
}

/** Parses a request's JSON payload, for route predicates. */
export function jsonPayload(request: HttpRequest): unknown {
  return request.payload === undefined ? undefined : JSON.parse(request.payload);
}
