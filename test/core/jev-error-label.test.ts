import { describe, expect, it } from 'vitest';

import { StateError } from '../../src/core/errors.ts';
import type { GmailThread } from '../../src/core/gmail-types.ts';
import {
  addJevErrorLabelId,
  decodeJevErrorLabelIds,
  encodeJevErrorLabelIds,
  hasJevErrorLabel,
  JEV_ERROR_LABEL_KEY,
  JEV_ERROR_LABEL_MAX_ID_LENGTH,
  JEV_ERROR_LABEL_MAX_IDS,
} from '../../src/core/jev-error-label.ts';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function idsOf(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Label_${String(i + 1)}`);
}

describe('the state.jevErrorLabel codec', () => {
  it('uses the decided key', () => {
    expect(JEV_ERROR_LABEL_KEY).toBe('state.jevErrorLabel');
  });

  it.each<[string, readonly string[]]>([
    ['no IDs', []],
    ['one ID', ['Label_12']],
    ['two IDs, newest last', ['Label_12', 'Label_40']],
    ['the most IDs', idsOf(JEV_ERROR_LABEL_MAX_IDS)],
    ['the longest ID', ['x'.repeat(JEV_ERROR_LABEL_MAX_ID_LENGTH)]],
  ])('round trips %s', (_name, ids) => {
    const stored = encodeJevErrorLabelIds(ids);
    expect(stored).toEqual({ v: 1, ids });
    expect(decodeJevErrorLabelIds(JSON.parse(JSON.stringify(stored)))).toEqual(ids);
  });

  it('writes v first', () => {
    expect(JSON.stringify(encodeJevErrorLabelIds(['Label_1']))).toBe('{"v":1,"ids":["Label_1"]}');
  });

  it('throws StateError version for a newer v', () => {
    const error = thrown(() => decodeJevErrorLabelIds({ v: 2, ids: [] }));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: JEV_ERROR_LABEL_KEY, reason: 'version' });
  });

  it.each<[string, unknown]>([
    ['no v', { ids: [] }],
    ['not an object', ['Label_1']],
    ['a non-string ID', { v: 1, ids: [12] }],
    ['an empty ID', { v: 1, ids: [''] }],
    ['an ID over 200 characters', { v: 1, ids: ['x'.repeat(JEV_ERROR_LABEL_MAX_ID_LENGTH + 1)] }],
    ['11 IDs', { v: 1, ids: idsOf(JEV_ERROR_LABEL_MAX_IDS + 1) }],
    ['no ids field', { v: 1 }],
    ['an extra field', { v: 1, ids: [], extra: true }],
  ])('throws StateError schema for %s', (_name, raw) => {
    const error = thrown(() => decodeJevErrorLabelIds(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: JEV_ERROR_LABEL_KEY, reason: 'schema' });
  });
});

describe('addJevErrorLabelId', () => {
  it.each<[string, readonly string[], string, readonly string[]]>([
    ['into an empty list', [], 'Label_1', ['Label_1']],
    ['a new ID goes last', ['Label_1', 'Label_2'], 'Label_3', ['Label_1', 'Label_2', 'Label_3']],
    [
      'an ID already last gives an equal list',
      ['Label_1', 'Label_2'],
      'Label_2',
      ['Label_1', 'Label_2'],
    ],
    [
      'an ID in the middle moves last',
      ['Label_1', 'Label_2', 'Label_3'],
      'Label_2',
      ['Label_1', 'Label_3', 'Label_2'],
    ],
    ['the first ID moves last', ['Label_1', 'Label_2'], 'Label_1', ['Label_2', 'Label_1']],
    ['the 11th ID drops the oldest, leaving 10', idsOf(10), 'Label_11', [...idsOf(11).slice(1)]],
    [
      'a known ID in a full list drops nothing',
      idsOf(10),
      'Label_1',
      [...idsOf(10).slice(1), 'Label_1'],
    ],
  ])('%s', (_name, ids, id, expected) => {
    const before = [...ids];
    expect(addJevErrorLabelId(ids, id)).toEqual(expected);
    expect(ids).toEqual(before);
  });

  it.each<[string, string]>([
    ['an empty ID', ''],
    ['an ID over 200 characters', 'x'.repeat(JEV_ERROR_LABEL_MAX_ID_LENGTH + 1)],
  ])('throws StateError schema for %s', (_name, id) => {
    const error = thrown(() => addJevErrorLabelId(['Label_1'], id));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: JEV_ERROR_LABEL_KEY, reason: 'schema' });
  });

  it('accepts an ID of exactly 200 characters', () => {
    const id = 'x'.repeat(JEV_ERROR_LABEL_MAX_ID_LENGTH);
    expect(addJevErrorLabelId([], id)).toEqual([id]);
  });
});

describe('hasJevErrorLabel', () => {
  function message(id: string, labelIds?: readonly string[]) {
    return { id, threadId: 't1', ...(labelIds === undefined ? {} : { labelIds }) };
  }
  const known = ['Label_12', 'Label_40'];

  it.each<[string, GmailThread, readonly string[], boolean]>([
    ['no known IDs', { id: 't1', messages: [message('m1', ['INBOX', 'Label_12'])] }, [], false],
    [
      'an older ID (not the newest) on one message of three',
      {
        id: 't1',
        messages: [message('m1', ['INBOX']), message('m2', ['Label_12']), message('m3', ['SENT'])],
      },
      known,
      true,
    ],
    [
      'the newest ID on the first message',
      { id: 't1', messages: [message('m1', ['Label_40']), message('m2', ['INBOX'])] },
      known,
      true,
    ],
    [
      'only on a message in TRASH',
      { id: 't1', messages: [message('m1', ['INBOX']), message('m2', ['TRASH', 'Label_40'])] },
      known,
      true,
    ],
    [
      'only on a message in SPAM',
      { id: 't1', messages: [message('m1', ['SPAM', 'Label_12'])] },
      known,
      true,
    ],
    [
      'no message carries one',
      { id: 't1', messages: [message('m1', ['INBOX', 'Label_7']), message('m2', ['SENT'])] },
      known,
      false,
    ],
    [
      'a message with no labelIds',
      { id: 't1', messages: [message('m1'), message('m2', [])] },
      known,
      false,
    ],
    ['a thread with no messages', { id: 't1', messages: [] }, known, false],
    ['a thread with no messages field', { id: 't1' }, known, false],
  ])('%s', (_name, thread, ids, expected) => {
    expect(hasJevErrorLabel(thread, ids)).toBe(expected);
  });
});
