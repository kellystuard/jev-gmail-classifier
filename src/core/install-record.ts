/**
 * The `state.installedAt` codec (Solution Design §6.7, §7.3; epic #13
 * decision 11): when `install` last ran.
 *
 * Stored as `{"v": 1, "at": <epoch ms>}`. Every `install` overwrites it.
 * Nothing reads it in v1: it is a record for support.
 */
import { z } from 'zod';

import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';

/** The Script Properties key. */
export const INSTALLED_AT_KEY = 'state.installedAt';

export type InstallRecord = {
  /** Epoch ms of the last `install`: a non-negative integer. */
  readonly at: number;
};

/**
 * `decode(INSTALLED_AT_KEY, raw)` throws `StateError` `version` for an unknown
 * `v`, and `schema` for a missing `v` or a bad shape. `encode` writes `v` first.
 */
export const installRecordCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    at: z.number().int().nonnegative(),
  }),
});

/** Decodes a `state.installedAt` value. The caller handles an absent key. Throws `StateError`. */
export function decodeInstallRecord(raw: unknown): InstallRecord {
  return installRecordCodec.decode(INSTALLED_AT_KEY, raw);
}

/** The JSON to store under `state.installedAt`. */
export function encodeInstallRecord(record: InstallRecord): JsonValue {
  return installRecordCodec.encode(record);
}
