# ADR-0007: Keep all persistent state in Script Properties behind `StatePort`

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §7.3](../solution-design.md#73-script-properties-state)

## Context

- The product must store the position, the work queue, strike counts, the daily token usage, when each alert was last sent, the manual job, and a run heartbeat.
- Script Properties allow 9 KB per value and 500 KB per store.
- A Sheet or Drive file would add something the user owns and could break.

## Decision

- All state goes through a typed `StatePort`, backed by Script Properties.
- Keys are namespaced under `state.`.
- Values are versioned JSON (`{"v": 1, …}`).
- Anything that can grow is sharded across numbered keys, with a hard cap.
- User inputs (`JEV_API_KEY`, `MANUAL_*`, `RESET_POSITION`) are separate from `state.*`.
- `uninstall` deletes only `state.*`.

## Consequences

- There are no extra files for the user to manage.
- Storage can move later without touching the core.
- The size caps force back-pressure and pruning designs.

## Alternatives Considered

- **A Google Sheet ledger:** better for a future digest or evaluation tool, but more to set up.
- **Hidden strike labels:** clutter the user's labels.
