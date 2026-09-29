/**
 * Versioned codecs for `state.*` values (Solution Design §7.3, §11 "Upgrades";
 * ADR-0007).
 *
 * A codec turns what `StatePort.get(key)` returned into a typed value, and a
 * typed value into the JSON to store: `{ "v": <version>, ...value }`. A value
 * stored under an older version is migrated on read by ordered hooks. A value
 * that can't be decoded throws `StateError` and is **never** reset or
 * rewritten: silently dropping the queue or moving the position would lose mail
 * or process it twice (SD §11).
 *
 * `StateError` messages and fields never contain the stored value or any part
 * of it (Engineering Standards §6): a later key might hold a subject or a
 * query. They name the key, the version, and the schema issues' paths and
 * messages only.
 */
import type { z } from 'zod';

import { StateError } from './errors.ts';
import type { JsonValue } from './state-types.ts';

export type StateMigration = {
  /** Migrates a value at version `from` to version `from + 1`. Both without `v`. */
  readonly from: number;
  /** Must not mutate its input, and must not add a `v` field. */
  readonly migrate: (value: Readonly<Record<string, unknown>>) => Record<string, unknown>;
};

export type StateCodec<T> = {
  readonly version: number;
  /** The JSON to store: `{ v: version, ...value }`, with `v` first. */
  encode(value: T): JsonValue;
  /** Decodes what `StatePort.get(key)` returned (never `undefined`: the caller handles an absent key). Throws `StateError`. */
  decode(key: string, raw: unknown): T;
};

export type StateCodecSpec<S extends z.ZodType> = {
  /** The current version, an integer >= 1. */
  readonly version: number;
  /** The current version's shape, without `v`. `z.strictObject` is recommended. */
  readonly schema: S;
  /** Hooks for older versions. A gap only fails when a stored value needs it. */
  readonly migrations?: readonly StateMigration[];
};

/**
 * Defines the codec for one key's value. Throws `Error` (a bug in the code,
 * not bad state) when `version` isn't an integer >= 1, when two migrations
 * have the same `from`, or when a migration's `from` isn't in `1 .. version - 1`.
 *
 * `decode`, in order:
 * 1. `raw` isn't a plain JSON object, or has no integer `v`: `StateError` `schema`.
 * 2. `v` is newer than `version`: `StateError` `version`.
 * 3. `v` is older: runs the migrations `v`, `v + 1`, … `version - 1` in order.
 *    A missing step (including any `v < 1`) or a hook that throws (kept as the
 *    `cause`) is `StateError` `version`.
 * 4. The value without `v` fails the schema: `StateError` `schema`.
 *
 * `decode` writes nothing and doesn't change `raw`. `encode` doesn't re-run the
 * schema: the type guarantees the shape. The payload must not have its own `v`.
 */
export function defineStateCodec<S extends z.ZodType>(
  spec: StateCodecSpec<S>,
): StateCodec<z.output<S>> {
  const { version, schema } = spec;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`State codec version must be an integer >= 1, got ${String(version)}`);
  }
  const steps = new Map<number, StateMigration['migrate']>();
  for (const migration of spec.migrations ?? []) {
    const from = migration.from;
    if (!Number.isInteger(from) || from < 1 || from > version - 1) {
      throw new Error(
        `State migration from ${String(from)} is outside 1..${String(version - 1)} for version ${String(version)}`,
      );
    }
    if (steps.has(from)) {
      throw new Error(`Two state migrations start from version ${String(from)}`);
    }
    steps.set(from, migration.migrate);
  }

  return {
    version,
    encode(value: z.output<S>): JsonValue {
      // `v` goes first so the stored text starts with `{"v":`. The value is
      // JSON-safe by contract (the schema describes stored JSON), which the
      // type can't say, so this is the one cast.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the schema's output is an object and JSON-safe by contract; a generic Zod output type can't say so.
      return { v: version, ...(value as object) };
    },
    decode(key: string, raw: unknown): z.output<S> {
      if (!isPlainObject(raw)) {
        throw new StateError(`State ${key} is not a JSON object`, { key, reason: 'schema' });
      }
      const stored = raw['v'];
      if (typeof stored !== 'number' || !Number.isInteger(stored)) {
        throw new StateError(`State ${key} has no integer version "v"`, { key, reason: 'schema' });
      }
      if (stored > version) {
        throw new StateError(
          `State ${key} is version ${String(stored)}, newer than this release's ${String(version)}`,
          { key, reason: 'version', version: stored },
        );
      }

      let value: Record<string, unknown> = withoutVersion(raw);
      for (let from = stored; from < version; from += 1) {
        const migrate = steps.get(from);
        if (migrate === undefined) {
          throw new StateError(
            `State ${key} is version ${String(stored)} and has no migration from ${String(from)}`,
            { key, reason: 'version', version: stored },
          );
        }
        try {
          value = migrate(value);
        } catch (cause) {
          throw new StateError(
            `State ${key} migration from version ${String(from)} failed`,
            { key, reason: 'version', version: stored },
            { cause },
          );
        }
      }

      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new StateError(
          `State ${key} (version ${String(stored)}) failed its schema: ${describeIssues(parsed.error)}`,
          { key, reason: 'schema', version: stored },
        );
      }
      return parsed.data;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function withoutVersion(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // `Object.fromEntries` defines own properties, so a stored `__proto__` key
  // stays data instead of changing the copy's prototype.
  return Object.fromEntries(Object.entries(raw).filter(([name]) => name !== 'v'));
}

/**
 * `<path>: <message>` per issue, joined with `; `, for example
 * `items[3].strikes: Invalid input: expected number, received string`. Zod
 * messages describe the schema's expectation, not the value, except for an
 * unrecognized key, which names the stored key: that message is replaced.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = formatPath(issue.path);
      const message =
        issue.code === 'unrecognized_keys'
          ? `Unrecognized key (${String(issue.keys.length)})`
          : issue.message;
      return `${path === '' ? '(root)' : path}: ${message}`;
    })
    .join('; ');
}

/** Formats a Zod issue path as `items[3].strikes`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') {
      out += `[${String(key)}]`;
    } else {
      const name = String(key);
      out += out === '' ? name : `.${name}`;
    }
  }
  return out;
}
