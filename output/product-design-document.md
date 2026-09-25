# Jev Gmail Classifier: Product Design Document

> **Status:** Draft for v1 planning. Decided on 2026-09-24; updated on 2026-09-25 with the Solution Design decisions (see [§15](#15-decision-log)).
>
> **Where this fits:** the [Product Vision](product-vision.md) says *why* the product exists. This document says *what* v1 is and *how* it is shaped, at the level needed to plan epics. The [Solution Design](solution-design.md) says how it is built (architecture, technology, patterns), with the [Engineering Standards](engineering-standards.md) and [ADRs](adr/README.md) beside it. The [README](../README.md) holds the user-facing mechanics (configuration, permissions, limits, cost figures) and is not repeated here. Low-level details are expected to be settled during development; the ones already known are listed in [§13](#13-details-to-settle-during-development).

## 1. Product Summary

Jev Gmail Classifier is a Google Apps Script project that runs in the user's own Google account. On a timer, it finds Gmail conversations (threads) that have new mail, sends each one to the [Jev](https://docs.typesafe.ai/models) classification API from [TypeSafe AI](https://typesafe.ai/) along with the user's plain-English yes/no questions, and then labels or moves each thread according to the probabilities Jev returns.

The product is independent and not affiliated with TypeSafe AI or Google.

## 2. Users and Key Journeys

The user is a technical Gmail user (see the [Vision](product-vision.md#target-users)). v1 supports these journeys:

| Journey              | What the user does                                                                                  | What the product guarantees                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Set up**           | Clones the repo, writes `config.yaml` from the example, builds, pushes with `clasp`, adds the API key, runs `install`. | The build rejects an invalid config. `install` asks only for the documented permissions, saves its starting position, and creates the trigger. |
| **Everyday use**     | Nothing.                                                                                            | New mail is labeled or moved within about 2 trigger intervals, within quotas and the daily token cap. |
| **Tune a rule**      | Reads the execution log (probabilities per rule `id`), spot-checks a label in Gmail, adjusts a threshold or question, rebuilds, pushes. | Logs show enough to tune without exposing email bodies.                            |
| **Backfill**         | Sets a query and/or time span in Script Properties and starts a manual run, optionally applying moves. | Large runs continue across executions until done. The exclusion query still applies. |
| **Recover from errors** | Reads an alert email, fixes the cause (for example, the API key or a missing permission), removes `Jev/Error` from any threads to retry. | Problems are reported by email, at most once per condition per day. Nothing is lost while the key is broken. |
| **Upgrade**          | Pulls, builds, pushes.                                                                              | Labels and stored state carry over.                                                |
| **Uninstall**        | Runs `uninstall`.                                                                                   | The trigger and stored state are removed. Labels are left in place.                |

## 3. Scope

### 3.1 In v1

- Plain-English yes/no **rules**, each either applying a **label** or **moving** the thread (Archive, Spam, Trash, or Move to label).
- **Thread-based** classification, with reclassification when a thread receives new mail.
- **Scheduled runs** on a configurable interval, and **manual runs** for backfill and reclassification.
- A configurable **exclusion query** that keeps matching threads from ever being sent to Jev.
- A configurable **Jev model** (default `jev-latest`).
- A **daily token budget** that caps Jev spend.
- **Retries**, error classification, and the `Jev/Error` label.
- **Alert emails** and **structured execution logs** with per-question probabilities.
- `install` and `uninstall` functions.
- **Least-privilege permissions**, documented, with graceful handling when one is not granted.
- Both **consumer Gmail and Google Workspace** accounts.

### 3.2 Out of v1

- Removing labels, and replying, forwarding, sending, or permanently deleting mail.
- A dry-run mode or evaluation harness for tuning questions.
- A settings UI, Workspace Add-on, or Marketplace listing.
- Real-time processing (Gmail push through Pub/Sub) and any hosted server.
- A periodic digest email.
- An advanced HTML-to-text converter (`plainTextMethod: advanced` is reserved).
- Automated deployment.
- Attachments, multiple accounts, and other classifier providers.

See [§12](#12-roadmap-after-v1) for what may come later.

## 4. Functional Design

### 4.1 Rules

A **rule** is a unique `id`, one yes/no question, and one outcome. Rules live in `config.yaml` and are evaluated together.

- **Label rule** (the default): adds a Gmail label. Missing labels, including nested ones such as `Finance/Bill`, are created automatically.
- **Move rule**: moves the thread to one destination:
  - **Archive**: removes it from the Inbox.
  - **Spam**.
  - **Trash**: recoverable in Gmail for 30 days.
  - **Move to label**: adds a label *and* removes it from the Inbox, like Gmail's own "Move to."
- **Threshold:** a rule fires when Jev's yes-probability is at least the rule's `threshold`, or `defaultThreshold` if it has none. Label and move rules use the same thresholds; choosing a high threshold for a move rule is left to the user and encouraged by the docs.
- **ID:** a short slug that stays the same when a rule is reworded or reordered, so logged probabilities stay comparable over time.

### 4.2 Processing Pipeline

```text
Trigger fires
  └─ Check guardrails: one run at a time, time left in run, config valid, permissions, daily token budget
      └─ Ingest: read Gmail history since the saved position → queue threads with new mail
          └─ Process a bounded chunk of the queue:
              └─ Drop threads where any message matches the exclusion query
                  └─ For each thread: build Jev `state` (headers allowlist, plain text, truncated)
                      └─ Send all threads' requests concurrently (one request per thread, all rules in each)
                          └─ Retry temporary failures within the time left
                              └─ Apply outcomes: labels, then at most one move (or Jev/Error)
                                  └─ Dequeue, log, record token usage
  └─ Spare time: continue any manual run the same way
```

### 4.3 Finding Work

- **Scheduled runs** read Gmail's change history since a saved position. Each thread that received a new message, received or sent, is queued. Drafts, Spam, and Trash are ignored. No "processed" label is added: the position and the queue live in the script's stored state. The mechanism is in the [Solution Design](solution-design.md#63-ingest-gmail-history-to-work-queue).
- **Scope** is all mail except Spam, Trash, and drafts, so mail that other filters archive on arrival is still classified. `install` starts from "now"; older mail is classified with a manual run.
- **The exclusion query** is a Gmail search describing mail that must never be sent (for example `from:mybank.com OR label:Private`). It is always applied, to scheduled runs and to every manual run, with no override. If **any** message in a thread matches, the whole thread is skipped. It is a privacy control, not just a filter.

### 4.4 What Is Sent to Jev

Each thread is one request, containing every rule's question (keyed by rule `id`) and the thread's content: a list of messages, newest first, each with a fixed header allowlist under descriptive names and a plain-text body (converted from HTML when needed, per `plainTextMethod`). The oldest content is truncated first to fit Jev's limit. Attachments are never sent. The details are in the [README](../README.md#what-is-sent-to-jev) and the [Solution Design](solution-design.md#83-state-layout).

### 4.5 Applying Outcomes

- **All** matching label rules are applied.
- **At most one** move is applied. If several move rules match, the **first one in config order wins**.
- **Moves only happen for a brand-new thread** (every message arrived since the saved position), or during a manual run with the `applyMoves` option. When a reply makes an existing thread eligible again, reclassification only adds labels. This prevents the product from fighting a user who has moved a thread back (for example, clicking "Not spam").
- Labels are never removed in v1. The product adds only classification labels, plus `Jev/Error`.

### 4.6 Failures

- **Temporary failures** (rate limits, overload, network errors) are retried with exponential backoff and jitter, within the time left in the run. A thread that still fails stays queued for the next run. Which responses count as temporary is decided per case during development; a generic server error is not assumed to be temporary.
- **`Jev/Error`.** A thread that fails on 3 consecutive runs, or gets an invalid-request response, gets `Jev/Error` and is not retried automatically, not even when a new reply arrives. Removing the label retries it. Manual runs skip it.
- **A bad or missing API key** stops the run without marking anything.
- **A missing permission** is logged and alerted, and the run continues with what still works. If only a move can't be made, the labels are applied and the skipped move is logged.

Details are in the [README](../README.md#failures).

### 4.7 Manual Runs

A manual run takes a Gmail query and/or a recent time span (for example `2h`), and an optional **applyMoves** flag, entered as Script Properties because editor functions can't take arguments. It reclassifies every matching thread in chunks and continues across executions until done, using scheduled runs' spare time and optional extra editor runs. With `applyMoves`, **moves apply**. This is how a newly added move rule is backfilled, and the docs must warn that a new Trash rule plus `applyMoves` can move a lot of old mail. The run log reports how many threads went to each destination.

### 4.8 Guardrails

- **Execution time:** every run is bounded well under the 6-minute execution limit, and scheduled runs fit the daily trigger-runtime quota (90 minutes a day on consumer accounts). The polling interval is configurable, so accounts with more quota can poll more often. Only one execution runs at a time.
- **Daily token budget:** Jev's reported token usage is added up per day, across scheduled and manual runs. Once the budget is reached, no more requests are sent until the next day (in the script's time zone, `Etc/UTC` unless the user changes it), and an alert is sent. A run may overshoot by at most one batch. The default, `20,000,000` tokens, is $1.00/day at today's price rounded down to one significant figure.
- **Permissions:** only `gmail.modify`, external requests, trigger management, and send-mail are requested. The full-mail scope, which allows permanent deletion, is never requested.

### 4.9 Observability

- **Execution logs** are structured JSON. They record, per thread: thread ID, subject, sender, each question's probability by rule `id`, and the actions taken. Each run ends with a summary of counts, which is the evidence for the Coverage measure. Bodies are never logged. The probabilities are what a user tunes thresholds from.
- **Alert emails** go to the account owner when:
  1. the API key is rejected or missing;
  2. threads are newly marked `Jev/Error`;
  3. runs fail or time out repeatedly;
  4. the daily token budget is reached;
  5. a permission is missing;
  6. the configuration is invalid at runtime;
  7. Gmail's history had expired and a fallback search was used.

  Each condition sends at most one alert per day.

### 4.10 Lifecycle

- **Distribution:** clone or fork, build, `clasp push`. No Marketplace, no Apps Script library. `config.yaml` and `.clasp.json` are personal and git-ignored; example files are committed.
- **Versioning:** SemVer git tags and a changelog.
- **`install`:** asks for permissions, saves the starting position (keeping an existing one), and creates or replaces the trigger.
- **`uninstall`:** removes the trigger and stored state, and leaves labels and the API key in place.

## 5. Configuration Surface

All behavior is set in `config.yaml`. Field names below are working names; the final schema is settled in E2.

| Setting                  | Default      | Purpose                                                           |
| ------------------------ | ------------ | ----------------------------------------------------------------- |
| `defaultThreshold`       | (required)   | Minimum yes-probability for rules without their own threshold.    |
| `triggerIntervalMinutes` | `10`         | Polling interval: 1, 5, 10, 15, or 30.                            |
| `jevModel`               | `jev-latest` | Jev model version to request.                                     |
| `dailyTokenBudget`       | `20000000`   | Maximum Jev input tokens per day, across all runs.                |
| `excludeQuery`           | (none)       | Gmail search describing mail that is never sent to Jev; applied per thread. |
| `plainTextMethod`        | `basic`      | How HTML-only mail becomes plain text. `advanced` is reserved.    |
| `rules[].id`             | (required)   | Unique, stable rule name; the Jev question key and the log key.   |
| `rules[].question`       | (required)   | The yes/no question.                                              |
| `rules[].action`         | `label`      | `label` or `move`.                                                |
| `rules[].label`          | (required for `label`) | Label to apply.                                         |
| `rules[].destination`    | (required for `move`) | `archive`, `spam`, `trash`, or `label:<name>`.           |
| `rules[].threshold`      | `defaultThreshold` | Per-rule override.                                          |

The Jev API key is not in the config. It lives in `.env` locally and in Script Properties when deployed. The script's time zone is set in `appsscript.json` (default `Etc/UTC`). The configuration is validated at build time and again when the script loads it.

## 6. Technical Approach

The [Solution Design](solution-design.md) is the authority for how the product is built. In summary:

- **Platform:** Google Apps Script (V8 runtime) in the user's account, with a time-driven trigger and the Advanced Gmail Service. No hosted server in v1.
- **Language:** TypeScript, bundled by the build step into files Apps Script can run.
- **Build:** one step that validates `config.yaml`, generates the config as code, and bundles the source. **An invalid config fails the build** (for example, an unknown destination, a threshold outside 0–1, an unsupported interval, a duplicate rule `id`, or a missing field).
- **Tests:** unit tests run in Node against fakes of Gmail, `UrlFetchApp`, and the other Apps Script services, so retry, quota, budget, and move logic are tested without a real inbox.
- **CI:** GitHub Actions runs build, lint, and tests on every pull request. Deployment stays manual (`clasp push` from the maintainer's machine) in v1.

### 6.1 Main Components

| Component         | Responsibility                                                             |
| ----------------- | -------------------------------------------------------------------------- |
| Config            | Validated, generated rules and settings; re-validated at runtime.          |
| History sync (work finder) | Reads Gmail history since the saved position and queues threads with new mail. |
| Exclusion filter  | Removes every thread in which any message matches the exclusion query.     |
| State builder     | Turns a thread into Jev `state`: headers, plain text, truncation.          |
| Jev client        | Sends requests concurrently, retries, classifies errors, reports token usage. |
| Outcome applier   | Applies labels and the winning move, or `Jev/Error`.                       |
| Run controller    | Lock, time budgeting, token budget, scheduled vs. manual runs, continuation. |
| Notifier          | Structured logging and rate-limited alert emails.                          |
| Lifecycle         | `install`, `uninstall`, and the permission check.                          |

## 7. Non-Functional Requirements

| Area          | Requirement                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Reliability   | No eligible thread is silently skipped. Every thread ends up classified, excluded, or `Jev/Error`, and each run's summary accounts for it. |
| Quotas        | No execution fails from Apps Script quota or timeout errors at personal volume on a consumer account. |
| Cost          | Under $5/month at personal volume; never more than the daily token budget plus one batch.           |
| Privacy       | Only the header allowlist and plain-text bodies are sent. Excluded threads are never sent. Bodies are never logged. The script has no permission to permanently delete mail. |
| Latency       | Threads are handled within about 2 trigger intervals of arrival.                                    |
| Maintainability | Behavior changes need only a config edit, build, and push.                                        |

## 8. Constraints and Assumptions

- Apps Script cannot react to incoming mail, so the product polls.
- Apps Script quotas: 6 minutes per execution; 90 minutes a day of trigger runtime on consumer accounts (6 hours on Workspace); daily limits on URL fetches, Gmail operations, and sent email. See the [README](../README.md#google-apps-script).
- Jev accepts one `state` per request and has per-request token limits; prices and limits may change. See the [README](../README.md#jev).
- **Assumption to verify first:** Gmail's History API reports new received and sent messages, and label removals, reliably enough to drive the queue, and its history lasts long enough between runs. E1 confirms this, and the exclusion query's grouping behavior, before other work depends on it.
- Workspace admin policies that block external requests, unverified scripts, or individual permissions are outside the product's control and are documented, not solved.

## 9. Risks

| Risk                                                                 | Impact                                           | Mitigation                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| The History API misses events or expires sooner than expected.       | Threads are missed or classified late.           | E1 spike first. Queue with back-pressure; fallback date-based search and alert when history has expired. |
| The exclusion search misses a matching message.                      | Private mail is sent to Jev.                     | Exclusion is applied per thread, with a search window covering every message in the chunk. E1 verifies query grouping. |
| A new `jev-latest` release shifts probabilities.                     | Precision drops without any config change.       | The model is configurable, so a user can pin a version. Probability logs make drift visible. |
| Move rules misfire, especially Trash and Spam.                       | Mail is hidden from the user.                    | Precision-first defaults, documentation encouraging high thresholds for move rules, moves only for brand-new threads, per-destination counts in logs. |
| Consumer trigger-runtime quota is tight (about 37 s per run at 10 minutes). | Backlogs, or quota failures.               | Bounded runs, concurrent requests, a configurable interval, backfill only in spare time. |
| Jev price or limits change.                                          | Cost or truncation assumptions go stale.         | The budget is in tokens, not dollars. Figures in the README are dated.                |
| Moving to Spam through the Gmail API may or may not report the sender to Google. | Surprising side effects. | E1 confirms and the docs describe it.                                                 |
| A user doesn't grant every permission.                                | Parts of the product silently stop working.      | A permission check at install and every run, alerts, and graceful per-action fallback. |

## 10. Known Limitations (v1)

- A label the user removes by hand can be re-added when a reply arrives and the thread is reclassified.
- Moves are not reapplied on reclassification. For example, a reply to an archived thread returns it to the Inbox, as Gmail normally does. Replies to threads that started before installation get labels only.
- Threads in Spam or Trash are never reclassified.
- Each reply to a thread costs a new classification of the whole thread.
- Latency is bounded by the polling interval.
- There is no Gmail-visible marker of which threads have been classified; the logs are the record.
- Mail that arrives while the classifier is uninstalled is classified only by a manual run.

## 11. Release Criteria for v1

v1 is released when:

1. every in-scope feature in [§3.1](#31-in-v1) works;
2. the History API and exclusion-query behavior is confirmed (E1); and
3. it has run on the maintainer's own inbox for **2 consecutive weeks** while meeting the [Vision's success measures](product-vision.md#success-measures-v1). Precision is measured by manually spot-checking labels and moved threads in Gmail against the execution logs.

## 12. Roadmap After v1

Not committed and not ordered. See the [Vision](product-vision.md#possible-future-directions).

- Remove labels when a newer classification no longer matches, and respect user corrections.
- A dry run or evaluation harness for tuning questions.
- A periodic digest email.
- A fuller HTML-to-text converter (`plainTextMethod: advanced`).
- Automated deployment from `main` through a GitHub Action (needs `clasp` credentials stored as a repository secret).
- Real-time processing.
- A Workspace Add-on or Marketplace listing with a settings UI.

## 13. Details to Settle During Development

These are known low-level decisions, left to the epic that owns them. The [Solution Design §13](solution-design.md#13-epic-guidance) lists them per epic, with starting values.

- Final `config.yaml` field names and validation messages (E2).
- Queue size cap and sharding, exclusion-search batching, and the fallback window when history has expired (E3).
- The HTML-to-text `basic` conversion rules, the characters-per-token estimate, and the truncation safety margin (E4).
- Which responses are retryable, retry attempt count, backoff base, and jitter (E5).
- Chunk size, the time budget per run, and the permission-check API (E7).
- The manual-run cursor that survives across executions, and the time-span format (E8).
- Alert email format (E9).

## 14. Epics

Each epic is a planning unit for stories and tasks. E1 comes first because the rest of the design depends on what it confirms. The [Solution Design §13](solution-design.md#13-epic-guidance) gives each epic's architectural scope.

| #   | Epic                         | Goal                                                                                                  | Depends on |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| E1  | **Gmail behavior spike**     | Confirm History API behavior (new received and sent messages, label removals, expiry), exclusion-query grouping, and how labels and moves (Archive, Spam, Trash, Move to label) behave through the Gmail API. | None       |
| E2  | **Project foundation**       | Repo tooling, TypeScript bundling, config build with validation, manifest and scopes, `clasp` push, test harness with fakes, CI. | None       |
| E3  | **History sync**             | Saved position, history ingest, work queue, first-classification rule, exclusion filter, expired-history fallback. | E1, E2     |
| E4  | **Thread → `state`**         | Header allowlist, plain text or converted HTML (`basic`), newest-first order, truncation.              | E2         |
| E5  | **Jev client**               | Requests with all rules, concurrent sending, retries and backoff, error classes, token accounting, daily budget. | E2   |
| E6  | **Outcomes**                 | Label and move rules, config-order move conflicts, `Jev/Error`, the 3-strike rule, missing-permission fallback. | E1, E2 |
| E7  | **Scheduling and lifecycle** | Lock, run time budget, trigger, permission check, `install`, `uninstall`.                             | E3–E6      |
| E8  | **Manual runs**              | Query, time span, and applyMoves options; continuation across executions; per-destination counts.     | E7         |
| E9  | **Observability**            | Structured logging, alert emails, alert rate limiting.                                                | E5, E6     |
| E10 | **v1 release**               | Setup, permissions, and tuning docs; changelog; SemVer tag; 2-week pilot against the success measures. | All        |

## 15. Decision Log

Decisions made on 2026-09-24 that shape this document:

| Decision                                                            | Reason                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Target technical users; the author is the first user.               | Matches the YAML and `clasp` design; a UI is a later product. |
| Labels are a building block for automation, so precision beats recall. | A wrong label or move causes a wrong downstream action.     |
| Moves are part of v1, including Trash.                              | Routing is sometimes the right response to a classification. |
| Moves use the same thresholds as labels.                            | One model to learn; users set high thresholds where needed. |
| Moves only on first classification (or manual reprocess).          | Avoids fighting the user's own corrections, without stored state. |
| First matching move rule in config order wins.                      | Explicit and predictable.                                   |
| Exclusion query from config, always applied.                        | Turns privacy from a warning into a control.                |
| Model defaults to `jev-latest`, configurable.                       | Stays current; users can pin if they need stability.        |
| Daily token budget, default 20M tokens (about $1/day).              | Enforces the cost principle; tokens don't go stale when prices change. |
| Alerts by email to self, rate limited; no dry run in v1.            | Background failures must be visible; tuning uses probability logs instead. |
| TypeScript, build fails on invalid config, CI without auto-deploy.  | Testable logic and fast feedback; deploy needs personal credentials. |
| Consumer and Workspace accounts; configurable polling interval.     | Consumer quotas are the baseline; others can poll more often. |

Decisions made on 2026-09-25 during the Solution Design (details in the [ADRs](adr/README.md)):

| Decision                                                            | Reason                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Track progress with a Gmail History API position and a work queue; drop the `Jev/Processed` label ([ADR-0004](adr/0004-history-api-position.md)). | Only classification labels are added; removes the untested per-message `-label:` assumption; enables time-span manual runs. |
| "First classification" now means a brand-new thread (every message newer than the saved position); manual `reprocess` becomes `applyMoves`. | Follows from dropping `Jev/Processed`; slightly stricter, in keeping with precision-first. |
| Keep `Jev/Error` as the only system label; removing it retries the thread; a new reply doesn't ([ADR-0006](adr/0006-results-and-error-boundaries.md)). | Errors "shouldn't happen", so they deserve an actionable, visible label. |
| `excludeQuery` is a positive query of mail to exclude, applied per thread (**fix**) ([ADR-0005](adr/0005-positive-thread-level-exclusion.md)). | The previous form could send a whole thread, including an excluded message, to Jev. |
| Advanced Gmail Service with `gmail.modify` only; missing permissions are logged, alerted, and handled per action ([ADR-0003](adr/0003-advanced-gmail-service-and-scopes.md)). | The platform then makes permanent deletion impossible; granular consent can leave scopes ungranted. |
| Each rule has a required, unique `id` ([ADR-0010](adr/0010-jev-request-shape-and-retries.md)). | Stable Jev question keys and comparable probability logs across edits. |
| `plainTextMethod: basic` (default), `advanced` reserved ([ADR-0011](adr/0011-plain-text-extraction.md)). | `getPlainBody()` needs the full-mail scope and has known failures; a better converter can come later. |
| Config validated at build and at runtime; `config.yaml` and `.clasp.json` git-ignored with committed examples ([ADR-0013](adr/0013-config-validation-and-per-user-files.md)). | A stale or edited bundle can't run with bad config; personal rules stay out of a public repo. |
| Time zone comes from `appsscript.json`, default `Etc/UTC`.          | One well-known place; predictable default.                  |
| Manual runs are started through Script Properties and continue in scheduled runs' spare time ([ADR-0009](adr/0009-manual-runs-use-spare-time.md)). | Editor functions can't take arguments; backfill must never starve new mail. |
