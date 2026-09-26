# Architecture Decision Records

Decisions that shape the [Solution Design](../solution-design.md). See [ADR-0001](0001-record-architecture-decisions.md) for how ADRs work, and the [template](template.md) for new ones.

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-ports-and-adapters.md) | Ports and adapters around a pure core | Accepted |
| [0003](0003-advanced-gmail-service-and-scopes.md) | Advanced Gmail Service with `gmail.modify` only; missing scopes handled | Accepted |
| [0004](0004-history-api-position.md) | Gmail History API position instead of `Jev/Processed` | Accepted |
| [0005](0005-positive-thread-level-exclusion.md) | Positive `excludeQuery`, applied per thread | Accepted |
| [0006](0006-results-and-error-boundaries.md) | Results vs. exceptions; three error boundaries; `Jev/Error` lifecycle | Accepted |
| [0007](0007-script-properties-state.md) | Script Properties state behind `StatePort` | Accepted |
| [0008](0008-single-lock-and-deadline.md) | One script lock and a deadline per execution | Accepted |
| [0009](0009-manual-runs-use-spare-time.md) | Manual runs use spare time and editor runs | Accepted |
| [0010](0010-jev-request-shape-and-retries.md) | Jev request shape, `state` layout, retry rounds | Accepted |
| [0011](0011-plain-text-extraction.md) | `basic` plain-text converter behind `BodyConverter` | Accepted |
| [0012](0012-toolchain.md) | Toolchain | Accepted |
| [0013](0013-config-validation-and-per-user-files.md) | Config validated at build and runtime; per-user files git-ignored | Accepted |
| [0014](0014-structured-logging.md) | Structured JSON logging | Accepted |
| [0015](0015-git-workflow-and-releases.md) | Git workflow and releases | Accepted |
| [0016](0016-run-spikes-from-agents-and-a-manual-workflow.md) | Run spikes against a test account from agents and a manual workflow | Proposed |
