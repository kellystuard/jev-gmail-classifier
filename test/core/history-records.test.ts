import { describe, expect, it } from 'vitest';

import type { GmailHistoryRecord } from '../../src/core/gmail-types.ts';
import { messageAddedThreadIds } from '../../src/core/history-records.ts';

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
