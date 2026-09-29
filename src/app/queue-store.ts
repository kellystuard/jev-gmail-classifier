/**
 * Loads and saves the work queue over `StatePort` (Solution Design §7.3).
 * The queue is a sharded list under `state.queue.<n>` (`src/app/sharded-state.ts`),
 * with the item and the pure operations in `src/core/work-queue.ts`.
 *
 * Nothing here logs: the caller does.
 */
import {
  canonicalOrder,
  QUEUE_MAX_SHARDS,
  type WorkItem,
  type WorkQueue,
  workQueueShardCodec,
} from '../core/work-queue.ts';
import type { StatePort } from '../ports/state-port.ts';
import { loadShardedList, saveShardedList, type ShardedListSpec } from './sharded-state.ts';

const QUEUE_LIST: ShardedListSpec<WorkItem> = {
  prefix: 'state.queue.',
  codec: workQueueShardCodec,
  idOf: (item) => item.threadId,
  maxShards: QUEUE_MAX_SHARDS,
};

/**
 * Reads every `state.queue.<n>` shard (in numeric order, duplicates removed by
 * `threadId`, first kept) and returns the queue in canonical order. No shards
 * is an empty queue. Throws `StateError` for a stray key, bad JSON, an unknown
 * `v` or an invalid item: nothing is reset.
 */
export function loadQueue(state: StatePort): WorkQueue {
  return canonicalOrder(loadShardedList(state, QUEUE_LIST));
}

/**
 * Saves the whole queue. Unchanged shards aren't written, surplus shards are
 * deleted, and a save that stops part-way loses no item (`saveShardedList`).
 * Throws `StateError` `too_large` before writing anything when the queue would
 * need more than `QUEUE_MAX_SHARDS` shards: the caps make that impossible, so
 * it's a guard, not a flow.
 */
export function saveQueue(state: StatePort, queue: WorkQueue): void {
  saveShardedList(state, QUEUE_LIST, queue);
}
