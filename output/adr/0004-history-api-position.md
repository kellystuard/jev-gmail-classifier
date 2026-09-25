# ADR-0004: Track progress with a Gmail History API position, not a `Jev/Processed` label

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §6.2–6.3, §7](../solution-design.md#63-ingest-gmail-history-to-work-queue), [PDD §4.3](../product-design-document.md#43-finding-work)

## Context

- The original design searched `-label:Jev/Processed -label:Jev/Error after:<install date>`. It relied on an untested assumption: that Gmail matches `-label:` per message. It also added a system label to every thread.
- The stakeholder wants only classification labels added, and wants manual reclassification by time span.
- A timestamp position was considered. It risks missing mail that Gmail indexes late, and search results come newest first, which doesn't suit a position that advances oldest first.
- `users.history.list` is Google's supported way to sync changes incrementally. History is typically kept for at least a week, sometimes only hours, and returns 404 once it has expired.

## Decision

- Save `state.position = {historyId, savedAt}`.
- Each run **ingests** `messageAdded` records (received and sent messages; drafts, Spam, and Trash ignored) and `labelRemoved` records (for `Jev/Error`) into a persisted, de-duplicated **work queue**. It advances the position only after the queue is saved, and stops at a queue cap (back-pressure).
- It then **processes** the queue within the deadline and budget.
- There is no `Jev/Processed` label. `Jev/Error` stays ([ADR-0006](0006-results-and-error-boundaries.md)).
- **"First classification"** means every message in the thread is newer than the position when the thread was queued. Only these items, and manual jobs with `applyMoves`, may move a thread. The flag is fixed when the item is queued, and survives retries.
- **`install` keeps an existing position.** `RESET_POSITION=true` forces a new start. `uninstall` deletes the position.
- **A 404 (expired position)** triggers a fallback search `after:<last ingest − 1 h>`, resets the position from `getProfile`, and alerts.

## Consequences

- There is no Gmail-visible marker of what has been processed. Coverage evidence comes from `run.end` summaries.
- Replies to threads that predate the position get labels only, never moves. That is slightly stricter than before, which fits precision-first.
- Manual runs simply reclassify whatever matches. The `reprocess` flag becomes `applyMoves`.
- E1 verifies history semantics instead of per-message `-label:` matching.
- The queue and the position need careful state handling and tests.

## Alternatives Considered

- **Keep `Jev/Processed`:** visible, but it clutters every thread and depends on an unverified search behavior.
- **Timestamp position:** late-indexing gaps, awkward chunking, and it needs a deduplication ledger.
