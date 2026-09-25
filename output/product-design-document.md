# Jev Gmail Classifier: Product Design Document

> **Status:** Draft for v1 planning. Decided on 2026-09-24.
>
> **Where this fits:** the [Product Vision](product-vision.md) says *why* the product exists. This document says *what* v1 is and *how* it is shaped, at the level needed to plan epics. The [README](../README.md) holds the detailed mechanics (queries, headers, limits, cost figures) and is not repeated here. Low-level details are expected to be settled during development; the ones already known are listed in [§13](#13-details-to-settle-during-development).

## 1. Product Summary

Jev Gmail Classifier is a Google Apps Script project that runs in the user's own Google account. On a timer, it finds Gmail conversations (threads) that have new mail, sends each one to the [Jev](https://docs.typesafe.ai/models) classification API from [TypeSafe AI](https://typesafe.ai/) along with the user's plain-English yes/no questions, and then labels or moves each thread according to the probabilities Jev returns.

The product is independent and not affiliated with TypeSafe AI or Google.

## 2. Users and Key Journeys

The user is a technical Gmail user (see the [Vision](product-vision.md#target-users)). v1 supports these journeys:

| Journey              | What the user does                                                                                  | What the product guarantees                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Set up**           | Clones the repo, writes `config.yaml`, builds, pushes with `clasp`, adds the API key, runs `install`. | The build rejects an invalid config. `install` creates the trigger and records the install date. |
| **Everyday use**     | Nothing.                                                                                            | New mail is labeled or moved within about 2 trigger intervals, within quotas and the daily token cap. |
| **Tune a rule**      | Reads the execution log (probabilities per question), spot-checks a label in Gmail, adjusts a threshold or question, rebuilds, pushes. | Logs show enough to tune without exposing email bodies.                            |
| **Backfill**         | Starts a manual run with a Gmail query, optionally reprocessing already-processed threads.          | Large runs continue across executions until done. The exclusion query still applies. |
| **Recover from errors** | Reads an alert email, fixes the cause (for example, the API key), removes `Jev/Error` from any threads to retry. | Problems are reported by email, at most once per condition per day. Nothing is lost while the key is broken. |
| **Upgrade**          | Pulls, builds, pushes.                                                                              | Labels and stored state carry over.                                                |
| **Uninstall**        | Runs `uninstall`.                                                                                   | The trigger and stored state are removed. Labels are left in place.                |

## 3. Scope

### 3.1 In v1

- Plain-English yes/no **rules**, each either applying a **label** or **moving** the thread (Archive, Spam, Trash, or Move to label).
- **Thread-based** classification, with reclassification when a thread receives new mail.
- **Scheduled runs** on a configurable interval, and **manual runs** for backfill and reprocessing.
- A configurable **exclusion query** that keeps matching mail from ever being sent to Jev.
- A configurable **Jev model** (default `jev-latest`).
- A **daily token budget** that caps Jev spend.
- **Retries**, error classification, and the `Jev/Error` label.
- **Alert emails** and **execution logs** with per-question probabilities.
- `install` and `uninstall` functions.
- Both **consumer Gmail and Google Workspace** accounts.

### 3.2 Out of v1

- Removing labels, and replying, forwarding, sending, or permanently deleting mail.
- A dry-run mode or evaluation harness for tuning questions.
- A settings UI, Workspace Add-on, or Marketplace listing.
- Real-time processing (Gmail push through Pub/Sub) and any hosted server.
- A periodic digest email.
- Automated deployment.
- Attachments, multiple accounts, and other classifier providers.

See [§12](#12-roadmap-after-v1) for what may come later.

## 4. Functional Design

### 4.1 Rules

A **rule** is one yes/no question plus one outcome. Rules live in `config.yaml` and are evaluated together.

- **Label rule** (the default): adds a Gmail label. Missing labels, including nested ones such as `Finance/Bill`, are created automatically.
- **Move rule**: moves the thread to one destination:
  - **Archive**: removes it from the Inbox.
  - **Spam**.
  - **Trash**: recoverable in Gmail for 30 days.
  - **Move to label**: adds a label *and* removes it from the Inbox, like Gmail's own "Move to."
- **Threshold:** a rule fires when Jev's yes-probability is at least the rule's `threshold`, or `defaultThreshold` if it has none. Label and move rules use the same thresholds; choosing a high threshold for a move rule is left to the user and encouraged by the docs.

### 4.2 Processing Pipeline

```text
Trigger fires
  └─ Check guardrails: time left in run, daily token budget
      └─ Find work: Gmail search (work query + exclusion query), bounded chunk
          └─ For each thread: build Jev `state` (headers allowlist, plain text, truncated)
              └─ Send all threads' requests concurrently (one request per thread, all rules in each)
                  └─ Retry temporary failures within the time left
                      └─ Apply outcomes: labels, then at most one move
                          └─ Mark Jev/Processed (or Jev/Error), log, record token usage
```

### 4.3 Finding Work

- Scheduled runs search for threads with mail that has not yet been processed, received after the install date, and not matching the exclusion query. The query and why it works are in the [README](../README.md#avoiding-reprocessing).
- Scope is all mail except Spam and Trash (Gmail search skips those by default), so mail that other filters archive on arrival is still classified.
- The **exclusion query** is always added: to scheduled runs and to every manual run, with no override. It is a privacy control, not just a filter.

### 4.4 What Is Sent to Jev

Each thread is one request, containing every rule's question and the thread's content: newest message first, a fixed header allowlist, plain-text bodies (converted from HTML when needed), and oldest content truncated first to fit Jev's limit. Attachments are never sent. The details are in the [README](../README.md#what-is-sent-to-jev).

### 4.5 Applying Outcomes

- **All** matching label rules are applied.
- **At most one** move is applied. If several move rules match, the **first one in config order wins**.
- **Moves only happen on a thread's first classification**, or during a manual run with the reprocess option. When a reply makes an already-processed thread eligible again, reclassification only adds labels. This prevents the product from fighting a user who has moved a thread back (for example, clicking "Not spam").
- User labels are never removed in v1.
- After outcomes are applied, the thread gets `Jev/Processed`.

### 4.6 Failures

- Temporary failures (rate limits, overload, server and network errors) are retried with exponential backoff and jitter, within the time left in the run. A thread that still fails stays unprocessed for the next run.
- A thread that fails on 3 consecutive runs, or gets an invalid-request response, gets `Jev/Error` and is not retried automatically. Removing the label retries it.
- A bad API key stops the run without marking anything.

Details are in the [README](../README.md#failures).

### 4.7 Manual Runs

A manual run takes a Gmail query and an optional **reprocess** flag. It processes matching threads in chunks and continues across executions until done. With reprocess, previously processed threads are treated as a first classification, so **moves apply**. This is how a newly added move rule is backfilled, and the docs must warn that a new Trash rule plus reprocess can move a lot of old mail. The run log reports how many threads went to each destination.

### 4.8 Guardrails

- **Execution time:** every run is bounded well under the 6-minute execution limit, and scheduled runs fit the daily trigger-runtime quota (90 minutes a day on consumer accounts). The polling interval is configurable, so accounts with more quota can poll more often.
- **Daily token budget:** Jev's reported token usage is added up per day, across scheduled and manual runs. Once the budget is reached, no more requests are sent until the next day (in the script's time zone), and an alert is sent. A run may overshoot by at most one batch. The default, `20,000,000` tokens, is $1.00/day at today's price rounded down to one significant figure.

### 4.9 Observability

- **Execution logs** record, per thread: thread ID, subject, sender, each question's probability, and the actions taken. Bodies are never logged. The probabilities are what a user tunes thresholds from.
- **Alert emails** go to the account owner when:
  1. the API key is rejected;
  2. threads are newly marked `Jev/Error`;
  3. runs fail or time out repeatedly;
  4. the daily token budget is reached.

  Each condition sends at most one alert per day.

### 4.10 Lifecycle

- **Distribution:** clone or fork, build, `clasp push`. No Marketplace, no Apps Script library.
- **Versioning:** SemVer git tags and a changelog.
- **`install`:** asks for permissions, records the install date, and creates or replaces the trigger.
- **`uninstall`:** removes the trigger and stored state, and leaves labels in place.

## 5. Configuration Surface

All behavior is set in `config.yaml`. Field names below are working names; the final schema is settled in E2.

| Setting                  | Default      | Purpose                                                           |
| ------------------------ | ------------ | ----------------------------------------------------------------- |
| `defaultThreshold`       | (required)   | Minimum yes-probability for rules without their own threshold.    |
| `triggerIntervalMinutes` | `10`         | Polling interval: 1, 5, 10, 15, or 30.                            |
| `jevModel`               | `jev-latest` | Jev model version to request.                                     |
| `dailyTokenBudget`       | `20000000`   | Maximum Jev input tokens per day, across all runs.                |
| `excludeQuery`           | (none)       | Gmail search terms for mail that is never sent to Jev.            |
| `rules[].question`       | (required)   | The yes/no question.                                              |
| `rules[].action`         | `label`      | `label` or `move`.                                                |
| `rules[].label`          | (required for `label`) | Label to apply.                                         |
| `rules[].destination`    | (required for `move`) | `archive`, `spam`, `trash`, or `label:<name>`.           |
| `rules[].threshold`      | `defaultThreshold` | Per-rule override.                                          |

The Jev API key is not in the config. It lives in `.env` locally and in Script Properties when deployed.

## 6. Technical Approach

- **Platform:** Google Apps Script (V8 runtime) in the user's account, with a time-driven trigger. No hosted server in v1.
- **Language:** TypeScript, bundled by the build step into files Apps Script can run.
- **Build:** one step that validates `config.yaml`, generates the config as code, and bundles the source. **An invalid config fails the build** (for example, an unknown destination, a threshold outside 0–1, an unsupported interval, or a missing field).
- **Tests:** unit tests run in Node against fakes of `GmailApp`, `UrlFetchApp`, and the other Apps Script services, so retry, quota, budget, and move logic are tested without a real inbox.
- **CI:** GitHub Actions runs build, lint, and tests on every pull request. Deployment stays manual (`clasp push` from the maintainer's machine) in v1.

### 6.1 Main Components

| Component         | Responsibility                                                             |
| ----------------- | -------------------------------------------------------------------------- |
| Config            | Validated, generated rules and settings.                                   |
| Work finder       | Builds the Gmail query and returns a bounded chunk of threads.             |
| State builder     | Turns a thread into Jev `state`: headers, plain text, truncation.          |
| Jev client        | Sends requests concurrently, retries, classifies errors, reports token usage. |
| Outcome applier   | Applies labels and the winning move, marks processed or errored.           |
| Run controller    | Time budgeting, token budget, scheduled vs. manual runs, continuation.     |
| Notifier          | Logging and rate-limited alert emails.                                     |
| Lifecycle         | `install` and `uninstall`.                                                 |

## 7. Non-Functional Requirements

| Area          | Requirement                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Reliability   | No eligible thread is silently skipped. Every thread ends up processed or `Jev/Error`.              |
| Quotas        | No execution fails from Apps Script quota or timeout errors at personal volume on a consumer account. |
| Cost          | Under $5/month at personal volume; never more than the daily token budget plus one batch.           |
| Privacy       | Only the header allowlist and plain-text bodies are sent. Excluded mail is never sent. Bodies are never logged. |
| Latency       | Threads are handled within about 2 trigger intervals of arrival.                                    |
| Maintainability | Behavior changes need only a config edit, build, and push.                                        |

## 8. Constraints and Assumptions

- Apps Script cannot react to incoming mail, so the product polls.
- Apps Script quotas: 6 minutes per execution; 90 minutes a day of trigger runtime on consumer accounts (6 hours on Workspace); daily limits on URL fetches, Gmail operations, and sent email. See the [README](../README.md#google-apps-script).
- Jev accepts one `state` per request and has per-request token limits; prices and limits may change. See the [README](../README.md#jev).
- **Assumption to verify first:** Gmail search matches `-label:` per message rather than per thread, which is what lets a reply make a processed thread eligible again. E1 confirms this before other work depends on it.
- Workspace admin policies that block external requests or unverified scripts are outside the product's control and are documented, not solved.

## 9. Risks

| Risk                                                                 | Impact                                           | Mitigation                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| The per-message `-label:` assumption is wrong.                       | Replies never trigger reclassification.          | E1 spike first. Fallback: compare each thread's latest message date with when it was processed. |
| A new `jev-latest` release shifts probabilities.                     | Precision drops without any config change.       | The model is configurable, so a user can pin a version. Probability logs make drift visible. |
| Move rules misfire, especially Trash and Spam.                       | Mail is hidden from the user.                    | Precision-first defaults, documentation encouraging high thresholds for move rules, moves only on first classification, per-destination counts in logs. |
| Consumer trigger-runtime quota is tight (about 37 s per run at 10 minutes). | Backlogs, or quota failures.               | Bounded runs, concurrent requests, a configurable interval.                           |
| Jev price or limits change.                                          | Cost or truncation assumptions go stale.         | The budget is in tokens, not dollars. Figures in the README are dated.                |
| Behavior of Apps Script move methods (for example, whether moving to Spam also reports it to Google) is unclear. | Surprising side effects. | E1 confirms and the docs describe it.                                                 |

## 10. Known Limitations (v1)

- A label the user removes by hand can be re-added when a reply arrives and the thread is reclassified.
- Moves are not reapplied on reclassification. For example, a reply to an archived thread returns it to the Inbox, as Gmail normally does.
- Threads in Spam or Trash are never reclassified.
- Each reply to a thread costs a new classification of the whole thread.
- Latency is bounded by the polling interval.

## 11. Release Criteria for v1

v1 is released when:

1. every in-scope feature in [§3.1](#31-in-v1) works;
2. the per-message `-label:` behavior is confirmed; and
3. it has run on the maintainer's own inbox for **2 consecutive weeks** while meeting the [Vision's success measures](product-vision.md#success-measures-v1). Precision is measured by manually spot-checking labels and moved threads in Gmail against the execution logs.

## 12. Roadmap After v1

Not committed and not ordered. See the [Vision](product-vision.md#possible-future-directions).

- Remove labels when a newer classification no longer matches, and respect user corrections.
- A dry run or evaluation harness for tuning questions.
- A periodic digest email.
- Automated deployment from `main` through a GitHub Action (needs `clasp` credentials stored as a repository secret).
- Real-time processing.
- A Workspace Add-on or Marketplace listing with a settings UI.

## 13. Details to Settle During Development

These are known low-level decisions, left to the epic that owns them:

- Final `config.yaml` field names and validation messages (E2).
- The HTML-to-text conversion approach, the characters-per-token estimate, and the truncation safety margin (E4).
- Retry attempt count, backoff base, and jitter (E5).
- Where token usage, consecutive-failure counts, alert rate limits, and manual-run progress are stored, given the 9 KB-per-value Script Properties limit (E5, E6, E8, E9).
- Chunk size and the time budget per run (E7).
- How a manual run continues across executions (E8).
- Alert email format (E9).

## 14. Epics

Each epic is a planning unit for stories and tasks. E1 comes first because the rest of the design depends on what it confirms.

| #   | Epic                         | Goal                                                                                                  | Depends on |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| E1  | **Gmail behavior spike**     | Confirm per-message `-label:` matching and how thread labels and the move methods (Archive, Spam, Trash, Move to label) behave. | None       |
| E2  | **Project foundation**       | Repo tooling, TypeScript bundling, config build with validation, `clasp` push, test harness with fakes, CI. | None       |
| E3  | **Thread discovery**         | Work query, exclusion query, install date, bounded chunks.                                            | E1, E2     |
| E4  | **Thread → `state`**         | Header allowlist, plain text or converted HTML, newest-first order, truncation.                       | E2         |
| E5  | **Jev client**               | Requests with all rules, concurrent sending, retries and backoff, error classes, token accounting, daily budget. | E2   |
| E6  | **Outcomes**                 | Label and move rules, first-classification rule, config-order move conflicts, `Jev/Processed`, `Jev/Error`, the 3-strike rule. | E1, E2 |
| E7  | **Scheduling and lifecycle** | Run time budget, trigger, `install`, `uninstall`.                                                     | E3–E6      |
| E8  | **Manual runs**              | Query and reprocess options, continuation across executions, per-destination counts.                  | E7         |
| E9  | **Observability**            | Probability logging, alert emails, alert rate limiting.                                               | E5, E6     |
| E10 | **v1 release**               | Setup and tuning docs, changelog, SemVer tag, 2-week pilot against the success measures.              | All        |

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
