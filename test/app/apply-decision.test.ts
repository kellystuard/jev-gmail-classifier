import { describe, expect, it } from 'vitest';
import { applyDecision } from '../../src/app/apply-decision.ts';
import { createLabelCache } from '../../src/app/label-cache.ts';
import type { MoveDestination } from '../../src/config/schema.ts';
import type { Decision } from '../../src/core/decide.ts';
import { UnexpectedResponseError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { fail } from '../../src/core/result.ts';
import type { ThreadLabelChange } from '../../src/ports/gmail-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';

const BILL = 'Finance/Bill';
const receipts: MoveDestination = { kind: 'label', label: 'Receipts' };

function setup() {
  const { gmail, log } = createFakePorts();
  const labels = createLabelCache({ gmail, log });
  const deps = { gmail, labels };
  return { gmail, log, labels, deps };
}

function decision(labels: readonly string[], destination?: MoveDestination): Decision {
  return destination === undefined
    ? { fired: [], labels }
    : { fired: [], labels, move: { ruleId: 'move-rule', destination } };
}

function callsTo(gmail: FakeGmail, method: string): (readonly unknown[])[] {
  return gmail.calls.filter((c) => c.method === method).map((c) => c.args);
}

function modifyChanges(gmail: FakeGmail): ThreadLabelChange[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- modifyThread's second argument is always a ThreadLabelChange
  return callsTo(gmail, 'modifyThread').map((args) => args[1] as ThreadLabelChange);
}

/** Calls that read or change a thread (not the label list or label creation). */
function threadCalls(gmail: FakeGmail): string[] {
  return gmail.calls.map((c) => c.method).filter((m) => m !== 'listLabels' && m !== 'createLabel');
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

const invalidLabel = fail('invalid_label', { message: 'labelId not found' });
const noScope = fail('scope', { message: 'Insufficient Permission' });

describe('applyDecision: the call table', () => {
  it.each<[string, MoveDestination | undefined, (bill: string, receipt: string) => string[]]>([
    ['none', undefined, (bill) => ['INBOX', 'UNREAD', bill]],
    ['archive', { kind: 'archive' }, (bill) => ['UNREAD', bill]],
    ['label:Receipts', receipts, (bill, receipt) => ['UNREAD', bill, receipt]],
    ['spam', { kind: 'spam' }, (bill) => ['UNREAD', bill, 'SPAM']],
    ['trash', { kind: 'trash' }, (bill) => ['UNREAD', bill, 'TRASH']],
  ])('move %s: one modifyThread, labels on every message', (_name, move, expected) => {
    const { gmail, deps } = setup();
    const bill = gmail.seedLabel(BILL).id;
    const receipt = gmail.seedLabel('Receipts').id;
    const { threadId } = gmail.deliver();
    gmail.deliver({ threadId });

    const result = applyDecision(threadId, decision([BILL], move), deps);

    expect(result).toEqual({
      ok: true,
      applied: move === undefined ? { labels: [BILL] } : { labels: [BILL], move },
    });
    const want = sorted(expected(bill, receipt));
    expect(gmail.threadLabels(threadId).map(sorted)).toEqual([want, want]);
    expect(threadCalls(gmail)).toEqual(['modifyThread']);
  });

  it('makes no call at all with no labels and no move', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    expect(applyDecision(threadId, decision([]), deps)).toEqual({
      ok: true,
      applied: { labels: [] },
    });
    expect(gmail.calls).toEqual([]);
  });

  it('makes one call for a move with no labels', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    const result = applyDecision(threadId, decision([], { kind: 'archive' }), deps);
    expect(result).toEqual({ ok: true, applied: { labels: [], move: { kind: 'archive' } } });
    expect(modifyChanges(gmail)).toEqual([{ addLabelIds: [], removeLabelIds: ['INBOX'] }]);
    expect(threadCalls(gmail)).toEqual(['modifyThread']);
  });

  it('adds a label move whose label also fires once', () => {
    const { gmail, deps } = setup();
    const id = gmail.seedLabel('Receipts').id;
    const { threadId } = gmail.deliver();
    applyDecision(threadId, decision(['Receipts'], receipts), deps);
    expect(modifyChanges(gmail)).toEqual([{ addLabelIds: [id], removeLabelIds: ['INBOX'] }]);
  });

  it('creates missing nested labels and applies them in the same call', () => {
    const { gmail, log, deps } = setup();
    const { threadId } = gmail.deliver();
    const result = applyDecision(
      threadId,
      decision(['Finance/Bill/Utility'], { kind: 'label', label: 'Archive/2026' }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(callsTo(gmail, 'createLabel')).toEqual([
      ['Finance'],
      ['Finance/Bill'],
      ['Finance/Bill/Utility'],
      ['Archive'],
      ['Archive/2026'],
    ]);
    expect(log.all('label.created')).toHaveLength(5);
    const [change] = modifyChanges(gmail);
    expect(change?.addLabelIds).toHaveLength(2);
    expect(threadCalls(gmail)).toEqual(['modifyThread']);
    const labelsNow = gmail.threadLabels(threadId)[0] ?? [];
    for (const id of change?.addLabelIds ?? []) {
      expect(labelsNow).toContain(id);
    }
    expect(labelsNow).not.toContain('INBOX');
  });

  it.each<[string, MoveDestination]>([
    ['spam', { kind: 'spam' }],
    ['trash', { kind: 'trash' }],
  ])('moves a thread with a sent message to %s: every message, SENT kept', (_name, move) => {
    const { gmail, deps } = setup();
    const bill = gmail.seedLabel(BILL).id;
    const { threadId } = gmail.deliver();
    gmail.deliver({ threadId, labelIds: ['SENT'] });
    applyDecision(threadId, decision([BILL], move), deps);
    const moved = move.kind === 'spam' ? 'SPAM' : 'TRASH';
    expect(gmail.threadLabels(threadId).map(sorted)).toEqual([
      sorted(['UNREAD', bill, moved]),
      sorted(['SENT', bill, moved]),
    ]);
  });
});

describe('applyDecision: never removes a label', () => {
  it.each<[string, MoveDestination | undefined]>([
    ['none', undefined],
    ['archive', { kind: 'archive' }],
    ['label:Receipts', receipts],
    ['spam', { kind: 'spam' }],
    ['trash', { kind: 'trash' }],
  ])('keeps a user label and Jev/Error on move %s', (_name, move) => {
    const { gmail, deps } = setup();
    const keep = gmail.seedLabel('Keep').id;
    const jevError = gmail.seedLabel(JEV_ERROR_LABEL).id;
    const { threadId } = gmail.deliver({ labelIds: ['INBOX', 'UNREAD', keep, jevError] });
    applyDecision(threadId, decision([BILL], move), deps);
    for (const labels of gmail.threadLabels(threadId)) {
      expect(labels).toEqual(expect.arrayContaining([keep, jevError]));
    }
    for (const change of modifyChanges(gmail)) {
      expect([[], ['INBOX']]).toContainEqual(change.removeLabelIds);
    }
  });

  it('writes no history record when the same decision is applied again', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    const same = decision([BILL], { kind: 'spam' });
    applyDecision(threadId, same, deps);
    const before = gmail.history.length;
    expect(applyDecision(threadId, same, deps).ok).toBe(true);
    expect(gmail.history).toHaveLength(before);
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(2);
  });
});

describe('applyDecision: a stale label ID', () => {
  it('refreshes, recreates the deleted label and retries once', () => {
    const { gmail, labels, deps } = setup();
    const { threadId } = gmail.deliver();
    const first = labels.idFor(BILL);
    if (!first.ok) {
      throw new Error('setup: idFor failed');
    }
    gmail.deleteLabelAsUser(first.id);

    const result = applyDecision(threadId, decision([BILL]), deps);

    expect(result).toEqual({ ok: true, applied: { labels: [BILL] } });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(2);
    expect(callsTo(gmail, 'listLabels')).toHaveLength(2);
    const [stale, fresh] = modifyChanges(gmail);
    expect(stale?.addLabelIds).toEqual([first.id]);
    const freshId = fresh?.addLabelIds[0];
    expect(freshId).toBeDefined();
    expect(freshId).not.toBe(first.id);
    expect(gmail.threadLabels(threadId)[0]).toContain(freshId);
  });

  it('throws UnexpectedResponseError on a second invalid_label', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', invalidLabel, { times: 2 });
    let thrown: unknown;
    try {
      applyDecision(threadId, decision([BILL]), deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({ service: 'gmail', reason: 'invalid_label' });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(2);
  });

  it('returns a failed refresh', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', invalidLabel);
    gmail.failNext('listLabels', FakeGmail.rateLimited(), { after: 1 });
    expect(applyDecision(threadId, decision([BILL]), deps)).toEqual(FakeGmail.rateLimited());
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });

  it('returns a failure resolving the IDs again', () => {
    const { gmail, labels, deps } = setup();
    const { threadId } = gmail.deliver();
    const first = labels.idFor(BILL);
    if (!first.ok) {
      throw new Error('setup: idFor failed');
    }
    gmail.deleteLabelAsUser(first.id);
    gmail.failNext('createLabel', FakeGmail.rateLimited());
    expect(applyDecision(threadId, decision([BILL]), deps)).toEqual(FakeGmail.rateLimited());
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });
});

describe('applyDecision: failures', () => {
  it('returns listLabels rate_limited and modifies nothing', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    const failure = FakeGmail.rateLimited();
    gmail.failNext('listLabels', failure);
    expect(applyDecision(threadId, decision([BILL], { kind: 'spam' }), deps)).toEqual(failure);
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(0);
  });

  it('returns a failure resolving the move label and modifies nothing', () => {
    const { gmail, deps } = setup();
    gmail.seedLabel(BILL);
    const { threadId } = gmail.deliver();
    gmail.failNext('createLabel', FakeGmail.rateLimited());
    expect(applyDecision(threadId, decision([BILL], receipts), deps)).toEqual(
      FakeGmail.rateLimited(),
    );
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(0);
  });

  it('returns not_found for an unknown thread', () => {
    const { deps } = setup();
    expect(applyDecision('no-such-thread', decision([BILL]), deps)).toEqual(fail('not_found'));
  });

  it.each([
    ['failed_precondition', FakeGmail.failedPrecondition()],
    ['rate_limited', FakeGmail.rateLimited()],
  ] as const)('returns modifyThread %s as is, with no retry', (_name, failure) => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', failure);
    expect(applyDecision(threadId, decision([BILL], { kind: 'trash' }), deps)).toEqual(failure);
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });
});

describe('applyDecision: a missing scope', () => {
  const archive: MoveDestination = { kind: 'archive' };

  function scopeSetup() {
    const s = setup();
    const bill = s.gmail.seedLabel(BILL).id;
    const { threadId } = s.gmail.deliver();
    return { ...s, bill, threadId };
  }

  it('drops the move and applies the labels when modifyThread lacks a scope once', () => {
    const { gmail, deps, bill, threadId } = scopeSetup();
    gmail.failNext('modifyThread', noScope);
    const result = applyDecision(threadId, decision([BILL], archive), deps);
    expect(result).toEqual({ ok: true, applied: { labels: [BILL] }, moveSkipped: 'scope' });
    expect(modifyChanges(gmail)).toEqual([
      expect.anything(),
      { addLabelIds: [bill], removeLabelIds: [] },
    ]);
    expect(sorted(gmail.threadLabels(threadId)[0] ?? [])).toEqual(
      sorted(['INBOX', 'UNREAD', bill]),
    );
  });

  it.each(['spam', 'trash'] as const)('does not add %s in the labels-only retry', (kind) => {
    const { gmail, deps, bill, threadId } = scopeSetup();
    gmail.failNext('modifyThread', noScope);
    const result = applyDecision(threadId, decision([BILL], { kind }), deps);
    expect(result).toEqual({ ok: true, applied: { labels: [BILL] }, moveSkipped: 'scope' });
    expect(modifyChanges(gmail)[1]).toEqual({ addLabelIds: [bill], removeLabelIds: [] });
  });

  it('skips a label move whose label cannot be created, and applies the labels', () => {
    const { gmail, deps, bill, threadId } = scopeSetup();
    gmail.failNext('createLabel', noScope);
    const result = applyDecision(threadId, decision([BILL], receipts), deps);
    expect(result).toEqual({ ok: true, applied: { labels: [BILL] }, moveSkipped: 'scope' });
    expect(modifyChanges(gmail)).toEqual([{ addLabelIds: [bill], removeLabelIds: [] }]);
  });

  it('reports both skipped when the retry lacks the scope too, and stops there', () => {
    const { gmail, deps, threadId } = scopeSetup();
    const before = gmail.threadLabels(threadId);
    gmail.failNext('modifyThread', noScope, { times: 2 });
    const result = applyDecision(threadId, decision([BILL], archive), deps);
    expect(result).toEqual({
      ok: true,
      applied: { labels: [] },
      moveSkipped: 'scope',
      labelsSkipped: 'scope',
    });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(2);
    expect(gmail.threadLabels(threadId)).toEqual(before);
  });

  it('makes at most one retry when the label list keeps failing with scope', () => {
    const { gmail, deps, threadId } = scopeSetup();
    gmail.failNext('listLabels', noScope, { times: 10 });
    const result = applyDecision(threadId, decision([BILL], archive), deps);
    expect(result).toEqual({
      ok: true,
      applied: { labels: [] },
      moveSkipped: 'scope',
      labelsSkipped: 'scope',
    });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(0);
    expect(callsTo(gmail, 'listLabels')).toHaveLength(2);
  });

  it('skips only the move, with no retry, when there are no labels', () => {
    const { gmail, deps, threadId } = scopeSetup();
    gmail.failNext('modifyThread', noScope);
    expect(applyDecision(threadId, decision([], archive), deps)).toEqual({
      ok: true,
      applied: { labels: [] },
      moveSkipped: 'scope',
    });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });

  it('skips only the labels, with no retry, when there is no move', () => {
    const { gmail, deps, threadId } = scopeSetup();
    gmail.failNext('modifyThread', noScope);
    expect(applyDecision(threadId, decision([BILL]), deps)).toEqual({
      ok: true,
      applied: { labels: [] },
      labelsSkipped: 'scope',
    });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });

  it('refreshes once for a stale ID inside the labels-only retry', () => {
    const { gmail, deps, bill, threadId } = scopeSetup();
    gmail.failNext('modifyThread', noScope);
    gmail.failNext('modifyThread', invalidLabel);
    const result = applyDecision(threadId, decision([BILL], archive), deps);
    expect(result).toEqual({ ok: true, applied: { labels: [BILL] }, moveSkipped: 'scope' });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(3);
    expect(callsTo(gmail, 'listLabels')).toHaveLength(2);
    expect(gmail.threadLabels(threadId)[0]).toContain(bill);
  });

  it.each([
    ['rate_limited', FakeGmail.rateLimited()],
    ['not_found', fail('not_found')],
    ['failed_precondition', FakeGmail.failedPrecondition()],
  ] as const)('returns %s from the labels-only retry as it is', (_name, failure) => {
    const { gmail, deps, threadId } = scopeSetup();
    gmail.failNext('modifyThread', noScope);
    gmail.failNext('modifyThread', failure);
    expect(applyDecision(threadId, decision([BILL], archive), deps)).toEqual(failure);
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(2);
  });
});
