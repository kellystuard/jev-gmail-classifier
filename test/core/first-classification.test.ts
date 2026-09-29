import { describe, expect, it } from 'vitest';

import { isFirstClassification } from '../../src/core/first-classification.ts';
import type { GmailMessage } from '../../src/core/gmail-types.ts';

type Msg = Pick<GmailMessage, 'labelIds' | 'internalDate'>;

const SAVED_AT = 1_000_000;
const OLD = String(SAVED_AT - 5_000);
const NEW = String(SAVED_AT + 5_000);

// `exactOptionalPropertyTypes` is on, so an absent date is an omitted key.
const withDate = (labelIds: readonly string[], internalDate: string | undefined): Msg =>
  internalDate === undefined ? { labelIds } : { labelIds, internalDate };
const received = (internalDate: string | undefined): Msg =>
  withDate(['INBOX', 'UNREAD'], internalDate);
const draft = (internalDate: string | undefined): Msg => withDate(['DRAFT'], internalDate);

describe('isFirstClassification', () => {
  it.each<[string, readonly Msg[], number, boolean]>([
    [
      'a new thread: every message after the position',
      [received(NEW), received(String(SAVED_AT + 9))],
      SAVED_AT,
      true,
    ],
    ['a single new message', [received(NEW)], SAVED_AT, true],
    [
      'a replied-to old thread: an old message plus a new reply',
      [received(OLD), received(NEW)],
      SAVED_AT,
      false,
    ],
    [
      'a pre-install thread: every message before the position',
      [received(OLD), received(String(SAVED_AT - 1))],
      SAVED_AT,
      false,
    ],
    ['a newer draft on an old thread', [received(OLD), draft(NEW)], SAVED_AT, false],
    [
      'an old draft plus a newer sent message',
      [draft(OLD), { labelIds: ['SENT'], internalDate: NEW }],
      SAVED_AT,
      true,
    ],
    [
      'the boundary: internalDate equal to the position',
      [received(String(SAVED_AT))],
      SAVED_AT,
      true,
    ],
    ['one ms before the position', [received(String(SAVED_AT - 1))], SAVED_AT, false],
    [
      'a missing internalDate on a non-draft message',
      [received(NEW), received(undefined)],
      SAVED_AT,
      false,
    ],
    ['an empty internalDate', [received('')], SAVED_AT, false],
    ['a non-numeric internalDate', [received('abc')], SAVED_AT, false],
    ['a negative internalDate', [received('-5')], SAVED_AT, false],
    ['a fractional internalDate', [received('1.5')], SAVED_AT, false],
    ['an internalDate beyond the safe integers', [received('9'.repeat(30))], SAVED_AT, false],
    [
      'a draft with a missing internalDate is ignored',
      [received(NEW), draft(undefined)],
      SAVED_AT,
      true,
    ],
    ['no messages', [], SAVED_AT, false],
    ['only drafts', [draft(NEW), draft(NEW)], SAVED_AT, false],
    [
      'an old message now in TRASH plus a new message',
      [{ labelIds: ['TRASH'], internalDate: OLD }, received(NEW)],
      SAVED_AT,
      false,
    ],
    [
      'an old message now in SPAM plus a new message',
      [{ labelIds: ['SPAM'], internalDate: OLD }, received(NEW)],
      SAVED_AT,
      false,
    ],
    [
      'a new message in TRASH still counts',
      [{ labelIds: ['TRASH'], internalDate: NEW }],
      SAVED_AT,
      true,
    ],
    [
      'an imported message with an old internalDate',
      [received(NEW), { labelIds: ['INBOX'], internalDate: String(SAVED_AT - 86_400_000) }],
      SAVED_AT,
      false,
    ],
    ['a message with no labelIds counts', [{ internalDate: NEW }], SAVED_AT, true],
    [
      'an old message with no labelIds counts as old',
      [{ internalDate: OLD }, received(NEW)],
      SAVED_AT,
      false,
    ],
    ['compares numbers, not strings ("999" vs 1000)', [received('999')], 1000, false],
    ['compares numbers, not strings ("1000" vs 999)', [received('1000')], 999, true],
    ['positionSavedAt is NaN', [received(NEW)], Number.NaN, false],
  ])('%s', (_name, messages, positionSavedAt, expected) => {
    expect(isFirstClassification(messages, positionSavedAt)).toBe(expected);
  });

  it('accepts full GmailMessage objects', () => {
    const message: GmailMessage = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      internalDate: NEW,
    };
    expect(isFirstClassification([message], SAVED_AT)).toBe(true);
  });
});
