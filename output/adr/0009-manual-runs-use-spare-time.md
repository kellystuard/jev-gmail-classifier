# ADR-0009: Manual runs use spare time and editor executions, not their own triggers

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §6.6](../solution-design.md#66-manual-runs), [PDD §4.7](../product-design-document.md#47-manual-runs)

## Context

- A backfill can take many executions.
- Chaining one-off triggers uses up the same 90 min/day trigger budget (on consumer accounts) that scheduled runs need.
- Editor executions don't count toward trigger runtime.
- Functions run from the editor can't take arguments.

## Decision

- **Input.** The user sets `MANUAL_QUERY` and/or `MANUAL_TIMESPAN` (converted to `after:<epoch>`), `MANUAL_APPLY_MOVES`, and `MANUAL_REPLACE` in Script Properties, then runs `startManualRun`.
- **Continuation.** A single job is saved in state. It continues in scheduled runs' spare time, after scheduled work, and in `continueManualRun` editor executions. `cancelManualRun` deletes it.
- **Filtering.** Manual runs skip `Jev/Error` threads and always apply `excludeQuery`.

## Consequences

- Scheduled processing can never be starved.
- Large backfills on consumer accounts are slow unless the user clicks `continueManualRun`.
- The cursor must survive across executions (E8).

## Alternatives Considered

- **Chained `.after()` triggers:** fast, but can starve scheduled runs.
- **`clasp run` from a local CLI:** needs a standard GCP project and an API-executable deployment.
- **A settings dialog:** out of scope for v1.
