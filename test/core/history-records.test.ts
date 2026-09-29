import { describe, expect, it } from 'vitest';

import type { GmailHistoryRecord } from '../../src/core/gmail-types.ts';
import { jevErrorRemovalThreadIds, messageAddedThreadIds } from '../../src/core/history-records.ts';

/** A `messagesAdded` entry for `threadId`. `labelIds` undefined leaves the field out. */
function added(threadId: string, labelIds?: readonly string[]) {
  return {
    message: {
      id: `m-${threadId}-${String(labelIds?.length ?? 0)}`,
      threadId,
      ...(labelIds === undefined ? {} : { labelIds }),
    },
  };
}

function record(entries: ReturnType<typeof added>[]): GmailHistoryRecord {
  return {
    id: '100',
    messages: entries.map((e) => ({ id: e.message.id, threadId: e.message.threadId })),
    messagesAdded: entries,
  };
}

describe('messageAddedThreadIds', () => {
  it.each<[string, GmailHistoryRecord, readonly string[], number]>([
    ['a bare record', { id: '100', messages: [{ id: 'm1', threadId: 't1' }] }, [], 0],
    ['a record with only an id', { id: '100' }, [], 0],
    ['received mail in the inbox', record([added('t1', ['INBOX', 'UNREAD'])]), ['t1'], 0],
    ['a draft', record([added('t1', ['DRAFT'])]), [], 1],
    ['mail that arrived in Spam', record([added('t1', ['SPAM', 'UNREAD'])]), [], 1],
    ['mail that arrived in Trash', record([added('t1', ['TRASH'])]), [], 1],
    ['sent mail (SENT only)', record([added('t1', ['SENT'])]), ['t1'], 0],
    ['mail sent to yourself', record([added('t1', ['SENT', 'INBOX', 'UNREAD'])]), ['t1'], 0],
    ['filter-archived mail (no INBOX)', record([added('t1', ['Label_7', 'UNREAD'])]), ['t1'], 0],
    ['a category', record([added('t1', ['INBOX', 'CATEGORY_PROMOTIONS'])]), ['t1'], 0],
    ['missing labelIds', record([added('t1')]), ['t1'], 0],
    ['empty labelIds', record([added('t1', [])]), ['t1'], 0],
    [
      'two entries for one thread',
      record([added('t1', ['INBOX']), added('t1', ['SENT'])]),
      ['t1'],
      0,
    ],
    [
      'several threads, in order of first appearance',
      record([added('t2', ['INBOX']), added('t1', ['INBOX']), added('t2', ['SENT'])]),
      ['t2', 't1'],
      0,
    ],
    [
      'kept and ignored entries mixed',
      record([
        added('t1', ['DRAFT']),
        added('t2', ['INBOX']),
        added('t3', ['SPAM']),
        added('t1', ['SENT']),
      ]),
      ['t2', 't1'],
      2,
    ],
    [
      'a record with only labelsRemoved',
      {
        id: '100',
        labelsRemoved: [
          { labelIds: ['Label_1'], message: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] } },
        ],
      },
      [],
      0,
    ],
    [
      'a record with only labelsAdded',
      {
        id: '100',
        labelsAdded: [
          { labelIds: ['SPAM'], message: { id: 'm1', threadId: 't1', labelIds: ['SPAM'] } },
        ],
      },
      [],
      0,
    ],
  ])('%s', (_name, input, threadIds, ignored) => {
    expect(messageAddedThreadIds(input)).toEqual({ threadIds, ignored });
  });
});

/** A `labelsRemoved` entry: `removed` are the IDs removed, `left` the message's labels right after. */
function removal(
  threadId: string,
  removed: readonly string[],
  left: readonly string[],
  messageId = `m-${threadId}`,
) {
  return { labelIds: removed, message: { id: messageId, threadId, labelIds: left } };
}

function removals(...entries: ReturnType<typeof removal>[]): GmailHistoryRecord {
  return { id: '200', labelsRemoved: entries };
}

describe('jevErrorRemovalThreadIds', () => {
  const known = ['Label_12'];
  const older = ['Label_5', 'Label_12'];

  it.each<[string, GmailHistoryRecord, readonly string[], readonly string[]]>([
    ['a matching entry', removals(removal('t1', ['Label_12'], ['INBOX'])), known, ['t1']],
    [
      'a match among other removed labels',
      removals(removal('t1', ['UNREAD', 'Label_12'], ['INBOX'])),
      known,
      ['t1'],
    ],
    ["another label's removal", removals(removal('t1', ['Label_7'], ['INBOX'])), known, []],
    [
      'UNREAD when the user opens a thread',
      removals(removal('t1', ['UNREAD'], ['INBOX'])),
      known,
      [],
    ],
    [
      'a match whose message.labelIds include TRASH',
      removals(removal('t1', ['Label_12'], ['TRASH'])),
      known,
      [],
    ],
    [
      'a match whose message.labelIds include SPAM',
      removals(removal('t1', ['Label_12'], ['SPAM', 'UNREAD'])),
      known,
      [],
    ],
    [
      'three entries of one thread give one ID',
      removals(
        removal('t1', ['Label_12'], ['INBOX'], 'm1'),
        removal('t1', ['Label_12'], ['INBOX'], 'm2'),
        removal('t1', ['Label_12'], ['SENT'], 'm3'),
      ),
      known,
      ['t1'],
    ],
    [
      'one entry in Trash and another not keeps the thread',
      removals(
        removal('t1', ['Label_12'], ['TRASH'], 'm1'),
        removal('t1', ['Label_12'], ['INBOX'], 'm2'),
      ),
      known,
      ['t1'],
    ],
    [
      'the trash record: INBOX removed, the Jev/Error ID left on the message',
      removals(removal('t1', ['INBOX'], ['TRASH', 'Label_12'])),
      known,
      [],
    ],
    [
      'the INBOX removal of a labelled thread outside Trash',
      removals(removal('t1', ['INBOX'], ['Label_12'])),
      known,
      [],
    ],
    ['an older known ID', removals(removal('t1', ['Label_5'], ['INBOX'])), older, ['t1']],
    ['an unknown older ID', removals(removal('t1', ['Label_5'], ['INBOX'])), known, []],
    ['no known IDs', removals(removal('t1', ['Label_12'], ['INBOX'])), [], []],
    [
      'a record with no change arrays',
      { id: '200', messages: [{ id: 'm1', threadId: 't1' }] },
      known,
      [],
    ],
    ['a record with only an id', { id: '200' }, known, []],
    [
      'labelsAdded with the Jev/Error ID',
      {
        id: '200',
        labelsAdded: [
          { labelIds: ['Label_12'], message: { id: 'm1', threadId: 't1', labelIds: ['Label_12'] } },
        ],
      },
      known,
      [],
    ],
    ['a messageAdded record', record([added('t1', ['INBOX', 'Label_12'])]), known, []],
    [
      'several threads, in order of first appearance',
      removals(
        removal('t2', ['Label_12'], ['INBOX']),
        removal('t1', ['Label_12'], ['INBOX']),
        removal('t2', ['Label_12'], ['SENT'], 'other'),
        removal('t3', ['Label_12'], ['TRASH']),
      ),
      known,
      ['t2', 't1'],
    ],
    [
      'missing message.labelIds',
      {
        id: '200',
        labelsRemoved: [{ labelIds: ['Label_12'], message: { id: 'm1', threadId: 't1' } }],
      },
      known,
      ['t1'],
    ],
  ])('%s', (_name, input, ids, expected) => {
    expect(jevErrorRemovalThreadIds(input, ids)).toEqual(expected);
  });
});
