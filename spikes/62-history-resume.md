# 62: Resuming history from a record ID

- Task: informs #62 and #63. Run during E3's refinement (epic #9).
- Date run: 2026-09-27
- Account: `<test-account>` (consumer)
- Run by: agent, through `node spikes/run.mjs` (Node 24)

## Question

E3's ingest can stop part-way through history, at the queue cap or the deadline. Solution Design §6.3 said not to advance the position then, so the next run reads the same history again. But those threads may already have been classified and removed from the queue, so they'd be queued and classified again. And if the history since the position holds more new threads than the cap, every run stops at the same point and ingest never gets further.

The fix is to save the **last fully queued record's `id`** as the position. Google's docs say `startHistoryId` "should be obtained from the historyId of a message, thread, or previous list response". So:

1. Does `users.history.list` accept a history record's `id` as `startHistoryId`?
2. Does it then return exactly the records after it, without the start record?
3. What does the 404 for a discarded position look like through the Advanced Service?

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s62_run`: saves `getProfile().historyId`, inserts 4 synthetic messages (each a new thread, 1.5 s apart), lists `messageAdded` history from the saved ID with `maxResults: 2` (so it pages), then lists again from each of the 4 records' `id`s. It also lists from `startHistoryId: '1'` and from a position 100,000,000 ahead of the mailbox.
3. `node spikes/run.mjs run s62_cleanup`: trashes the 4 messages.

No maintainer steps.

## Results

From the start position `36598780`, 3 pages returned 4 records, one per message: `36598782` (m1), `36598821` (m2), `36598853` (m3), `36598885` (m4). Every page reported `historyId` `36598915`. No bare records appeared in this `messageAdded`-only listing.

| `startHistoryId` | Records returned | Start record included? |
|------------------|------------------|------------------------|
| `36598782` (m1's record) | m2, m3, m4 | no |
| `36598821` (m2's record) | m3, m4 | no |
| `36598853` (m3's record) | m4 | no |
| `36598885` (m4's record) | none (success, with `historyId` `36598915`) | — |
| `1` | 404 | — |
| start + 100,000,000 (ahead of the mailbox) | 404 | — |

Both 404s threw `GoogleJsonResponseException` with the message `API call to gmail.users.history.list failed with error: Requested entity was not found.` and `details` `{code: 404, message: "Requested entity was not found.", errors: [{reason: "notFound", domain: "global"}]}`.

## Conclusion

1. **A record's `id` works as `startHistoryId`.** The listing returns exactly the records after it, in order, and never the start record itself. So ingest can stop after any record and save that record's `id` as the position. The next run resumes right after it, with nothing skipped and nothing read twice.
2. **After the last page**, the position is the response's `historyId` (unchanged from spike 19, finding 8). That's at or after the last record's `id`.
3. **404 means "not usable", not only "expired".** A position ahead of the mailbox gets the same 404 as one Gmail has discarded. The adapter maps the 404 to `history_expired` either way, so a corrupt position also leads to the date-search fallback (Solution Design §6.3), which is the safe outcome.
4. The adapter can recognize the 404 by `details.code === 404`, or by the message ending in `Requested entity was not found.`.

Recorded in Solution Design §6.3 ("Advance" and "Expired position").
