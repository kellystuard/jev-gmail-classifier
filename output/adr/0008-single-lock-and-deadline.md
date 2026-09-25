# ADR-0008: One script-wide lock and a deadline for every execution

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §10.3–10.4](../solution-design.md#103-time-budget)

## Context

- Scheduled runs and editor runs can overlap.
- The queue, the budget, strike counts, and the position are all read, changed, and written back.
- Executions are limited to 6 minutes, and consumer accounts get about 37 s per scheduled run on average.

## Decision

- **Lock.** Every entry point calls `LockService.getScriptLock().tryLock(0)`. If the lock is busy, it logs `run.skipped` with reason `busy` and returns.
- **Deadline.** Every entry point creates one `Deadline`, with a soft limit (no new work after it) and a reserve (time to apply outcomes and save state for anything already sent).
- **Starting values** (tuned in E7): 30 s soft limit for scheduled runs, 4.5 min for manual runs, 10 s reserve.

## Consequences

- Only one execution ever changes state at a time.
- A skipped run costs about a second.
- A paid classification is never lost to a timeout.

## Alternatives Considered

- **Allowing overlap and making everything idempotent:** the budget and strike counts would drift.
