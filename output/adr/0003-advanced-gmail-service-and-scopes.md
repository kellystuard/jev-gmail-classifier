# ADR-0003: Use the Advanced Gmail Service with the `gmail.modify` scope only

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §9](../solution-design.md#9-gmail-integration), [README Permissions](../../README.md#permissions)

## Context

- Every `GmailApp` method documents only the full `https://mail.google.com/` scope. That scope allows permanent deletion.
- There are reports of `GmailApp` returning empty results *silently* when a narrower scope is pinned.
- The Gmail API accepts `gmail.modify` for everything v1 needs: `history.list`, `threads.list` with `q`, `threads.get`, `threads.modify` (including `INBOX` and `SPAM`), `threads.trash`, `labels.create`, and `getProfile`.
- `gmail.modify` explicitly cannot permanently delete. `threads.delete` requires `https://mail.google.com/`.
- Google's granular consent lets a user decline some of the scopes a script declares.

## Decision

- Use only the Advanced Gmail Service (`Gmail.Users.*`). Lint bans `GmailApp`.
- Declare explicit `oauthScopes`:
  - `gmail.modify`
  - `script.external_request`
  - `script.scriptapp`
  - `script.send_mail`
- Never request `https://mail.google.com/`.
- Get the owner's address from `Gmail.Users.getProfile('me')`.
- **Missing scopes are handled, not fatal:**
  - A preflight check at `install` and at each run logs `scope_missing` with the features it disables, and alerts once a day.
  - Adapters turn a 403 "insufficient scopes" into a `scope` result.
  - If only a move fails, labels are still applied, the move is skipped (`moveSkipped: "scope"`), and the thread counts as handled. After the fix, a manual run with `applyMoves` redoes it.
- The README documents each scope, why it's needed, and what breaks without it.

## Consequences

- "Never permanently deletes" is enforced by the platform, not only by our code.
- Message bodies must be decoded from the MIME tree ourselves, because `getPlainBody()` isn't available ([ADR-0011](0011-plain-text-extraction.md)).
- Label IDs, not names, are used on the API, so a per-run label cache is needed.

## Alternatives Considered

- **`GmailApp` with the full scope:** simpler API, but it permits permanent deletion and has known `getPlainBody()` failures.
- **Mixing `GmailApp` for bodies with the Advanced Service for everything else:** still forces the full scope.
