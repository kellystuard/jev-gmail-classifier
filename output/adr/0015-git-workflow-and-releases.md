# ADR-0015: Trunk-based workflow, Conventional Commits, release-please, signed commits

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Engineering Standards §9–10](../engineering-standards.md#10-git-ci-and-releases)

## Context

The PDD requires SemVer tags and a changelog. The maintainer requires signed commits. Most changes will come from agents in short-lived branches.

## Decision

- **Trunk-based development**, with PRs into `main` and squash merges.
- **Conventional Commit** PR titles.
- **release-please** maintains `CHANGELOG.md` and SemVer tags.
- **Branch protection** on `main` requires signed commits, passing CI (lint, typecheck, test, and build on Node 24 and 26), and a CODEOWNERS review.
- **Dependabot** runs weekly for npm and GitHub Actions, with no auto-merge.
- **Deployment stays manual** in v1.

## Consequences

- The changelog and versions come from history, with no manual release notes.
- Every contributor, human or agent, needs commit signing set up.

## Alternatives Considered

- **A hand-written changelog:** easy to forget.
- **Renovate:** more configurable, but needs a GitHub App.
