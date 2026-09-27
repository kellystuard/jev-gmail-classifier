import { describe, expect, it } from 'vitest';

import { fail } from '../../src/core/result.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeHttp, jsonPayload } from './fake-http.ts';
import { FakeScopes, SCOPE_ERROR_MESSAGE } from './fake-scopes.ts';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

function request(threadId: string): HttpRequest {
  return {
    url: JEV_URL,
    method: 'post',
    headers: { Authorization: 'Bearer test-key' },
    contentType: 'application/json',
    payload: JSON.stringify({ threadId }),
  };
}

function forThread(threadId: string): (r: HttpRequest) => boolean {
  return (r) => {
    const payload = jsonPayload(r);
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'threadId' in payload &&
      payload.threadId === threadId
    );
  };
}

describe('FakeHttp', () => {
  it('answers a [429, 200] route across two sendAll rounds', () => {
    const http = new FakeHttp();
    http.respond(forThread('t1'), [
      { status: 429, headers: { 'Retry-After': '1' } },
      { status: 200, body: '{}' },
    ]);
    expect(http.sendAll([request('t1')])).toEqual([
      { ok: true, status: 429, headers: { 'retry-after': '1' }, body: '' },
    ]);
    expect(http.sendAll([request('t1')])).toEqual([
      { ok: true, status: 200, headers: {}, body: '{}' },
    ]);
    // The last response repeats.
    expect(http.sendAll([request('t1')])[0]).toMatchObject({ status: 200 });
    expect(http.batches).toHaveLength(3);
  });

  it('returns mixed results in request order within one batch', () => {
    const http = new FakeHttp();
    http.respond(forThread('ok'), [{ status: 200, body: '{"answers":{}}' }]);
    http.respond(forThread('busy'), [{ status: 429 }]);
    http.respond(forThread('bad'), [{ status: 422, body: '{"error":"invalid"}' }]);
    http.respond(forThread('down'), [{ transport: 'Address unavailable' }]);
    const results = http.sendAll([request('bad'), request('ok'), request('down'), request('busy')]);
    expect(results).toEqual([
      { ok: true, status: 422, headers: {}, body: '{"error":"invalid"}' },
      { ok: true, status: 200, headers: {}, body: '{"answers":{}}' },
      { ok: false, kind: 'transport', message: 'Address unavailable' },
      { ok: true, status: 429, headers: {}, body: '' },
    ]);
  });

  it('lower-cases response header names', () => {
    const http = new FakeHttp();
    http.respond(() => true, [{ status: 200, headers: { 'X-TypeSafe-Request-Id': 'req_1' } }]);
    expect(http.sendAll([request('t1')])[0]).toMatchObject({
      headers: { 'x-typesafe-request-id': 'req_1' },
    });
  });

  it('returns scope for every request while script.external_request is revoked', () => {
    const scopes = new FakeScopes();
    const http = new FakeHttp({ scopes });
    http.respond(() => true, [{ status: 200 }]);
    scopes.revoke('https://www.googleapis.com/auth/script.external_request');
    const scope = { ok: false, kind: 'scope', message: SCOPE_ERROR_MESSAGE };
    expect(http.sendAll([request('t1'), request('t2')])).toEqual([scope, scope]);
  });

  it('throws for a request that matches no route', () => {
    const http = new FakeHttp();
    expect(() => http.sendAll([request('t1')])).toThrow(/no route matches POST/);
  });

  it('returns an empty list for an empty batch without advancing the clock', () => {
    const clock = new FakeClock({ now: 0 });
    const http = new FakeHttp({ clock, latencyMs: 800 });
    expect(http.sendAll([])).toEqual([]);
    expect(clock.now()).toBe(0);
  });

  it('advances the clock once per batch, however many requests it has', () => {
    const clock = new FakeClock({ now: 0 });
    const http = new FakeHttp({ clock, latencyMs: 800 });
    http.respond(() => true, [{ status: 200 }]);
    http.sendAll([request('t1'), request('t2'), request('t3')]);
    http.sendAll([request('t1')]);
    expect(clock.now()).toBe(1600);
  });

  it('records batches, so a test can see which requests were retried', () => {
    const http = new FakeHttp();
    http.respond(forThread('t1'), [{ status: 200 }]);
    http.respond(forThread('t2'), [{ status: 529 }, { status: 200 }]);
    http.sendAll([request('t1'), request('t2')]);
    http.sendAll([request('t2')]);
    expect(http.batches.map((b) => b.map((r) => jsonPayload(r)))).toEqual([
      [{ threadId: 't1' }, { threadId: 't2' }],
      [{ threadId: 't2' }],
    ]);
  });

  it('can fail a whole batch with a result or a thrown error', () => {
    const http = new FakeHttp();
    http.respond(() => true, [{ status: 200 }]);
    http.failNext('sendAll', fail('transport', { message: 'Timeout' }));
    http.failNext('sendAll', new Error('Exception: fetchAll failed'));
    expect(http.sendAll([request('t1'), request('t2')])).toEqual([
      { ok: false, kind: 'transport', message: 'Timeout' },
      { ok: false, kind: 'transport', message: 'Timeout' },
    ]);
    expect(() => http.sendAll([request('t1')])).toThrow('fetchAll failed');
    expect(http.sendAll([request('t1')])[0]).toMatchObject({ ok: true, status: 200 });
  });
});
