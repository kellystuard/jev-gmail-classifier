# Smoke test: results

This file records each run of the release checklist, [`docs/smoke-test.md`](smoke-test.md). The checklist is run before each release and after any change to an adapter ([Engineering Standards §8](../output/engineering-standards.md#8-testing)). Each run adds a dated section at the top of this file, with one row per check ID.

- **Result** is `pass`, `fail (#<bug>)`, or `not run (<reason>)`.
- A run **passes** when every **required** check is `pass` in its latest row. A check that failed is run again after its bug is fixed, in a new dated section that holds only the rows that were run again, with the bug's number.
- The account is written `<test-account>`. The results hold event names, field names, counts, and what synthetic mail showed. They never hold an address, a subject or sender of real mail, the API key, or an `Authorization` header.

## 2026-10-03: L5 again, after #329

- **Commit tested:** `45ccca8` (`main`, with PR #330, the fix of #329). The adapter bundle built from it is the same, byte for byte, as the one the first run used.
- **Account and runner:** as in the run below.
- **The check:** L5 as #330 corrected it in `docs/smoke-test.md`: `createLabel('jevsmoke/a-b')` while `JevSmoke/A/B` exists.

| ID | Marking | Result | Run by | Note |
|----|---------|--------|--------|------|
| L5 | required | pass | agent | `{ ok: false, kind: 'label_exists', message }`; the message ends "Label name exists or conflicts". No throw. (#329) |

## 2026-10-01

- **Commits tested:**
  - `ee3da4a` (`main`, 0.9.0): the first session, 2026-10-01 23:49 UTC to 2026-10-02 00:15 UTC. Sections G, T (but T12), L (but L15), U, K, A, M; H1 to H5 and H8; S3, S4, R5, C7, C9 to C11, P1, P2.
  - `45ccca8` (`main` after the fix of #329, PR #330): every other row, from 2026-10-03 03:14 UTC. The adapter bundle built from `45ccca8` is byte for byte the one built from `ee3da4a` (no adapter imports `labelKey`, the one function the fix changed), so the direct checks that had passed were not run again. Only L5 was: see the section above. H3 was run again because the first session had no key to restore.
- **Version:** 0.9.0, and `main` after it.
- **Account:** consumer, `<test-account>`.
- **Run by:** an agent, through the spike runner (`node spikes/run.mjs`), in the shared spike project, with the helper `spikes/155-smoke.js` ([#155](https://github.com/kellystuard/jev-gmail-classifier/issues/155), Option A). The maintainer set the Jev key in the project by hand, and did the checks marked `person`; their results are taken from the maintainer's reply on #155.
- **Checklist:** `docs/smoke-test.md` at `ee3da4a`, with #330's correction of L5 and the corrections made in the same pull request as this file.
- **How a result was read:** a return value or a throw through `s155_call` or `s155_check`; log lines captured by `s155_call`, which redefines `console.info`, `console.warn` and `console.error` for the length of one call; Script Properties and triggers through `s155_props` and `s155_triggers`; the mailbox through the Gmail API. The log of a run that the trigger started itself can't be read this way: those checks read `state.runs` and the mailbox.

**Summary (latest row of each check, the re-run above included):** 166 checks, 150 required. Of the required checks: 117 pass, 0 fail, 33 not run. Of the other 16: 16 not run.

**This run is not finished.** The second session (from 2026-10-03 03:14 UTC) is running the checks from S5 on. A row that says `not run (waits for …)` has not been reached yet. Section Z waits for E1 #21 to close.

| ID | Marking | Result | Run by | Note |
|----|---------|--------|--------|------|
| G1 | required | pass | agent | `ok: true`, the address, and a `historyId` of digits. |
| G2 | required | pass | agent | One record, whose `messagesAdded[0].message` is the imported message (`id`, `threadId`, `labelIds`). |
| G3 | required | pass | agent | One record and a `nextPageToken`. |
| G4 | required | pass | agent | One record on each page. With `maxResults: 1`, the page that holds the last record still has a `nextPageToken`; the page after it has no records and no `nextPageToken` (see First observations). |
| G5 | required | pass | agent | The two later records, not the start record. |
| G6 | required | pass | agent | `{ ok: false, kind: 'history_expired' }`, no throw. |
| G7 | required | pass | agent | `records: []`. |
| G8 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| T1 | required | pass | agent | 2 IDs and a `nextPageToken`. |
| T2 | required | pass | agent | 2 more IDs, none repeated. |
| T3 | required | pass | agent | With `q: 'from:smoke-direct@example.test'` and `maxResults: 5`: 15 threads on 3 pages; the last page's keys are `ok` and `threadIds` only. |
| T4 | required | pass | agent | Keys: `ok`, `threadIds`, `nextPageToken` (the inbox has over 100 threads). Nothing else. |
| T5 | required | pass | agent | `threadIds: []`, no `nextPageToken` key. |
| T6 | required | pass | agent | The trashed thread is not in the result. |
| T7 | required | pass | agent | The trashed thread is in the result. |
| T8 | required | pass | agent | `id`, `labelIds`, `internalDate` (a string), only the `Date` header, no body `data`. |
| T9 | required | pass | agent | `body.data` is an array of numbers between -128 and 127; `internalDate` is a string. |
| T10 | required | pass | agent | No `payload`. Gmail's `minimal` form also holds `historyId`, `sizeEstimate` and `snippet`. |
| T11 | required | pass | agent | The trashed message is returned, with `TRASH` in `labelIds`. |
| T12 | required, person | pass | maintainer and agent | `{ ok: false, kind: 'not_found' }`, no throw. The maintainer deleted `JevSmoke direct 06 [r1]` forever in the Gmail web page; the agent made the call. |
| T13 | required | pass | agent | `UnexpectedResponseError`, `service: 'gmail'`, `status: 400`. Gmail's text is "Invalid id value"; no header text. |
| T14 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| T15 | required | pass | agent | `invalid_page_token`; the message ends "Invalid pageToken". |
| L1 | required | pass | agent | 22 labels in one response (keys `ok`, `labels`): system labels and 8 user labels with `Label_<n>` IDs. |
| L2 | required | pass | agent | `Label_<n>`, name `JevSmoke/A/B`. |
| L3 | required | pass | agent | Only the leaf exists. |
| L4 | required | pass | agent | `label_exists`; the message ends "Label name exists or conflicts". |
| L5 | required | fail (#329) | agent | Gmail **created** a second label, `jevsmoke / a / b`: `{ ok: true }`. To Gmail the two names differ: it treats a space and a `/` as the same character, so the second name has more separators (see First observations). The adapter returned what Gmail answered; the rule in SD §6.5 and `labelKey` is wrong. |
| L6 | required | pass | agent | `invalid_label_name`; the message ends "Invalid label name". |
| L7 | required | pass | agent | The thread's message has the label. |
| L8 | required | pass | agent | `ok: true`, labels unchanged. |
| L9 | required | pass | agent | `invalid_label`; the message ends "Invalid label: JevSmoke/A/B". Thread unchanged. |
| L10 | required | pass | agent | `invalid_label`; the message ends "labelId not found". Thread unchanged. |
| L11 | required | pass | agent | `INBOX` gone; the user label and `UNREAD` kept. |
| L12 | required | pass | agent | The label added and `INBOX` gone, in one call. |
| L13 | required | pass | agent | `SPAM` added, `INBOX` gone, the user label kept. |
| L14 | required | pass | agent | `TRASH` added, `INBOX` gone too, the user label kept. |
| L15 | required, person | pass | maintainer and agent | `{ ok: false, kind: 'not_found' }`, no throw, on the thread of T12. |
| L16 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| U1 | required | pass | agent |  |
| U2 | required | pass | agent |  |
| U3 | required | pass | agent | Length 4; code units 233, 26085, 55357, 56898. |
| U4 | required | pass | agent | Length 2, starting with U+FEFF: the same as `nodeDecodeUtf8`. |
| U5 | required | pass | agent | One U+FFFD, no throw. |
| U6 | required | pass | agent | The part declares `charset=ISO-8859-1`; the decoded text ends `café`. |
| H1 | required | pass | agent |  |
| H2 | required | pass | agent |  |
| H3 | required | pass | agent | `'test-key'`; the real key was restored afterwards (run again on 2026-10-03 with the key in the project). |
| H4 | required | pass | agent |  |
| H5 | required | pass | agent | Status 403, `error_type: authentication_error`; 11 header names, all lower-case, with `content-type`, `set-cookie` and `x-typesafe-request-id`. |
| H6 | required | pass | agent | Status 200, an `x-typesafe-request-id` header, a body with `answers`, `model` and `usage` (`input_tokens`: 302). |
| H7 | required | pass | agent | Three `transport` results, each `DNS error: https://jev-smoke.invalid/`. No message holds `Bearer`, the key or the payload. |
| H8 | required | pass | agent | Status 301, `location: https://www.google.com/`. |
| H9 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| K1 | required | pass | agent |  |
| K2 | required | pass | agent | `true` both times: as `FakeLock` models. |
| K3 | required | pass | agent | `false` after 94 ms. |
| K4 | required | pass | agent | B's `release()` returned; a third execution got `false`. |
| K5 | required | pass | agent | A threw while holding the lock; the next execution got `true`. |
| K6 | required | pass | agent |  |
| K7 | required | pass | agent |  |
| K8 | required | pass | agent |  |
| K9 | required | pass | agent | `{ entry: 'install', status: 'skipped', reason: 'busy' }`; one log line, `run.skipped` (`info`); no property written. |
| A1 | required | pass | agent | `{ ok: true, missing: [] }`. |
| A2 | required | pass | agent | Returned normally for the three essential scopes. |
| A3 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| A4 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| A5 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| M1 | required | pass | agent |  |
| M2 | required | pass | agent | From `Jev Gmail Classifier <<test-account>>`, exact subject, one `text/plain` part, no file name. Body: `Line 1\r\nLine 2\r\n`. |
| M3 | required | pass | agent | Recorded: labels `INBOX`, `SENT`, `UNREAD`, `IMPORTANT`, `CATEGORY_PERSONAL`; a thread of its own (see First observations). |
| M4 | required | pass | agent | Recorded: the second email, with the same subject and body, started a **new** thread. |
| M5 | required | pass | agent | Unchanged, apart from a line break (`\r\n`) added at the end. |
| M6 | required | pass | agent | All 5,000 characters. `MailApp` sends `format=flowed; delsp=yes`: each `\n` arrived as `\r\n`, one line break was added at the end, and a second run with 999-character lines arrived soft-wrapped at 73 characters and was identical once unflowed (see First observations). |
| M7 | required | pass | agent | `UnexpectedResponseError`, `service: 'mail'`. Message: "MailApp sendEmail failed: Invalid email: <recipient>". Apps Script's own text is "Invalid email: " followed by the address given. |
| M8 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| M9 | not observed | not run (accepted v1 risk, SD §14) |  |  |
| S1 | required, person | pass | maintainer | Reported by the maintainer: "All as expected" (a fresh project in the test account, `npm run push` from a scratch clone with the smoke config; the editor lists `Code.gs` and `appsscript.json`). |
| S2 | required, person | pass | maintainer | Reported by the maintainer: "All as expected" ("Google hasn't verified this app", then four permissions, none pre-ticked, none about permanent deletion). |
| S3 | required | pass | agent | Counts: (a) 43,120, (b) 397, (c) 4, (d) 43,518. Every thread of (d) is in (a), (b) or (c). The 4 threads that are neither excluded nor synthetic are the classifier's own emails of section M. In both (a) and (b): 3 threads, the one marked `JevSmokeExcluded` and 2 threads of earlier spikes that hold one message from `example.test` and one that the account sent (the check was corrected for them: see the pull request). |
| S4 | required | pass | agent | `RunAbortError` with that message. `run.start`, then `run.failed` (`error`, `reason: missing_key`, `alerts: [auth]`), then `alert.sent`. No `state.position`, no `state.installedAt`, no trigger. The run wrote `state.gmailCalls` and `state.alerts` (#325). Run with no key in the project at all. |
| S5 | required | pass | agent | `position: 'set'`, `triggerMinutes: 10`, `missingScopes: []`. One time-driven (`CLOCK`) trigger for `onTrigger`. `state.position` (`historyId`, `savedAt`), `state.installedAt`, `state.gmailCalls`. Log: `run.start`, `run.end`; nothing else. |
| S6 | required | pass | agent | Delivered `JevSmoke live 01 [r1]` (label kind) and `JevSmoke live 02 JevSmokeExcluded [r1]`, ran nothing. The trigger's own run started about 3 minutes later: `state.runs` has `lastOutcome: 'ok'`, `consecutiveFailures: 0`, and `lastSummary` with `ingested: 2`, `excluded: 1`, `sent: 1`, `classified: 1`. Mailbox: `live 01` has `JevSmoke/Test`, `live 02` has no label. (Its log can't be read through the runner; the maintainer's Setup walk saw a completed trigger run on the Executions page.) |
| S7 | required | pass | agent | `position: 'kept'` with the `historyId` that `state.position` held; `savedAt` unchanged. Still one `onTrigger` trigger: `install` replaced it (a new unique ID). |
| S8 | required | pass | agent | `position: 'reset'` and the mailbox's current `historyId`; `state.position` has a new `savedAt`; `RESET_POSITION` is deleted. |
| S9 | required | pass | agent | `position: 'kept'`. `run.end` at `warn` with `resetPositionIgnored: true`, without the value. `RESET_POSITION` (`yes`) still there; `state.position` unchanged. Then deleted. |
| R1 | required | pass | agent | Two trigger runs in a row, nothing run by hand in between: `lastStart` 601 s apart (10.0 minutes). |
| R2 | required | pass | agent | Built and pushed with `triggerMinutes: 5`; `install` returned `triggerMinutes: 5`, `position: 'kept'`. Still one `onTrigger` trigger (a new unique ID). |
| R3 | required | pass | agent | Two trigger runs in a row at the 5-minute build: `lastStart` 294 s apart (4.9 minutes). Then the smoke config was built and pushed again and `install` returned `triggerMinutes: 10`. |
| R4 | required | pass | agent | With a second `onTrigger` trigger and an hourly `s155_other` trigger made by hand, `install` left exactly one `onTrigger` trigger, and `s155_other`'s (same unique ID) untouched. |
| R5 | required | pass | agent | `{ ok: true }`, one `onTrigger` trigger in between, then `{ ok: true, deleted: 1 }`; no HTTP 500. Run on its own before `install` at `ee3da4a`, and again after R4 at `45ccca8`, which paused the trigger. Then the `s155_other` trigger was deleted. |
| R6 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| E1 | required | pass | agent | `{ entry: 'onTrigger', status: 'ok', stopped: 'drained', summary, alerts: [] }`. Log: `run.start`, `ingest.done`, `jev.batch`, `thread.classified` (`probabilities.smoke_label` 0.99, `actions: ['label:JevSmoke/Test']`), `run.end` (`ingested: 1`, `classified: 1`); no `scope_missing`. `state.runs`: `ok`, `consecutiveFailures: 0`. The thread has the label. |
| E2 | required | pass | agent | `thread.classified` with both rules in `fired` and `actions: ['label:JevSmoke/Test', 'move:archive']`; `run.end` `moves: { archive: 1 }`. The thread has the label and left the inbox. |
| E3 | required | pass | agent | Imported with a `Date` 2 days old. `thread.classified` at `info`, `smoke_archive` in `fired`, `actions: ['label:JevSmoke/Test']` only. The thread has the label and is still in the inbox. |
| E4 | required | pass | agent | `thread.excluded` (`reason: 'matched'`) for the thread, no `thread.classified`; `run.end` `excluded: 1`, `sent: 0`. No label on the thread. |
| E5 | required | pass | agent | `stopped: 'drained'`; `run.end` with `ingested: 0`, `sent: 0`, `classified: 0`. |
| E6 | required | pass | agent | While the sleeper held the lock: `{ entry: 'onTrigger', status: 'skipped', reason: 'busy' }`, and one log line, `run.skipped`. |
| E7 | required | pass | agent | `RunAbortError` ("The Jev API key is not set: add JEV_API_KEY in Script Properties"). Log: `run.start`, then `run.failed` (`error: RunAbortError`, `reason: missing_key`, `alerts: [auth]`, `consecutiveFailures: 1`), then `alert.sent`: no `ingest.done`, so no Gmail or Jev work came first. No thread labelled. |
| E8 | required | pass | agent | `status: 'ok'`; `state.runs` `consecutiveFailures: 0`. It classified one thread: E7's `auth` alert email (the account's own mail, #304), with no rule firing. |
| C1 | required | pass | agent | Over every line captured in sections S, E and P (and later J, N, V, X: see the note of C6): each line is one JSON object whose first four keys are `event`, `runId`, `entry`, `ts`, at a level `LOG_EVENT_LEVELS` allows. |
| C2 | required | pass | agent | One `runId` per execution, a UUID. |
| C3 | required | pass | agent | No `runId` repeats across executions. |
| C4 | required | not run (waits for the Jev key in the test project) |  |  |
| C5 | required | pass | agent | Every `ts` ends with `Z` and lies between the times taken just before and after its call. |
| C6 | required | not run (waits for the Jev key in the test project) |  |  |
| C7 | required | pass | agent | An integer, between the two `Date.now()` values. |
| C8 | required | pass | agent | E1: `lastStart` and `lastEnd` lie between the times taken just before and after the call, `lastStart <= lastEnd`. |
| C9 | required | pass | agent | 1,501 ms. |
| C10 | required | pass | agent | `Etc/UTC`. |
| C11 | required | pass | agent | 1,000 values from 0.0003 to 0.998, all different. |
| C12 | when it happens | not run (did not happen) |  |  |
| P1 | required | pass | agent | The stored text is `{"v":1,"text":"é日🙂"}`. |
| P2 | required | pass | agent |  |
| P3 | required | pass | agent | After S and E: `state.alerts`, `state.budget`, `state.gmailCalls`, `state.installedAt`, `state.position`, `state.runs`, each one line of JSON starting `{"v":`. No other key written; `JEV_API_KEY` still set. |
| P4 | required | pass | agent | `StateError`; `run.failed` with `error: StateError`, `reason: parse`, `key: state.position`, and a `cause` that names a position in the text, not the text. The value stayed as edited. Restored. |
| P5 | required | pass | agent | `StateError`; `run.failed` with `reason: version` (`version: 99`). The value stayed as edited. Restored; the next `onTrigger` succeeded. |
| J1 | required | pass | agent | `{ entry: 'startManualRun', status: 'rejected', reason: 'no_input' }`, no throw. Log: `run.start`, `manual.rejected` (`warn`); no `run.end`. No `state.manual`. |
| J2 | required | pass | agent | `rejected`, `invalid_timespan`. `MANUAL_QUERY` and `MANUAL_TIMESPAN` still there. |
| J3 | required | pass | agent | `status: 'ok'`, `query: '(from:smoke-manual@example.test) after:<seconds>'`, `applyMoves: false`, `job: 'completed'`, `stopped: 'completed'`. Log: `manual.started` with that query, `manual.progress`, `manual.completed` (`classified: 30`, `labels: { JevSmoke/Test: 30 }`). The `MANUAL_*` inputs and `state.manual` are gone. The 30 threads have the label. (Before J1, `Jev/Error` was put on `JevSmoke manual error [r1]` and `state.jevErrorLabel` was set by hand, as the checklist says.) |
| J4 | required | pass | agent | `thread.excluded` for `JevSmoke manual JevSmokeExcluded [r1]`, no `thread.classified` for it; `manual.completed` `excluded: 1`; `manual.started`'s query holds no part of the `excludeQuery`. The thread has no `JevSmoke` label. |
| J5 | required | pass | agent | `thread.skipped` (`reason: 'jev_error'`) for `JevSmoke manual error [r1]`, no `thread.classified` for it; `manual.completed` `skipped: 1`. |
| J6 | required | pass | agent | Each of the 30 `thread.classified` has `smoke_archive` in `fired` and `actions: ['label:JevSmoke/Test']` only. The 30 threads are still in the inbox. |
| J7 | required | pass | agent | `applyMoves: true`, `job: 'completed'`; `manual.completed` `moves: { archive: 30 }`. Only 2 threads of the manual set are left in the inbox (the excluded one and the `Jev/Error` one). |
| J8 | required | pass | agent | `RunAbortError` (`missing_key`). Log: `manual.started`, then `run.failed` (`reason: missing_key`, `alerts: [auth]`; no new email, the `auth` alert was already sent today). `state.manual` exists; the `MANUAL_*` inputs are deleted. Key restored. |
| J9 | required | pass | agent | `rejected`, `job_unfinished`; `manual.rejected` names the running job's query. `MANUAL_QUERY` still there, `state.manual` unchanged. |
| J10 | required | pass | agent | Run twice. The first call's job ran (`state.runs` `ok`, 20 classified), but its result was lost: the helper's own `getProfile`, after the run, hit Gmail's per-minute limit, which the run had used up (the helper now reads the address once per execution, with a retry). The second call replaced that unfinished job the same way: `status: 'ok'`, `query: 'from:smoke-bulk@example.test'`, `job: 'active'`. Log: `manual.cancelled` (`reason: 'replaced'`, `removed: 180`), `manual.started` (`replaced: true`), `manual.progress` with `stopped: 'rate_limited'` (40 classified). `state.manual` holds the new query. |
| J11 | required | pass | agent | `state.queue.0` (9,210 bytes) and `state.queue.1`: no gap, each at most 9,216 bytes. |
| J12 | required | not run (waits for the Jev key in the test project) |  |  |
| J13 | required | not run (waits for the Jev key in the test project) |  |  |
| J14 | required | not run (waits for the Jev key in the test project) |  |  |
| J15 | required | not run (waits for the Jev key in the test project) |  |  |
| J16 | required | not run (waits for the Jev key in the test project) |  |  |
| J17 | required | not run (waits for the Jev key in the test project) |  |  |
| N1 | required | not run (waits for the Jev key in the test project) |  |  |
| N2 | required | not run (waits for the Jev key in the test project) |  |  |
| N3 | required | not run (waits for the Jev key in the test project) |  |  |
| N4 | required | not run (waits for the Jev key in the test project) |  |  |
| N5 | required | not run (waits for the Jev key in the test project) |  |  |
| N6 | required | not run (waits for the Jev key in the test project) |  |  |
| N7 | required | not run (waits for the Jev key in the test project) |  |  |
| N8 | required | not run (waits for the Jev key in the test project) |  |  |
| N9 | required | not run (waits for the Jev key in the test project) |  |  |
| N10 | required | not run (waits for the Jev key in the test project) |  |  |
| N11 | required | not run (waits for the Jev key in the test project) |  |  |
| N12 | required | not run (waits for the Jev key in the test project) |  |  |
| N13 | required, person | pass | maintainer | Reported by the maintainer: link 1 of the email `[Jev Gmail Classifier] Smoke test links` opened the thread `JevSmoke direct 05 [r1]` in the test account (the browser was signed in to one Google account). Recorded in SD §14 (links row). |
| N14 | required, person | pass | maintainer | Reported by the maintainer: link 2 opened the label `Jev/Error`, listing that thread, in the test account. The label was then removed from the thread. Recorded in SD §14 (links row). |
| N15 | required | not run (waits for the Jev key in the test project) |  |  |
| N16 | required | not run (waits for the Jev key in the test project) |  |  |
| N17 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| N18 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| N19 | not observed | not run (accepted v1 risk, SD §14) |  |  |
| N20 | when it happens | not run (did not happen) |  |  |
| N21 | when it happens | not run (did not happen) |  |  |
| Z1 | required | not run (waits for #21 to close) |  | The time zone of the shared spike project can't be changed while E1 #21's daily trigger runs there. |
| Z2 | required | not run (waits for #21 to close) |  | The time zone of the shared spike project can't be changed while E1 #21's daily trigger runs there. |
| Z3 | required | not run (waits for #21 to close) |  | The time zone of the shared spike project can't be changed while E1 #21's daily trigger runs there. |
| V1 | required | not run (waits for the Jev key in the test project) |  |  |
| V2 | required | not run (waits for the Jev key in the test project) |  |  |
| V3 | required | not run (waits for the Jev key in the test project) |  |  |
| V4 | required | not run (waits for the Jev key in the test project) |  |  |
| V5 | required | not run (waits for the Jev key in the test project) |  |  |
| X1 | required | not run (waits for the Jev key in the test project) |  |  |
| X2 | required | not run (waits for the Jev key in the test project) |  |  |
| X3 | required | not run (waits for the Jev key in the test project) |  |  |

### First observations

What this run saw live for the first time, and where else it is recorded.

- **`console` can be intercepted on Apps Script, but not by assignment.** `console.info`, `console.warn` and `console.error` are own properties of `console` that are not writable but are configurable. `console.info = fn` does nothing and throws nothing. `Object.defineProperty(console, 'info', { value: fn, … })` works, and the original descriptor can be put back. Also in `spikes/155-smoke.js` (`s155_call`, `s155_consoleProbe`).
- **A `MailApp` self-send** (M2 to M4). The email arrives in the account's own mailbox with the labels `INBOX`, `SENT`, `UNREAD`, `IMPORTANT` and `CATEGORY_PERSONAL`. It is a thread of its own, and a second email with the same subject and body starts another thread: two alerts don't share a thread. Also in SD §14 (MailApp row).
- **`MailApp` sends `text/plain; charset="UTF-8"; format=flowed; delsp=yes`** (M5, M6, S4). Line breaks arrive as `\r\n`, one is added at the end, and a long line is soft-wrapped (a space, then the line break; the longest line received was 73 characters). A mail client joins such lines again; the Gmail API returns them as sent. The alert texts have one long line per paragraph, so through the API an alert's body shows these soft breaks. A link has no space in it and is not broken. Also in SD §14 (MailApp row).
- **`MailApp`'s text for an address that isn't one** (M7): "Invalid email: " followed by the address given. The adapter throws `UnexpectedResponseError` (`service: 'mail'`) with `<recipient>` in its place. Also in SD §14 (MailApp row).
- **The daily email quota** read 96 after four sends: 100 a day on this consumer account.
- **Gmail's rule for label names that conflict** (L5, #329; `s155_labelProbe`, and `s155_labelProbe2` on 2026-10-02 with one base name per case). Gmail compares two names after it has trimmed white space at both ends and turned each run of white space (a tab too) into one space, which is also what it stores; ignored case; and treated a space, a `/` and a `-` as the same character. `_` and `.` stay themselves. A conflict is 409 "Label name exists or conflicts". What was seen, existing name first:
  - created, so different names: `P /A` then `P/A`; `P / A` then `P/A`; `P / A` then `P/ A`; `P/ A` then `P / A`; `P/ A` then `P/A`; `P/A` then `P/␠␠A` (stored as `P/ A`); `P/A` then `P/<tab>A` (stored as `P/ A`); `P/A/B` then `P/A/ B`; `P` and `P/A` then `P /A`; `P_A` then `P/A`; `P.A` then `P/A`.
  - refused, so the same name: another case (`P/A` then `p/a`); a space at the start or the end (`P/A␠` is stored as `P/A`); `P /A` then `P/ A`, and the reverse; `P/A /B` then `P/A/ B`; `P//X` then `P/ X`; `P/A` then `P-A`; `P/A` then `P A`; `P A` then `P/A`; `P-A` then `P/A`; `P-A` then `P A`; `P /A` then `P--A` and `P-/A`.
  - So a mailbox that holds a flat label `Finance-Bill` or `Finance Bill` refuses the creation of `Finance/Bill`. SD §6.5 and `labelKey` say something else (spaces around a `/` are ignored): that is the bug #329, which has the full table. The first probe tried its variants one after another against one base, and two of its refusals came from variants it had created itself; spike 25's case 9 has the same cause (`S25odd/ X` conflicted with `S25odd//X`).
- **The last page of `history.list`** (G4). With `maxResults: 1` and three records, the page that holds the third record still has a `nextPageToken`. The page after it has no records and no token. The adapter returns `records: []` for it.
- **`threads.get` with `format: 'minimal'`** (T10) also returns `historyId`, `sizeEstimate` and `snippet` for each message. The snippet is a piece of the body.
- **`threads.get` for an ID that isn't one** (T13) is HTTP 400, "Invalid id value".
- **A search matches a thread when any of its messages matches** (S3). Two threads of earlier spikes, each with one message from `example.test` and one that the account sent, are matched by `-from:example.test`, and so by the smoke `excludeQuery`. That is the same rule that makes the exclusion drop a whole thread.
- **`install` without a key** (S4) writes `state.gmailCalls` and `state.alerts`, and sends the `auth` alert. It saves no position and creates no trigger. The README sentence about it is #325.
