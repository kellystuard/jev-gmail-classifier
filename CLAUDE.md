# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

The tooling is in place (E2, #8), history sync is done (E3, #9), and so are Thread → `state` (E4, #10), the Jev client (E5, #11), Outcomes (E6, #12), Scheduling and lifecycle (E7, #13), Manual runs (E8, #14) and Observability (E9, #15). `src/` has the layers, the ports, the config schema and loader, and the entry points. Since E3 it also has the state codec and crash-safe sharding, the work queue, ingest (with the resumable expired-history fallback), chunk screening (`screenChunk`: it skips deleted and `Jev/Error` threads, fixes the first-classification flag and applies the exclusion filter), and the reading half of the Gmail adapter and the whole Script Properties adapter (`src/adapters/gas/`). Since E4, `src/core/` also has the `state` builder (`jev-state.ts`), the MIME body walker and the `basic` HTML converter (`src/core/body/`), the token estimate (`token-estimate.ts`), truncation (`truncation.ts`) and `threadToState` (`thread-state.ts`), the one entry point that turns a thread into Jev's `state`; `src/adapters/gas/gas-utf8.ts` decodes body bytes. Since E5 it also has the Jev client: in `src/core/`, the request builder (`jev-request.ts`), the response classification and interpretation (`jev-status.ts`, `jev-response.ts`: `interpretResponse` gives a `JevResult`), the retry policy (`retry-delay.ts`) and the daily token budget (`token-budget.ts`); in `src/app/`, the sender (`jev-sender.ts`: `sendJevRequests` sends in batches of 20 per `fetchAll`, retries in rounds, up to 3 attempts, and checks and records the budget per batch) and the budget store (`budget-store.ts`); in `src/adapters/gas/`, the `fetchAll` HTTP adapter and the secrets adapter; and the local probe (`scripts/probe.ts`). `test/fakes/` has in-memory fakes of the ports. Since E6 it also has the outcomes: in `src/core/`, the decision (`decide.ts`: `decideOutcome`, `movesAllowed`), label paths (`label-path.ts`: `labelAncestors`, `JEV_ERROR_LABEL`) and the `threads.modify` change (`thread-change.ts`); in `src/app/`, the per-run label cache (`label-cache.ts`: `createLabelCache`), applying a decision in one `modifyThread` with the missing-scope fallback (`apply-decision.ts`: `applyDecision`), strikes and `Jev/Error` (`jev-error.ts`: `markJevError`, `strikeOrError`), and the per-thread error boundary (`settle-thread.ts`: `settleThread` turns one sender entry into a `ThreadSettlement`); in `src/adapters/gas/`, the Gmail adapter's write half (`listLabels`, `createLabel`, `modifyThread`). Since E7 it also has the scheduling and lifecycle: in `src/core/`, the run limits per trigger interval (`run-limits.ts`: soft limit, reserve, chunk size, Gmail units per run, `GMAIL_UNIT_COST`), the `Deadline` (`deadline.ts`), the `state.gmailCalls` codec (`gmail-calls.ts`), the scope → feature map (`scope-features.ts`), the `state.runs` codec (`run-record.ts`) and the `state.installedAt` codec (`install-record.ts`); in `src/app/`, the counting `GmailPort` (`counting-gmail.ts`: `countGmailCalls`, `loadGmailCalls`, `saveGmailCalls`), the scope preflight (`scope-preflight.ts`: `checkScopes`), one chunk end to end (`process-chunk.ts`: `processChunk`), the run preflight (`run-preflight.ts`: `runPreflight`: key, scopes, budget), the alert collector and E7's do-nothing sink (`alerts.ts`: `createAlertCollector`, `logOnlyAlertSink`), the per-run boundary (`run-entry.ts`: `runEntry`: lock, config, limits, `Deadline`, the `state.runs` heartbeat, the Gmail tally, `run.start` / `run.skipped` / `run.failed`), the run controller (`run-controller.ts`: `runScheduled`: preflight, ingest, the chunk loop with each thread settled at most once per run, `run.end`), and `install` and `uninstall` (`install.ts` with `requireScopes` for the three essential scopes, `uninstall.ts`); in `src/adapters/gas/`, the lock, trigger, auth, clock, random and log adapters. `src/entry/main.ts` is the composition root: it builds the adapters per call and wires all six entry points through `runEntry`, so the script now **does something** when deployed (`install` saves the position and creates the trigger, each trigger run ingests and classifies in bounded chunks, `uninstall` removes the trigger and state). Since E8 it also has the manual runs: in `src/core/`, the timespan grammar (`timespan.ts`), the four `MANUAL_*` inputs and their refusals (`manual-input.ts`), the job record and its search cursor (`manual-job.ts`), the counts and the `manual.*` report events (`manual-counts.ts`), `dropManualWork` and `takeChunk`'s `source` filter (`work-queue.ts`); in `src/app/`, the job store (`manual-job-store.ts`), the search-page refill (`manual-refill.ts`), the editor run and the spare-time hook (`manual-run.ts`: `continueManualJob`, `createManualSpareTime`), the start (`manual-start.ts`: `startManualJob`, a refusal is a result) and the cancel (`manual-cancel.ts`: `cancelManualJob`); the Gmail port's `invalid_page_token` failure; and in `src/entry/main.ts`, the three manual entry points and `onTrigger`'s spare-time hook (a refused start returns `{status: 'rejected', reason}` and is not a failed run). `startManualRun` starts a job and continues it, `continueManualRun` continues it and `cancelManualRun` removes it; `onTrigger` continues a job in its spare time. Since E9 it also has the observability, so the script **tells its owner when something is wrong**: in `src/core/`, `redact` (`redact.ts`: forbidden field names, `Bearer` values, the secret values and over-long strings are scrubbed from every log line), the event catalog (`log-events.ts`: `LOG_EVENT_LEVELS`, `LOG_EVENTS`; tests keep it equal to the log calls in `src/` and to the "Main events" list in SD §10.5, so a new event goes in both), the `state.alerts` codec and the once-a-day rule (`alert-limit.ts`: `dueAlerts`, `markAlertSent`) and the alert email texts (`alert-email.ts`: `buildAlertEmail`, `ALERT_SUBJECT_PREFIX`); in `src/app/`, the alert mailer (`alert-mailer.ts`: `createMailAlertSink`, the `AlertSink` that emails the owner, with the `state.alerts` store) and `run_failures` in `run-entry.ts` (3 failed or unfinished runs in a row, counted in `state.runs`; the event `run.unfinished`); in `src/adapters/gas/`, the mail adapter (`gas-mail-adapter.ts`, with the pure `mail-errors.ts`) and `redact` in the log adapter; and in `src/entry/main.ts`, the wiring: the mailer for `onTrigger`, `install`, `startManualRun` and `continueManualRun` (`uninstall` and `cancelManualRun` keep `logOnlyAlertSink`: the mailer writes `state.alerts`), and the Jev key as the log adapter's secret value. Use Node 24 (`.nvmrc`; `fnm use` or `nvm use`), then `npm ci`. The commands (`output/engineering-standards.md` §2):

- `npm run build`: validates `config.yaml`, then writes `dist/Code.js` and `dist/appsscript.json` (and `src/generated/`, `config.schema.json`). Without your own `config.yaml`, run `npm run build -- --config config.example.yaml`.
- `npm run lint`: ESLint (including the layer and V8 rules) and `prettier --check`. `npm run format` rewrites files with Prettier.
- `npm run typecheck`: `tsc --noEmit`.
- `npm test`: Vitest once, with coverage (reported, never enforced). `npm run test:watch` runs it in watch mode.
- `npm run push`: `build` from `config.yaml`, then `clasp push` to the project in your `.clasp.json`. It's the only deploy, and it's manual.
- `npm run probe -- [--config <file>] [--show-state] [--json] [--env <file>] <file.eml>...`: the local Jev probe (E5). It sends each `.eml` to Jev with your key (from `.env`) and prints each rule's probability and whether it fires. Use only synthetic mail, or mail you are happy to send.

CI runs `npm ci`, lint, typecheck, test, the example-config build, and `git diff --exit-code` on Node 24 and 26 for every PR and push to `main`.

**Next step.** E1's last task, the history-retention watch (#21), stays open until at least 2026-10-03. E10 (v1 release, #16) is the last epic in the order of PDD §14. It was refined on 2026-10-01: its epic body has the waves, the Read first list and the binding decisions 1–17. E10 builds no feature: it writes the README's Setup, Permissions, Tuning and recovery sections (#150, #151, #152), turns `docs/smoke-test.md` into the release checklist (#154) and runs it on the test account (#155), runs a 14-day pilot on the maintainer's own mailbox (#315, #157, #158), and cuts `v1.0.0` (#160). Every E10 issue is Ready, and the maintainer's answers (2026-10-01) are in the epic body: an agent runs the smoke test through the spike runner (#155); the pilot's log is exported from a Cloud project attached to the pilot's script, by an agent on the maintainer's machine (#157); and v1.0.0 is released without a run on a Workspace account (#160). Wave 1 is #150, #151, #152, #154, #315 and the bug #314, which measures Jev's token rate limit against a batch of 20 requests. No agent runs anything on the maintainer's mailbox or opens its mail. An agent may read the pilot's log, but nothing from it that holds mail content goes into an issue, a PR, a commit or a file in this public repository. No agent pushes to Apps Script from a worktree (`.worktreeinclude` copies the maintainer's `.clasp.json` into it). The epics are tracked in the Project. Refine each epic the way E2 was refined: check scope, acceptance criteria, sizing, ordering, and dependencies. Put the merge order, the files to read, and the binding decisions in the epic body, and make each story and task self-contained for an independent agent, with a Read first list. Issues with open questions carry the `needs: maintainer` label; the rest go to the Project's Ready status.

## Work tracking

The v1 work lives in GitHub, in the **[Jev v1](https://github.com/users/kellystuard/projects/1)** Project (user project #1, linked to this repo) and the **v1.0** milestone. The conventions are in `output/engineering-standards.md` §13.

- **Three levels**, each marked by one label and linked as **sub-issues** (not just mentioned in the text):
  - **Epic** (`type: epic`): E1–E10 from the PDD §14, issues #7–#16.
  - **Story** (`type: story`): an outcome that can be tested, with acceptance criteria, under one epic.
  - **Task** (`type: task`): one PR's worth of work, under one story.

  Stories and tasks are #17–#160, plus #287, #288, #289, #302, #303, #304 and #315. E10's bugs start at #314.
- **New issues** come from the forms in `.github/ISSUE_TEMPLATE/`. Each gets its type label, the `v1.0` milestone, a parent via the sub-issues API, a place on the Project, and the matching Project `Level` value (🟣 Epic, 🔷 Story, ✅ Task; field `PVTSSF_lAHOACXgPs4Bktm_zhjdVrc`, set with `gh project item-edit`).
- **PRs:** each PR closes one task (`Closes #N`). Move items through the Project's Status field: Todo (drafted), Ready (refined, no open questions), In progress, Done.
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
  - An expired position (404) starts a resumable fallback: a search of time windows (oldest first, from an hour before the last successful ingest), saved in `state.fallback` after each window and continued across runs. It reports the `history_expired` alert once. E3 sends nothing: E7 passes the condition on and E9 sends it.
- **Exclusion:** `excludeQuery` is a *positive* Gmail query of mail never to send. If any message in a thread matches, the whole thread is dropped before anything is read for Jev.
  - `screenChunk` reads the chunk's threads in metadata form and runs one search per chunk, and it fails closed: if a read or search fails, no thread from that chunk goes on.
  - It also skips deleted threads, threads marked `Jev/Error`, and threads with no message outside Drafts, Spam and Trash. Ingest makes no per-thread reads, so these checks happen at an item's first read.
- **Jev request:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`.
  - One request per thread, with `questions` keyed by each rule's required, unique `id`. Every question is a Noul (yes/no) question.
  - Requests go out concurrently via `UrlFetchApp.fetchAll`, in batches of 20. Retries happen in rounds, 3 attempts in all: re-send the retryable ones after a sleep.
- **`state` contents:** an array of message objects, newest first, with descriptive keys (`from`, `sender`, `replyTo`, `to`, `cc`, `subject`, `date`, `listId`, `listUnsubscribe`, `precedence`, `autoSubmitted`, `body`).
  - The body is plain text: the `text/plain` part, or HTML converted by `plainTextMethod: basic`.
  - Never send attachments or other headers.
  - Truncate the oldest content first, working on the structure, so `state` plus the longest question fits in 32,768 tokens and `state` plus all questions in 65,536, estimated as UTF-8 bytes with a fixed overhead and a margin (SD §8.4).
- **Outcomes:**
  - A rule fires when its probability ≥ its `threshold` (or `defaultThreshold`).
  - All firing label rules apply. Missing labels, including nested ones, are created.
  - At most one move applies (`archive`, `spam`, `trash`, `label:<name>`), and the first firing move rule in config order wins.
  - Moves happen only for brand-new threads (every message newer than the saved position) or in manual runs with `applyMoves`.
  - Labels are never removed. Only classification labels and `Jev/Error` are ever added.
- **Failures:**
  - Results for expected failures, exceptions for invalid input or state. There are three error boundaries: per request, per thread, and per run.
  - The implementer classifies each response as retryable, a normal failure, or exceptional. A generic 500 is not assumed retryable.
  - 422 → `Jev/Error`, and so does the 400 `max_tokens_exceeded` for a request over Jev's token limit.
  - 401 or a missing key → stop the run and mark nothing.
  - Failing on 3 runs → `Jev/Error`. A run that leaves the thread untouched neither adds a strike nor resets them.
  - Removing `Jev/Error` retries the thread. A new reply doesn't (it is queued, then skipped at its first read), and manual runs skip it.
  - The daily token budget (summed from Jev's `usage.input_tokens`) stops sending until the next day, in the script's time zone.
- **Quotas:** every run is bounded well under the 6-minute limit and fits the daily trigger budget (90 min/day consumer, about 37 s per run at 10-minute intervals).
- **Manual runs:**
  - Set `MANUAL_QUERY` and/or `MANUAL_TIMESPAN` (plus `MANUAL_APPLY_MOVES` and `MANUAL_REPLACE`) in Script Properties, then run `startManualRun`. A refused start leaves them; a started job deletes all four.
  - The job continues in scheduled runs' spare time and in `continueManualRun`. `cancelManualRun` stops it.
- **Observability:**
  - Structured JSON logs through `LogPort` only. Log the thread ID, subject, sender, per-rule probabilities, actions, the Jev request ID, and a per-run summary. Never log bodies or the key: the log adapter runs `redact` on every event as the last line of defence.
  - Email the owner at most once per condition per day (in the script's time zone) about: auth, new `Jev/Error` threads, repeated run failures (3 failed or unfinished runs in a row), budget reached, a missing scope, invalid config, or expired history. Each subject starts with `[Jev Gmail Classifier]`. An alert that can't be sent is logged (`alert.failed`) and never changes the run.

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
- **Deployment** is via `clasp` 3 (`npm run push`), manually for v1. CI (`.github/workflows/ci.yml`, Node 24 and 26) runs lint, typecheck, test, and a build against the example config. Its aggregate job `ci` is the one required check. Dependabot opens weekly update PRs, with no auto-merge.
- **`install`** checks scopes, saves the starting position (keeping an existing one unless `RESET_POSITION=true`), and creates or replaces the trigger. **`uninstall`** removes the trigger and `state.*` keys, and leaves labels and the key.
- **Git:** trunk-based, squash merge, Conventional Commit PR titles, release-please, and **signed commits required**. The "Protect main" ruleset requires a PR, the `ci` check, signed commits, and squash merges, with no approving review (ADR-0018). Never merge with the admin bypass (`gh pr merge --admin`). A release-please PR's CI run waits for approval, so before squash-merging one, approve that run (ES §10) and wait for `ci` to pass.
