# ADR-0014: Structured JSON logging through `LogPort`

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §10.5](../solution-design.md#105-logging-and-alerts), [Engineering Standards §6](../engineering-standards.md#6-logging)

## Context

- Users tune thresholds by reading logged probabilities.
- Apps Script sends `console.*` output to Cloud Logging, and logging an object shows up as `jsonPayload`.
- Bodies and secrets must never be logged.

## Decision

- Every log entry is one JSON object per event through `LogPort`, with `event`, `runId`, `entry`, and `ts`.
- `console` is banned outside the log adapter.
- A `redact` helper scrubs known secret fields.
- The event list lives in the Solution Design.

## Consequences

- Logs can be filtered in Cloud Logging and read in the Executions view.
- Adding an event means updating the list in the Solution Design.

## Alternatives Considered

- **Human-readable lines:** hard to filter or aggregate for tuning.
