import { describe, expect, it } from 'vitest';

import { countGmailCalls, loadGmailCalls, saveGmailCalls } from '../../src/app/counting-gmail.ts';
import { StateError } from '../../src/core/errors.ts';
import { GMAIL_CALLS_KEY, GMAIL_UNIT_COST } from '../../src/core/gmail-calls.ts';
import type { GmailPort } from '../../src/ports/gmail-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';

const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TODAY = '2026-09-30';

function callEveryMethod(gmail: GmailPort): void {
  gmail.getProfile();
  gmail.listHistory({ startHistoryId: '1', historyTypes: ['messageAdded'] });
  gmail.searchThreadIds({ q: 'in:inbox', includeSpamTrash: true });
  gmail.getThread('missing', { format: 'minimal' });
  gmail.listLabels();
  gmail.createLabel('Jev/Test');
  gmail.modifyThread('missing', { addLabelIds: [], removeLabelIds: [] });
}

describe('countGmailCalls', () => {
  it('counts every method once, with the units of the fake', () => {
    const { gmail } = createFakePorts();
    gmail.setSearchMatcher(() => false);
    const counting = countGmailCalls(gmail);
    callEveryMethod(counting.gmail);
    expect(counting.calls()).toBe(7);
    expect(counting.units()).toBe(
      Object.values(GMAIL_UNIT_COST).reduce((sum, cost) => sum + cost, 0),
    );
    expect(counting.units()).toBe(gmail.unitsUsed);
    expect(gmail.calls).toHaveLength(7);
  });

  it('starts at zero', () => {
    const counting = countGmailCalls(createFakePorts().gmail);
    expect(counting.calls()).toBe(0);
    expect(counting.units()).toBe(0);
  });

  it('counts a call that returns a failure, and passes it through', () => {
    const { gmail } = createFakePorts();
    const failure = FakeGmail.rateLimited();
    gmail.failNext('getThread', failure);
    const counting = countGmailCalls(gmail);
    expect(counting.gmail.getThread('t1', { format: 'minimal' })).toBe(failure);
    expect(counting.calls()).toBe(1);
    expect(counting.units()).toBe(GMAIL_UNIT_COST.getThread);
  });

  it('counts a call that throws, and rethrows the same error', () => {
    const { gmail } = createFakePorts();
    const error = new Error('boom');
    gmail.failNext('getThread', error);
    const counting = countGmailCalls(gmail);
    expect(() => counting.gmail.getThread('t1', { format: 'minimal' })).toThrow(error);
    expect(counting.calls()).toBe(1);
    expect(counting.units()).toBe(GMAIL_UNIT_COST.getThread);
  });

  it('passes results by identity and arguments unchanged', () => {
    const { gmail } = createFakePorts();
    const failure = FakeGmail.rateLimited();
    gmail.failNext('searchThreadIds', failure);
    gmail.setSearchMatcher(() => false);
    const request = { q: 'from:a', includeSpamTrash: true } as const;
    const format = { format: 'metadata', metadataHeaders: ['From'] } as const;
    const change = { addLabelIds: ['L1'], removeLabelIds: [] } as const;
    const counting = countGmailCalls(gmail);
    expect(counting.gmail.searchThreadIds(request)).toBe(failure);
    counting.gmail.getThread('t9', format);
    counting.gmail.modifyThread('t9', change);
    counting.gmail.createLabel('Jev/X');
    expect(gmail.calls.map((c) => c.method)).toEqual([
      'searchThreadIds',
      'getThread',
      'modifyThread',
      'createLabel',
    ]);
    expect(gmail.calls[0]?.args[0]).toBe(request);
    expect(gmail.calls[1]?.args[0]).toBe('t9');
    expect(gmail.calls[1]?.args[1]).toBe(format);
    expect(gmail.calls[2]?.args[1]).toBe(change);
    expect(gmail.calls[3]?.args[0]).toBe('Jev/X');
  });

  it('still counts a call when the scope was revoked', () => {
    const { gmail, scopes } = createFakePorts();
    scopes.revoke(MODIFY_SCOPE);
    const counting = countGmailCalls(gmail);
    expect(counting.gmail.getProfile().ok).toBe(false);
    expect(counting.calls()).toBe(1);
    expect(counting.units()).toBe(GMAIL_UNIT_COST.getProfile);
  });
});

describe('loadGmailCalls and saveGmailCalls', () => {
  it('returns today at 0 for an absent key, and writes nothing', () => {
    const { state } = createFakePorts();
    expect(loadGmailCalls(state, TODAY)).toEqual({ day: TODAY, count: 0 });
    expect(state.calls.filter((c) => c.method === 'set')).toHaveLength(0);
  });

  it("returns today's stored tally", () => {
    const { state } = createFakePorts();
    state.set(GMAIL_CALLS_KEY, { v: 1, day: TODAY, count: 42 });
    expect(loadGmailCalls(state, TODAY)).toEqual({ day: TODAY, count: 42 });
  });

  it("starts from 0 when the stored tally is yesterday's", () => {
    const { state } = createFakePorts();
    state.set(GMAIL_CALLS_KEY, { v: 1, day: '2026-09-29', count: 42 });
    expect(loadGmailCalls(state, TODAY)).toEqual({ day: TODAY, count: 0 });
  });

  it('throws StateError for a corrupt value and writes nothing', () => {
    const { state } = createFakePorts();
    state.seedRaw(GMAIL_CALLS_KEY, '{"v":1,"day":"today","count":-1}');
    expect(() => loadGmailCalls(state, TODAY)).toThrow(StateError);
    expect(state.calls.filter((c) => c.method === 'set')).toHaveLength(0);
  });

  it('writes the encoded tally', () => {
    const { state } = createFakePorts();
    saveGmailCalls(state, { day: TODAY, count: 7 });
    expect(state.get(GMAIL_CALLS_KEY)).toEqual({ v: 1, day: TODAY, count: 7 });
  });

  it('propagates a StateError from the port', () => {
    const { state } = createFakePorts();
    const error = new StateError('full', { key: GMAIL_CALLS_KEY, reason: 'store_full' });
    state.failNext('set', error);
    expect(() => {
      saveGmailCalls(state, { day: TODAY, count: 7 });
    }).toThrow(error);
  });
});
