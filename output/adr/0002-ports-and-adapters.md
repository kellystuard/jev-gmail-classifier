# ADR-0002: Structure the code as ports and adapters around a pure core

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §4–5](../solution-design.md#4-architecture-overview)

## Context

The PDD requires the retry, quota, budget, and move logic to be tested in Node, without a real inbox. Apps Script services are globals that don't exist in Node.

## Decision

- `src/core/` is pure: no globals, I/O, clock, or randomness.
- `src/app/` orchestrates the use cases through port interfaces in `src/ports/`.
- `src/adapters/gas/` is the only code that touches Apps Script globals.
- `src/entry/` is the composition root and exposes the global functions.
- All ports are synchronous.
- ESLint enforces the boundaries.

## Consequences

- Decision logic is fast to test, and deterministic.
- Each port needs one adapter and one in-memory fake.
- Adapters are thin and are verified by spikes and a manual smoke checklist, not by unit tests.

## Alternatives Considered

- **Plain modules calling globals, with globals mocked in tests:** tests end up checking the mocks, and the boundary erodes.
