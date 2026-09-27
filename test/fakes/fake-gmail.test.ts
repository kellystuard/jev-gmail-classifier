import { describe, expect, it } from 'vitest';

import type { GmailHistoryRecord, GmailMessage } from '../../src/core/gmail-types.ts';
import { fail } from '../../src/core/result.ts';
import plainUtf8 from '../fixtures/gmail/01-plain-utf8-7bit.json' with { type: 'json' };
import { FakeClock } from './fake-clock.ts';
import { FakeGmail, RATE_LIMIT_MESSAGE } from './fake-gmail.ts';
import { FakeScopes, SCOPE_ERROR_MESSAGE } from './fake-scopes.ts';

const BOTH_TYPES = ['messageAdded', 'labelRemoved'] as const;

function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- TypeScript can't narrow a generic union on `ok`; the check above makes this safe
  return result as Extract<T, { ok: true }>;
}

function isBare(record: GmailHistoryRecord): boolean {
  return (
    record.messagesAdded === undefined &&
    record.labelsRemoved === undefined &&
    record.labelsAdded === undefined
  );
}

function changeRecords(gmail: FakeGmail, after: string): GmailHistoryRecord[] {
  return gmail.history.filter((r) => Number(r.id) > Number(after) && !isBare(r));
}

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name === name)?.value;
}

describe('FakeGmail history', () => {
  it('writes a messageAdded record with the labels at the time of adding, then a bare record', () => {
    const gmail = new FakeGmail();
    const start = gmail.historyId;
    const { id, threadId } = gmail.deliver({ labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'] });
    const records = gmail.history;
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      id: String(Number(start) + 1),
      messages: [{ id, threadId }],
      messagesAdded: [
        { message: { id, threadId, labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'] } },
      ],
    });
    expect(records[1]).toEqual({ id: String(Number(start) + 2), messages: [{ id, threadId }] });
  });

  it('keeps the record labels when the message moves later', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    const start = gmail.historyId;
    const { threadId } = gmail.deliver();
    unwrap(gmail.modifyThread(threadId, { addLabelIds: ['SPAM'], removeLabelIds: [] }));
    const page = unwrap(
      gmail.listHistory({ startHistoryId: start, historyTypes: ['messageAdded'], maxResults: 10 }),
    );
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.messagesAdded?.[0]?.message.labelIds).toEqual(['INBOX', 'UNREAD']);
  });

  it('can turn bare records off', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    gmail.deliver();
    expect(gmail.history).toHaveLength(1);
  });

  it('pages, and a later page has a change made between pages and a higher historyId', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    const start = gmail.historyId;
    gmail.deliver();
    gmail.deliver();
    gmail.deliver();
    const first = unwrap(gmail.listHistory({ startHistoryId: start, historyTypes: BOTH_TYPES }));
    expect(first.records).toHaveLength(2);
    expect(first.nextPageToken).toBeDefined();
    const firstHistoryId = first.historyId;

    const late = gmail.deliver();
    const second = unwrap(
      gmail.listHistory({
        startHistoryId: start,
        historyTypes: BOTH_TYPES,
        pageToken: first.nextPageToken ?? '',
      }),
    );
    expect(second.records).toHaveLength(2);
    expect(second.records[1]?.messagesAdded?.[0]?.message.id).toBe(late.id);
    expect(Number(second.historyId)).toBeGreaterThan(Number(firstHistoryId));
    expect(second.nextPageToken).toBeUndefined();
  });

  it('lets an onCall hook change the mailbox between pages', () => {
    const gmail = new FakeGmail();
    const start = gmail.historyId;
    gmail.deliver();
    // Mail arrives just as the second page is read.
    gmail.onCall = (method) => {
      if (method === 'listHistory' && gmail.calls.length === 1) {
        gmail.deliver();
      }
    };
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = unwrap(
        gmail.listHistory({
          startHistoryId: start,
          historyTypes: ['messageAdded'],
          maxResults: 1,
          ...(pageToken === undefined ? {} : { pageToken }),
        }),
      );
      ids.push(...page.records.flatMap((r) => r.messagesAdded?.map((m) => m.message.id) ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    expect(ids).toEqual(['msg-1', 'msg-2']);
  });

  it('includes bare records, which callers must ignore', () => {
    const gmail = new FakeGmail();
    const start = gmail.historyId;
    gmail.deliver();
    const page = unwrap(
      gmail.listHistory({ startHistoryId: start, historyTypes: ['messageAdded'], maxResults: 10 }),
    );
    expect(page.records.filter(isBare)).toHaveLength(1);
  });

  it('returns only the requested types, and never labelsAdded records', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    const label = gmail.seedLabel('Jev/Error');
    const { threadId } = gmail.deliver();
    const start = gmail.historyId;
    unwrap(gmail.modifyThread(threadId, { addLabelIds: [label.id], removeLabelIds: [] }));
    gmail.removeLabelAsUser(threadId, label.id);
    gmail.deliver();
    const added = unwrap(
      gmail.listHistory({ startHistoryId: start, historyTypes: ['messageAdded'], maxResults: 10 }),
    );
    expect(added.records.map((r) => Object.keys(r).sort())).toEqual([
      ['id', 'messages', 'messagesAdded'],
    ]);
    const removed = unwrap(
      gmail.listHistory({ startHistoryId: start, historyTypes: ['labelRemoved'], maxResults: 10 }),
    );
    expect(removed.records.map((r) => Object.keys(r).sort())).toEqual([
      ['id', 'labelsRemoved', 'messages'],
    ]);
  });

  it('returns history_expired for a start before the expiry point', () => {
    const gmail = new FakeGmail();
    const old = gmail.historyId;
    gmail.deliver();
    gmail.expireHistoryBefore(gmail.historyId);
    expect(gmail.listHistory({ startHistoryId: old, historyTypes: BOTH_TYPES })).toEqual({
      ok: false,
      kind: 'history_expired',
    });
    expect(
      gmail.listHistory({ startHistoryId: gmail.historyId, historyTypes: BOTH_TYPES }).ok,
    ).toBe(true);
  });

  it('writes one removal record with one entry per message that had the label', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    const label = gmail.seedLabel('Jev/Error');
    const first = gmail.deliver();
    gmail.deliver({ threadId: first.threadId });
    gmail.deliver({ threadId: first.threadId });
    unwrap(
      gmail.modifyThread(first.threadId, { addLabelIds: [label.id], removeLabelIds: ['UNREAD'] }),
    );
    gmail.deliver({ threadId: first.threadId });
    const start = gmail.historyId;
    gmail.removeLabelAsUser(first.threadId, label.id);
    const records = changeRecords(gmail, start);
    expect(records).toHaveLength(1);
    expect(records[0]?.labelsRemoved).toEqual([
      {
        labelIds: [label.id],
        message: { id: 'msg-1', threadId: first.threadId, labelIds: ['INBOX'] },
      },
      {
        labelIds: [label.id],
        message: { id: 'msg-2', threadId: first.threadId, labelIds: ['INBOX'] },
      },
      {
        labelIds: [label.id],
        message: { id: 'msg-3', threadId: first.threadId, labelIds: ['INBOX'] },
      },
    ]);
  });

  it('deletes a label with one record per thread, and recreating the name gives a new ID', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    const label = gmail.seedLabel('Jev/Error');
    const a = gmail.deliver();
    const b = gmail.deliver();
    for (const t of [a, b]) {
      unwrap(gmail.modifyThread(t.threadId, { addLabelIds: [label.id], removeLabelIds: [] }));
    }
    const start = gmail.historyId;
    gmail.deleteLabelAsUser(label.id);
    const records = changeRecords(gmail, start);
    expect(records.map((r) => r.labelsRemoved?.map((e) => e.message.threadId))).toEqual([
      [a.threadId],
      [b.threadId],
    ]);
    const labels = unwrap(gmail.listLabels()).labels;
    expect(labels.find((l) => l.id === label.id)).toBeUndefined();
    const recreated = unwrap(gmail.createLabel('Jev/Error')).label;
    expect(recreated.id).not.toBe(label.id);
  });
});

describe('FakeGmail delivery', () => {
  it('gives a reply only its own labels, not the thread labels, SPAM or TRASH', () => {
    const gmail = new FakeGmail();
    const label = gmail.seedLabel('Finance');
    const first = gmail.deliver();
    unwrap(
      gmail.modifyThread(first.threadId, { addLabelIds: [label.id, 'SPAM'], removeLabelIds: [] }),
    );
    const reply = gmail.deliver({ threadId: first.threadId });
    expect(gmail.labelsOf(reply.id)).toEqual(['INBOX', 'UNREAD']);
    expect(gmail.labelsOf(first.id)).toEqual(['UNREAD', label.id, 'SPAM']);
  });

  it('throws when delivering to an unknown thread', () => {
    expect(() => new FakeGmail().deliver({ threadId: 'nope' })).toThrow(/unknown thread nope/);
  });
});

describe('FakeGmail search', () => {
  it('misses a Spam-only match without includeSpamTrash and finds it with it', () => {
    const gmail = new FakeGmail();
    const inbox = gmail.deliver({ headers: [{ name: 'From', value: 'other@example.com' }] });
    const spam = gmail.deliver({
      labelIds: ['SPAM'],
      headers: [{ name: 'From', value: 'bank@example.com' }],
    });
    gmail.deliver({
      threadId: spam.threadId,
      labelIds: ['INBOX'],
      headers: [{ name: 'From', value: 'me@example.com' }],
    });
    gmail.setSearchMatcher(
      (q, message) =>
        q === 'from:bank@example.com' && header(message, 'From') === 'bank@example.com',
    );
    expect(
      unwrap(gmail.searchThreadIds({ q: 'from:bank@example.com', includeSpamTrash: false }))
        .threadIds,
    ).toEqual([]);
    expect(
      unwrap(gmail.searchThreadIds({ q: 'from:bank@example.com', includeSpamTrash: true }))
        .threadIds,
    ).toEqual([spam.threadId]);
    expect(gmail.searches).toEqual(['from:bank@example.com', 'from:bank@example.com']);
    expect(inbox.threadId).not.toBe(spam.threadId);
  });

  it('pages distinct thread IDs', () => {
    const gmail = new FakeGmail();
    const threads = [gmail.deliver(), gmail.deliver(), gmail.deliver()];
    gmail.deliver({ threadId: threads[0]?.threadId ?? '' });
    gmail.setSearchMatcher(() => true);
    const first = unwrap(gmail.searchThreadIds({ q: 'x', includeSpamTrash: true }));
    const second = unwrap(
      gmail.searchThreadIds({
        q: 'x',
        includeSpamTrash: true,
        pageToken: first.nextPageToken ?? '',
      }),
    );
    expect([...first.threadIds, ...second.threadIds]).toEqual(threads.map((t) => t.threadId));
    expect(second.nextPageToken).toBeUndefined();
  });

  it('throws without a matcher', () => {
    expect(() => new FakeGmail().searchThreadIds({ q: 'x', includeSpamTrash: true })).toThrow(
      /setSearchMatcher/,
    );
  });
});

describe('FakeGmail getThread', () => {
  it('returns a fixture in full, with byte-array data', () => {
    const gmail = new FakeGmail();
    gmail.addThread(plainUtf8);
    const thread = unwrap(gmail.getThread(plainUtf8.id, { format: 'full' })).thread;
    const data = thread.messages?.[0]?.payload?.body?.data;
    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual(plainUtf8.messages[0]?.payload.body.data);
    expect(thread.messages?.[0]?.labelIds).toEqual(plainUtf8.messages[0]?.labelIds);
  });

  it('returns only the requested headers and no body data in metadata format', () => {
    const gmail = new FakeGmail();
    gmail.addThread(plainUtf8);
    const message = unwrap(
      gmail.getThread(plainUtf8.id, { format: 'metadata', metadataHeaders: ['date'] }),
    ).thread.messages?.[0];
    expect(message?.payload?.headers).toEqual([
      { name: 'Date', value: 'Thu, 24 Sep 2026 12:00:00 +0000' },
    ]);
    expect(message?.payload?.body).toBeUndefined();
    expect(message?.payload?.parts).toBeUndefined();
    expect(message?.internalDate).toBe(plainUtf8.messages[0]?.internalDate);
  });

  it('returns IDs, labels and internalDate in minimal format', () => {
    const gmail = new FakeGmail();
    const { id, threadId } = gmail.deliver({ internalDate: 1234 });
    expect(unwrap(gmail.getThread(threadId, { format: 'minimal' })).thread.messages).toEqual([
      { id, threadId, labelIds: ['INBOX', 'UNREAD'], internalDate: '1234' },
    ]);
  });

  it('includes Spam and Trash messages', () => {
    const gmail = new FakeGmail();
    const first = gmail.deliver({ labelIds: ['SPAM'] });
    gmail.deliver({ threadId: first.threadId, labelIds: ['TRASH'] });
    expect(
      unwrap(gmail.getThread(first.threadId, { format: 'minimal' })).thread.messages,
    ).toHaveLength(2);
  });

  it('returns not_found for an unknown thread', () => {
    expect(new FakeGmail().getThread('gone', { format: 'minimal' })).toEqual({
      ok: false,
      kind: 'not_found',
    });
  });

  it("doesn't let a caller change the mailbox through a returned thread", () => {
    const gmail = new FakeGmail();
    gmail.addThread(plainUtf8);
    const thread = unwrap(gmail.getThread(plainUtf8.id, { format: 'full' })).thread;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately mutates a readonly result, as a careless caller might
    (thread.messages?.[0]?.labelIds as string[] | undefined)?.push('STARRED');
    expect(gmail.threadLabels(plainUtf8.id)[0]).not.toContain('STARRED');
  });
});

describe('FakeGmail labels', () => {
  it('lists system and user labels in one response', () => {
    const gmail = new FakeGmail();
    gmail.seedLabel('Finance');
    const labels = unwrap(gmail.listLabels()).labels;
    expect(labels.find((l) => l.id === 'INBOX')).toEqual({
      id: 'INBOX',
      name: 'INBOX',
      type: 'system',
    });
    expect(labels.find((l) => l.name === 'Finance')).toEqual({
      id: 'Label_1',
      name: 'Finance',
      type: 'user',
    });
  });

  it('creates exactly the name given, without parents', () => {
    const gmail = new FakeGmail();
    expect(unwrap(gmail.createLabel('Finance/Bill')).label).toEqual({
      id: 'Label_1',
      name: 'Finance/Bill',
      type: 'user',
    });
    const names = unwrap(gmail.listLabels())
      .labels.filter((l) => l.type === 'user')
      .map((l) => l.name);
    expect(names).toEqual(['Finance/Bill']);
  });

  it.each(['finance/bill', 'FINANCE / BILL', 'Finance/ Bill'])(
    'returns label_exists for %j',
    (name) => {
      const gmail = new FakeGmail();
      gmail.seedLabel('Finance/Bill');
      expect(gmail.createLabel(name)).toEqual({
        ok: false,
        kind: 'label_exists',
        message: 'Label name exists or conflicts',
      });
    },
  );

  it.each([
    'inbox',
    'Inbox',
    'SPAM',
    'Trash',
    'sent',
    'Drafts',
    'starred',
    'Important',
    'unread',
    'Chats',
  ])('returns invalid_label_name for %j', (name) => {
    expect(new FakeGmail().createLabel(name)).toEqual({
      ok: false,
      kind: 'invalid_label_name',
      message: 'Invalid label name',
    });
  });

  it.each(['Social', 'Inbox/X'])('allows %j', (name) => {
    expect(new FakeGmail().createLabel(name).ok).toBe(true);
  });
});

describe('FakeGmail modifyThread', () => {
  it('applies to every message, and SPAM also removes INBOX', () => {
    const gmail = new FakeGmail();
    const first = gmail.deliver();
    gmail.deliver({ threadId: first.threadId, labelIds: ['SENT'] });
    unwrap(gmail.modifyThread(first.threadId, { addLabelIds: ['SPAM'], removeLabelIds: [] }));
    expect(gmail.threadLabels(first.threadId)).toEqual([
      ['UNREAD', 'SPAM'],
      ['SENT', 'SPAM'],
    ]);
  });

  it('writes only label records, one per label change, never messagesAdded', () => {
    const gmail = new FakeGmail({ bareRecords: false });
    const label = gmail.seedLabel('Finance');
    const { threadId } = gmail.deliver();
    const start = gmail.historyId;
    unwrap(gmail.modifyThread(threadId, { addLabelIds: [label.id], removeLabelIds: ['INBOX'] }));
    const records = changeRecords(gmail, start);
    expect(records.map((r) => Object.keys(r).sort())).toEqual([
      ['id', 'labelsAdded', 'messages'],
      ['id', 'labelsRemoved', 'messages'],
    ]);
    expect(records[1]?.labelsRemoved?.[0]?.message.labelIds).toEqual(['UNREAD', label.id]);
  });

  it('writes no record for a repeat that changes nothing', () => {
    const gmail = new FakeGmail();
    const { threadId } = gmail.deliver();
    const change = { addLabelIds: ['TRASH'], removeLabelIds: [] };
    unwrap(gmail.modifyThread(threadId, change));
    const historyId = gmail.historyId;
    const count = gmail.history.length;
    expect(gmail.modifyThread(threadId, change)).toEqual({ ok: true });
    expect(gmail.historyId).toBe(historyId);
    expect(gmail.history).toHaveLength(count);
  });

  it('returns invalid_label for a name or an unknown ID, and changes nothing', () => {
    const gmail = new FakeGmail();
    const { threadId } = gmail.deliver();
    const count = gmail.history.length;
    expect(
      gmail.modifyThread(threadId, { addLabelIds: ['Finance'], removeLabelIds: ['INBOX'] }),
    ).toEqual({
      ok: false,
      kind: 'invalid_label',
      message: 'Invalid label: Finance',
    });
    expect(gmail.modifyThread(threadId, { addLabelIds: ['Label_99'], removeLabelIds: [] })).toEqual(
      {
        ok: false,
        kind: 'invalid_label',
        message: 'labelId not found',
      },
    );
    expect(gmail.threadLabels(threadId)).toEqual([['INBOX', 'UNREAD']]);
    expect(gmail.history).toHaveLength(count);
  });

  it('returns not_found for an unknown thread', () => {
    expect(
      new FakeGmail().modifyThread('gone', { addLabelIds: [], removeLabelIds: ['INBOX'] }),
    ).toEqual({
      ok: false,
      kind: 'not_found',
    });
  });

  it('trashes a thread like adding TRASH', () => {
    const gmail = new FakeGmail();
    const { threadId } = gmail.deliver();
    expect(gmail.trashThread(threadId)).toEqual({ ok: true });
    expect(gmail.threadLabels(threadId)).toEqual([['UNREAD', 'TRASH']]);
    expect(gmail.trashThread('gone')).toEqual({ ok: false, kind: 'not_found' });
  });
});

describe('FakeGmail quota, latency and failures', () => {
  it('tallies quota units per call', () => {
    const gmail = new FakeGmail();
    const { threadId } = gmail.deliver();
    gmail.setSearchMatcher(() => false);
    gmail.getProfile();
    gmail.listLabels();
    gmail.listHistory({ startHistoryId: '1000', historyTypes: BOTH_TYPES });
    gmail.searchThreadIds({ q: 'x', includeSpamTrash: true });
    gmail.getThread(threadId, { format: 'minimal' });
    gmail.createLabel('A');
    gmail.modifyThread(threadId, { addLabelIds: [], removeLabelIds: ['UNREAD'] });
    gmail.trashThread(threadId);
    expect(gmail.unitsUsed).toBe(1 + 1 + 2 + 10 + 40 + 5 + 10 + 20);
  });

  it('advances the clock on every call', () => {
    const clock = new FakeClock({ now: 0 });
    const gmail = new FakeGmail({ clock, latencyMs: 150 });
    gmail.getProfile();
    gmail.listLabels();
    expect(clock.now()).toBe(300);
  });

  it('returns rate_limited only for the injected thread, then recovers', () => {
    const gmail = new FakeGmail();
    const a = gmail.deliver();
    const b = gmail.deliver();
    gmail.failNext('getThread', FakeGmail.rateLimited(), { threadId: b.threadId });
    expect(gmail.getThread(a.threadId, { format: 'minimal' }).ok).toBe(true);
    expect(gmail.getThread(b.threadId, { format: 'minimal' })).toEqual({
      ok: false,
      kind: 'rate_limited',
      message: RATE_LIMIT_MESSAGE,
    });
    expect(gmail.getThread(b.threadId, { format: 'minimal' }).ok).toBe(true);
  });

  it('uses injected failures in order, including a thrown error', () => {
    const gmail = new FakeGmail();
    gmail.failNext('getProfile', fail('rate_limited', { message: 'first' }), { times: 2 });
    gmail.failNext('getProfile', new Error('Unexpected Gmail error'));
    expect(gmail.getProfile()).toMatchObject({ kind: 'rate_limited' });
    expect(gmail.getProfile()).toMatchObject({ kind: 'rate_limited' });
    expect(() => gmail.getProfile()).toThrow('Unexpected Gmail error');
    expect(unwrap(gmail.getProfile())).toEqual({
      ok: true,
      emailAddress: 'owner@example.com',
      historyId: '1000',
    });
  });

  it('returns scope for every call while gmail.modify is revoked, and records calls', () => {
    const scopes = new FakeScopes();
    const gmail = new FakeGmail({ scopes });
    const { threadId } = gmail.deliver();
    scopes.revoke('https://www.googleapis.com/auth/gmail.modify');
    const scope = { ok: false, kind: 'scope', message: SCOPE_ERROR_MESSAGE };
    expect(gmail.getProfile()).toEqual(scope);
    expect(gmail.getThread(threadId, { format: 'full' })).toEqual(scope);
    expect(gmail.modifyThread(threadId, { addLabelIds: ['SPAM'], removeLabelIds: [] })).toEqual(
      scope,
    );
    expect(gmail.threadLabels(threadId)).toEqual([['INBOX', 'UNREAD']]);
    expect(gmail.calls.map((c) => c.method)).toEqual(['getProfile', 'getThread', 'modifyThread']);
  });
});
