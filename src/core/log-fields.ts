/**
 * JSON-safe, flat log fields (Engineering Standards §6, Solution Design §10.5).
 *
 * A value is a scalar, a flat array of strings or numbers, or a flat record of
 * scalars (for example per-rule `probabilities`). Nothing nests deeper, and
 * there is no `undefined`: leave an optional field out instead.
 */

type LogScalar = string | number | boolean | null;

export type LogValue =
  LogScalar | readonly (string | number)[] | Readonly<Record<string, LogScalar>>;

export type LogFields = Readonly<Record<string, LogValue>>;
