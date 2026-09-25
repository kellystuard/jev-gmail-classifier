# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Design phase: no code, build tooling, or tests exist yet. The repo is documentation only. There are no build/lint/test commands to run. When code is added, update this file with the real commands.

## Source-of-truth documents

Read them in this order. A higher document wins when two disagree:

1. `output/product-vision.md`: why the product exists, its target users, principles, success measures, and non-goals.
2. `output/product-design-document.md`: v1 scope, functional design, risks, release criteria, and the epic list (E1–E10). Low-level details are left to the epic that owns them (see its §13).
3. `README.md`: the detailed design and mechanics. It describes classification **per thread**, and must stay consistent with the two documents above.

`docs/archive/` holds the original notes and the superseded product requirements. They are historical records: do not follow or "fix" them.

## Intended architecture

A Google Apps Script project (TypeScript, bundled for Apps Script, running in the user's Google account) that labels and moves Gmail threads using the Jev classification API from TypeSafe AI. The project is independent and not affiliated with TypeSafe AI or Google. Precision beats recall: a wrong label or move is worse than a missed one.

- **Trigger:** a time-driven trigger (interval must be 1, 5, 10, 15, or 30 minutes) polls Gmail. Apps Script cannot fire on mail arrival.
- **Work query:** `-label:Jev/Processed -label:Jev/Error after:<install date> <excludeQuery>`. The exclusion query is always appended, including to manual runs. This works because Gmail labels apply to all messages in a thread *at that moment*, while search matches individual messages, so a new reply makes a processed thread match again. This behavior still needs a quick test to confirm.
- **Jev request:** `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`. One request per thread (the API accepts one `state` per request), with **all** rules sent together as Noul (yes/no probability) questions. Requests within a run go out concurrently via `UrlFetchApp.fetchAll`.
- **`state` contents:** each message newest first, with only these headers: `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted`; plus the plain-text body (HTML converted if there is no text part). Never send attachments or other headers. Truncate the oldest content first so `state` plus the longest question fits in 32k tokens.
- **Outcomes:** a rule fires when its Noul probability ≥ the rule's `threshold` (or `defaultThreshold`). Label rules add their label; missing labels (including nested ones like `Finance/Bill`) are created automatically. Move rules move the thread to `archive`, `spam`, `trash`, or `label:<name>` (label plus remove from Inbox). All firing label rules apply; at most one move applies, and the first firing move rule in config order wins. Moves only happen on a thread's first classification or a manual reprocess; reclassification after a reply only adds labels. Labels are never removed in v1. Then add `Jev/Processed`.
- **Failures:** retry 429/529/5xx/network errors with exponential backoff and jitter, within the time left in the run. 422 → `Jev/Error` immediately. 401 → stop the run and mark nothing. A thread that fails on 3 consecutive runs → `Jev/Error`. When the daily token budget (summed from Jev's reported `usage`) is reached, stop sending until the next day.
- **Quotas:** every run must be bounded well under the 6-minute execution limit and fit the daily trigger budget (90 min/day on consumer accounts, about 37 s per run at 10-minute intervals). Manual runs (a Gmail query plus an optional reprocess flag) work through threads in chunks across executions.
- **Observability:** log thread ID, subject, sender, per-question probabilities, and actions; never bodies. Email the account owner on 401, new `Jev/Error` threads, repeated run failures, or budget reached, at most once per condition per day.

## Configuration and secrets

- `config.yaml` (repo root) holds `defaultThreshold`, `triggerIntervalMinutes`, `jevModel` (default `jev-latest`), `dailyTokenBudget` (default `20000000`), `excludeQuery`, and `rules[]` (`question`, `action` (`label` default or `move`), `label` or `destination`, optional `threshold`). Apps Script cannot read YAML, so a build step must validate it (failing on an invalid config) and generate a script file from it before `clasp push`.
- `.env` (git-ignored) holds `JEV_API_KEY` for local use. The deployed script reads the key from Script Properties.
- Deployment is planned via `clasp`, manually for v1. CI (GitHub Actions) runs build, lint, and tests only. An `install` function records the install date and creates or replaces the trigger; `uninstall` removes the trigger and stored state and leaves labels.
