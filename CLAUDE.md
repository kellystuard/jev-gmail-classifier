# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Design is done; implementation hasn't started. No code, build tooling, or tests exist yet, so there are no build/lint/test commands to run. When code is added (E2), the planned commands are `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run probe`, and `npm run push` (see `output/engineering-standards.md` §2); update this file once they exist.

**Next step: backlog refinement.** The full v1 backlog was drafted from the design documents on 2026-09-25 and has not been refined yet. Before implementation starts, review the stories and tasks with the user: check scope, acceptance criteria, sizing, ordering, and dependencies, and update the issues. Start with E1 and E2, which have no dependencies and can run in parallel. Update this section when refinement is done.

## Work tracking

The v1 work lives in GitHub, in the **[Jev v1](https://github.com/users/kellystuard/projects/1)** Project (user project #1, linked to this repo) and the **v1.0** milestone. The conventions are in `output/engineering-standards.md` §13.

- **Three levels**, each marked by one label and linked as **sub-issues** (not just mentioned in the text):
  - **Epic** (`type: epic`): E1–E10 from the PDD §14, issues #7–#16.
  - **Story** (`type: story`): an outcome that can be tested, with acceptance criteria, under one epic.
  - **Task** (`type: task`): one PR's worth of work, under one story.

  Stories and tasks are #17–#160.
- **New issues** come from the forms in `.github/ISSUE_TEMPLATE/`. Each gets its type label, the `v1.0` milestone, a parent via the sub-issues API, a place on the Project, and the matching Project `Level` value (🟣 Epic, 🔷 Story, ✅ Task; field `PVTSSF_lAHOACXgPs4Bktm_zhjdVrc`, set with `gh project item-edit`).
- **PRs:** each PR closes one task (`Closes #N`). Move items through the Project's Status field (Todo, In Progress, Done).
- **Tooling note:** the local `gh` (2.45) has no `--parent` flag, so link a sub-issue with `gh api -X POST repos/kellystuard/jev-gmail-classifier/issues/<parent>/sub_issues -F sub_issue_id=<child's numeric id>`. The ID is the issue's `id` field, not its number. Project commands need the `project` token scope.

## Source-of-truth documents

Read them in this order. A higher document wins when two disagree:

1. `output/product-vision.md`: why the product exists, its target users, principles, success measures, and non-goals.
2. `output/product-design-document.md`: v1 scope, functional design, risks, release criteria, and the epic list (E1–E10). Low-level details are left to the epic that owns them (see its §13).
3. The technical documents, which rank together:
   - `output/solution-design.md`: the architecture, components, ports, runtime flows, data, integrations, and per-epic guidance.
   - `output/engineering-standards.md`: toolchain, code conventions, error handling, logging, testing, git workflow, and the Definition of Done.
   - `output/adr/`: one Architecture Decision Record per significant decision. Change a decision by adding a superseding ADR, not by editing an accepted one.
4. `README.md`: the user-facing design and mechanics. It must stay consistent with the documents above.

Load only what the task needs: `engineering-standards.md` §1 says which document to read for which kind of task.

`docs/archive/` holds the original notes and the superseded product requirements. They are historical records: do not follow or "fix" them.

## Intended architecture (summary; the Solution Design is authoritative)

A Google Apps Script project (TypeScript, bundled with esbuild, running in the user's Google account) that labels and moves Gmail threads using the Jev classification API from TypeSafe AI. The project is independent and not affiliated with TypeSafe AI or Google. Precision beats recall: a wrong label or move is worse than a missed one.

- **Layers (ports and adapters):**
  - `src/core` is pure: no Apps Script globals.
  - `src/app` orchestrates through the port interfaces in `src/ports`.
  - Only `src/adapters/gas` touches Apps Script globals.
  - `src/entry` wires everything up and exposes the global functions.
  - Everything is synchronous. ESLint enforces the boundaries.
- **Gmail access:** use the Advanced Gmail Service only (`GmailApp` is banned). The explicit scopes are `gmail.modify`, `script.external_request`, `script.scriptapp`, and `script.send_mail`. The script never requests `https://mail.google.com/`, so it can't permanently delete mail. A missing scope is logged and alerted, and handled per action, never crashing the run.
- **Trigger:** a time-driven trigger (1, 5, 10, 15, or 30 minutes) calls `onTrigger`. One script-wide lock (`tryLock(0)`) and a `Deadline` bound every execution.
- **Finding work:**
  - Save a Gmail History API position (`historyId`) in state.
  - Each run ingests `messageAdded` records (received and sent; drafts, Spam, and Trash ignored) and `labelRemoved` records (for `Jev/Error`) into a persisted work queue, then processes the queue in chunks.
  - There is **no** `Jev/Processed` label.
  - An expired position (404) falls back to a date-based search and sends an alert.
- **Exclusion:** `excludeQuery` is a *positive* Gmail query of mail never to send. If any message in a thread matches, the whole thread is dropped before anything is read for Jev.
- **Jev request:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`.
  - One request per thread, with `questions` keyed by each rule's required, unique `id`. Every question is a Noul (yes/no) question.
  - Requests go out concurrently via `UrlFetchApp.fetchAll`. Retries happen in rounds: re-send the retryable ones after a sleep.
- **`state` contents:** an array of message objects, newest first, with descriptive keys (`from`, `sender`, `replyTo`, `to`, `cc`, `subject`, `date`, `listId`, `listUnsubscribe`, `precedence`, `autoSubmitted`, `body`).
  - The body is plain text: the `text/plain` part, or HTML converted by `plainTextMethod: basic`.
  - Never send attachments or other headers.
  - Truncate the oldest content first, working on the structure, so `state` plus the longest question fits in 32k tokens.
- **Outcomes:**
  - A rule fires when its probability ≥ its `threshold` (or `defaultThreshold`).
  - All firing label rules apply. Missing labels, including nested ones, are created.
  - At most one move applies (`archive`, `spam`, `trash`, `label:<name>`), and the first firing move rule in config order wins.
  - Moves happen only for brand-new threads (every message newer than the saved position) or in manual runs with `applyMoves`.
  - Labels are never removed. Only classification labels and `Jev/Error` are ever added.
- **Failures:**
  - Results for expected failures, exceptions for invalid input or state. There are three error boundaries: per request, per thread, and per run.
  - The implementer classifies each response as retryable, a normal failure, or exceptional. A generic 500 is not assumed retryable.
  - 422 → `Jev/Error`.
  - 401 or a missing key → stop the run and mark nothing.
  - Failing on 3 consecutive runs → `Jev/Error`.
  - Removing `Jev/Error` retries the thread. A new reply doesn't, and manual runs skip it.
  - The daily token budget (summed from Jev's `usage.input_tokens`) stops sending until the next day, in the script's time zone.
- **Quotas:** every run is bounded well under the 6-minute limit and fits the daily trigger budget (90 min/day consumer, about 37 s per run at 10-minute intervals).
- **Manual runs:**
  - Set `MANUAL_QUERY` and/or `MANUAL_TIMESPAN` (plus `MANUAL_APPLY_MOVES` and `MANUAL_REPLACE`) in Script Properties, then run `startManualRun`.
  - The job continues in scheduled runs' spare time and in `continueManualRun`. `cancelManualRun` stops it.
- **Observability:**
  - Structured JSON logs through `LogPort` only. Log the thread ID, subject, sender, per-rule probabilities, actions, the Jev request ID, and a per-run summary. Never log bodies or the key.
  - Email the owner at most once per condition per day about: auth, new `Jev/Error` threads, repeated run failures, budget reached, a missing scope, invalid config, or expired history.

## Configuration and secrets

- **`config.yaml`** (repo root, **git-ignored**; copy it from `config.example.yaml`) holds:
  - `defaultThreshold`
  - `triggerIntervalMinutes`
  - `jevModel` (default `jev-latest`)
  - `dailyTokenBudget` (default `20000000`)
  - `excludeQuery`
  - `plainTextMethod` (default `basic`)
  - `rules[]`: `id`, `question`, `action` (`label` default or `move`), `label` or `destination`, and an optional `threshold`

  One Zod schema validates it at build time (failing the build) and again at runtime load, and the build generates a script file from it.
- **Time zone** is `timeZone` in `appsscript.json`, default `Etc/UTC`.
- **`.env`** (git-ignored; copy it from `.env.example`) holds `JEV_API_KEY` for local use, by the probe and spikes. The deployed script reads the key from Script Properties. It also holds the spike runner's credentials for the throwaway test account: `GMAIL_EMAIL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SPIKE_REFRESH_TOKEN`, and `SPIKE_SCRIPT_ID`. The same five are secrets in the `spike-account` GitHub environment. Run spikes with `node spikes/run.mjs push` and `node spikes/run.mjs run <function> [json]`, or dispatch `.github/workflows/spikes.yml` (manual only; the one workflow that makes live calls). See `spikes/README.md` and ADR-0016. Never print or commit these values or the test account's address (write `<test-account>`).
- **`.clasp.json`** is git-ignored; `.clasp.json.example` is committed.
- **Deployment** is via `clasp` 3, manually for v1. CI (GitHub Actions, Node 24 and 26) runs lint, typecheck, test, and a build against the example config.
- **`install`** checks scopes, saves the starting position (keeping an existing one unless `RESET_POSITION=true`), and creates or replaces the trigger. **`uninstall`** removes the trigger and `state.*` keys, and leaves labels and the key.
- **Git:** trunk-based, squash merge, Conventional Commit PR titles, release-please, and **signed commits required**.
