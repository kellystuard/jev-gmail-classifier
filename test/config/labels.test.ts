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
    ['Approval Required', 'approval/required'],
    ['INBOX', 'inbox'],
    ['Q8_A', 'q8_a'],
    ['Q9.A', 'q9.a'],
    ['  Q7  ', 'q7'],
    ['Q A\tB', 'q/a/b'],
  ])('%j -> %j', (name, key) => {
    expect(labelKey(name)).toBe(key);
  });

  // Pairs from the second probe (#329); the letter-digit is its case number.
  it.each([
    ['7a', 'Q4/A', 'Q4-A'],
    ['7b', 'Q5/A', 'Q5 A'],
    ['7c', 'Q6 A', 'Q6/A'],
    ['7d', 'Q7-A', 'Q7/A'],
    ['7g', 'Q10-A', 'Q10 A'],
    ['7h', 'Q11/A', 'q11/a'],
    ['6b', 'Q2/A /B', 'Q2/A/ B'],
    ['6c', 'Q3//X', 'Q3/ X'],
    ['6d', 'Q12 /A', 'Q12/ A'],
    ['6e', 'Q13/ A', 'Q13 /A'],
    ['3b', 'P6/A', 'P6/A '],
    ['5b', 'P9b/A', ' P9b/A'],
    ['5c', 'P9c/A', 'P9c/A  '],
  ])('same name, case %s: %j and %j', (_case, one, other) => {
    expect(labelKey(one)).toBe(labelKey(other));
  });

  it.each([
    ['1', 'P1 /A', 'P1/A'],
    ['2a', 'P2 / A', 'P2/A'],
    ['2b', 'P3 / A', 'P3/ A'],
    ['2c', 'P4/ A', 'P4 / A'],
    ['3a', 'P5/ A', 'P5/A'],
    ['4b', 'P8/A', 'P8 /A'],
    ['5a', 'P9a/A', 'P9a/  A'],
    ['5d', 'P9d/A', 'P9d/\tA'],
    ['6a', 'Q1/A/B', 'Q1/A/ B'],
    ['7e', 'Q8_A', 'Q8/A'],
    ['7f', 'Q9.A', 'Q9/A'],
  ])('different names, case %s: %j and %j', (_case, one, other) => {
    expect(labelKey(one)).not.toBe(labelKey(other));
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
