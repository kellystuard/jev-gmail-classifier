/**
 * The `state.position` codec (Solution Design §6.3, §7.3; epic #9 decision 8):
 * the Gmail history position ingest reads from, and the time it was saved.
 *
 * Stored as `{"v": 1, "historyId": "<digits>", "savedAt": <epoch ms>}`.
 * `install` (E7) writes the first one with this codec, and ingest moves it.
 * A value that can't be decoded throws `StateError` and is never reset.
 */
import { z } from 'zod';

import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';

/** The Script Properties key. */
export const POSITION_KEY = 'state.position';

export type Position = {
  /** A Gmail `historyId`: a uint64 as 1 to 20 decimal digits. */
  readonly historyId: string;
  /** Epoch ms of the save, taken after the last `history.list` call. */
  readonly savedAt: number;
};

/** A uint64 as Gmail sends it: 1 to 20 decimal digits. */
const HISTORY_ID = /^\d{1,20}$/;

/**
 * `decode(POSITION_KEY, raw)` throws `StateError` `version` for an unknown
 * `v`, and `schema` for a missing `v` or a bad shape. `encode` writes `v` first.
 */
export const positionCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    historyId: z.string().regex(HISTORY_ID, 'Expected 1 to 20 decimal digits'),
    savedAt: z.number().int().nonnegative(),
  }),
});

/** Decodes a `state.position` value. The caller handles an absent key. Throws `StateError`. */
export function decodePosition(raw: unknown): Position {
  return positionCodec.decode(POSITION_KEY, raw);
}

/** The JSON to store under `state.position`. */
export function encodePosition(position: Position): JsonValue {
  return positionCodec.encode(position);
}
