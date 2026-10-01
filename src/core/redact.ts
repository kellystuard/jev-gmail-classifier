/**
 * `redact`: the last line of defence before a log line is written (Solution
 * Design §10.5, Engineering Standards §6, epic #15 decisions 3 and 4).
 *
 * Callers never pass a body, the key, the `Authorization` header or a request
 * `state`. This makes sure a slip still can't reach the log. Pure: no Apps
 * Script global, no clock, no `console`.
 */
import type { LogFields } from './log-fields.ts';

/** What a scrubbed value becomes. */
export const REDACTED = '[redacted]';

/** Field names never logged, lower-cased with `_` and `-` removed. */
export const FORBIDDEN_LOG_FIELDS: readonly string[] = [
  'body',
  'state',
  'authorization',
  'apikey',
  'jevapikey',
  'secret',
  'password',
  'token',
  'pagetoken',
];

/** A longer string is cut to this many UTF-16 code units. */
export const LOG_STRING_MAX_CHARS = 2000;

/** A secret value shorter than this is ignored. */
export const LOG_SECRET_MIN_CHARS = 8;

/** Arrays and objects nested deeper than this are replaced whole. */
export const LOG_REDACT_MAX_DEPTH = 4;

const BEARER = /\bbearer\s+\S+/gi;

/** True when the name, lower-cased with `_` and `-` removed, is exactly a forbidden one. */
export function isForbiddenLogField(name: string): boolean {
  return FORBIDDEN_LOG_FIELDS.includes(name.toLowerCase().replace(/[_-]/g, ''));
}

function scrubString(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) text = text.split(secret).join(REDACTED);
  text = text.replace(BEARER, `Bearer ${REDACTED}`);
  if (text.length > LOG_STRING_MAX_CHARS) {
    let cut = LOG_STRING_MAX_CHARS;
    const last = text.charCodeAt(cut - 1);
    // Don't split a surrogate pair: a high surrogate would be left alone.
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    text = `${text.slice(0, cut)}…[+${String(text.length - cut)} chars]`;
  }
  return text;
}

function isKeepable(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'boolean' || value === null;
}

function walk(value: unknown, depth: number, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (Array.isArray(value)) {
    if (depth >= LOG_REDACT_MAX_DEPTH) return REDACTED;
    return value.map((item: unknown) => walk(item, depth + 1, secrets));
  }
  if (typeof value === 'object' && value !== null) {
    if (depth >= LOG_REDACT_MAX_DEPTH) return REDACTED;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]): [string, unknown] => [
        key,
        isForbiddenLogField(key) && !isKeepable(item) ? REDACTED : walk(item, depth + 1, secrets),
      ]),
    );
  }
  return value;
}

/**
 * Returns a scrubbed copy of `fields`; never mutates it. Forbidden names, the
 * `secretValues`, `Bearer <token>` and over-long strings are replaced.
 */
export function redact(fields: LogFields, secretValues: readonly string[] = []): LogFields {
  const secrets = secretValues.filter(
    (s) => typeof s === 'string' && s.length >= LOG_SECRET_MIN_CHARS,
  );
  const entries = Object.entries(fields).map(([name, value]): [string, unknown] => [
    name,
    isForbiddenLogField(name) ? REDACTED : walk(value, 1, secrets),
  ]);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the walk keeps the shape of its input, which is `LogFields`; `fromEntries` can't say so.
  return Object.fromEntries(entries) as LogFields;
}
