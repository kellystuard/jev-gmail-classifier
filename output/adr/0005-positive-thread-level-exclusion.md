# ADR-0005: Make `excludeQuery` a positive query applied per thread

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §6.4](../solution-design.md#64-process-classify-a-chunk), [PDD §4.3](../product-design-document.md#43-finding-work)

## Context

- The original `excludeQuery` example (`-from:mybank.com -label:Private`) was appended to the work search, so it really described mail to *keep*.
- Gmail search matches individual messages and returns whole threads. A thread with one message from the bank and one from anyone else still matched, and the **entire thread, including the bank's message, would have been sent to Jev**.
- The History API approach ([ADR-0004](0004-history-api-position.md)) doesn't use a work search at all.

## Decision

- `excludeQuery` is a **positive** description of mail to exclude, for example `from:mybank.com OR label:Private`.
- Before any thread in a chunk is read for Jev, run one search:
  - `(<excludeQuery>) after:<oldest message − 1 d> before:<newest message + 1 d>` for scheduled work.
  - `(<query>) (<excludeQuery>)` for manual runs.
- Drop every thread it returns. **If any message in a thread matches, the whole thread is never sent.**
- The query applies to every run, with no override.

## Consequences

- Privacy holds at the thread level, which is what users expect.
- It costs one extra search per chunk.
- E1 must confirm how Gmail handles grouping, `OR`, and epoch `after:`/`before:` values.
- This is a breaking change to the documented config semantics. It is fine because nothing has shipped.

## Alternatives Considered

- **Keep the "keep" filter semantics:** confusing to write, and it leaks mail at the thread level.
