/**
 * The work queue: the version 1 work item, its caps, pure immutable queue
 * operations, and the shard codec (Solution Design §7.3, §7.4; epic #9
 * decisions 3, 4, 5 and 7). `src/app/queue-store.ts` reads and writes it over
 * `StatePort`.
 *
 * - The queue is always in **canonical order**: scheduled items first, then
 *   manual, each by `enqueuedAt` ascending, ties in their existing order.
 *   Every operation returns a new array in that order and never changes its
 *   input.
 * - An item leaves the queue only through `dequeue` or `addStrike`, once it's
 *   finished, so a crash repeats work and never loses an item (SD §10.4).
 * - Bounds are part of the type's contract, so a full queue of worst-case
 *   items is proven to fit in `QUEUE_MAX_SHARDS` shards: a `threadId` is 1 to
 *   32 characters from `[A-Za-z0-9_-]`, timestamps are integers from 0 to
 *   9,999,999,999,999 (13 digits), and `strikes` is 0, 1 or 2. An operation
 *   given a value outside them throws `JevClassifierError` (a caller bug).
 *   Decoding a stored value outside them throws `StateError` `schema`.
 */
import { z } from 'zod';

import { JevClassifierError } from './errors.ts';
import { fail, type Fail, ok, type Result } from './result.ts';
import { defineStateCodec } from './state-codec.ts';

/** The most items the queue holds. Internal, not a config field. */
export const QUEUE_MAX_ITEMS = 1000;

/**
 * The most manual items the queue holds, so a manual job can never fill the
 * queue and block scheduled ingest.
 */
export const QUEUE_MAX_MANUAL_ITEMS = 200;

/** The most `state.queue.<n>` shards the queue may use. */
export const QUEUE_MAX_SHARDS = 24;

/** The largest stored strike count. The third strike removes the item. */
export const MAX_STORED_STRIKES = 2;

/** The largest epoch-ms timestamp the queue stores (13 digits). */
export const MAX_TIMESTAMP_MS = 9_999_999_999_999;

const THREAD_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type WorkItemSource = 'scheduled' | 'manual';

/** The version 1 work item. See SD §7.3. */
export type WorkItem = {
  readonly threadId: string;
  readonly source: WorkItemSource;
  /** Epoch ms. */
  readonly enqueuedAt: number;
  /** An integer 0 to 2. E6 removes the item on the third strike. */
  readonly strikes: number;
  /** Epoch ms: the `savedAt` of the position the item was queued against. */
  readonly positionSavedAt?: number;
  /** Unset until the first read decides it; then it never changes (epic decision 7). */
  readonly firstClassification?: boolean;
  /** Manual items only. */
  readonly applyMoves?: boolean;
};

/** Always in canonical order. */
export type WorkQueue = readonly WorkItem[];

export type EnqueueRequest = {
  readonly threadId: string;
  readonly source: WorkItemSource;
  readonly enqueuedAt: number;
  readonly positionSavedAt?: number;
  readonly firstClassification?: boolean;
  readonly applyMoves?: boolean;
  /** A `Jev/Error` removal (#65): sets a merged item's strikes to 0. */
  readonly resetStrikes?: boolean;
};

export type EnqueueOutcome = 'queued' | 'merged';

type EnqueuedFields = { readonly queue: WorkQueue; readonly outcome: EnqueueOutcome };

export type EnqueueResult = Result<
  EnqueuedFields,
  Fail<'full', { readonly cap: 'total' | 'manual' }>
>;

// ---------------------------------------------------------------------------
// Items and order
// ---------------------------------------------------------------------------

/** The fields of an item. Optional ones may be `undefined`, and are then left out. */
type ItemFields = {
  readonly threadId: string;
  readonly source: WorkItemSource;
  readonly enqueuedAt: number;
  readonly strikes: number;
  readonly positionSavedAt?: number | undefined;
  readonly firstClassification?: boolean | undefined;
  readonly applyMoves?: boolean | undefined;
};

/**
 * The only place a `WorkItem` is built. It writes the fields in one fixed
 * order and leaves out absent optional ones, so an unchanged item always
 * gives the same JSON text and the sharded writer can skip an unchanged shard.
 */
function buildItem(fields: ItemFields): WorkItem {
  return {
    threadId: fields.threadId,
    source: fields.source,
    enqueuedAt: fields.enqueuedAt,
    strikes: fields.strikes,
    ...(fields.positionSavedAt === undefined ? {} : { positionSavedAt: fields.positionSavedAt }),
    ...(fields.firstClassification === undefined
      ? {}
      : { firstClassification: fields.firstClassification }),
    ...(fields.applyMoves === undefined ? {} : { applyMoves: fields.applyMoves }),
  };
}

/**
 * Puts items into canonical order: scheduled before manual, each by
 * `enqueuedAt` ascending. Ties keep their order in `items` (broken explicitly
 * by index, not left to the engine's sort). Returns a new array.
 */
export function canonicalOrder(items: readonly WorkItem[]): WorkQueue {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        sourceRank(a.item) - sourceRank(b.item) ||
        a.item.enqueuedAt - b.item.enqueuedAt ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

function sourceRank(item: WorkItem): number {
  return item.source === 'scheduled' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function assertThreadId(threadId: string): void {
  if (!THREAD_ID.test(threadId)) {
    throw new JevClassifierError(
      'A work item thread ID must be 1 to 32 characters from A-Z, a-z, 0-9, _ and -',
      { threadId },
    );
  }
}

function assertTimestamp(threadId: string, field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    throw new JevClassifierError(
      `A work item ${field} must be an integer from 0 to ${String(MAX_TIMESTAMP_MS)}`,
      { threadId, field },
    );
  }
}

function assertRequest(request: EnqueueRequest): void {
  assertThreadId(request.threadId);
  assertTimestamp(request.threadId, 'enqueuedAt', request.enqueuedAt);
  if (request.positionSavedAt !== undefined) {
    assertTimestamp(request.threadId, 'positionSavedAt', request.positionSavedAt);
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Adds a thread, or merges the request into the item already queued for it.
 *
 * - **New thread:** `ok({ queue, outcome: 'queued' })` with `strikes: 0` and
 *   only the optional fields the request sets. At a cap it returns
 *   `fail('full', { cap })` and the caller keeps its old queue: `total` when
 *   the queue holds `QUEUE_MAX_ITEMS`, `manual` when `source` is `manual` and
 *   it holds `QUEUE_MAX_MANUAL_ITEMS` manual items (checked second).
 * - **Existing thread:** always succeeds, even at a cap, with
 *   `outcome: 'merged'` (epic decision 5): `source` is `scheduled` if either
 *   is; `applyMoves` is `true` if either is, else absent; `enqueuedAt` is the
 *   earlier; `firstClassification` and `positionSavedAt` keep the existing
 *   value when set, else take the request's; `strikes` are kept, or set to 0
 *   when `resetStrikes` is true.
 *
 * Throws `JevClassifierError` for a value outside the bounds.
 */
export function enqueue(queue: WorkQueue, request: EnqueueRequest): EnqueueResult {
  assertRequest(request);
  const existing = queue.find((item) => item.threadId === request.threadId);
  if (existing === undefined) {
    if (queue.length >= QUEUE_MAX_ITEMS) {
      return fail('full', { cap: 'total' });
    }
    if (
      request.source === 'manual' &&
      queue.filter((item) => item.source === 'manual').length >= QUEUE_MAX_MANUAL_ITEMS
    ) {
      return fail('full', { cap: 'manual' });
    }
    const added = buildItem({
      threadId: request.threadId,
      source: request.source,
      enqueuedAt: request.enqueuedAt,
      strikes: 0,
      positionSavedAt: request.positionSavedAt,
      firstClassification: request.firstClassification,
      applyMoves: request.applyMoves,
    });
    return ok<EnqueuedFields>({ queue: canonicalOrder([...queue, added]), outcome: 'queued' });
  }

  const merged = buildItem({
    threadId: existing.threadId,
    source:
      existing.source === 'scheduled' || request.source === 'scheduled' ? 'scheduled' : 'manual',
    enqueuedAt: Math.min(existing.enqueuedAt, request.enqueuedAt),
    strikes: request.resetStrikes === true ? 0 : existing.strikes,
    positionSavedAt: existing.positionSavedAt ?? request.positionSavedAt,
    firstClassification: existing.firstClassification ?? request.firstClassification,
    applyMoves: existing.applyMoves === true || request.applyMoves === true ? true : undefined,
  });
  return ok<EnqueuedFields>({
    queue: canonicalOrder(queue.map((item) => (item === existing ? merged : item))),
    outcome: 'merged',
  });
}

/**
 * The first `n` items in canonical order whose `threadId` isn't in `exclude`,
 * `n` a positive integer (else it throws `JevClassifierError`). The run
 * controller passes the threads already taken this run, so each thread is
 * settled at most once per run. Removes nothing: an item leaves the queue only
 * through `dequeue` or `addStrike`, once it's finished.
 */
export function takeChunk(
  queue: WorkQueue,
  n: number,
  exclude?: ReadonlySet<string>,
): readonly WorkItem[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new JevClassifierError('A chunk size must be a positive integer', { n });
  }
  if (exclude === undefined || exclude.size === 0) {
    return queue.slice(0, n);
  }
  const chunk: WorkItem[] = [];
  for (const item of queue) {
    if (chunk.length >= n) break;
    if (!exclude.has(item.threadId)) chunk.push(item);
  }
  return chunk;
}

/** Removes the item. An unknown ID returns the queue unchanged, so a repeat is harmless. */
export function dequeue(queue: WorkQueue, threadId: string): WorkQueue {
  return queue.some((item) => item.threadId === threadId)
    ? queue.filter((item) => item.threadId !== threadId)
    : queue;
}

/**
 * Adds a strike. `strikes` is the new count, 1 to 3. At 3 the item is removed
 * from the returned queue (E6 adds `Jev/Error` and alerts), so a stored count
 * never exceeds 2. An unknown ID throws `JevClassifierError`.
 */
export function addStrike(
  queue: WorkQueue,
  threadId: string,
): { readonly queue: WorkQueue; readonly strikes: number } {
  const existing = requireItem(queue, threadId);
  const strikes = existing.strikes + 1;
  if (strikes > MAX_STORED_STRIKES) {
    return { queue: dequeue(queue, threadId), strikes };
  }
  return {
    queue: queue.map((item) => (item === existing ? buildItem({ ...existing, strikes }) : item)),
    strikes,
  };
}

/**
 * Fixes the item's `firstClassification`, only when it's unset: a decided
 * value never changes (epic decision 7), and then the queue is returned
 * unchanged. An unknown ID throws `JevClassifierError`.
 */
export function setFirstClassification(
  queue: WorkQueue,
  threadId: string,
  value: boolean,
): WorkQueue {
  const existing = requireItem(queue, threadId);
  if (existing.firstClassification !== undefined) {
    return queue;
  }
  const decided = buildItem({ ...existing, firstClassification: value });
  return queue.map((item) => (item === existing ? decided : item));
}

function requireItem(queue: WorkQueue, threadId: string): WorkItem {
  const item = queue.find((candidate) => candidate.threadId === threadId);
  if (item === undefined) {
    throw new JevClassifierError('No work item is queued for this thread', { threadId });
  }
  return item;
}

// ---------------------------------------------------------------------------
// Shard codec
// ---------------------------------------------------------------------------

const timestampSchema = z.number().int().min(0).max(MAX_TIMESTAMP_MS);

/** One stored item. The transform puts the fields in the fixed order. */
const workItemSchema = z
  .strictObject({
    threadId: z.string().regex(THREAD_ID),
    source: z.enum(['scheduled', 'manual']),
    enqueuedAt: timestampSchema,
    strikes: z.number().int().min(0).max(MAX_STORED_STRIKES),
    positionSavedAt: timestampSchema.optional(),
    firstClassification: z.boolean().optional(),
    applyMoves: z.boolean().optional(),
  })
  .transform((fields): WorkItem => buildItem(fields));

/**
 * The codec for one `state.queue.<n>` shard, `{"v": 1, "items": [...]}`. It
 * satisfies `ShardCodec<WorkItem>` for `src/app/sharded-state.ts`. Decoding
 * validates each item and throws `StateError` (`version` or `schema`); it
 * never drops an item or resets the queue (ADR-0007). The order of items in a
 * shard doesn't matter: `loadQueue` re-sorts.
 */
export const workQueueShardCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({ items: z.array(workItemSchema) }),
});
