# ADR-0006: Results for expected failures, exceptions for invalid input or state, three error boundaries

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §10.1](../solution-design.md#101-error-model), [Engineering Standards §5](../engineering-standards.md#5-error-handling)

## Context

The PDD's failure rules (422 → `Jev/Error`, 401 → stop, 3 strikes, retry on temporary errors) form a decision table. Some failures are ordinary outcomes; others mean something is broken.

## Decision

- **Expected failures are results.** Code that receives one handles it as ordinary control flow, and "fails successfully" too.
- **Exceptions are thrown only for invalid input or state**, for example a bad config, a malformed 200 response, or a missing answer.
- **Throwing a typed exception on purpose to reach a shared handler is allowed.** For example, a failed result and an unexpected 500 can both reach the same per-thread handler.
- **Three boundaries:**
  - **Per request:** the Jev client returns results.
  - **Per thread:** decides between a strike and `Jev/Error`. One thread never stops the run.
  - **Per run:** logs, records the failure, alerts, and rethrows.
- A 401 or a missing key throws `RunAbortError`, which stops the run without marking anything.
- **The implementer classifies each failure** as retryable, normal, or exceptional for their use case. They document the choice in code and test it. For example, a generic 500 is exceptional, not retryable.
- **`Jev/Error` stays as a label:**
  - It's added after a 422 or after 3 strikes.
  - Only the user removes it, and removing it retries the thread through history.
  - A new reply does not retry it.
  - Manual runs skip it.

## Consequences

- Failure handling is explicit and testable as data.
- A failed run still shows as Failed in the Apps Script execution list.

## Alternatives Considered

- **Exceptions throughout:** the decision table gets buried in `catch` chains.
- **A state-only error list with a `retryErrors` function:** invisible in Gmail. `Jev/Error` "shouldn't happen", so it should be an actionable label.
