import { describe, expect, it } from 'vitest';
import type { MoveDestination } from '../../src/config/schema.ts';
import { InvalidArgumentError } from '../../src/core/errors.ts';
import { buildThreadChange } from '../../src/core/thread-change.ts';

const labelIds = ['L1', 'L2'] as const;
const receipts: MoveDestination = { kind: 'label', label: 'Receipts' };

type Row = readonly [
  string,
  MoveDestination | undefined,
  string | undefined,
  readonly string[],
  readonly string[],
];

const rows: readonly Row[] = [
  ['none', undefined, undefined, ['L1', 'L2'], []],
  ['archive', { kind: 'archive' }, undefined, ['L1', 'L2'], ['INBOX']],
  ['label', receipts, 'L3', ['L1', 'L2', 'L3'], ['INBOX']],
  ['spam', { kind: 'spam' }, undefined, ['L1', 'L2', 'SPAM'], ['INBOX']],
  ['trash', { kind: 'trash' }, undefined, ['L1', 'L2', 'TRASH'], []],
];

describe('buildThreadChange', () => {
  it.each(rows)('move %s', (_name, move, moveLabelId, adds, removes) => {
    expect(buildThreadChange(labelIds, move, moveLabelId)).toEqual({
      addLabelIds: adds,
      removeLabelIds: removes,
    });
  });

  it.each(rows)('move %s removes nothing but INBOX', (_name, move, moveLabelId) => {
    const { removeLabelIds } = buildThreadChange(labelIds, move, moveLabelId);
    expect([[], ['INBOX']]).toContainEqual(removeLabelIds);
  });

  it.each([
    ['archive', { kind: 'archive' }, [], ['INBOX']],
    ['spam', { kind: 'spam' }, ['SPAM'], ['INBOX']],
    ['trash', { kind: 'trash' }, ['TRASH'], []],
  ] as const)('no labels, move %s', (_name, move, adds, removes) => {
    expect(buildThreadChange([], move)).toEqual({ addLabelIds: adds, removeLabelIds: removes });
  });

  it('no labels and no move is an empty change', () => {
    expect(buildThreadChange([], undefined)).toEqual({ addLabelIds: [], removeLabelIds: [] });
  });

  it.each([
    ['a repeated label ID', ['L1', 'L1', 'L2'], undefined, undefined],
    ['a label move whose label also fires', ['L1', 'L2'], receipts, 'L1'],
  ] as const)('de-duplicates %s, keeping first order', (_name, ids, move, moveLabelId) => {
    expect(buildThreadChange(ids, move, moveLabelId).addLabelIds).toEqual(['L1', 'L2']);
  });

  it('does not mutate its input', () => {
    const ids = ['L1', 'L1'];
    buildThreadChange(ids, { kind: 'spam' });
    expect(ids).toEqual(['L1', 'L1']);
  });

  it.each([
    ['a label move without moveLabelId', receipts, undefined],
    ['archive with a moveLabelId', { kind: 'archive' }, 'L3'],
    ['no move with a moveLabelId', undefined, 'L3'],
  ] as const)('throws InvalidArgumentError for %s', (_name, move, moveLabelId) => {
    expect(() => buildThreadChange(labelIds, move, moveLabelId)).toThrow(InvalidArgumentError);
  });
});
