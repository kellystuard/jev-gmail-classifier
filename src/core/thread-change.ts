/**
 * The one `threads.modify` change for a thread's outcome (Solution Design §6.5,
 * "Apply"; `spikes/26-moves.md`). Pure: label IDs in, label IDs out.
 *
 * | Move            | Adds                           | Removes |
 * |-----------------|--------------------------------|---------|
 * | none            | every firing label             | —       |
 * | `archive`       | every firing label             | `INBOX` |
 * | `label:<name>`  | every firing label + the label | `INBOX` |
 * | `spam`          | every firing label + `SPAM`    | `INBOX` |
 * | `trash`         | every firing label + `TRASH`   | —       |
 *
 * Labels are never removed: `removeLabelIds` only ever holds `INBOX`.
 */
import type { MoveDestination } from '../config/schema.ts';
import { assertNever } from './assert-never.ts';
import { InvalidArgumentError } from './errors.ts';

/** Same shape as GmailPort's ThreadLabelChange (core can't import ports/). */
export type LabelIdChange = {
  readonly addLabelIds: readonly string[];
  readonly removeLabelIds: readonly string[];
};

const INBOX = 'INBOX';

/**
 * Builds the change: `labelIds` (the firing labels' IDs), then the move's.
 * `addLabelIds` is de-duplicated, keeping the first occurrence's order.
 *
 * Throws InvalidArgumentError when a `label` move has no moveLabelId, or another move has one.
 */
export function buildThreadChange(
  labelIds: readonly string[],
  move: MoveDestination | undefined,
  moveLabelId?: string,
): LabelIdChange {
  const isLabelMove = move?.kind === 'label';
  if (isLabelMove && moveLabelId === undefined) {
    throw new InvalidArgumentError('A label move needs the label ID', {
      argument: 'moveLabelId',
      reason: 'missing for a label move',
    });
  }
  if (!isLabelMove && moveLabelId !== undefined) {
    throw new InvalidArgumentError('Only a label move takes a label ID', {
      argument: 'moveLabelId',
      reason: 'given for a move that is not a label move',
    });
  }

  const { add, remove } = moveChange(move, moveLabelId);
  return { addLabelIds: [...new Set([...labelIds, ...add])], removeLabelIds: remove };
}

function moveChange(
  move: MoveDestination | undefined,
  moveLabelId: string | undefined,
): { add: readonly string[]; remove: readonly string[] } {
  if (move === undefined) {
    return { add: [], remove: [] };
  }
  switch (move.kind) {
    case 'archive':
      return { add: [], remove: [INBOX] };
    case 'label':
      return { add: moveLabelId === undefined ? [] : [moveLabelId], remove: [INBOX] };
    case 'spam':
      return { add: ['SPAM'], remove: [INBOX] };
    case 'trash':
      return { add: ['TRASH'], remove: [] };
    default:
      return assertNever(move);
  }
}
