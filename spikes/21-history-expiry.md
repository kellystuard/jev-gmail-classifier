# 21: History expiry and the 404 response

- Task: #21
- Date run: 2026-09-26 (day 0: error cases, trigger installed). Observation window: 2026-09-26 to 2026-10-03 or later
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
| `s21_oldest({samples?})` | Day-0 retention estimate, extra to the task. Bisects for the oldest `startHistoryId` that `History.list` still accepts (a non-404 error aborts), then dates the messages in the first `messageAdded` records after it (`Messages.get` minimal, `internalDate`). Returns IDs, counts, and dates only. |
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
3. Day 0: `s21_oldest`, for how far back the account's history reaches today.
4. Leave the trigger running for at least 7 days. The other spikes' activity on the account helps.
5. During the week, run `s21_report` now and then to check the trigger is firing (at least one `s21.results.*` day per calendar day). On day 1 or later, rerun `s21_errors` to fill in E7.
6. Day 7 or later: `s21_report`, and record the retention table. Then `s21_removeTrigger`, and confirm no `s21_daily` trigger remains.
7. Keep the next-check dates in #21's `**Agent status**` comment, so whichever session resumes can continue. The PR stays in draft until step 5.

## Maintainer steps

None expected. If trigger creation fails through `scripts.run`, the agent asks, in one comment:

1. Open the spike project in the Apps Script editor as `<test-account>`, select `s21_installTrigger`, and run it.
2. After the observation (day 7 or later), select `s21_removeTrigger` and run it.

## Results

### Errors

From `s21_errors` and `s21_rawStatus`, 2026-09-26 08:06 UTC, current `historyId` 36554823. Every exception had `e.name` `GoogleJsonResponseException`, `e.constructor.name` `Error`, `Object.keys(e)` `name`, `details`, and own properties `stack`, `message`, `name`, `details`. `e.details` is a plain object: `{code, message, errors: [{reason, domain?, message}]}`. `String(e)` and the first stack line are `GoogleJsonResponseException: ` followed by `e.message`.

| # | Value | Threw? | e.name / constructor | e.message (verbatim) | e.details (verbatim) | HTTP status (raw fetch) | Notes |
|---|-------|--------|----------------------|----------------------|----------------------|-------------------------|-------|
| E1 | `1` | Yes | `GoogleJsonResponseException` / `Error` | `API call to gmail.users.history.list failed with error: Requested entity was not found.` | `{"errors":[{"reason":"notFound","domain":"global","message":"Requested entity was not found."}],"code":404,"message":"Requested entity was not found."}` | 404 `NOT_FOUND` | Expired. |
| E2a | `35554823` (current − 1,000,000) | Yes | as E1 | as E1 | as E1 | 404 `NOT_FOUND` | Expired. |
| E2b | `36454823` (current − 100,000) | No | | | | 200 | Still retained: 1 record, `nextPageToken` present. |
| E3 | `abc` | Yes | as E1 | `API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), "abc"` | `{"code":400,"errors":[{"message":"Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\"","reason":"invalid"}],"message":"Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\""}` | 400 `INVALID_ARGUMENT` | The raw body adds a `google.rpc.BadRequest` field violation on `start_history_id`; the Advanced Service's `details` doesn't carry it. |
| E4 | `-5` | Yes | as E1 | `… Invalid value at 'start_history_id' (TYPE_UINT64), "-5"` | as E3, with `"-5"` | 400 `INVALID_ARGUMENT` | Same as E3. |
| E5 | `37554823` (current + 1,000,000) | Yes | as E1 | as E1 (`Requested entity was not found.`) | as E1 | 404 `NOT_FOUND` | **A future position is a 404, the same as an expired one.** |
| E6 | `36554823` (current) | No | | | | 200 | Empty `history`, response `historyId` = current, no `nextPageToken`. |
| E7 | (a position ≥ 24 h old) | | | | | | Skipped on day 0 (none old enough). Rerun `s21_errors` on day 1 or later. |

**How far back history reaches (`s21_oldest`, 2026-09-26 08:06 UTC).** 26 probes. The oldest accepted `startHistoryId` was 36181823 (36181822 got a 404), 373,078 IDs below the current 36554901. The first 10 messages added after it have `internalDate` from 2026-08-28 23:49 to 2026-08-29 00:45 UTC, about **680 hours (28 days)** before the check. Their message IDs, which Gmail derives from the time, agree. So on this account, Gmail kept about four weeks of history on day 0. The account holds about 41.7k messages, many of them imported in bulk, and it isn't a normal busy inbox.

### Retention

(Filled in from `s21_report` on day 7 or later.)

| Position saved (YYYY-MM-DD HH:MM UTC) | historyId | Checked | Age (h) | Valid? | Error |
|---|---|---|---|---|---|

### Findings

1. **The expired-position exception and the detection rule.** The Advanced Service throws `GoogleJsonResponseException` (a plain `Error` whose `name` is set) with `e.message` `API call to gmail.users.history.list failed with error: Requested entity was not found.` and a structured `e.details` object: `code: 404`, `errors[0].reason: 'notFound'`. **Detection rule for the adapter:** around the `history.list` call only, catch, and if `e.details && e.details.code === 404`, return the distinct "position not found" result. A 400 with `errors[0].reason === 'invalid'` is an invalid position (finding 2). Anything else (401, 403, 429, 5xx, or no `details`) rethrows, or goes to the adapter's normal error mapping. The message text isn't needed, and shouldn't be used: it can change. 401, 403, and 429 weren't produced here. #27 records the scope error; its rule should use the same `e.details.code` approach.
2. **Non-numeric or negative IDs** fail differently from an expired one: HTTP 400, `details.code === 400`, `reason: 'invalid'`, with the message `Invalid value at 'start_history_id' (TYPE_UINT64), "<value>"`. I agree with the recommendation: this is corrupt state, an exception per ADR-0006 (it can only come from a bug or a hand-edited Script Property), not expiry. The domain can also refuse it before calling Gmail, since a valid position is a string of digits.
3. **A future ID** (current + 1,000,000) is a **404, the same as an expired one**. So a position ahead of the mailbox (for example after restoring stale state from another account, or a hand edit) doesn't fail silently with empty history. It takes the expired-position path: fall back to a search, reset from `getProfile`, and alert. That is safe. If E3 wants a clearer alert, it can compare the rejected position with `getProfile().historyId` and say "ahead of the mailbox" when it is larger. It doesn't need different handling.
4. **Retention:** (day 7 or later). Day 0: history reached back about 28 days (`s21_oldest`). The watch continues daily.

## Raw output

<details><summary>s21_savePosition, s21_installTrigger (2026-09-26)</summary>

`s21_savePosition`:

```json
{
 "positions": [
  {
   "historyId": "36554805",
   "savedAt": "2026-09-26T08:05:44.078Z"
  }
 ],
 "saved": {
  "historyId": "36554805",
  "savedAt": "2026-09-26T08:05:44.078Z"
 }
}
```

`s21_installTrigger`:

```json
{
 "removedExisting": [],
 "triggerId": "7592073902986100736",
 "triggers": [
  {
   "handler": "s21_daily",
   "id": "7592073902986100736",
   "source": "CLOCK"
  }
 ]
}
```

</details>

<details><summary>s21_errors, s21_rawStatus, s21_oldest (2026-09-26)</summary>

`s21_errors`:

```json
{
 "at": "2026-09-26T08:05:59.053Z",
 "currentHistoryId": "36554823",
 "results": [
  {
   "case": "E1",
   "exception": {
    "constructorName": "Error",
    "details": "{\"errors\":[{\"reason\":\"notFound\",\"domain\":\"global\",\"message\":\"Requested entity was not found.\"}],\"code\":404,\"message\":\"Requested entity was not found.\"}",
    "keys": [
     "name",
     "details"
    ],
    "message": "API call to gmail.users.history.list failed with error: Requested entity was not found.",
    "name": "GoogleJsonResponseException",
    "ownPropertyNames": [
     "stack",
     "message",
     "name",
     "details"
    ],
    "stackFirstLine": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Requested entity was not found.",
    "string": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Requested entity was not found."
   },
   "label": "very old: 1",
   "threw": true,
   "value": "1"
  },
  {
   "case": "E2a",
   "exception": {
    "constructorName": "Error",
    "details": "{\"errors\":[{\"reason\":\"notFound\",\"domain\":\"global\",\"message\":\"Requested entity was not found.\"}],\"code\":404,\"message\":\"Requested entity was not found.\"}",
    "keys": [
     "name",
     "details"
    ],
    "message": "API call to gmail.users.history.list failed with error: Requested entity was not found.",
    "name": "GoogleJsonResponseException",
    "ownPropertyNames": [
     "stack",
     "message",
     "name",
     "details"
    ],
    "stackFirstLine": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Requested entity was not found.",
    "string": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Requested entity was not found."
   },
   "label": "current - 1,000,000",
   "threw": true,
   "value": "35554823"
  },
  {
   "case": "E2b",
   "hasNextPageToken": true,
   "historyLength": 1,
   "label": "current - 100,000",
   "responseHistoryId": "36554823",
   "threw": false,
   "value": "36454823"
  },
  {
   "case": "E3",
   "exception": {
    "constructorName": "Error",
    "details": "{\"code\":400,\"errors\":[{\"message\":\"Invalid value at 'start_history_id' (TYPE_UINT64), \\\"abc\\\"\",\"reason\":\"invalid\"}],\"message\":\"Invalid value at 'start_history_id' (TYPE_UINT64), \\\"abc\\\"\"}",
    "keys": [
     "name",
     "details"
    ],
    "message": "API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\"",
    "name": "GoogleJsonResponseException",
    "ownPropertyNames": [
     "stack",
     "message",
     "name",
     "details"
    ],
    "stackFirstLine": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\"",
    "string": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\""
   },
   "label": "non-numeric",
   "threw": true,
   "value": "abc"
  },
  {
   "case": "E4",
   "exception": {
    "constructorName": "Error",
    "details": "{\"errors\":[{\"message\":\"Invalid value at 'start_history_id' (TYPE_UINT64), \\\"-5\\\"\",\"reason\":\"invalid\"}],\"message\":\"Invalid value at 'start_history_id' (TYPE_UINT64), \\\"-5\\\"\",\"code\":400}",
    "keys": [
     "details",
     "name"
    ],
    "message": "API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), \"-5\"",
    "name": "GoogleJsonResponseException",
    "ownPropertyNames": [
     "stack",
     "message",
     "details",
     "name"
    ],
    "stackFirstLine": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), \"-5\"",
    "string": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Invalid value at 'start_history_id' (TYPE_UINT64), \"-5\""
   },
   "label": "negative",
   "threw": true,
   "value": "-5"
  },
  {
   "case": "E5",
   "exception": {
    "constructorName": "Error",
    "details": "{\"code\":404,\"message\":\"Requested entity was not found.\",\"errors\":[{\"message\":\"Requested entity was not found.\",\"reason\":\"notFound\",\"domain\":\"global\"}]}",
    "keys": [
     "name",
     "details"
    ],
    "message": "API call to gmail.users.history.list failed with error: Requested entity was not found.",
    "name": "GoogleJsonResponseException",
    "ownPropertyNames": [
     "stack",
     "message",
     "name",
     "details"
    ],
    "stackFirstLine": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Requested entity was not found.",
    "string": "GoogleJsonResponseException: API call to gmail.users.history.list failed with error: Requested entity was not found."
   },
   "label": "future: current + 1,000,000",
   "threw": true,
   "value": "37554823"
  },
  {
   "case": "E6",
   "hasNextPageToken": false,
   "historyLength": 0,
   "label": "current (valid control)",
   "responseHistoryId": "36554823",
   "threw": false,
   "value": "36554823"
  },
  {
   "case": "E7",
   "label": "saved at least 24 h ago",
   "skipped": "no position in s21.positions is 24 h old yet; rerun later"
  }
 ]
}
```

`s21_rawStatus`:

```json
{
 "at": "2026-09-26T08:06:08.745Z",
 "currentHistoryId": "36554823",
 "results": [
  {
   "case": "E1",
   "error": {
    "code": 404,
    "errors": [
     {
      "domain": "global",
      "message": "Requested entity was not found.",
      "reason": "notFound"
     }
    ],
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND"
   },
   "httpStatus": 404,
   "label": "very old: 1",
   "value": "1"
  },
  {
   "case": "E2a",
   "error": {
    "code": 404,
    "errors": [
     {
      "domain": "global",
      "message": "Requested entity was not found.",
      "reason": "notFound"
     }
    ],
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND"
   },
   "httpStatus": 404,
   "label": "current - 1,000,000",
   "value": "35554823"
  },
  {
   "case": "E2b",
   "hasNextPageToken": true,
   "historyLength": 1,
   "httpStatus": 200,
   "label": "current - 100,000",
   "responseHistoryId": "36554823",
   "value": "36454823"
  },
  {
   "case": "E3",
   "error": {
    "code": 400,
    "details": [
     {
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      "fieldViolations": [
       {
        "description": "Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\"",
        "field": "start_history_id"
       }
      ]
     }
    ],
    "errors": [
     {
      "message": "Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\"",
      "reason": "invalid"
     }
    ],
    "message": "Invalid value at 'start_history_id' (TYPE_UINT64), \"abc\"",
    "status": "INVALID_ARGUMENT"
   },
   "httpStatus": 400,
   "label": "non-numeric",
   "value": "abc"
  },
  {
   "case": "E4",
   "error": {
    "code": 400,
    "details": [
     {
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      "fieldViolations": [
       {
        "description": "Invalid value at 'start_history_id' (TYPE_UINT64), \"-5\"",
        "field": "start_history_id"
       }
      ]
     }
    ],
    "errors": [
     {
      "message": "Invalid value at 'start_history_id' (TYPE_UINT64), \"-5\"",
      "reason": "invalid"
     }
    ],
    "message": "Invalid value at 'start_history_id' (TYPE_UINT64), \"-5\"",
    "status": "INVALID_ARGUMENT"
   },
   "httpStatus": 400,
   "label": "negative",
   "value": "-5"
  },
  {
   "case": "E5",
   "error": {
    "code": 404,
    "errors": [
     {
      "domain": "global",
      "message": "Requested entity was not found.",
      "reason": "notFound"
     }
    ],
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND"
   },
   "httpStatus": 404,
   "label": "future: current + 1,000,000",
   "value": "37554823"
  },
  {
   "case": "E6",
   "hasNextPageToken": false,
   "historyLength": 0,
   "httpStatus": 200,
   "label": "current (valid control)",
   "responseHistoryId": "36554823",
   "value": "36554823"
  },
  {
   "case": "E7",
   "label": "saved at least 24 h ago",
   "skipped": "no position in s21.positions is 24 h old yet; rerun later"
  }
 ]
}
```

`s21_oldest`:

```json
{
 "at": "2026-09-26T08:06:41.531Z",
 "currentHistoryId": "36554901",
 "firstMessagesAdded": [
  {
   "ageHours": 680.3,
   "internalDateIso": "2026-08-28T23:49:24.000Z",
   "messageId": "1a04ad16694b2562",
   "recordId": "36181824"
  },
  {
   "ageHours": 680.1,
   "internalDateIso": "2026-08-29T00:00:44.000Z",
   "messageId": "1a04ad198dcd15f3",
   "recordId": "36181846"
  },
  {
   "ageHours": 680.1,
   "internalDateIso": "2026-08-29T00:01:02.000Z",
   "messageId": "1a04ad1e1148e7bb",
   "recordId": "36181917"
  },
  {
   "ageHours": 680.1,
   "internalDateIso": "2026-08-29T00:03:05.000Z",
   "messageId": "1a04ad4106c1668e",
   "recordId": "36182008"
  },
  {
   "ageHours": 680,
   "internalDateIso": "2026-08-29T00:06:54.000Z",
   "messageId": "1a04ad73f4363dac",
   "recordId": "36182026"
  },
  {
   "ageHours": 679.8,
   "internalDateIso": "2026-08-29T00:16:07.000Z",
   "messageId": "1a04adfad2e4a463",
   "recordId": "36182045"
  },
  {
   "ageHours": 679.8,
   "internalDateIso": "2026-08-29T00:21:07.000Z",
   "messageId": "1a04ae44bb1b2c9f",
   "recordId": "36182065"
  },
  {
   "ageHours": 679.4,
   "internalDateIso": "2026-08-29T00:39:54.000Z",
   "messageId": "1a04af6222d6eba0",
   "recordId": "36182142"
  },
  {
   "ageHours": 680.2,
   "internalDateIso": "2026-08-28T23:52:36.000Z",
   "messageId": "1a04afc154f9c72e",
   "recordId": "36182279"
  },
  {
   "ageHours": 679.4,
   "internalDateIso": "2026-08-29T00:45:30.000Z",
   "messageId": "1a04afecbe21af17",
   "recordId": "36182303"
  }
 ],
 "idsRetained": 373078,
 "newestRejected": "36181822",
 "oldestValid": "36181823",
 "probes": 26
}
```

</details>

<details><summary>s21_report (day 7+), s21_removeTrigger</summary>

</details>

## Conclusion

(After the run.)

## Design changes

(SD §6.3 "Expired position", SD §14 first row, and #62, #73, after the run.)
