# ADR-0016: Run Gmail spikes against a test account from agents and a manual GitHub Actions workflow

- **Status:** Proposed
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, E1 developer agent
- **Related:** [Engineering Standards §8](../engineering-standards.md#8-testing), [Solution Design §10.6](../solution-design.md#106-security-and-privacy) and [§12](../solution-design.md#12-testing-architecture), [ADR-0003](0003-advanced-gmail-service-and-scopes.md), [`spikes/README.md`](../../spikes/README.md#running-spikes-automatically), issues #7 and #163

## Context

- E1 confirms Gmail behavior with spikes: plain Apps Script functions in one shared project, run against a throwaway consumer test account (`<test-account>`).
- The maintainer decided (epic #7, 2026-09-26) that agents and GitHub Actions must run spikes themselves. Pasting code into the editor and copying logs by hand doesn't scale to about ten parallel tasks.
- Engineering Standards §8 says "CI makes no live calls: no Gmail, no Jev, no secrets", and Solution Design §12 says "No live Gmail or Jev calls run in CI". A workflow that runs spikes contradicts both.
- The Apps Script API can do this:
  - `projects.getContent` / `projects.updateContent` read and replace a project's files. `updateContent` replaces **all** files, so pushes from parallel branches must merge.
  - `scripts.run` runs a function and returns only its return value. It needs a token carrying every scope the script declares, an OAuth client in the same **standard** Cloud project as the script, and the manifest's `executionApi` key. With `devMode: true` it runs the latest saved code, and only the owner may call it that way. Script errors come back inside an HTTP 200 response. Executions stop at 6 minutes.
- Google expires refresh tokens after 7 days for External apps whose consent screen is in **Testing** status. In production (even unverified), a token lasts until it's revoked, is unused for 6 months, or the password changes (for tokens with Gmail scopes). Source: [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2), "Refresh token expiration".

## Decision

- **Runner.** `spikes/run.mjs` and `spikes/auth.mjs` are zero-dependency Node scripts (Node 22 locally, Node 24 in CI). E1 has no `package.json`.
  - `push` merges this checkout's `spikes/*.js` and `spikes/appsscript.json` into the project (replace same-name files, keep the rest), writes immediately, re-reads to confirm its own files survived, and retries on a concurrent overwrite. It never deletes remote files.
  - `run` calls `scripts.run` with `devMode: true` on the script ID, after checking the function exists in the project. It prints the return value as JSON, or the script error and stack with exit code 1.
  - It uses `node:https` rather than `fetch`, because fetch's default 300-second headers timeout is shorter than Apps Script's 6-minute limit.
- **Account guard.** Every runner command first calls Gmail `users.getProfile` and refuses unless the address equals `GMAIL_EMAIL`. It also refuses a token that lacks a manifest scope or carries `https://mail.google.com/`. Output is scrubbed of the address, plus-addresses, and secrets.
- **Credentials.** One Desktop OAuth client in a standard Cloud project owned by the test account. `auth.mjs` runs a loopback flow with PKCE, once, and saves the refresh token to `.env` without printing it. The token's scopes are the four manifest scopes plus:
  - `script.projects`, for `getContent`, `updateContent`, and `projects.create` (the runner creates the spike project in setup);
  - `script.deployments`, so that if `scripts.run` turns out to need an API-executable deployment even in `devMode`, the runner can create one without a second consent round. It's a narrow scope on a throwaway account; drop it if verification shows it's never needed.
- **Consent screen publishing status: In production, unverified.** Testing status would expire the token every 7 days, breaking unattended runs and #21's 7-day retention watch. Unverified apps are limited to 100 users and show a warning screen, which is irrelevant for one account.
- **Workflow.** `.github/workflows/spikes.yml` is `workflow_dispatch` only (inputs `function`, `args`, `push`). It reads the five secrets (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SPIKE_REFRESH_TOKEN`, `SPIKE_SCRIPT_ID`, `GMAIL_EMAIL`) from the `spike-account` environment, pushes, runs, and writes the result to the log and job summary. Workflow inputs reach the shell only through environment variables.
- **The rule "CI makes no live calls" is amended, not dropped.** PR and `main` CI (lint, typecheck, test, build) still makes no live calls and uses no secrets. The only live-call workflow is the manually dispatched `spikes.yml`, against the throwaway test account only. Product code is never run against a real mailbox from CI.

## Consequences

- Agents run spikes, read the JSON, and record findings without the maintainer. The maintainer does a one-time setup (Cloud project, consent screen, client, token, linking the spike project) and only Gmail-UI or consent steps after that.
- **Security trade-off.** Anyone with write access can dispatch `spikes.yml` against any branch, and that branch's code runs with the environment's secrets (and could exfiltrate the refresh token). The token can read and modify the test account's mail and edit its Apps Script projects, and it cannot permanently delete mail. That's acceptable only because the account is a throwaway with synthetic mail. The environment must never hold credentials for a real mailbox. If the repository gains outside collaborators, add required reviewers to the `spike-account` environment.
- The shared project's manifest is last-writer-wins, and `push` never deletes files, so abandoned spikes are removed by hand in the editor.
- The token stops working if the test account's password changes, the jev-spike-runner grant is removed at myaccount.google.com/connections (a risk in #27), or it goes unused for 6 months. `auth.mjs` mints a new one; the secret must then be updated.
- `.env` now holds spike credentials as well as `JEV_API_KEY` (Solution Design §10.6).
- The E2 build, lint, and test tooling continues to exclude `spikes/`.

## Alternatives Considered

- **`clasp push` / `clasp run`:** a dependency and a login flow for Node, and `clasp push` replaces the whole project, which would delete other branches' spikes. The runner needs the same Cloud project and API setup anyway.
- **Consent screen in Testing status:** no "unverified app" screen, but the token expires every 7 days, so the maintainer would re-run `auth.mjs` weekly.
- **A service account:** consumer Gmail accounts don't support domain-wide delegation, so a service account can't act on the test account's mailbox.
- **Running spikes on `pull_request`:** automatic, but every PR, including Dependabot's, would get live credentials, and runs would race on the shared project for no benefit.
- **A versioned API-executable deployment for every run:** runs pinned code, but each push would need a new version and deployment, and parallel branches would fight over which one is current. `devMode` runs the latest pushed code, which is what a spike wants.
