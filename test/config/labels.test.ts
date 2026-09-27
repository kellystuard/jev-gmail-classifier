import { describe, expect, it } from 'vitest';

import { labelKey, labelNameProblem, RESERVED_LABEL_NAMES } from '../../src/config/labels.ts';

describe('RESERVED_LABEL_NAMES', () => {
  it('lists the system labels Gmail refuses to create (spikes/25-nested-labels.md)', () => {
    expect([...RESERVED_LABEL_NAMES].sort()).toEqual(
      [
        'Chats',
        'Drafts',
        'Important',
        'Inbox',
        'Sent',
        'Spam',
        'Starred',
        'Trash',
        'Unread',
      ].sort(),
    );
  });

  it('does not reserve Social', () => {
    expect(RESERVED_LABEL_NAMES.map((name) => name.toLowerCase())).not.toContain('social');
  });
});

describe('labelKey', () => {
  it.each([
    ['Finance/Bill', 'finance/bill'],
    ['finance/bill', 'finance/bill'],
    ['Finance / Bill', 'finance/bill'],
    ['Finance/ Bill', 'finance/bill'],
    ['Finance /Bill', 'finance/bill'],
    ['A  /  B / C', 'a/b/c'],
    ['Approval Required', 'approval required'],
    ['INBOX', 'inbox'],
  ])('%j -> %j', (name, key) => {
    expect(labelKey(name)).toBe(key);
  });
});

describe('labelNameProblem', () => {
  it.each(['Bill', 'Finance/Bill', 'Approval Required', 'Social', 'Work/Inbox', 'A/B/C', 'Jevons'])(
    'accepts %j',
    (name) => {
      expect(labelNameProblem(name)).toBeUndefined();
    },
  );

  it.each(['', 'A/', '/A', 'A//B', 'A / B', 'A/ B', ' A', 'A ', '/'])(
    'rejects %j for an empty or padded part',
    (name) => {
      expect(labelNameProblem(name)).toBe(
        'each part between / must be non-empty, with no spaces at either end',
      );
    },
  );
});
