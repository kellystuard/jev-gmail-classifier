/**
 * The four `MANUAL_*` Script Properties inputs, validated, and the job query
 * built from them (Solution Design §6.6; epic #14 decision 3). Pure: no port,
 * no clock, no logging; the caller passes the raw values and the time.
 *
 * Each input is trimmed, and a blank value counts as unset. The checks run in a
 * fixed order and the first failure is the result: the query (length, then
 * control characters), the timespan, `MANUAL_APPLY_MOVES`, `MANUAL_REPLACE`,
 * then "neither a query nor a timespan". The query is otherwise never parsed,
 * escaped or changed: Gmail decides what it means. A flag is `true` or `false`
 * in any case; anything else is refused, never guessed.
 *
 * The job query never holds `excludeQuery` (ADR-0017: `screenChunk` applies it
 * to every item) and nothing for `Jev/Error` (screening skips those threads).
 */
import { InvalidArgumentError } from './errors.ts';
import { fail, ok } from './result.ts';
import type { Fail, Result } from './result.ts';
import { parseTimespan, timespanAfterSeconds } from './timespan.ts';

export const MANUAL_QUERY_INPUT = 'MANUAL_QUERY';
export const MANUAL_TIMESPAN_INPUT = 'MANUAL_TIMESPAN';
export const MANUAL_APPLY_MOVES_INPUT = 'MANUAL_APPLY_MOVES';
export const MANUAL_REPLACE_INPUT = 'MANUAL_REPLACE';

/** All four, in this order: read and deleted together. */
export const MANUAL_INPUT_NAMES: readonly string[] = [
  MANUAL_QUERY_INPUT,
  MANUAL_TIMESPAN_INPUT,
  MANUAL_APPLY_MOVES_INPUT,
  MANUAL_REPLACE_INPUT,
];

/** The cap on `MANUAL_QUERY`, trimmed, in UTF-16 code units (`.length`). */
export const MANUAL_QUERY_MAX_CHARS = 1000;

/** The four inputs as `StatePort.getInput` returned them: `undefined` when unset. */
export type RawManualInputs = {
  readonly query: string | undefined;
  readonly timespan: string | undefined;
  readonly applyMoves: string | undefined;
  readonly replace: string | undefined;
};

export type ManualInputRejection =
  | 'query_too_long'
  | 'invalid_query'
  | 'invalid_timespan'
  | 'invalid_apply_moves'
  | 'invalid_replace'
  | 'no_input';

export type ManualStartRequest = {
  /** The exact final job query: stored and logged as it is. */
  readonly query: string;
  readonly applyMoves: boolean;
  readonly replace: boolean;
  /** The canonical timespan text, such as `36h`. Only with a timespan. */
  readonly timespan?: string;
  /** The bound, in epoch seconds. Only with a timespan. */
  readonly after?: number;
};

/** The trimmed value, or `undefined` when it is unset or blank. */
function trimmedOrUnset(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === '' ? undefined : text;
}

/**
 * A code unit in U+0000-U+001F or U+007F-U+009F, U+2028 or U+2029, or a lone
 * surrogate. A loop, not a regular expression: `no-control-regex` forbids the
 * latter, and `isWellFormed` isn't in ES2020.
 */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029) {
      return true;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** `true` / `false` in any case; unset is `false`; anything else is `undefined` (refused). */
function parseFlag(raw: string | undefined): boolean | undefined {
  const value = trimmedOrUnset(raw)?.toLowerCase();
  if (value === undefined || value === 'false') return false;
  return value === 'true' ? true : undefined;
}

/** Validates the four inputs. A refusal is an expected failure with only its reason. */
export function parseManualInputs(
  raw: RawManualInputs,
  nowMs: number,
): Result<ManualStartRequest, Fail<ManualInputRejection>> {
  const query = trimmedOrUnset(raw.query);
  if (query !== undefined) {
    if (query.length > MANUAL_QUERY_MAX_CHARS) return fail('query_too_long');
    if (hasControlCharacter(query)) return fail('invalid_query');
  }

  const timespanText = trimmedOrUnset(raw.timespan);
  let timespan: { readonly text: string; readonly after: number } | undefined;
  if (timespanText !== undefined) {
    const parsed = parseTimespan(timespanText);
    if (!parsed.ok) return fail('invalid_timespan');
    timespan = { text: parsed.text, after: timespanAfterSeconds(nowMs, parsed.ms) };
  }

  const applyMoves = parseFlag(raw.applyMoves);
  if (applyMoves === undefined) return fail('invalid_apply_moves');
  const replace = parseFlag(raw.replace);
  if (replace === undefined) return fail('invalid_replace');

  if (query === undefined && timespan === undefined) return fail('no_input');

  return ok({
    query: buildJobQuery(query, timespan?.after),
    applyMoves,
    replace,
    ...(timespan === undefined ? {} : { timespan: timespan.text, after: timespan.after }),
  });
}

/**
 * The final job query: the trimmed query as typed, `after:<s>`, or
 * `(<query>) after:<s>`. Throws `InvalidArgumentError` with neither argument (a
 * caller bug; `parseManualInputs` never does that).
 */
export function buildJobQuery(query: string | undefined, afterSeconds: number | undefined): string {
  if (query === undefined && afterSeconds === undefined) {
    throw new InvalidArgumentError('A job query needs a query or a bound', {
      argument: 'query',
      reason: 'no_input',
    });
  }
  if (afterSeconds === undefined) return query ?? '';
  const bound = `after:${String(afterSeconds)}`;
  return query === undefined ? bound : `(${query}) ${bound}`;
}
