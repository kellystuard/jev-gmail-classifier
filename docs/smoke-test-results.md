# Smoke test: results

This file records each run of the release checklist, [`docs/smoke-test.md`](smoke-test.md). The checklist is run before each release and after any change to an adapter ([Engineering Standards §8](../output/engineering-standards.md#8-testing)). Each run adds a dated section at the top of this file, with one row per check ID.

- **Result** is `pass`, `fail (#<bug>)`, or `not run (<reason>)`.
- A run **passes** when every **required** check is `pass` in its latest row. A check that failed is run again after its bug is fixed, in a new dated section that holds only the rows that were run again, with the bug's number.
- The account is written `<test-account>`. The results hold event names, field names, counts, and what synthetic mail showed. They never hold an address, a subject or sender of real mail, the API key, or an `Authorization` header.

## 2026-10-01

- **Commit tested:** `ee3da4a` (`main`), both builds made from it: the product from the checklist's smoke config, and the adapter bundle.
- **Version:** 0.9.0.
- **When:** the first session ran from 2026-10-01 23:49 UTC to 2026-10-02 00:15 UTC.
- **Account:** consumer, `<test-account>`.
- **Run by:** an agent, through the spike runner (`node spikes/run.mjs`), in the shared spike project, with the helper `spikes/155-smoke.js` ([#155](https://github.com/kellystuard/jev-gmail-classifier/issues/155), Option A). The checks marked `person` are the maintainer's.
- **Checklist:** `docs/smoke-test.md` at `ee3da4a`, with the corrections made in the same pull request as this file.
- **How a result was read:** a return value or a throw through `s155_call` or `s155_check`; log lines captured by `s155_call`, which redefines `console.info`, `console.warn` and `console.error` for the length of one call; Script Properties and triggers through `s155_props` and `s155_triggers`; the mailbox through the Gmail API. The log of a run that the trigger started itself can't be read this way: those checks read `state.runs` and the mailbox.

**Summary:** 166 checks, 150 required. Of the required checks: 72 pass, 1 fail, 77 not run. Of the other 16: 16 not run.

**This run is not finished.** It stopped where the Jev key is needed: the agent that ran it was not allowed to copy the key into the test project, so the maintainer sets it by hand (#155). The checks from S5 on, and H6 and H7, wait for that. Six checks wait for the maintainer's own steps (S1, S2, T12, L15, N13, N14), and section Z waits for E1 #21 to close. One check failed (L5, #329).

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
| T12 | required, person | not run (waits for the maintainer: one thread deleted forever in the Gmail web page) |  | The thread `JevSmoke direct 06 [r1]` carries the label `JevSmoke/DeleteForever`. |
| T13 | required | pass | agent | `UnexpectedResponseError`, `service: 'gmail'`, `status: 400`. Gmail's text is "Invalid id value"; no header text. |
| T14 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| T15 | required | pass | agent | `invalid_page_token`; the message ends "Invalid pageToken". |
| L1 | required | pass | agent | 22 labels in one response (keys `ok`, `labels`): system labels and 8 user labels with `Label_<n>` IDs. |
| L2 | required | pass | agent | `Label_<n>`, name `JevSmoke/A/B`. |
| L3 | required | pass | agent | Only the leaf exists. |
| L4 | required | pass | agent | `label_exists`; the message ends "Label name exists or conflicts". |
| L5 | required | fail (#329) | agent | Gmail **created** a second label, `jevsmoke / a / b`: `{ ok: true }`. Gmail ignores case and a space after a `/`, but not a space before a `/` (see First observations). The adapter returned what Gmail answered; the rule in SD §6.5 and `labelKey` is wrong. |
| L6 | required | pass | agent | `invalid_label_name`; the message ends "Invalid label name". |
| L7 | required | pass | agent | The thread's message has the label. |
| L8 | required | pass | agent | `ok: true`, labels unchanged. |
| L9 | required | pass | agent | `invalid_label`; the message ends "Invalid label: JevSmoke/A/B". Thread unchanged. |
| L10 | required | pass | agent | `invalid_label`; the message ends "labelId not found". Thread unchanged. |
| L11 | required | pass | agent | `INBOX` gone; the user label and `UNREAD` kept. |
| L12 | required | pass | agent | The label added and `INBOX` gone, in one call. |
| L13 | required | pass | agent | `SPAM` added, `INBOX` gone, the user label kept. |
| L14 | required | pass | agent | `TRASH` added, `INBOX` gone too, the user label kept. |
| L15 | required, person | not run (waits for the maintainer: the thread of T12 deleted forever) |  |  |
| L16 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| U1 | required | pass | agent |  |
| U2 | required | pass | agent |  |
| U3 | required | pass | agent | Length 4; code units 233, 26085, 55357, 56898. |
| U4 | required | pass | agent | Length 2, starting with U+FEFF: the same as `nodeDecodeUtf8`. |
| U5 | required | pass | agent | One U+FFFD, no throw. |
| U6 | required | pass | agent | The part declares `charset=ISO-8859-1`; the decoded text ends `café`. |
| H1 | required | pass | agent |  |
| H2 | required | pass | agent |  |
| H3 | required | pass | agent | `'test-key'`. There was no real key to restore yet (see the note above the table). |
| H4 | required | pass | agent |  |
| H5 | required | pass | agent | Status 403, `error_type: authentication_error`; 11 header names, all lower-case, with `content-type`, `set-cookie` and `x-typesafe-request-id`. |
| H6 | required | not run (waits for the Jev key in the test project) |  |  |
| H7 | required | not run (waits for the Jev key in the test project) |  | Tried without a key: three `transport` results with `DNS error: https://jev-smoke.invalid/`. It is run again with the key, so that the leak check means something. |
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
| S1 | required, person | not run (waits for the maintainer: the Setup walk in a fresh project) |  |  |
| S2 | required, person | not run (waits for the maintainer: the Setup walk in a fresh project) |  |  |
| S3 | required | pass | agent | Counts: (a) 43,120, (b) 397, (c) 4, (d) 43,518. Every thread of (d) is in (a), (b) or (c). The 4 threads that are neither excluded nor synthetic are the classifier's own emails of section M. In both (a) and (b): 3 threads, the one marked `JevSmokeExcluded` and 2 threads of earlier spikes that hold one message from `example.test` and one that the account sent (the check was corrected for them: see the pull request). |
| S4 | required | pass | agent | `RunAbortError` with that message. `run.start`, then `run.failed` (`error`, `reason: missing_key`, `alerts: [auth]`), then `alert.sent`. No `state.position`, no `state.installedAt`, no trigger. The run wrote `state.gmailCalls` and `state.alerts` (#325). Run with no key in the project at all. |
| S5 | required | not run (waits for the Jev key in the test project) |  |  |
| S6 | required | not run (waits for the Jev key in the test project) |  |  |
| S7 | required | not run (waits for the Jev key in the test project) |  |  |
| S8 | required | not run (waits for the Jev key in the test project) |  |  |
| S9 | required | not run (waits for the Jev key in the test project) |  |  |
| R1 | required | not run (waits for the Jev key in the test project) |  |  |
| R2 | required | not run (waits for the Jev key in the test project) |  |  |
| R3 | required | not run (waits for the Jev key in the test project) |  |  |
| R4 | required | not run (waits for the Jev key in the test project) |  |  |
| R5 | required | pass | agent | `{ ok: true }`, one `onTrigger` trigger in between, then `{ ok: true, deleted: 1 }`; no HTTP 500. Run on its own, before `install`: it needs no key. |
| R6 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| E1 | required | not run (waits for the Jev key in the test project) |  |  |
| E2 | required | not run (waits for the Jev key in the test project) |  |  |
| E3 | required | not run (waits for the Jev key in the test project) |  |  |
| E4 | required | not run (waits for the Jev key in the test project) |  |  |
| E5 | required | not run (waits for the Jev key in the test project) |  |  |
| E6 | required | not run (waits for the Jev key in the test project) |  |  |
| E7 | required | not run (waits for the Jev key in the test project) |  |  |
| E8 | required | not run (waits for the Jev key in the test project) |  |  |
| C1 | required | not run (waits for the Jev key in the test project) |  |  |
| C2 | required | not run (waits for the Jev key in the test project) |  |  |
| C3 | required | not run (waits for the Jev key in the test project) |  |  |
| C4 | required | not run (waits for the Jev key in the test project) |  |  |
| C5 | required | not run (waits for the Jev key in the test project) |  |  |
| C6 | required | not run (waits for the Jev key in the test project) |  |  |
| C7 | required | pass | agent | An integer, between the two `Date.now()` values. |
| C8 | required | not run (waits for the Jev key in the test project) |  |  |
| C9 | required | pass | agent | 1,501 ms. |
| C10 | required | pass | agent | `Etc/UTC`. |
| C11 | required | pass | agent | 1,000 values from 0.0003 to 0.998, all different. |
| C12 | when it happens | not run (did not happen) |  |  |
| P1 | required | pass | agent | The stored text is `{"v":1,"text":"é日🙂"}`. |
| P2 | required | pass | agent |  |
| P3 | required | not run (waits for the Jev key in the test project) |  |  |
| P4 | required | not run (waits for the Jev key in the test project) |  |  |
| P5 | required | not run (waits for the Jev key in the test project) |  |  |
| J1 | required | not run (waits for the Jev key in the test project) |  |  |
| J2 | required | not run (waits for the Jev key in the test project) |  |  |
| J3 | required | not run (waits for the Jev key in the test project) |  |  |
| J4 | required | not run (waits for the Jev key in the test project) |  |  |
| J5 | required | not run (waits for the Jev key in the test project) |  |  |
| J6 | required | not run (waits for the Jev key in the test project) |  |  |
| J7 | required | not run (waits for the Jev key in the test project) |  |  |
| J8 | required | not run (waits for the Jev key in the test project) |  |  |
| J9 | required | not run (waits for the Jev key in the test project) |  |  |
| J10 | required | not run (waits for the Jev key in the test project) |  |  |
| J11 | required | not run (waits for the Jev key in the test project) |  |  |
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
| N13 | required, person | not run (waits for the maintainer: a Gmail link opened in a browser) |  | The link is in the email `[Jev Gmail Classifier] Smoke test links` in the test account. |
| N14 | required, person | not run (waits for the maintainer: a Gmail link opened in a browser) |  | The thread `JevSmoke direct 05 [r1]` carries `Jev/Error`; the link is in the same email. |
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
- **Gmail's rule for label names that conflict** (L5, #329). With a label `JevSmokeProbe/A/B` in the mailbox, Gmail refuses another case (`jevsmokeprobe/a/b`), a space after a `/` (`JevSmokeProbe/ A/B`) and a space at the end, with 409 "Label name exists or conflicts". It **creates** a name with a space before a `/` (`JevSmokeProbe /A/B`, `JevSmokeProbe / A / B`), stored exactly as given (`s155_labelProbe`). SD §6.5 and `labelKey` say spaces around a `/` are ignored on both sides: that is the bug #329.
- **The last page of `history.list`** (G4). With `maxResults: 1` and three records, the page that holds the third record still has a `nextPageToken`. The page after it has no records and no token. The adapter returns `records: []` for it.
- **`threads.get` with `format: 'minimal'`** (T10) also returns `historyId`, `sizeEstimate` and `snippet` for each message. The snippet is a piece of the body.
- **`threads.get` for an ID that isn't one** (T13) is HTTP 400, "Invalid id value".
- **A search matches a thread when any of its messages matches** (S3). Two threads of earlier spikes, each with one message from `example.test` and one that the account sent, are matched by `-from:example.test`, and so by the smoke `excludeQuery`. That is the same rule that makes the exclusion drop a whole thread.
- **`install` without a key** (S4) writes `state.gmailCalls` and `state.alerts`, and sends the `auth` alert. It saves no position and creates no trigger. The README sentence about it is #325.
