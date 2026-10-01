/**
 * The manual job record, `state.manual` (Solution Design §6.6, §7.3; epic #14
 * decisions 5, 6 and 10; ADR-0017): its type, its codec, the pure updates of
 * its search cursor, and the size it can reach. Pure: no port, no clock, no
 * logging. The store over `StatePort` is `src/app/manual-job-store.ts`.
 *
 * Stored as `{"v": 1, "query", "applyMoves", "startedAt", "cursor": {"seen",
 * "pageToken"?}, "searchDone", "executions", "counts": {…}, "labels", "moves",
 * "otherLabels", "otherMoves"}`, in that order, with an absent `pageToken` left
 * out. A value that can't be decoded throws `StateError` and is never reset
 * (ADR-0007). The job holds no exclusion term: exclusion is the chunk filter's
 * (ADR-0017).
 */
import { z } from 'zod';

import { InvalidArgumentError } from './errors.ts';
import { defineStateCodec } from './state-codec.ts';
import { utf8ByteLength } from './state-limits.ts';
import type { JsonValue, StateKey } from './state-types.ts';

/** The Script Properties key. A job is unfinished while this key exists. */
export const MANUAL_KEY = 'state.manual' satisfies StateKey;

/** The job search's `maxResults`. */
export const MANUAL_PAGE_SIZE = 100;

/**
 * The longest stored query, in UTF-16 code units. The input is capped at 1,000
 * characters; the final query adds at most `(`, `)` and ` after:<10 digits>`.
 */
export const MANUAL_JOB_QUERY_MAX_CHARS = 1024;

/** The longest stored page token, in characters. */
export const MANUAL_PAGE_TOKEN_MAX_CHARS = 2048;

/**
 * A storable page token: printable ASCII other than `"` and `\`, so it is one
 * byte per character in the JSON text.
 */
const PAGE_TOKEN_PATTERN = /^[!#-[\]-~]+$/;

const MAX = Number.MAX_SAFE_INTEGER;

export type ManualJobCounts = {
  /** Job-search pages queued (#135). */
  readonly pages: number;
  /** IDs queued as new manual items (#135). */
  readonly queued: number;
  /** IDs merged into an item already queued (#135). */
  readonly merged: number;
  /** From here on: #138's `addChunkToJob`. */
  readonly chunks: number;
  readonly excluded: number;
  readonly skipped: number;
  readonly sent: number;
  readonly classified: number;
  /** Strike events. */
  readonly struck: number;
  readonly errored: number;
  readonly gone: number;
  readonly inputTokens: number;
};

export type ManualJob = {
  /** The exact final job query (#132). */
  readonly query: string;
  readonly applyMoves: boolean;
  /** Epoch ms. */
  readonly startedAt: number;
  /** `seen`: thread IDs read and queued so far. `pageToken`: the next page's token. */
  readonly cursor: { readonly seen: number; readonly pageToken?: string };
  /** The job search has no more pages. */
  readonly searchDone: boolean;
  /** Executions that worked on the job (#136). */
  readonly executions: number;
  readonly counts: ManualJobCounts;
  /** Threads labelled, per label name. */
  readonly labels: Readonly<Record<string, number>>;
  /** Threads moved, per destination: `archive`, `spam`, `trash` or `label:<name>`. */
  readonly moves: Readonly<Record<string, number>>;
  /** Decision 10: label counts that no longer fit under their own key. */
  readonly otherLabels: number;
  readonly otherMoves: number;
};

const countSchema = z.number().int().nonnegative().max(MAX);

const countsSchema = z.strictObject({
  pages: countSchema,
  queued: countSchema,
  merged: countSchema,
  chunks: countSchema,
  excluded: countSchema,
  skipped: countSchema,
  sent: countSchema,
  classified: countSchema,
  struck: countSchema,
  errored: countSchema,
  gone: countSchema,
  inputTokens: countSchema,
});

/**
 * Not `z.record`: it drops an own key named `__proto__` when it decodes. The
 * entries are checked by hand, and `buildJob` rebuilds the map with
 * `Object.fromEntries`, which defines own properties.
 */
const countMapSchema = z.custom<Readonly<Record<string, number>>>(isCountMap, {
  message: 'Expected an object of non-empty keys and counts that are safe integers >= 0',
});

const manualJobSchema = z
  .strictObject({
    query: z.string().min(1).max(MANUAL_JOB_QUERY_MAX_CHARS),
    applyMoves: z.boolean(),
    startedAt: countSchema,
    cursor: z.strictObject({
      seen: countSchema,
      pageToken: z
        .string()
        .min(1)
        .max(MANUAL_PAGE_TOKEN_MAX_CHARS)
        .regex(PAGE_TOKEN_PATTERN, 'Expected printable ASCII without " or \\')
        .optional(),
    }),
    searchDone: z.boolean(),
    executions: countSchema,
    counts: countsSchema,
    labels: countMapSchema,
    moves: countMapSchema,
    otherLabels: countSchema,
    otherMoves: countSchema,
  })
  .refine((job) => !(job.searchDone && job.cursor.pageToken !== undefined), {
    message: 'Expected no pageToken when searchDone is true',
  })
  .transform((fields): ManualJob => buildJob(fields));

function isCountMap(value: unknown): value is Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.entries(value).every(
    ([key, count]) => key !== '' && typeof count === 'number' && isCount(count),
  );
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

type JobFields = {
  readonly query: string;
  readonly applyMoves: boolean;
  readonly startedAt: number;
  readonly cursor: { readonly seen: number; readonly pageToken?: string | undefined };
  readonly searchDone: boolean;
  readonly executions: number;
  readonly counts: ManualJobCounts;
  readonly labels: Readonly<Record<string, number>>;
  readonly moves: Readonly<Record<string, number>>;
  readonly otherLabels: number;
  readonly otherMoves: number;
};

/**
 * The job with its fields in the stored order, an absent `pageToken` left out,
 * and fresh maps. Every job goes through here, so an unchanged job gives the
 * same JSON text, and the order doesn't depend on the caller's object.
 */
function buildJob(fields: JobFields): ManualJob {
  const { counts } = fields;
  return {
    query: fields.query,
    applyMoves: fields.applyMoves,
    startedAt: fields.startedAt,
    cursor: {
      seen: fields.cursor.seen,
      ...(fields.cursor.pageToken === undefined ? {} : { pageToken: fields.cursor.pageToken }),
    },
    searchDone: fields.searchDone,
    executions: fields.executions,
    counts: {
      pages: counts.pages,
      queued: counts.queued,
      merged: counts.merged,
      chunks: counts.chunks,
      excluded: counts.excluded,
      skipped: counts.skipped,
      sent: counts.sent,
      classified: counts.classified,
      struck: counts.struck,
      errored: counts.errored,
      gone: counts.gone,
      inputTokens: counts.inputTokens,
    },
    labels: Object.fromEntries(Object.entries(fields.labels)),
    moves: Object.fromEntries(Object.entries(fields.moves)),
    otherLabels: fields.otherLabels,
    otherMoves: fields.otherMoves,
  };
}

/**
 * `decode(MANUAL_KEY, raw)` throws `StateError` `version` for an unknown `v`,
 * and `schema` for a missing `v` or a bad shape (an extra key at any level, a
 * bad number, query or token, or `searchDone` with a token). The error text
 * never holds the query or the token.
 */
export const manualJobCodec = defineStateCodec({ version: 1, schema: manualJobSchema });

/** Decodes a `state.manual` value. The caller handles an absent key. Throws `StateError`. */
export function decodeManualJob(raw: unknown): ManualJob {
  return manualJobCodec.decode(MANUAL_KEY, raw);
}

/** The JSON to store under `state.manual`, fields in the stored order. */
export function encodeManualJob(job: ManualJob): JsonValue {
  return manualJobCodec.encode(buildJob(job));
}

function invalid(argument: string, reason: string, message: string): InvalidArgumentError {
  return new InvalidArgumentError(message, { argument, reason });
}

function checkCount(argument: string, value: number): void {
  if (!isCount(value)) {
    throw invalid(argument, 'invalid_count', `${argument} must be a safe integer of at least 0`);
  }
}

function add(a: number, b: number): number {
  return Math.min(MAX, a + b);
}

/** Whether `token` can be stored in the cursor (one byte per character in the JSON text). */
export function isStorablePageToken(token: string): boolean {
  return (
    token.length >= 1 &&
    token.length <= MANUAL_PAGE_TOKEN_MAX_CHARS &&
    PAGE_TOKEN_PATTERN.test(token)
  );
}

function checkToken(argument: string, token: string): void {
  if (!isStorablePageToken(token)) {
    throw invalid(argument, 'invalid_page_token', `${argument} is not a storable page token`);
  }
}

const ZERO_COUNTS: ManualJobCounts = {
  pages: 0,
  queued: 0,
  merged: 0,
  chunks: 0,
  excluded: 0,
  skipped: 0,
  sent: 0,
  classified: 0,
  struck: 0,
  errored: 0,
  gone: 0,
  inputTokens: 0,
};

const MAX_COUNTS: ManualJobCounts = {
  pages: MAX,
  queued: MAX,
  merged: MAX,
  chunks: MAX,
  excluded: MAX,
  skipped: MAX,
  sent: MAX,
  classified: MAX,
  struck: MAX,
  errored: MAX,
  gone: MAX,
  inputTokens: MAX,
};

/**
 * A new job: cursor at 0, the search not done, no executions, every count 0.
 * Throws `InvalidArgumentError` for an empty or over-long `query`, or a
 * `startedAt` that isn't a safe integer of at least 0.
 */
export function newManualJob(input: {
  readonly query: string;
  readonly applyMoves: boolean;
  readonly startedAt: number;
}): ManualJob {
  if (input.query.length < 1 || input.query.length > MANUAL_JOB_QUERY_MAX_CHARS) {
    throw invalid(
      'query',
      'invalid_query',
      `query must be 1 to ${String(MANUAL_JOB_QUERY_MAX_CHARS)} characters`,
    );
  }
  checkCount('startedAt', input.startedAt);
  return buildJob({
    query: input.query,
    applyMoves: input.applyMoves,
    startedAt: input.startedAt,
    cursor: { seen: 0 },
    searchDone: false,
    executions: 0,
    counts: ZERO_COUNTS,
    labels: {},
    moves: {},
    otherLabels: 0,
    otherMoves: 0,
  });
}

/**
 * One job-search page was read and queued: `seen += idsOnPage`, and the page
 * counts add to `counts`. With `nextPageToken` it becomes the cursor's token;
 * without, the token is removed and `searchDone` is true. Throws
 * `InvalidArgumentError` when the search is already done, a number isn't a
 * safe integer of at least 0, `queued + merged !== idsOnPage`, or the token
 * isn't storable (the caller checks `isStorablePageToken` first). Additions
 * saturate at `Number.MAX_SAFE_INTEGER`.
 */
export function advanceCursor(
  job: ManualJob,
  page: {
    readonly idsOnPage: number;
    readonly queued: number;
    readonly merged: number;
    readonly nextPageToken?: string | undefined;
  },
): ManualJob {
  if (job.searchDone) {
    throw invalid('job', 'search_done', 'The job search is already done');
  }
  checkCount('idsOnPage', page.idsOnPage);
  checkCount('queued', page.queued);
  checkCount('merged', page.merged);
  if (page.queued + page.merged !== page.idsOnPage) {
    throw invalid('page', 'page_counts_differ', 'queued + merged must equal idsOnPage');
  }
  if (page.nextPageToken !== undefined) {
    checkToken('nextPageToken', page.nextPageToken);
  }
  return buildJob({
    ...job,
    cursor: { seen: add(job.cursor.seen, page.idsOnPage), pageToken: page.nextPageToken },
    searchDone: page.nextPageToken === undefined,
    counts: {
      ...job.counts,
      pages: add(job.counts.pages, 1),
      queued: add(job.counts.queued, page.queued),
      merged: add(job.counts.merged, page.merged),
    },
  });
}

/** Gmail rejected the token: removes it and keeps `seen` (decision 6). Unchanged without a token. */
export function dropPageToken(job: ManualJob): ManualJob {
  if (job.cursor.pageToken === undefined) {
    return job;
  }
  return buildJob({ ...job, cursor: { seen: job.cursor.seen } });
}

/**
 * Whether the next refill must walk from the first page: no token, `seen > 0`
 * and the search not done. No token with `seen === 0` is the first page.
 */
export function needsCursorWalk(job: ManualJob): boolean {
  return !job.searchDone && job.cursor.pageToken === undefined && job.cursor.seen > 0;
}

/**
 * Sets the cursor after a walk (#135). The counts are untouched: a walk queues
 * nothing. Throws `InvalidArgumentError` for `searchDone` with a token, a token
 * that isn't storable, an invalid `seen`, or a `seen` past the job's own.
 */
export function restoreCursor(
  job: ManualJob,
  cursor: {
    readonly seen: number;
    readonly pageToken?: string | undefined;
    readonly searchDone: boolean;
  },
): ManualJob {
  checkCount('seen', cursor.seen);
  if (cursor.seen > job.cursor.seen) {
    throw invalid('seen', 'seen_past_job', 'A walk never goes past where the job was');
  }
  if (cursor.pageToken !== undefined) {
    checkToken('pageToken', cursor.pageToken);
    if (cursor.searchDone) {
      throw invalid('searchDone', 'token_when_done', 'A finished search has no page token');
    }
  }
  return buildJob({
    ...job,
    cursor: { seen: cursor.seen, pageToken: cursor.pageToken },
    searchDone: cursor.searchDone,
  });
}

/** One more execution worked on the job (saturating). */
export function countExecution(job: ManualJob): ManualJob {
  return buildJob({ ...job, executions: add(job.executions, 1) });
}

/**
 * The UTF-8 byte length of the job's JSON text at its widest: the same
 * `query`, `applyMoves` and map keys, every number `Number.MAX_SAFE_INTEGER`,
 * `searchDone: false` and a page token of `MANUAL_PAGE_TOKEN_MAX_CHARS`
 * characters. Compare it with decision 10's 8,000-byte bound when adding a map
 * key: a job that fits by this measure still fits after its token changes and
 * its numbers grow.
 */
export function manualJobReservedBytes(job: ManualJob): number {
  const widen = (map: Readonly<Record<string, number>>): Record<string, number> =>
    Object.fromEntries(Object.keys(map).map((key) => [key, MAX]));
  const wide = buildJob({
    query: job.query,
    applyMoves: job.applyMoves,
    startedAt: MAX,
    cursor: { seen: MAX, pageToken: 'a'.repeat(MANUAL_PAGE_TOKEN_MAX_CHARS) },
    searchDone: false,
    executions: MAX,
    counts: MAX_COUNTS,
    labels: widen(job.labels),
    moves: widen(job.moves),
    otherLabels: MAX,
    otherMoves: MAX,
  });
  return utf8ByteLength(JSON.stringify(encodeManualJob(wide)));
}
