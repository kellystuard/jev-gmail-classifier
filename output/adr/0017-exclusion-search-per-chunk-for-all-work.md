# ADR-0017: Run the exclusion search per chunk for all work, scheduled and manual

- **Status:** Proposed
- **Date:** 2026-09-26
- **Deciders:** Kelly Stuard, E1 developer agent
- **Supersedes:** [ADR-0005](0005-positive-thread-level-exclusion.md) (when accepted)
- **Related:** [Solution Design §6.4](../solution-design.md#64-process-classify-a-chunk) and [§6.6](../solution-design.md#66-manual-runs), [PDD §4.3](../product-design-document.md#43-finding-work), [`spikes/23-exclusion-query.md`](../../spikes/23-exclusion-query.md), issues #22 and #23

## Context

- ADR-0005 made `excludeQuery` a positive query applied per thread: if any message in a thread matches, the whole thread is never sent. It named two search forms: `(<excludeQuery>) after:<oldest − 1 d> before:<newest + 1 d>` for scheduled work, and `(<query>) (<excludeQuery>)` for manual runs.
- Gmail API search matches **per message** ("The Gmail UI allows users to perform thread-wide searches, but the API doesn't", Google's [filtering guide](https://developers.google.com/workspace/gmail/api/guides/filtering)). E1 confirmed this against a real account (spike #23, 2026-09-26):
  - **The manual form leaks.** In a thread where message A is from `alice` and message B is from `bank`, `(from:alice) (from:bank)` returned nothing (case E1). A manual job for `from:alice` with `excludeQuery` `from:bank` would have sent the bank's message to Jev.
  - Subtracting the exclusion in the job search is no safer: `(from:alice) -(from:bank)` still returned the thread (E2).
  - The scheduled form works when the window spans **every** message of the chunk's threads. A window built from the newest message alone missed a thread whose only match was 10 days older (A2).
  - A matching message in **Trash or Spam** is not found unless the search sets `includeSpamTrash: true` (D1, D2), yet `threads.get` still returns that message, body included.
  - Epoch `after:` and `before:` are exact to the second and both inclusive (C1, C3). Results page, and paging returns the same threads (H1). Grouping, nested parentheses, `OR`, and `{}` all work (B2–B4).
  - **Search can compare the bounds against a date the API doesn't report** (C2):
    - For messages uploaded with `internalDateSource: 'receivedTime'`, the API's `internalDate` equaled the `Date` header (10 days old), but search found them only in a window around the **upload time**.
    - A window built from `internalDate` (or the `Date` header) missed them.
    - Self-sends were consistent: Gmail rewrote the `Date` header to the send time.
    - E1 can't build mail from outside, but a message is never indexed later than **now**.

## Decision

- `excludeQuery` stays a **positive** description of mail to exclude, applied per thread, to every run, with no override (unchanged from ADR-0005).
- **One exclusion check, for all work.** Before any thread in a chunk is read for Jev, the chunk filter ([SD §6.4](../solution-design.md#64-process-classify-a-chunk)) runs one `threads.list` search for the whole chunk, scheduled and manual items alike:
  - `q = (<excludeQuery>) after:<lo> before:<hi>`, with the user's query always in parentheses.
  - `lo` is the earliest `internalDate` or parsed `Date` header of any message in any chunk thread, in epoch seconds, minus 86400.
  - `hi` is the latest of now and every chunk message's `internalDate` or `Date` header, plus 86400. It is never earlier than now plus a day, because search can index a message later than its reported dates (C2). The message dates are included so that a `Date` header set in the future can't escape.
  - `includeSpamTrash: true`.
  - Paged until there is no `nextPageToken`.
  - Every chunk thread it returns is dropped.
- **The manual job search never serves as the exclusion check.** It is `MANUAL_QUERY` and/or the timespan only, and it doesn't include `excludeQuery`. Manual items reach the same chunk filter as scheduled items. The form `(<query>) (<excludeQuery>)` is withdrawn.

## Consequences

- Privacy holds at the thread level for manual runs too, which ADR-0005's manual form didn't guarantee.
- Scheduled and manual work share one code path for exclusion, so there's one thing to test.
- The window reaches from the oldest message to at least now, so a message indexed under a later date than its reported `internalDate` can't fall outside it. The costs:
  - one extra metadata header (`Date`) per message;
  - a wider window when a chunk holds a long-running thread, which means more non-chunk threads to page through.
- `includeSpamTrash: true` can only add threads to the excluded set. It never lets more mail through.
- The cost stays at one search per chunk (more if it pages). A wide window over a large mailbox may return many threads that aren't in the chunk, so E3 must page, and E7's chunk sizing should allow for it.
- Users need to know that terms joined by a space must all hold in **one** message: `from:lawyer.example subject:contract` doesn't match a thread where the two terms are in different messages (B4b). Use `OR` to exclude on either.
- Out of scope here, but found by E1: `threads.get` returns Spam and Trash messages, so the state builder (E4) could send them to Jev when a thread isn't excluded.

## Alternatives Considered

- **Keep ADR-0005's manual form, `(<query>) (<excludeQuery>)`:** it leaks when the two queries match different messages of a thread (E1).
- **Subtract the exclusion in the job search, `(<query>) -(<excludeQuery>)`:** it still returns the thread when another message matches the job query (E2).
- **A window per thread, OR'ed in one query (`((after:a1 before:b1) OR …)`):** it returned the same threads as the single wide window (G1), and would narrow what a large mailbox returns. It isn't adopted for v1 because it lengthens the query and adds a second shape to test. E7 can revisit it if paging cost shows up.
- **Evaluate exclusion by reading each message and matching locally:** Gmail's query language (labels, categories, `has:`, `larger:`) can't be reproduced reliably, and reading messages before exclusion defeats the purpose.
