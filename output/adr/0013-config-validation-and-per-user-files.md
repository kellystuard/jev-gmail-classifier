# ADR-0013: Validate config at build and at runtime; git-ignore per-user files

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §7.2](../solution-design.md#72-configuration)

## Context

- Apps Script can't read YAML, so the build generates code from `config.yaml`.
- The repository is public (Apache-2.0), and a user's rules and exclusion query describe their mail. `.clasp.json` holds their `scriptId`.

## Decision

- **One Zod schema validates `config.yaml` at build time**, failing the build with field paths.
- **The same schema re-validates the embedded config when the script loads it at runtime.** A failure is invalid state: it throws `ConfigError`, alerts (`config_invalid`), and stops the run.
- **Each rule has a required, unique `id`.**
- **`config.yaml` and `.clasp.json` are git-ignored.** `config.example.yaml` and `.clasp.json.example` are committed. The build fails with a clear message if `config.yaml` is missing. CI builds the example.
- **The time zone is not in config.** It's `timeZone` in `appsscript.json`, which ships as `Etc/UTC`.

## Consequences

- A hand-edited or stale bundle can't run with an invalid config.
- Forks don't leak personal rules.

## Alternatives Considered

- **Committing `config.yaml`:** simpler for a single-user fork, but it leaks personal filters.
- **`timeZone` in `config.yaml`:** rejected in favour of the manifest the user already edits.
