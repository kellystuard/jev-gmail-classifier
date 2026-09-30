import { describe, expect, it } from 'vitest';

import {
  batchFailure,
  MAX_FAILURE_MESSAGE_LENGTH,
  normalizeHeaders,
} from '../../../src/adapters/gas/http-results.ts';

// The exact exception message spike #94 recorded for an unresolvable host.
const SPIKE_94_DNS_MESSAGE = 'DNS error: https://jev-smoke.invalid/';

const SCOPE_FRAGMENTS = [
  'Authorization is required to perform that action',
  'insufficient authentication scopes',
  'Specified permissions are not sufficient',
];

describe('normalizeHeaders', () => {
  it('lower-cases every name', () => {
    expect(
      normalizeHeaders({
        'Content-Type': 'application/json',
        'x-typesafe-request-id': 'req-1',
        'Retry-After': '5',
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-typesafe-request-id': 'req-1',
      'retry-after': '5',
    });
  });

  it('joins an array value (a repeated header) with ", "', () => {
    // The shape spike #94 recorded for a repeated `Set-Cookie`.
    expect(normalizeHeaders({ 'Set-Cookie': ['s94a=1', 's94b=2'] })).toEqual({
      'set-cookie': 's94a=1, s94b=2',
    });
  });

  it('joins names that collide after lower-casing, in input order', () => {
    expect(normalizeHeaders({ 'X-Rep': 'a', 'x-rep': 'b', 'X-REP': ['c', 'd'] })).toEqual({
      'x-rep': 'a, b, c, d',
    });
  });

  it('turns any other value type into a string', () => {
    expect(normalizeHeaders({ 'Content-Length': 42, 'X-Flag': true })).toEqual({
      'content-length': '42',
      'x-flag': 'true',
    });
  });

  it('returns an empty object for no headers', () => {
    expect(normalizeHeaders({})).toEqual({});
  });
});

describe('batchFailure', () => {
  it.each(SCOPE_FRAGMENTS)('is scope for every request when the message has %j', (fragment) => {
    const message = `Exception: ${fragment}.`;
    expect(batchFailure(new Error(message), 2)).toEqual([
      { ok: false, kind: 'scope', message },
      { ok: false, kind: 'scope', message },
    ]);
  });

  it('is transport for a DNS error', () => {
    expect(batchFailure(new Error(SPIKE_94_DNS_MESSAGE), 1)).toEqual([
      { ok: false, kind: 'transport', message: SPIKE_94_DNS_MESSAGE },
    ]);
  });

  it('uses the string form of a thrown non-Error', () => {
    expect(batchFailure('Timeout', 1)).toEqual([
      { ok: false, kind: 'transport', message: 'Timeout' },
    ]);
    expect(batchFailure({ message: 42 }, 1)).toEqual([
      { ok: false, kind: 'transport', message: '[object Object]' },
    ]);
  });

  it('cuts a very long message', () => {
    expect(MAX_FAILURE_MESSAGE_LENGTH).toBe(500);
    expect(batchFailure(new Error('x'.repeat(5000)), 1)).toEqual([
      { ok: false, kind: 'transport', message: 'x'.repeat(MAX_FAILURE_MESSAGE_LENGTH) },
    ]);
  });

  it('still finds a scope fragment past the cut', () => {
    const [result] = batchFailure(
      new Error(`${'x'.repeat(600)} insufficient authentication scopes`),
      1,
    );
    expect(result).toMatchObject({ ok: false, kind: 'scope' });
  });

  it('returns one result per request', () => {
    expect(batchFailure(new Error(SPIKE_94_DNS_MESSAGE), 0)).toEqual([]);
    expect(batchFailure(new Error(SPIKE_94_DNS_MESSAGE), 3)).toEqual([
      { ok: false, kind: 'transport', message: SPIKE_94_DNS_MESSAGE },
      { ok: false, kind: 'transport', message: SPIKE_94_DNS_MESSAGE },
      { ok: false, kind: 'transport', message: SPIKE_94_DNS_MESSAGE },
    ]);
  });
});
