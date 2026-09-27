/**
 * Results for expected failures (Solution Design §10.1, ADR-0006).
 *
 * Results are flat, with no `value` wrapper: `{ ok: true, …fields }` or
 * `{ ok: false, kind, …fields }`. `kind` is a lower-case `snake_case` string,
 * so a `switch (result.kind)` narrows a union of failures. Callers handle
 * `ok: false` with an ordinary `if` or `switch` (Engineering Standards §5).
 */

/**
 * No extra fields. A success with nothing to return is `Ok<NoFields>`, built
 * with `ok({})`. (Not `Record<string, never>`: its index signature would make
 * `ok` itself `never`.)
 */
export type NoFields = Record<never, never>;

/** A success carrying the fields `S`. */
export type Ok<S extends object> = { readonly ok: true } & Readonly<S>;

/** An expected failure of kind `K`, carrying the fields `F`. */
export type Fail<K extends string, F extends object = NoFields> = {
  readonly ok: false;
  readonly kind: K;
} & Readonly<F>;

/**
 * A success with fields `S`, or one of the failures in the union `F`. For
 * example `Result<{ labels: GmailLabel[] }, Fail<'scope'> | Fail<'rate_limited'>>`.
 */
export type Result<S extends object, F extends Fail<string, object>> = Ok<S> | F;

/** Builds a success. `ok` is set last, so the fields can't override it. */
export function ok<S extends object>(fields: S): Ok<S> {
  return { ...fields, ok: true };
}

/** Builds a failure of `kind`. `ok` and `kind` are set last, so the fields can't override them. */
export function fail<K extends string>(kind: K): Fail<K>;
export function fail<K extends string, F extends object>(kind: K, fields: F): Fail<K, F>;
export function fail(kind: string, fields: object = {}): Fail<string, object> {
  return { ...fields, ok: false, kind };
}
