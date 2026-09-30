import { describe, expect, it } from 'vitest';

import { createLabelCache } from '../../src/app/label-cache.ts';
import { UnexpectedResponseError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { fail } from '../../src/core/result.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';

function setup() {
  const { gmail, log } = createFakePorts();
  const cache = createLabelCache({ gmail, log });
  return { gmail, log, cache };
}

function callsTo(gmail: FakeGmail, method: string): unknown[][] {
  return gmail.calls.filter((c) => c.method === method).map((c) => [...c.args]);
}

const invalidName = fail('invalid_label_name', { message: 'Invalid label name' });
const labelExists = fail('label_exists', { message: 'exists' });
const noScope = fail('scope', { message: 'missing scope' });

describe('createLabelCache', () => {
  it('is lazy and lists labels once', () => {
    const { gmail, cache } = setup();
    gmail.seedLabel('A');
    gmail.seedLabel('B');
    expect(gmail.calls).toHaveLength(0);
    cache.idFor('A');
    expect(callsTo(gmail, 'listLabels')).toHaveLength(1);
    cache.idFor('B');
    expect(callsTo(gmail, 'listLabels')).toHaveLength(1);
  });

  it.each(['finance / bill', 'FINANCE/BILL'])('finds a seeded label as %j', (name) => {
    const { gmail, cache } = setup();
    const seeded = gmail.seedLabel('Finance/Bill');
    expect(cache.idFor(name)).toEqual({ ok: true, id: seeded.id, created: false });
    expect(callsTo(gmail, 'createLabel')).toHaveLength(0);
  });

  it('creates missing ancestors top-down and logs each', () => {
    const { gmail, log, cache } = setup();
    const result = cache.idFor('A/B/C');
    expect(result).toMatchObject({ ok: true, created: true });
    expect(callsTo(gmail, 'createLabel')).toEqual([['A'], ['A/B'], ['A/B/C']]);
    expect(log.all('label.created').map((e) => e.fields)).toEqual([
      { name: 'A' },
      { name: 'A/B' },
      { name: 'A/B/C' },
    ]);
  });

  it('skips an ancestor that exists', () => {
    const { gmail, cache } = setup();
    gmail.seedLabel('A');
    cache.idFor('A/B/C');
    expect(callsTo(gmail, 'createLabel')).toEqual([['A/B'], ['A/B/C']]);
  });

  it('caches a created label', () => {
    const { gmail, cache } = setup();
    const first = cache.idFor('New');
    const second = cache.idFor('New');
    expect(callsTo(gmail, 'createLabel')).toHaveLength(1);
    expect(second).toMatchObject({ ok: true, created: false });
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
  });

  it('creates Jev, then Jev/Error', () => {
    const { gmail, cache } = setup();
    cache.idFor(JEV_ERROR_LABEL);
    expect(callsTo(gmail, 'createLabel')).toEqual([['Jev'], ['Jev/Error']]);
  });

  it('warns about a failed ancestor and still creates the leaf', () => {
    const { gmail, log, cache } = setup();
    gmail.failNext('createLabel', invalidName);
    expect(cache.idFor('A/B')).toMatchObject({ ok: true, created: true });
    expect(log.atLevel('warn')).toEqual([
      {
        level: 'warn',
        event: 'label.parent_failed',
        fields: { name: 'A', label: 'A/B', kind: 'invalid_label_name' },
      },
    ]);
  });

  it('accepts an ancestor label_exists without a warning', () => {
    const { gmail, log, cache } = setup();
    gmail.failNext('createLabel', labelExists);
    expect(cache.idFor('A/B')).toMatchObject({ ok: true, created: true });
    expect(log.atLevel('warn')).toHaveLength(0);
    expect(callsTo(gmail, 'listLabels')).toHaveLength(1);
  });

  it.each([
    ['scope', noScope],
    ['rate_limited', FakeGmail.rateLimited()],
  ])('returns an ancestor %s and creates nothing more', (_kind, failure) => {
    const { gmail, cache } = setup();
    gmail.failNext('createLabel', failure);
    expect(cache.idFor('A/B')).toEqual(failure);
    expect(callsTo(gmail, 'createLabel')).toEqual([['A']]);
  });

  it.each([
    ['scope', noScope],
    ['rate_limited', FakeGmail.rateLimited()],
  ])('returns a leaf %s', (_kind, failure) => {
    const { gmail, cache } = setup();
    gmail.failNext('createLabel', failure);
    expect(cache.idFor('A')).toEqual(failure);
  });

  it.each([
    ['scope', noScope],
    ['rate_limited', FakeGmail.rateLimited()],
  ])('returns a listLabels %s and tries again next time', (_kind, failure) => {
    const { gmail, cache } = setup();
    gmail.seedLabel('A');
    gmail.failNext('listLabels', failure);
    expect(cache.idFor('A')).toEqual(failure);
    expect(cache.idFor('A')).toMatchObject({ ok: true, created: false });
    expect(callsTo(gmail, 'listLabels')).toHaveLength(2);
  });

  it('refreshes once on a leaf conflict and finds the label', () => {
    const { gmail, cache } = setup();
    cache.idFor('Other');
    const seeded = gmail.seedLabel('X');
    expect(cache.idFor('X')).toEqual({ ok: true, id: seeded.id, created: false });
    expect(callsTo(gmail, 'listLabels')).toHaveLength(2);
  });

  it('throws when the leaf exists but is still missing after one refresh', () => {
    const { gmail, cache } = setup();
    gmail.failNext('createLabel', labelExists);
    expect(() => cache.idFor('Ghost')).toThrow(
      expect.objectContaining({
        name: 'UnexpectedResponseError',
        reason: 'label_exists_but_missing',
      }),
    );
    expect(callsTo(gmail, 'listLabels')).toHaveLength(2);
  });

  it('returns the failure when the refresh after a conflict fails', () => {
    const { gmail, cache } = setup();
    cache.idFor('Other');
    gmail.seedLabel('X');
    gmail.failNext('listLabels', noScope);
    expect(cache.idFor('X')).toEqual(noScope);
  });

  it('throws UnexpectedResponseError for an invalid leaf name', () => {
    const { gmail, cache } = setup();
    gmail.failNext('createLabel', invalidName);
    let thrown: unknown;
    try {
      cache.idFor('Bad');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({ reason: 'invalid_label_name' });
  });

  it('refresh replaces the cache and keeps it on failure', () => {
    const { gmail, cache } = setup();
    const old = gmail.seedLabel('Old');
    cache.idFor('Old');
    gmail.deleteLabelAsUser(old.id);
    const fresh = gmail.seedLabel('Fresh');

    gmail.failNext('listLabels', noScope);
    expect(cache.refresh()).toEqual(noScope);
    expect(cache.idFor('Old')).toEqual({ ok: true, id: old.id, created: false });

    expect(cache.refresh()).toEqual({ ok: true });
    expect(cache.idFor('Fresh')).toEqual({ ok: true, id: fresh.id, created: false });
    const recreated = cache.idFor('Old');
    expect(recreated).toMatchObject({ ok: true, created: true });
    expect(recreated.ok && recreated.id !== old.id).toBe(true);
  });
});
