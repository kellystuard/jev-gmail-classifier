/**
 * The `Jev/Error` label IDs the classifier has used (Solution Design §6.3,
 * §7.3; epic #9 decision 11): the `state.jevErrorLabel` codec, the pure list
 * update, and the pure thread check. `src/app/jev-error-label-store.ts` reads
 * and writes the key over `StatePort`.
 *
 * Stored as `{"v": 1, "ids": ["Label_12", "Label_40"]}`: every label ID used
 * for `Jev/Error`, **newest last**, at most `JEV_ERROR_LABEL_MAX_IDS`. It keeps
 * more than one because a user who deletes the label gets `labelRemoved`
 * records that carry the **old** ID, and E6 may already have created a new
 * `Jev/Error` with a new one (spike 20, finding 8). An absent key means no ID
 * is known yet. A value that can't be decoded throws `StateError` and is never
 * reset.
 */
import { z } from 'zod';

import { StateError } from './errors.ts';
import type { GmailThread } from './gmail-types.ts';
import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';

/** The Script Properties key. */
export const JEV_ERROR_LABEL_KEY = 'state.jevErrorLabel';

/** The most IDs kept. The oldest is dropped past this. */
export const JEV_ERROR_LABEL_MAX_IDS = 10;

/** The longest label ID stored, so the value stays under 3 KB (ES §7). */
export const JEV_ERROR_LABEL_MAX_ID_LENGTH = 200;

const labelIdSchema = z.string().min(1).max(JEV_ERROR_LABEL_MAX_ID_LENGTH);

/**
 * `decode(JEV_ERROR_LABEL_KEY, raw)` throws `StateError` `version` for an
 * unknown `v`, and `schema` for a missing `v` or a bad shape (a non-string or
 * empty ID, an ID over 200 characters, more than 10 IDs).
 */
export const jevErrorLabelCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    ids: z.array(labelIdSchema).max(JEV_ERROR_LABEL_MAX_IDS),
  }),
});

/** Decodes a `state.jevErrorLabel` value into its IDs, oldest first. The caller handles an absent key. Throws `StateError`. */
export function decodeJevErrorLabelIds(raw: unknown): readonly string[] {
  return jevErrorLabelCodec.decode(JEV_ERROR_LABEL_KEY, raw).ids;
}

/** The JSON to store under `state.jevErrorLabel`. */
export function encodeJevErrorLabelIds(ids: readonly string[]): JsonValue {
  return jevErrorLabelCodec.encode({ ids: [...ids] });
}

/**
 * The list with `id` last. A new ID goes last; an ID already in the list moves
 * to the end; when the list would hold more than `JEV_ERROR_LABEL_MAX_IDS`, the
 * oldest (first) is dropped. Pure: `ids` isn't changed. Throws `StateError`
 * `schema` for an empty ID or one over 200 characters, as the codec would.
 */
export function addJevErrorLabelId(ids: readonly string[], id: string): readonly string[] {
  if (!labelIdSchema.safeParse(id).success) {
    throw new StateError(
      `A Jev/Error label ID must be 1 to ${String(JEV_ERROR_LABEL_MAX_ID_LENGTH)} characters`,
      { key: JEV_ERROR_LABEL_KEY, reason: 'schema' },
    );
  }
  return [...ids.filter((known) => known !== id), id].slice(-JEV_ERROR_LABEL_MAX_IDS);
}

/**
 * True when **any** message in the thread has **any** of `ids` in its
 * `labelIds`, including messages in Spam or Trash. False when `ids` is empty,
 * the thread has no messages, or a message has no `labelIds`. `screenChunk`
 * (#71) uses it to skip a `Jev/Error` thread at its first read.
 */
export function hasJevErrorLabel(thread: GmailThread, ids: readonly string[]): boolean {
  if (ids.length === 0) {
    return false;
  }
  return (thread.messages ?? []).some((message) =>
    (message.labelIds ?? []).some((label) => ids.includes(label)),
  );
}
