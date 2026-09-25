# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard (stakeholder), Solution Architect
- **Related:** [Solution Design](../solution-design.md), [Engineering Standards §11](../engineering-standards.md#11-documentation)

## Context

Most of the code will be written by AI agents working epic by epic. Without a written record, each agent would re-derive, or quietly re-decide, choices that were already made.

## Decision

Keep lightweight ADRs in `output/adr/`, numbered `NNNN-kebab-title.md`, using the [template](template.md). Accepted ADRs are not rewritten; a new ADR supersedes an old one, and both are linked. The [index](README.md) lists every ADR. ADRs rank with the Solution Design: below the Vision and the PDD, above the README.

## Consequences

- Agents can load only the decisions relevant to their task.
- Changing a decision takes a small amount of deliberate work: write a new ADR.

## Alternatives Considered

- **Decisions only inside the Solution Design:** the reasoning gets lost as the document is edited.
