import { describe, expect, it } from 'vitest';

import {
  type JevErrorCause,
  type JevErrorDeps,
  markJevError,
  strikeOrError,
} from '../../src/app/jev-error.ts';
import { readJevErrorLabelIds } from '../../src/app/jev-error-label-store.ts';
import { createLabelCache } from '../../src/app/label-cache.ts';
import { JevClassifierError, StateError, UnexpectedResponseError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL_KEY } from '../../src/core/jev-error-label.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { fail } from '../../src/core/result.ts';
import { enqueue, type WorkItem, type WorkQueue } from '../../src/core/work-queue.ts';
import type { ThreadLabelChange } from '../../src/ports/gmail-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { FakeLog } from '../fakes/fake-log.ts';
import { FakeState } from '../fakes/fake-state.ts';

function setup() {
  const gmail = new FakeGmail();
  const log = new FakeLog();
  const state = new FakeState();
  const labels = createLabelCache({ gmail, log });
  const deps: JevErrorDeps = { gmail, labels, state };
  return { gmail, log, state, labels, deps };
}

function callsTo(gmail: FakeGmail, method: string): (readonly unknown[])[] {
  return gmail.calls.filter((c) => c.method === method).map((c) => c.args);
}

function modifyChanges(gmail: FakeGmail): ThreadLabelChange[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- modifyThread's second argument is always a ThreadLabelChange
  return callsTo(gmail, 'modifyThread').map((args) => args[1] as ThreadLabelChange);
}

function stateSets(state: FakeState): number {
  return state.calls.filter((c) => c.method === 'set').length;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The label ID Gmail has for `name`, from a fresh `listLabels`. */
function labelId(gmail: FakeGmail, name: string): string | undefined {
  const listed = gmail.listLabels();
  return listed.ok ? listed.labels.find((l) => l.name === name)?.id : undefined;
}

/** A queue holding `threadIds` in order, the first with `strikes` and every optional field set. */
function queueOf(threadIds: readonly string[], strikes = 0): WorkQueue {
  let queue: WorkQueue = [];
  threadIds.forEach((threadId, i) => {
    const added = enqueue(queue, {
      threadId,
      source: 'scheduled',
      enqueuedAt: 1_000 + i,
      positionSavedAt: 500,
      firstClassification: true,
    });
    if (!added.ok) {
      throw new Error('setup: enqueue failed');
    }
    queue = added.queue;
  });
  return queue.map((item, i) => (i === 0 ? { ...item, strikes } : item));
}

const noScope = fail('scope', { message: 'Insufficient Permission' });
const invalidLabel = fail('invalid_label', { message: 'labelId not found' });

describe('markJevError', () => {
  it('creates Jev then Jev/Error when missing, and adds only that ID to every message', () => {
    const { gmail, log, state, deps } = setup();
    const keep = gmail.seedLabel('Keep').id;
    const { threadId } = gmail.deliver({ labelIds: ['INBOX', 'UNREAD', keep] });
    gmail.deliver({ threadId, labelIds: ['SENT'] });

    const result = markJevError(threadId, deps);

    const id = labelId(gmail, JEV_ERROR_LABEL);
    expect(id).toBeDefined();
    expect(result).toEqual({ ok: true, labelId: id });
    expect(callsTo(gmail, 'createLabel')).toEqual([['Jev'], [JEV_ERROR_LABEL]]);
    expect(log.all('label.created')).toHaveLength(2);
    expect(modifyChanges(gmail)).toEqual([{ addLabelIds: [id], removeLabelIds: [] }]);
    const [first, second] = gmail.threadLabels(threadId);
    expect(first).toEqual(expect.arrayContaining(['INBOX', 'UNREAD', keep, id]));
    expect(second).toEqual(expect.arrayContaining(['SENT', id]));
    expect(readJevErrorLabelIds(state)).toEqual([id]);
  });

  it('uses an existing Jev/Error with no createLabel', () => {
    const { gmail, deps } = setup();
    const id = gmail.seedLabel(JEV_ERROR_LABEL).id;
    const { threadId } = gmail.deliver();
    expect(markJevError(threadId, deps)).toEqual({ ok: true, labelId: id });
    expect(callsTo(gmail, 'createLabel')).toEqual([]);
  });

  it('remembers the ID even when modifyThread then fails', () => {
    const { gmail, state, deps } = setup();
    const id = gmail.seedLabel(JEV_ERROR_LABEL).id;
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', FakeGmail.rateLimited());
    expect(markJevError(threadId, deps)).toEqual(FakeGmail.rateLimited());
    expect(readJevErrorLabelIds(state)).toEqual([id]);
    expect(gmail.threadLabels(threadId)[0]).not.toContain(id);
  });

  it('writes state only once for two calls with the same ID', () => {
    const { gmail, state, deps } = setup();
    const a = gmail.deliver().threadId;
    const b = gmail.deliver().threadId;
    expect(markJevError(a, deps).ok).toBe(true);
    expect(markJevError(b, deps).ok).toBe(true);
    expect(stateSets(state)).toBe(1);
  });

  it('refreshes a stale ID, remembers the new one and retries once', () => {
    const { gmail, state, labels, deps } = setup();
    const { threadId } = gmail.deliver();
    const stale = labels.idFor(JEV_ERROR_LABEL);
    if (!stale.ok) {
      throw new Error('setup: idFor failed');
    }
    gmail.deleteLabelAsUser(stale.id);

    const result = markJevError(threadId, deps);

    const fresh = labelId(gmail, JEV_ERROR_LABEL);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(stale.id);
    expect(result).toEqual({ ok: true, labelId: fresh });
    expect(modifyChanges(gmail)).toEqual([
      { addLabelIds: [stale.id], removeLabelIds: [] },
      { addLabelIds: [fresh], removeLabelIds: [] },
    ]);
    expect(readJevErrorLabelIds(state)).toEqual([stale.id, fresh]);
    expect(gmail.threadLabels(threadId)[0]).toContain(fresh);
  });

  it('throws UnexpectedResponseError on a second invalid_label', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', invalidLabel, { times: 2 });
    const error = thrown(() => markJevError(threadId, deps));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error).toMatchObject({ service: 'gmail', reason: 'invalid_label' });
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(2);
  });

  it('returns a failed refresh after invalid_label, with no retry', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', invalidLabel);
    gmail.failNext('listLabels', FakeGmail.rateLimited(), { after: 1 });
    expect(markJevError(threadId, deps)).toEqual(FakeGmail.rateLimited());
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });

  it.each([
    ['listLabels', 'scope', noScope],
    ['listLabels', 'rate_limited', FakeGmail.rateLimited()],
    ['createLabel', 'scope', noScope],
    ['createLabel', 'rate_limited', FakeGmail.rateLimited()],
  ] as const)(
    'returns %s %s from idFor: nothing remembered, no modifyThread',
    (method, _kind, failure) => {
      const { gmail, state, deps } = setup();
      const { threadId } = gmail.deliver();
      gmail.failNext(method, failure);
      expect(markJevError(threadId, deps)).toEqual(failure);
      expect(state.get(JEV_ERROR_LABEL_KEY)).toBeUndefined();
      expect(callsTo(gmail, 'modifyThread')).toEqual([]);
    },
  );

  it.each([
    ['not_found', fail('not_found')],
    ['failed_precondition', FakeGmail.failedPrecondition()],
    ['rate_limited', FakeGmail.rateLimited()],
    ['scope', noScope],
  ] as const)('returns modifyThread %s as is, with no retry', (_kind, failure) => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    gmail.failNext('modifyThread', failure);
    expect(markJevError(threadId, deps)).toEqual(failure);
    expect(callsTo(gmail, 'modifyThread')).toHaveLength(1);
  });

  it('returns not_found for a deleted thread', () => {
    const { deps } = setup();
    expect(markJevError('no-such-thread', deps)).toEqual(fail('not_found'));
  });

  it('throws StateError for a corrupt state.jevErrorLabel, and labels nothing', () => {
    const { gmail, state, deps } = setup();
    const { threadId } = gmail.deliver();
    state.seedRaw(JEV_ERROR_LABEL_KEY, '{"v":1,"ids":[42]}');
    expect(thrown(() => markJevError(threadId, deps))).toBeInstanceOf(StateError);
    expect(callsTo(gmail, 'modifyThread')).toEqual([]);
    expect(state.snapshot()[JEV_ERROR_LABEL_KEY]).toBe('{"v":1,"ids":[42]}');
  });
});

describe('strikeOrError: strike', () => {
  it.each([
    [0, 1],
    [1, 2],
  ])('%i -> %i is struck, keeps the other fields, and calls no Gmail', (before, after) => {
    const { gmail, deps } = setup();
    const queue = queueOf(['t1', 't2'], before);
    const [item, other] = queue;

    const result = strikeOrError(queue, 't1', 'strike', deps);

    expect(result).toEqual({
      queue: [{ ...item, strikes: after }, other],
      outcome: 'struck',
      strikes: after,
      alerts: [],
    });
    expect(result.queue[1]).toBe(other);
    expect(gmail.calls).toEqual([]);
  });

  it('2 -> 3 adds Jev/Error and removes the item', () => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    const queue = queueOf([threadId, 'other'], 2);

    const result = strikeOrError(queue, threadId, 'strike', deps);

    const id = labelId(gmail, JEV_ERROR_LABEL);
    expect(result).toEqual({
      queue: [queue[1]],
      outcome: 'errored',
      strikes: 3,
      alerts: ['errored'],
      labelId: id,
    });
    expect(gmail.threadLabels(threadId)[0]).toContain(id);
  });
});

describe('strikeOrError: invalid', () => {
  it.each([0, 2])(
    'at strikes %i adds Jev/Error and removes the item, with no strikes',
    (strikes) => {
      const { gmail, deps } = setup();
      const { threadId } = gmail.deliver();
      const queue = queueOf([threadId, 'other'], strikes);

      const result = strikeOrError(queue, threadId, 'invalid', deps);

      const id = labelId(gmail, JEV_ERROR_LABEL);
      expect(result).toEqual({
        queue: [queue[1]],
        outcome: 'errored',
        alerts: ['errored'],
        labelId: id,
      });
      expect(result).not.toHaveProperty('strikes');
      expect(gmail.threadLabels(threadId)[0]).toContain(id);
    },
  );
});

describe('strikeOrError: adding Jev/Error fails', () => {
  const cases: [JevErrorCause, number][] = [
    ['strike', 2],
    ['invalid', 0],
    ['invalid', 1],
  ];

  it.each(
    cases.flatMap(([cause, strikes]) =>
      (
        [
          [
            'rate_limited',
            FakeGmail.rateLimited(),
            { alerts: [], stopGmail: 'rate_limited', markFailed: 'rate_limited' },
          ],
          ['scope', noScope, { alerts: ['scope_missing'], markFailed: 'scope' }],
          [
            'failed_precondition',
            FakeGmail.failedPrecondition(),
            { alerts: [], markFailed: 'failed_precondition' },
          ],
        ] as const
      ).map(([kind, failure, fields]) => [cause, strikes, kind, failure, fields] as const),
    ),
  )('%s at strikes %i, %s: untouched, the same queue', (cause, strikes, _kind, failure, fields) => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    const queue = queueOf([threadId, 'other'], strikes);
    const copy = structuredClone(queue);
    gmail.failNext('modifyThread', failure);

    const result = strikeOrError(queue, threadId, cause, deps);

    expect(result.queue).toBe(queue);
    expect(queue).toEqual(copy);
    expect(result).toEqual({ queue, outcome: 'untouched', ...fields });
  });

  it.each<[JevErrorCause, number]>(cases)(
    '%s at strikes %i, not_found: gone, the item removed',
    (cause, strikes) => {
      const { deps } = setup();
      const queue = queueOf(['gone-thread', 'other'], strikes);
      expect(strikeOrError(queue, 'gone-thread', cause, deps)).toEqual({
        queue: [queue[1]],
        outcome: 'gone',
        alerts: [],
      });
    },
  );

  it.each<JevErrorCause>(['strike', 'invalid'])(
    '%s: an exception while marking propagates',
    (cause) => {
      const { gmail, deps } = setup();
      const { threadId } = gmail.deliver();
      const queue = queueOf([threadId], 2);
      gmail.failNext('modifyThread', invalidLabel, { times: 2 });
      expect(thrown(() => strikeOrError(queue, threadId, cause, deps))).toBeInstanceOf(
        UnexpectedResponseError,
      );
    },
  );
});

describe('strikeOrError: the queue', () => {
  it.each<[JevErrorCause, number]>([
    ['strike', 0],
    ['strike', 2],
    ['invalid', 1],
  ])('%s at strikes %i never mutates the input or other items', (cause, strikes) => {
    const { gmail, deps } = setup();
    const { threadId } = gmail.deliver();
    const queue = queueOf(['a', threadId, 'z'], 0).map((item): WorkItem =>
      item.threadId === threadId ? { ...item, strikes } : item,
    );
    const copy = structuredClone(queue);
    const others = queue.filter((item) => item.threadId !== threadId);

    const result = strikeOrError(queue, threadId, cause, deps);

    expect(queue).toEqual(copy);
    expect(result.queue.filter((item) => item.threadId !== threadId)).toEqual(others);
    for (const [i, item] of result.queue.filter((x) => x.threadId !== threadId).entries()) {
      expect(item).toBe(others[i]);
    }
  });

  it.each<JevErrorCause>(['strike', 'invalid'])(
    '%s for a thread not in the queue throws JevClassifierError',
    (cause) => {
      const { gmail, deps } = setup();
      const queue = queueOf(['t1']);
      expect(thrown(() => strikeOrError(queue, 'unknown', cause, deps))).toBeInstanceOf(
        JevClassifierError,
      );
      expect(gmail.calls).toEqual([]);
    },
  );
});
