import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  INITIAL_ROUND_ESTIMATE_MS,
  type JevSendDeps,
  type JevSendEntry,
  type JevSendRequest,
  MAX_REQUESTS_PER_FETCHALL,
  sendJevRequests,
} from '../../src/app/jev-sender.ts';
import { InvalidArgumentError } from '../../src/core/errors.ts';
import { JEV_ENDPOINT, type JevRequestBody } from '../../src/core/jev-request.ts';
import { usageInputTokens } from '../../src/core/jev-response.ts';
import { fail } from '../../src/core/result.ts';
import { retryDelay } from '../../src/core/retry-delay.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import { FakeClock } from '../fakes/fake-clock.ts';
import { FakeHttp, type FakeHttpResponse, jsonPayload } from '../fakes/fake-http.ts';
import { FakeLog } from '../fakes/fake-log.ts';
import { FakeRandom } from '../fakes/fake-random.ts';
import ok200 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };
import okEdge200 from '../fixtures/jev/200-edge-rule-ids.json' with { type: 'json' };
import maxTokens400 from '../fixtures/jev/400-max-tokens-exceeded.json' with { type: 'json' };
import unknownModel400 from '../fixtures/jev/400-unknown-model.json' with { type: 'json' };
import wrongKey401 from '../fixtures/jev/401-wrong-key.json' with { type: 'json' };
import invalid422 from '../fixtures/jev/422-empty-questions.json' with { type: 'json' };

const NOW = Date.UTC(2026, 8, 30, 12);
const KEY = 'test-key-7f3a9c';
const JITTER = 0.5;

/** `usage.input_tokens` in the two 200 fixtures. */
const OK_TOKENS = 580;
const OK_EDGE_TOKENS = usageInputTokens(okEdge200);

/** Inline responses, complete as `HttpPort` returns them (no fixture exists for these statuses). */
const r429 = { status: 429, headers: {}, body: '' };
const r500 = { status: 500, headers: {}, body: '{"detail":"Internal Server Error"}' };
const r503 = { status: 503, headers: {}, body: '' };
const net: FakeHttpResponse = { transport: 'connection reset' };

type Setup = {
  readonly clock: FakeClock;
  readonly http: FakeHttp;
  readonly log: FakeLog;
  readonly deps: JevSendDeps;
};

function setup(
  options: { latencyMs?: number; remainingMs?: number; random?: FakeRandom; apiKey?: string } = {},
): Setup {
  const clock = new FakeClock({ now: NOW });
  const http = new FakeHttp({ clock, latencyMs: options.latencyMs ?? 0 });
  const log = new FakeLog();
  const deadlineAt = NOW + (options.remainingMs ?? 60_000);
  const deps: JevSendDeps = {
    http,
    clock,
    random: options.random ?? FakeRandom.sequence([JITTER]),
    log,
    apiKey: options.apiKey ?? KEY,
    remainingMs: () => deadlineAt - clock.now(),
  };
  return { clock, http, log, deps };
}

function body(id: string): JevRequestBody {
  return {
    model: 'jev-latest',
    state: [{ from: 'a@example.com', subject: id, body: `private body of ${id}` }],
    questions: { newsletter: { type: 'noul', instructions: 'Is this a newsletter?' } },
  };
}

function req(id: string): JevSendRequest {
  return { id, body: body(id) };
}

function ids(count: number, prefix = 't'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1)}`);
}

const payloadSchema = z.object({ state: z.array(z.object({ subject: z.string() })) });

/** The thread ID a request was built for (its first message's subject). */
function idOf(request: HttpRequest): string {
  return payloadSchema.parse(jsonPayload(request)).state[0]?.subject ?? '';
}

function route(http: FakeHttp, id: string, responses: readonly FakeHttpResponse[]): void {
  http.respond((request) => idOf(request) === id, responses);
}

/** Every request not routed otherwise gets `responses`. Add it last. */
function routeRest(http: FakeHttp, responses: readonly FakeHttpResponse[]): void {
  http.respond(() => true, responses);
}

function entry(entries: readonly JevSendEntry[], id: string): JevSendEntry {
  const found = entries.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`no entry for ${id}`);
  }
  return found;
}

function statusOf(e: JevSendEntry): number | undefined {
  return 'response' in e ? e.response.status : undefined;
}

describe('sendJevRequests', () => {
  describe('one batch of 200s', () => {
    it('sends once and returns the entries in input order with the summed tokens', () => {
      const { http, clock, log, deps } = setup();
      route(http, 'b', [okEdge200]);
      routeRest(http, [ok200]);

      const result = sendJevRequests(['a', 'b', 'c'].map(req), deps);

      expect(http.calls).toHaveLength(1);
      expect(result.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
      expect(result.entries).toEqual([
        { id: 'a', response: ok200, attempts: 1 },
        { id: 'b', response: okEdge200, attempts: 1 },
        { id: 'c', response: ok200, attempts: 1 },
      ]);
      expect(result.inputTokens).toBe(2 * OK_TOKENS + OK_EDGE_TOKENS);
      expect(result.stopped).toBeUndefined();
      expect(result.alerts).toEqual([]);
      expect(clock.sleeps).toEqual([]);
      expect(log.events).toEqual([
        {
          level: 'info',
          event: 'jev.batch',
          fields: {
            batch: 1,
            requests: 3,
            rounds: 1,
            attempts: 3,
            sleptMs: 0,
            inputTokens: 2 * OK_TOKENS + OK_EDGE_TOKENS,
            success: 3,
            invalid: 0,
            auth: 0,
            config: 0,
            exceptional: 0,
            retryable: 0,
            transport: 0,
            scope: 0,
            outage: 0,
          },
        },
      ]);
    });

    it('builds each HTTP request with the endpoint, the key header and the serialized body', () => {
      const { http, deps } = setup();
      route(http, 'a', [r429, ok200]);

      sendJevRequests([req('a')], deps);

      const [first, retry] = http.batches.map((batch) => batch[0]);
      expect(first).toEqual({
        url: JEV_ENDPOINT,
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${KEY}` },
        payload: JSON.stringify(body('a')),
      });
      expect(JSON.parse(first?.payload ?? '')).toEqual(body('a'));
      // A retry re-sends the same request, payload string and all.
      expect(retry).toBe(first);
      expect(retry?.payload).toBe(first?.payload);
    });

    it('trims the key in the header', () => {
      const { http, deps } = setup({ apiKey: `  ${KEY}\n` });
      routeRest(http, [ok200]);
      sendJevRequests([req('a')], deps);
      expect(http.batches[0]?.[0]?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    });
  });

  describe('retries', () => {
    it('retries a 429 once, alone, after the backoff', () => {
      const { http, clock, log, deps } = setup();
      route(http, 'a', [r429, ok200]);
      routeRest(http, [ok200]);

      const result = sendJevRequests([req('a'), req('b')], deps);

      expect(http.batches.map((batch) => batch.map(idOf))).toEqual([['a', 'b'], ['a']]);
      expect(clock.sleeps).toEqual([retryDelay(1, undefined, FakeRandom.sequence([JITTER]))]);
      expect(entry(result.entries, 'a')).toEqual({ id: 'a', response: ok200, attempts: 2 });
      expect(entry(result.entries, 'b')).toEqual({ id: 'b', response: ok200, attempts: 1 });
      expect(result.inputTokens).toBe(2 * OK_TOKENS);
      expect(log.find('jev.batch')?.fields).toMatchObject({
        rounds: 2,
        attempts: 3,
        sleptMs: clock.sleeps[0],
        success: 2,
      });
    });

    it('waits at least retry-after seconds', () => {
      const { http, clock, deps } = setup();
      route(http, 'a', [{ status: 429, headers: { 'retry-after': '2' } }, ok200]);
      const result = sendJevRequests([req('a')], deps);
      expect(clock.sleeps).toHaveLength(1);
      expect(clock.sleeps[0]).toBeGreaterThanOrEqual(2000);
      expect(entry(result.entries, 'a')).toMatchObject({ attempts: 2 });
    });

    it('honours retry-after-ms', () => {
      const { http, clock, deps } = setup();
      route(http, 'a', [{ status: 503, headers: { 'retry-after-ms': '1500' } }, ok200]);
      sendJevRequests([req('a')], deps);
      expect(clock.sleeps).toEqual([1500]);
    });

    it("doesn't retry when retry-after asks for more than 60 s", () => {
      const { http, clock, deps } = setup();
      const late = { status: 429, headers: { 'retry-after': '61' }, body: '' };
      route(http, 'a', [late, ok200]);

      const result = sendJevRequests([req('a')], deps);

      expect(http.calls).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
      expect(result.entries).toEqual([
        { id: 'a', response: late, attempts: 1, unretried: 'retry_after' },
      ]);
      expect(result.stopped).toBeUndefined();
    });

    it('sleeps once per round, for the largest delay', () => {
      const { http, clock, deps } = setup();
      route(http, 'a', [{ status: 429, headers: { 'retry-after': '3' } }, ok200]);
      route(http, 'b', [r503, ok200]);

      const result = sendJevRequests([req('a'), req('b')], deps);

      expect(clock.sleeps).toEqual([3000]);
      expect(http.batches.map((batch) => batch.map(idOf))).toEqual([
        ['a', 'b'],
        ['a', 'b'],
      ]);
      expect(result.entries.map(statusOf)).toEqual([200, 200]);
    });

    it('gives up after MAX_ATTEMPTS with the last response and no unretried', () => {
      const { http, clock, log, deps } = setup();
      route(http, 'a', [r503]);
      route(http, 'b', [ok200]);

      const result = sendJevRequests([req('a'), req('b')], deps);

      expect(http.calls).toHaveLength(3);
      expect(clock.sleeps).toHaveLength(2);
      expect(entry(result.entries, 'a')).toEqual({ id: 'a', response: r503, attempts: 3 });
      expect(result.stopped).toBeUndefined();
      expect(log.find('jev.batch')?.fields).toMatchObject({
        rounds: 3,
        attempts: 4,
        success: 1,
        retryable: 1,
      });
    });

    it('retries a network error like a retryable status', () => {
      const { http, deps } = setup();
      route(http, 'a', [net, ok200]);
      const result = sendJevRequests([req('a')], deps);
      expect(result.entries).toEqual([{ id: 'a', response: ok200, attempts: 2 }]);
    });

    it('returns transport after three network errors', () => {
      const { http, log, deps } = setup();
      route(http, 'a', [net]);
      const result = sendJevRequests([req('a')], deps);
      expect(result.entries).toEqual([{ id: 'a', transport: true, attempts: 3 }]);
      expect(result.stopped).toBeUndefined();
      expect(log.find('jev.batch')?.fields).toMatchObject({ transport: 1, attempts: 3 });
    });

    it.each([
      ['500', r500, 'exceptional'],
      ['422', invalid422, 'invalid'],
      ['400 max_tokens_exceeded', maxTokens400, 'invalid'],
      ['malformed 200', { status: 200, headers: {}, body: 'not json' }, 'success'],
    ] as const)('keeps a %s final after one attempt', (_, response, counted) => {
      const { http, clock, log, deps } = setup();
      route(http, 'a', [response]);
      route(http, 'b', [ok200]);

      const result = sendJevRequests([req('a'), req('b')], deps);

      expect(http.calls).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
      expect(entry(result.entries, 'a')).toEqual({ id: 'a', response, attempts: 1 });
      expect(result.stopped).toBeUndefined();
      expect(result.inputTokens).toBe(OK_TOKENS);
      expect(log.find('jev.batch')?.fields).toMatchObject({
        [counted]: counted === 'success' ? 2 : 1,
      });
    });
  });

  describe('stops', () => {
    it('stops on a 401: no retry, no later batch', () => {
      const { http, log, deps } = setup();
      const all = ids(25);
      route(http, 't1', [wrongKey401]);
      route(http, 't2', [r429, ok200]);
      routeRest(http, [ok200]);

      const result = sendJevRequests(all.map(req), deps);

      expect(http.calls).toHaveLength(1);
      expect(result.stopped).toBe('auth');
      expect(entry(result.entries, 't1')).toEqual({ id: 't1', response: wrongKey401, attempts: 1 });
      expect(entry(result.entries, 't2')).toEqual({
        id: 't2',
        response: r429,
        attempts: 1,
        unretried: 'stopped',
      });
      expect(entry(result.entries, 't3')).toEqual({ id: 't3', response: ok200, attempts: 1 });
      expect(result.entries.slice(20)).toEqual(
        all.slice(20).map((id) => ({ id, notSent: 'auth' })),
      );
      expect(result.inputTokens).toBe(18 * OK_TOKENS);
      expect(log.all('jev.batch')).toHaveLength(1);
      expect(log.find('jev.batch')?.fields).toMatchObject({ auth: 1, retryable: 1, success: 18 });
    });

    it('stops on the unknown-model response', () => {
      const { http, deps } = setup();
      const all = ids(21);
      route(http, 't1', [unknownModel400]);
      route(http, 't2', [net, ok200]);
      routeRest(http, [ok200]);

      const result = sendJevRequests(all.map(req), deps);

      expect(http.calls).toHaveLength(1);
      expect(result.stopped).toBe('config');
      expect(entry(result.entries, 't1')).toEqual({
        id: 't1',
        response: unknownModel400,
        attempts: 1,
      });
      expect(entry(result.entries, 't2')).toEqual({
        id: 't2',
        transport: true,
        attempts: 1,
        unretried: 'stopped',
      });
      expect(entry(result.entries, 't21')).toEqual({ id: 't21', notSent: 'config' });
    });

    it('stops when the scope is missing', () => {
      const { http, log, deps } = setup();
      const all = ids(25);
      routeRest(http, [ok200]);
      http.failNext('sendAll', fail('scope', { message: 'missing permission' }));

      const result = sendJevRequests(all.map(req), deps);

      expect(http.calls).toHaveLength(1);
      expect(result.stopped).toBe('scope');
      expect(result.entries).toEqual([
        ...all.slice(0, 20).map((id) => ({ id, scope: true })),
        ...all.slice(20).map((id) => ({ id, notSent: 'scope' })),
      ]);
      expect(log.find('jev.batch')?.fields).toMatchObject({ scope: 20, attempts: 20 });
    });

    it('stops on an outage round and strikes nothing', () => {
      const { http, clock, log, deps } = setup();
      const all = ids(22);
      routeRest(http, [r500]);

      const result = sendJevRequests(all.map(req), deps);

      expect(http.calls).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
      expect(result.stopped).toBe('outage');
      expect(result.entries).toEqual(all.map((id) => ({ id, notSent: 'outage' })));
      expect(log.atLevel('warn')).toEqual([
        {
          level: 'warn',
          event: 'jev.outage',
          fields: { batch: 1, requests: 20, serverErrors: 20, transport: 0 },
        },
      ]);
      expect(log.find('jev.batch')?.fields).toMatchObject({ requests: 20, outage: 20 });
    });

    it('treats a round of 503 and a network error as an outage, without retrying', () => {
      const { http, clock, log, deps } = setup();
      route(http, 'a', [r503, ok200]);
      route(http, 'b', [net, ok200]);

      const result = sendJevRequests([req('a'), req('b')], deps);

      expect(http.calls).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
      expect(result.entries).toEqual([
        { id: 'a', notSent: 'outage' },
        { id: 'b', notSent: 'outage' },
      ]);
      expect(log.find('jev.outage')?.fields).toEqual({
        batch: 1,
        requests: 2,
        serverErrors: 1,
        transport: 1,
      });
    });

    it('treats a retry round of 5xx only as an outage, keeping earlier finals', () => {
      const { http, deps } = setup();
      route(http, 'a', [ok200]);
      routeRest(http, [r503]);

      const result = sendJevRequests(['a', 'b', 'c'].map(req), deps);

      expect(http.calls).toHaveLength(2);
      expect(result.stopped).toBe('outage');
      expect(result.entries).toEqual([
        { id: 'a', response: ok200, attempts: 1 },
        { id: 'b', notSent: 'outage' },
        { id: 'c', notSent: 'outage' },
      ]);
      expect(result.inputTokens).toBe(OK_TOKENS);
    });

    it("doesn't treat a 500 beside a 200 as an outage", () => {
      const { http, deps } = setup();
      route(http, 'a', [r500]);
      route(http, 'b', [ok200]);

      const result = sendJevRequests([req('a'), req('b')], deps);

      expect(result.stopped).toBeUndefined();
      expect(result.entries).toEqual([
        { id: 'a', response: r500, attempts: 1 },
        { id: 'b', response: ok200, attempts: 1 },
      ]);
    });

    it("doesn't treat a single 500 as an outage", () => {
      const { http, log, deps } = setup();
      route(http, 'a', [r500]);

      const result = sendJevRequests([req('a')], deps);

      expect(result.stopped).toBeUndefined();
      expect(result.entries).toEqual([{ id: 'a', response: r500, attempts: 1 }]);
      expect(log.find('jev.outage')).toBeUndefined();
      expect(log.find('jev.batch')?.fields).toMatchObject({ exceptional: 1 });
    });

    it('lets whatever sendAll throws pass through', () => {
      const { http, deps } = setup();
      routeRest(http, [ok200]);
      http.failNext('sendAll', new Error('adapter bug'));
      expect(() => sendJevRequests([req('a')], deps)).toThrow('adapter bug');
    });

    it('throws when sendAll returns the wrong number of results', () => {
      const { deps } = setup();
      const http = { sendAll: () => [] };
      expect(() => sendJevRequests([req('a')], { ...deps, http })).toThrow(
        expect.objectContaining({
          name: 'UnexpectedResponseError',
          reason: 'result_count_mismatch',
        }),
      );
    });
  });

  describe('batches', () => {
    it('sends 45 requests as 20, 20 and 5, finishing each batch before the next', () => {
      const { http, log, deps } = setup();
      const all = ids(45);
      route(http, 't3', [r429, ok200]);
      routeRest(http, [ok200]);

      const result = sendJevRequests(all.map(req), deps);

      expect(MAX_REQUESTS_PER_FETCHALL).toBe(20);
      expect(http.batches.map((batch) => batch.map(idOf))).toEqual([
        all.slice(0, 20),
        ['t3'],
        all.slice(20, 40),
        all.slice(40),
      ]);
      expect(result.entries.map((e) => e.id)).toEqual(all);
      expect(result.inputTokens).toBe(45 * OK_TOKENS);
      expect(log.all('jev.batch').map((e) => [e.fields['batch'], e.fields['requests']])).toEqual([
        [1, 20],
        [2, 20],
        [3, 5],
      ]);
    });
  });

  describe('time', () => {
    it("sends nothing when the first round wouldn't fit", () => {
      const { http, log, deps } = setup({ remainingMs: INITIAL_ROUND_ESTIMATE_MS - 1 });
      routeRest(http, [ok200]);

      const result = sendJevRequests(['a', 'b'].map(req), deps);

      expect(http.calls).toHaveLength(0);
      expect(result).toEqual({
        entries: [
          { id: 'a', notSent: 'deadline' },
          { id: 'b', notSent: 'deadline' },
        ],
        stopped: 'deadline',
        inputTokens: 0,
        alerts: [],
      });
      expect(log.events).toEqual([]);
    });

    it('skips a retry round that would not fit, and still sends the next batch', () => {
      // Round 1 takes 3,000 ms and leaves 3,000: the retry needs the sleep
      // plus 3,000, but the next batch needs only 3,000.
      const { http, clock, deps } = setup({ latencyMs: 3000, remainingMs: 6000 });
      const all = ids(21);
      route(http, 't1', [r429, ok200]);
      routeRest(http, [ok200]);

      const result = sendJevRequests(all.map(req), deps);

      expect(clock.sleeps).toEqual([]);
      expect(http.batches.map((batch) => batch.length)).toEqual([20, 1]);
      expect(entry(result.entries, 't1')).toEqual({
        id: 't1',
        response: r429,
        attempts: 1,
        unretried: 'deadline',
      });
      expect(entry(result.entries, 't21')).toEqual({ id: 't21', response: ok200, attempts: 1 });
      expect(result.stopped).toBe('deadline');
    });

    it('retries when the sleep plus the longest round fits', () => {
      const { http, clock, deps } = setup({ latencyMs: 3000, remainingMs: 7000 });
      route(http, 'a', [r429, ok200]);

      const result = sendJevRequests([req('a')], deps);

      expect(clock.sleeps).toHaveLength(1);
      expect(result.entries).toEqual([{ id: 'a', response: ok200, attempts: 2 }]);
      expect(result.stopped).toBeUndefined();
    });

    it("doesn't start a batch after a slow one raised the estimate", () => {
      const { http, log, deps } = setup({ latencyMs: 8000, remainingMs: 15_000 });
      const all = ids(21);
      routeRest(http, [ok200]);

      const result = sendJevRequests(all.map(req), deps);

      // 7,000 ms left: enough for the initial estimate, not for an 8,000 ms round.
      expect(http.calls).toHaveLength(1);
      expect(entry(result.entries, 't21')).toEqual({ id: 't21', notSent: 'deadline' });
      expect(result.stopped).toBe('deadline');
      expect(log.all('jev.batch')).toHaveLength(1);
    });

    it('replaces the initial estimate with the measured round', () => {
      const { http, deps } = setup({ latencyMs: 1000, remainingMs: INITIAL_ROUND_ESTIMATE_MS });
      routeRest(http, [ok200]);

      const result = sendJevRequests(ids(21).map(req), deps);

      // 4,000 ms left after a 1,000 ms round: under the initial estimate, but enough.
      expect(http.calls).toHaveLength(2);
      expect(result.stopped).toBeUndefined();
    });
  });

  describe('input', () => {
    it.each(['', '  '])('throws for the blank key %j', (apiKey) => {
      const { http, deps } = setup({ apiKey });
      expect(() => sendJevRequests([req('a')], deps)).toThrow(InvalidArgumentError);
      expect(() => sendJevRequests([], deps)).toThrow(
        expect.objectContaining({ argument: 'apiKey' }),
      );
      expect(http.calls).toHaveLength(0);
    });

    it('throws for a repeated id', () => {
      const { http, deps } = setup();
      expect(() => sendJevRequests([req('a'), req('b'), req('a')], deps)).toThrow(
        expect.objectContaining({ name: 'InvalidArgumentError', argument: 'requests' }),
      );
      expect(http.calls).toHaveLength(0);
    });

    it('never puts the key in an error message', () => {
      const { deps } = setup();
      try {
        sendJevRequests([req('a'), req('a')], deps);
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain(KEY);
      }
    });

    it('does nothing for no requests', () => {
      const { http, log, deps } = setup();
      expect(sendJevRequests([], deps)).toEqual({ entries: [], inputTokens: 0, alerts: [] });
      expect(http.calls).toHaveLength(0);
      expect(log.events).toEqual([]);
    });
  });

  it('never logs the key, a body or a header value', () => {
    const { http, log, deps } = setup();
    const all = ids(24);
    route(http, 't1', [wrongKey401]);
    route(http, 't2', [{ status: 429, headers: { 'retry-after': '1' } }]);
    route(http, 't3', [invalid422]);
    routeRest(http, [ok200]);
    sendJevRequests(all.map(req), deps);

    const second = setup();
    routeRest(second.http, [r503]);
    sendJevRequests(ids(3).map(req), second.deps);

    const logged = JSON.stringify([...log.events, ...second.log.events]);
    expect(log.events.length + second.log.events.length).toBeGreaterThan(0);
    for (const secret of [
      KEY,
      'Bearer',
      'private body',
      'authentication_error',
      'req_',
      'application/json',
      'too_short',
      't1',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
