# 99: does Apps Script's V8 give the same day as Node for `Intl.DateTimeFormat` with a `timeZone`?

- Task: #99 (story #98, epic #11 decision 10)
- Date run: 2026-09-29
- Account: `<test-account>` (consumer)
- Run by: agent via `spikes/run.mjs`

## Question

The daily token budget (`state.budget`, SD §10.2) keys its count by the calendar day in the script's time zone. `dayInTimeZone` in `src/core/token-budget.ts` computes that day with `Intl.DateTimeFormat('en-US', {timeZone, year, month, day}).formatToParts`. Apps Script's V8 could ship smaller ICU data than Node, so does it give the same `YYYY-MM-DD`? The reference is `Utilities.formatDate(date, zone, 'yyyy-MM-dd')`, Apps Script's own.

If they disagreed, the fallback (epic #11 decision 10) was a `today()` method on `ClockPort`, implemented with `Utilities.formatDate`.

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s99_days` (no arguments: the default cases below). Optional argument `{"instants": [epochMs, ...], "zones": [...]}`.
3. Node's answer for each row is the `dayInTimeZone` table in `test/core/token-budget.test.ts`, which must pass with the days below.

No Gmail call, no Script Property, no trigger.

## Maintainer steps

None.

## Results

`s99_days` returned 36 rows for six zones (`Etc/UTC`, `America/Chicago`, `Asia/Kolkata`, `Pacific/Kiritimati`, `Australia/Lord_Howe`, `Pacific/Pago_Pago`): one minute before, at and one minute after local midnight on 2026-09-29 in each, and, for `America/Chicago`, around local midnight on the DST days 2026-03-08 and 2026-11-01 (and the days after), and around the 02:00 spring-forward gap and the repeated fall-back hour.

`allAgree` was `true`: Apps Script's `Intl` algorithm and `Utilities.formatDate` returned the same day in every row, and Node returns the same day in every row too (the test table).

| Zone | Instant (UTC) | Case | `Intl` day | `Utilities.formatDate` day |
|------|---------------|------|-----------|----------------------------|
| `Etc/UTC` | 2026-09-28T23:59:00Z | one minute before midnight 2026-09-29 | 2026-09-28 | 2026-09-28 |
| `Etc/UTC` | 2026-09-29T00:00:00Z | midnight 2026-09-29 | 2026-09-29 | 2026-09-29 |
| `Etc/UTC` | 2026-09-29T00:01:00Z | one minute after midnight 2026-09-29 | 2026-09-29 | 2026-09-29 |
| `America/Chicago` | 2026-09-29T04:59:00Z | one minute before midnight 2026-09-29 (UTC-5) | 2026-09-28 | 2026-09-28 |
| `America/Chicago` | 2026-09-29T05:00:00Z | midnight 2026-09-29 (UTC-5) | 2026-09-29 | 2026-09-29 |
| `America/Chicago` | 2026-09-29T05:01:00Z | one minute after midnight 2026-09-29 (UTC-5) | 2026-09-29 | 2026-09-29 |
| `Asia/Kolkata` | 2026-09-28T18:29:00Z | one minute before midnight 2026-09-29 (UTC+5:30) | 2026-09-28 | 2026-09-28 |
| `Asia/Kolkata` | 2026-09-28T18:30:00Z | midnight 2026-09-29 (UTC+5:30) | 2026-09-29 | 2026-09-29 |
| `Asia/Kolkata` | 2026-09-28T18:31:00Z | one minute after midnight 2026-09-29 (UTC+5:30) | 2026-09-29 | 2026-09-29 |
| `Pacific/Kiritimati` | 2026-09-28T09:59:00Z | one minute before midnight 2026-09-29 (UTC+14) | 2026-09-28 | 2026-09-28 |
| `Pacific/Kiritimati` | 2026-09-28T10:00:00Z | midnight 2026-09-29 (UTC+14) | 2026-09-29 | 2026-09-29 |
| `Pacific/Kiritimati` | 2026-09-28T10:01:00Z | one minute after midnight 2026-09-29 (UTC+14) | 2026-09-29 | 2026-09-29 |
| `Australia/Lord_Howe` | 2026-09-28T13:29:00Z | one minute before midnight 2026-09-29 (UTC+10:30) | 2026-09-28 | 2026-09-28 |
| `Australia/Lord_Howe` | 2026-09-28T13:30:00Z | midnight 2026-09-29 (UTC+10:30) | 2026-09-29 | 2026-09-29 |
| `Australia/Lord_Howe` | 2026-09-28T13:31:00Z | one minute after midnight 2026-09-29 (UTC+10:30) | 2026-09-29 | 2026-09-29 |
| `Pacific/Pago_Pago` | 2026-09-29T10:59:00Z | one minute before midnight 2026-09-29 (UTC-11) | 2026-09-28 | 2026-09-28 |
| `Pacific/Pago_Pago` | 2026-09-29T11:00:00Z | midnight 2026-09-29 (UTC-11) | 2026-09-29 | 2026-09-29 |
| `Pacific/Pago_Pago` | 2026-09-29T11:01:00Z | one minute after midnight 2026-09-29 (UTC-11) | 2026-09-29 | 2026-09-29 |
| `America/Chicago` | 2026-03-08T05:59:00Z | one minute before midnight 2026-03-08 (UTC-6) | 2026-03-07 | 2026-03-07 |
| `America/Chicago` | 2026-03-08T06:00:00Z | midnight 2026-03-08 (UTC-6) | 2026-03-08 | 2026-03-08 |
| `America/Chicago` | 2026-03-08T06:01:00Z | one minute after midnight 2026-03-08 (UTC-6) | 2026-03-08 | 2026-03-08 |
| `America/Chicago` | 2026-03-08T07:59:00Z | one minute before the spring-forward gap (02:00 CST) | 2026-03-08 | 2026-03-08 |
| `America/Chicago` | 2026-03-08T08:00:00Z | the spring-forward gap (02:00 CST) | 2026-03-08 | 2026-03-08 |
| `America/Chicago` | 2026-03-08T08:01:00Z | one minute after the spring-forward gap (02:00 CST) | 2026-03-08 | 2026-03-08 |
| `America/Chicago` | 2026-03-09T04:59:00Z | one minute before midnight 2026-03-09 (UTC-5) | 2026-03-08 | 2026-03-08 |
| `America/Chicago` | 2026-03-09T05:00:00Z | midnight 2026-03-09 (UTC-5) | 2026-03-09 | 2026-03-09 |
| `America/Chicago` | 2026-03-09T05:01:00Z | one minute after midnight 2026-03-09 (UTC-5) | 2026-03-09 | 2026-03-09 |
| `America/Chicago` | 2026-11-01T04:59:00Z | one minute before midnight 2026-11-01 (UTC-5) | 2026-10-31 | 2026-10-31 |
| `America/Chicago` | 2026-11-01T05:00:00Z | midnight 2026-11-01 (UTC-5) | 2026-11-01 | 2026-11-01 |
| `America/Chicago` | 2026-11-01T05:01:00Z | one minute after midnight 2026-11-01 (UTC-5) | 2026-11-01 | 2026-11-01 |
| `America/Chicago` | 2026-11-01T06:59:00Z | one minute before the fall-back hour (02:00 CDT to 01:00 CST) | 2026-11-01 | 2026-11-01 |
| `America/Chicago` | 2026-11-01T07:00:00Z | the fall-back hour (02:00 CDT to 01:00 CST) | 2026-11-01 | 2026-11-01 |
| `America/Chicago` | 2026-11-01T07:01:00Z | one minute after the fall-back hour (02:00 CDT to 01:00 CST) | 2026-11-01 | 2026-11-01 |
| `America/Chicago` | 2026-11-02T05:59:00Z | one minute before midnight 2026-11-02 (UTC-6) | 2026-11-01 | 2026-11-01 |
| `America/Chicago` | 2026-11-02T06:00:00Z | midnight 2026-11-02 (UTC-6) | 2026-11-02 | 2026-11-02 |
| `America/Chicago` | 2026-11-02T06:01:00Z | one minute after midnight 2026-11-02 (UTC-6) | 2026-11-02 | 2026-11-02 |

Other findings:

- `Session.getScriptTimeZone()` was `Etc/UTC`, and `Intl.DateTimeFormat().resolvedOptions().timeZone` was `UTC`.
- An invalid zone (`Not/AZone`) makes `Intl.DateTimeFormat` throw `RangeError: Invalid time zone specified: Not/AZone`, as in Node, which `dayInTimeZone` turns into `InvalidArgumentError`. `Utilities.formatDate` did **not** throw for it (`threw: false`), so it can't be used to validate a zone.

<details>
<summary>Raw output (without the rows above)</summary>

```json
{
 "scriptTimeZone": "Etc/UTC",
 "invalidZoneFormatDate": {
  "threw": false
 },
 "invalidZoneIntl": {
  "name": "RangeError",
  "threw": true,
  "message": "Invalid time zone specified: Not/AZone"
 },
 "allAgree": true,
 "rowCount": 36,
 "disagreements": [],
 "intlResolvedTimeZone": "UTC"
}
```

</details>

## Conclusion

They agree. `dayInTimeZone` can use `Intl.DateTimeFormat` in the deployed script, so `ClockPort` doesn't need a `today()` method. DST days and half-hour zones (`Asia/Kolkata`, `Australia/Lord_Howe`) match `Utilities.formatDate` and Node.

## Design changes

- **SD §10.2:** "a day" is the calendar day from `dayInTimeZone(clock.now(), clock.timeZone())`; links here.
- **SD §7.3:** the `state.budget` row gives the stored shape and the module.
