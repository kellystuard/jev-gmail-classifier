# 21: History expiry and the 404 response

- Task: #21
- Date run: (not run yet). Observation window: (start) to (end, at least 7 days later)
- Account: `<test-account>` (consumer)
- Run by: agent via #163

## Question

1. Exactly what does the Advanced Gmail Service throw when `users.history.list` gets an expired or invalid `startHistoryId`? How can E3's adapter tell "expired or invalid position" apart from other failures (401, 403 scope, 429, 5xx)?
2. How long does a saved position stay valid on this account, observed daily for at least 7 days?

Design text being tested:

- SD §6.3: "A 404 from `history.list` means Gmail has discarded the history. This is typically after a week or more, and sometimes after hours. Fall back to searching `after:<epoch of last successful ingest − 1 h>`, reset the position from `getProfile`, and alert once."
- Google's reference: a history ID is "typically valid for at least a week" but "in some rare circumstances may be valid for only a few hours", and an invalid or out-of-date ID "typically" returns HTTP 404.
- The Advanced Service throws an exception instead of returning an HTTP status. What it throws is not documented.

## Functions

`spikes/21-history-expiry.js`. Every function takes one optional JSON args object and returns its result (also logged). The test account's address never appears in results (`s21_out_` scrubs it anyway).

| Function | Does |
|----------|------|
| `s21_errors()` | Calls `Gmail.Users.History.list('me', {startHistoryId, maxResults: 1})` for each error case below, in `try/catch`. On success: `history` length, the response `historyId`, and whether `nextPageToken` is present. On an exception: `e.name`, `e.constructor.name`, `String(e)`, `e.message`, `JSON.stringify(e.details)`, `Object.keys(e)`, `Object.getOwnPropertyNames(e)`, and the first line of `e.stack`. |
| `s21_rawStatus()` | Cross-check: the same cases through `UrlFetchApp.fetch` against `https://gmail.googleapis.com/gmail/v1/users/me/history` with `Authorization: Bearer ScriptApp.getOAuthToken()` and `muteHttpExceptions: true`. Returns the HTTP status and the JSON error body. It uses the scopes already declared (`script.external_request` for the fetch, `gmail.modify` in the token), so the manifest doesn't change. |
| `s21_savePosition()` | Appends `{historyId, savedAt}` from `getProfile` to `s21.positions` (the newest 60 are kept). |
| `s21_daily()` | The trigger handler, also runnable by hand. Saves a new position, then checks every saved position with `History.list` and appends `{checkedAt, historyId, savedAt, ageHours, ok, historyCount, errorSummary}` for each to `s21.results.YYYY-MM-DD` (today's date, UTC). Also logs each entry. |
| `s21_installTrigger()` | Deletes any `s21_daily` trigger, then creates `ScriptApp.newTrigger('s21_daily').timeBased().everyDays(1).atHour(9)`. Returns the trigger ID and the project's triggers. |
| `s21_removeTrigger()` | Deletes every `s21_daily` trigger and returns the project's remaining triggers. Other spikes' triggers are never touched. |
| `s21_report()` | Returns every position and result, a per-position summary (checks, latest check, last success, first failure), the oldest position still valid, any failures, and the project's triggers. |

Results are stored per day (`s21.results.YYYY-MM-DD`, kept for 45 days) rather than in one list of the last 200 entries as the task sketched, because one Script Properties value holds at most 9 KB. Seven-plus days of checks against a growing list of positions would overflow a single value. A trigger run's return value and console output don't reach the agent, so Script Properties is how the results get back (through `s21_report`).

## Error cases

`s21_errors` and `s21_rawStatus` compute the values from `getProfile('me').historyId` at run time.

| # | `startHistoryId` | Expected (check) |
|---|------------------|------------------|
| E1 | `'1'` | 404, unless the account's history happens to start that low. |
| E2a | current − 1,000,000 (skipped unless current > 1,000,000) | 404 for very old; may succeed if still retained. |
| E2b | current − 100,000 (skipped unless current > 100,000) | As E2a. |
| E3 | `'abc'` (non-numeric) | 400? |
| E4 | `'-5'` | 400? |
| E5 | current + 1,000,000 (future) | An error, or empty history? |
| E6 | current (valid control) | Success, empty `history`. |
| E7 | the oldest position in `s21.positions` saved at least 24 h ago | Success expected. Skipped on day 0; rerun `s21_errors` on a later day to fill it in. |

## Runbook

The agent runs every step via #163 (`node spikes/run.mjs run <fn> [json-args]`).

1. Day 0: `s21_savePosition`, then `s21_installTrigger`. If creating the trigger fails through `scripts.run`, ask the maintainer to run `s21_installTrigger` once in the editor (see Maintainer steps).
2. Day 0: `s21_errors` and `s21_rawStatus`. Fill in the errors table (E7 stays open). **Post the errors table and the detection rule on #73 straight away**, so E3 isn't blocked.
3. Leave the trigger running for at least 7 days. The other spikes' activity on the account helps.
4. During the week, run `s21_report` now and then to check the trigger is firing (at least one `s21.results.*` day per calendar day). On day 1 or later, rerun `s21_errors` to fill in E7.
5. Day 7 or later: `s21_report`, and record the retention table. Then `s21_removeTrigger`, and confirm no `s21_daily` trigger remains.
6. Keep the next-check dates in #21's `**Agent status**` comment, so whichever session resumes can continue. The PR stays in draft until step 5.

## Maintainer steps

None expected. If trigger creation fails through `scripts.run`, the agent asks, in one comment:

1. Open the spike project in the Apps Script editor as `<test-account>`, select `s21_installTrigger`, and run it.
2. After the observation (day 7 or later), select `s21_removeTrigger` and run it.

## Results

### Errors

(Filled in from `s21_errors` and `s21_rawStatus`.)

| # | Value | Threw? | e.name / constructor | e.message (verbatim) | e.details (verbatim) | HTTP status (raw fetch) | Notes |
|---|-------|--------|----------------------|----------------------|----------------------|-------------------------|-------|
| E1 | `1` | | | | | | |
| E2a | | | | | | | |
| E2b | | | | | | | |
| E3 | `abc` | | | | | | |
| E4 | `-5` | | | | | | |
| E5 | | | | | | | |
| E6 | | | | | | | |
| E7 | | | | | | | |

### Retention

(Filled in from `s21_report` on day 7 or later.)

| Position saved (YYYY-MM-DD HH:MM UTC) | historyId | Checked | Age (h) | Valid? | Error |
|---|---|---|---|---|---|

### Findings

1. **The expired-position exception and the detection rule.** The verbatim exception, and a rule that tells "expired or invalid position" apart from 401, 403 (scope), 429, and 5xx. Prefer a structured property (for example `e.details.code === 404`) over message text; if only the message is usable, give the exact pattern and note that messages may be localized or change.
2. **Non-numeric or negative IDs:** a different error from an expired one? The recommendation to check: treat it as corrupt state (an exception per ADR-0006), not as expiry.
3. **A future ID:** does it fail, or succeed with empty history? If it succeeds, the adapter can't detect a position ahead of the mailbox (for example, after restoring stale state).
4. **Retention:** the oldest position still valid at the end, and whether any expired sooner. A lightly used test account may keep history longer than a busy inbox.

## Raw output

<details><summary>s21_savePosition, s21_installTrigger</summary>

</details>

<details><summary>s21_errors, s21_rawStatus</summary>

</details>

<details><summary>s21_report (day 7+), s21_removeTrigger</summary>

</details>

## Conclusion

(After the run.)

## Design changes

(SD §6.3 "Expired position", SD §14 first row, and #62, #73, after the run.)
