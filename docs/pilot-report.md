# Pilot report

The record of the v1 pilot. Task #158, story #156, epic #16. The plan is `docs/pilot.md`. All times are in UTC. Dates are `YYYY-MM-DD`.

**Status: the pilot is finished.** Window `w1` ran its 14 days without a restart, and every measure passed, two of them by the maintainer's judgment (section 4). Every number here comes from a comment on #158, and that comment is linked.

The pilot's log holds mail content, so this report holds only counts, event names, rule IDs, `stopped` values, error class names, `reason` codes, alert conditions, model names and dates.

## 1. Summary

The classifier ran for 14 days on the maintainer's own mailbox, a consumer account, at a 10-minute interval. It classified 875 threads and applied 210 labels and 321 moves. All 401 checked actions were correct. No run failed, no thread was marked `Jev/Error`, no alert was sent, and the maintainer did nothing to the script or its config. The one late thread (2026-10-08) waited while Jev was slow, and the maintainer accepted it as designed. The cross-check of mail that Gmail's history never reported was skipped by the maintainer.

| Item | Value |
|------|-------|
| The window that counted | `w1`, 2026-10-03T22:23Z to 2026-10-17T22:23Z |
| Version and commit | 0.9.1, `6c7153c845be548bc2364f3fbe214dfab3ccfd26` |
| Trigger interval | 10 minutes |
| Account kind | Consumer |

| Measure | Target | Number | Result |
|---------|--------|--------|--------|
| Precision | At least 95% of applied labels and moves are correct, by manual spot-check | `precision.estimate` 1, with 401 actions checked | Pass |
| Latency | A conversation is handled within 2 trigger intervals of arrival | `latency.lateEpisodes` 1 | Pass (judged) |
| Coverage | 100% of eligible conversations end up processed or explicitly marked as errored | 0 balance breaks, 0 unresolved failures, 0 fallback misses; no cross-check | Pass (judged) |
| Cost | Under $5 per month at personal volume | About $0.24 per 30 days | Pass |
| Quota safety | Zero executions fail from Apps Script quota or timeout errors | 0 | Pass |
| Effort | Near-zero maintenance after setup | 0 required interventions | Pass |

## 2. Windows

One row per start of the clock. The first row repeats the start record in `docs/pilot.md` section 4.

| Window | T0 | Commit | Version | Trigger interval | Plan used | How it ended |
|--------|----|--------|---------|------------------|-----------|--------------|
| `w1` | 2026-10-03T22:23Z | `6c7153c845be548bc2364f3fbe214dfab3ccfd26` | 0.9.1 | 10 minutes | `docs/pilot.md` at `bae307f` | Ran its 14 days to 2026-10-17T22:23Z without a restart. It counts. |

The rest of `w1`'s start record: the account is a consumer account; `timeZone` is `Etc/UTC`; `jevModel` is `jev-latest`; 12 label rules and 4 move rules (`archive` 1, `spam` 0, `trash` 0, `label` 3); `excludeQuery` is set.

## 3. Checkpoints

One row per checkpoint of each window.

| Window | Checkpoint | Due | Done on | What was posted | What was found |
|--------|------------|-----|---------|-----------------|----------------|
| `w1` | C1 | 2026-10-04T22:23Z | 2026-10-05 | [The reducer's output and the checks](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-5987595504) | Every measure can be read. 144 runs, all clean; 80 threads classified; 40 applied actions; no failure, no alert, no bug. The start gap's p95 is 604,530 ms against a 600,000 ms interval. One run took 42,341 ms, over its 30,000 ms soft limit plus the 10,000 ms reserve and far under the 6-minute limit. |
| `w1` | C2 | 2026-10-10T22:23Z | 2026-10-11 (first part), 2026-10-21 (precision) | [The reducer's output and the diagnosis](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-6111742446); [precision](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-6304674483) | 1,008 runs, all ended; 446 threads classified; 109 applied labels and 167 applied moves. One late episode on 2026-10-08: two `send_deadline` runs in a row while Jev was slow and gave retryable answers; one thread waited 20 to 30 minutes; nothing lost, no strike. Worksheet: 207 rows, all correct. The config copy equals C1's. |
| `w1` | C3 | 2026-10-17T22:23Z | 2026-10-20 (first part), 2026-10-21 (precision and the maintainer's answers) | [The reducer's output and the checks](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-6304023665); [the maintainer's answers](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-6304633480); [precision and the measures](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-6304674483) | 2,016 runs, all ended; 875 threads classified; days 8 to 14 had no retry and no late episode. One `ingest.done` line is missing from the log (2026-10-14T22:23Z); the next run's history position shows ingest ran. Worksheet: 194 rows, all correct. The config copy equals C2's. No clock restart. |

The log is kept 30 days, so the last export of `w1` had to be made before 2026-11-02T22:23Z. It was made on 2026-10-20.

## 4. The measures

From the reducer at `7ed1a25`, over the three exports, with `--from 2026-10-03T22:23:00Z --to 2026-10-17T22:23:00Z --interval 10 --usd-per-million 0.042`, the pilot's config and both worksheets in `--checked`. The output is in the [C3 comments](https://github.com/kellystuard/jev-gmail-classifier/issues/158#issuecomment-6304023665).

### 4.1 Precision

- **Formula** (plan 6.2): (correct moves + applied labels × correct labels ÷ checked labels) ÷ (applied moves + applied labels).
- **Numbers:** `precision.moves` 321 applied, 321 checked, 321 correct. `precision.labels` 210 applied, 80 checked, 80 correct. `precision.estimate` 1. 401 actions checked, against the 60 the plan asks for.
- **Per rule** (applied / checked / correct): `promotion` 311/311/311, `newsletter` 10/10/10, `event` 60/10/10, `deadline` 41/12/12, `reply` 40/11/11, `receipt` 21/10/10, `suspicious` 19/12/12, `approval` 14/10/10, `renewal` 7/7/7, `security` 3/3/3, `travel` 3/3/3, `personal` 1/1/1, `tax` 1/1/1. `bill`, `shipping` and `social` never fired.
- **Moves:** all 321 are `move:label`, from two of the four move rules. No `spam` or `trash` rule was configured, and the `archive` rule never fired. The maintainer accepted this as enough exercise of moves for v1; archive, Spam and Trash were checked on the test account in the smoke test (#155, checks E2, L13, L14).
- **Also:** `coverage.moveSkipped` 0 and `coverage.labelsSkipped` 0. `promotion` fired 380 times and was applied 311 times, `newsletter` 15 and 10: the other firings were on threads that held older mail, where moves aren't allowed. One model answered: `jev-1.13.0`, for all 874.
- **Result: pass.** One reviewer checked every row, as the plan says (section 8: no second opinion).

### 4.2 Latency

- **Formula** (plan 6.3): a late episode is two clean runs in a row where the second ended more than 1,320 s after the first started.
- **Numbers:** `latency.cleanRuns` 2,013, `otherRuns` 3, `lateEpisodes` 1, `maxCleanSpanMs` 1,800,100, `longestNotCleanStreak` 2. `startGapMs` p50 600,012, p95 604,767, max 656,206; `startGapsOverTwoIntervals` 0. `runs.onTrigger.stopped`: `drained` 2,014, `send_deadline` 2.
- **The late episode:** 2026-10-08, about 12:44 to 13:14. Jev took 21 s and 27 s for batches that usually take 1 to 2 s, and gave retryable answers. Two runs in a row used up their sending time in the first round, so their retries waited for the next run (SD §8.5). One thread waited between 20.2 and 30.0 minutes. Nothing was lost and no strike was added. No code or config cause was found.
- **The other non-clean run:** 2026-10-14T22:23Z, whose `ingest.done` line is missing from the export. It ended `drained` in 329 ms, and the next run started from the history position this run saved, so ingest ran and found nothing.
- **Result: pass (judged).** The maintainer accepted the episode: "as designed". Plan section 9: a cause outside the code and config is judged by the maintainer.

### 4.3 Coverage

- **Formula** (plan 6.4): a run's `queueSize` equals the previous one's plus `ingested` minus what left the queue; a failed thread must be resolved later; plus the cross-check.
- **Numbers:** `coverage.scheduled`: 890 ingested, 11 merged, 0 excluded, 15 skipped (all `not_found`), 875 classified, 0 errored, 0 gone, 0 struck, 3 untouched (all classified in a later run), `queueFirst` 0, `queueLast` 0. `balanceBreaks` 0, `balanceNotChecked` 1 (the window's first run), `failedThreads` 0, `failedUnresolved` 0, `fallbackMissed` 0, `historyExpired` 0, `truncated` 31.
- **The cross-check** was skipped by the maintainer at C3, so the mail that Gmail's history never reported is not checked by this pilot.
- **Result: pass (judged)** on the three log counts, which are all 0. The cross-check part is recorded in section 8 as not done.

### 4.4 Cost

- **Formula** (plan 6.5): `cost.inputTokens` ÷ `window.days` × 30 ÷ 1,000,000 × the price.
- **Numbers:** `cost.inputTokens` 2,662,224 (all scheduled), `tokensPer30Days` 5,704,766, `usdPer30Days` 0.24. `budget.reached` 0.
- **The price**, re-read on 2026-10-21 on [TypeSafe's models page](https://docs.typesafe.ai/models): $0.042 per million input tokens; output tokens are free.
- **TypeSafe's own figure** was not posted, so the cost is read from the log alone.
- **Result: pass**, about 20 times under the target.

### 4.5 Quota safety

- **Numbers:** `quota.runUnfinished` 0, `quota.runFailed` none, `quota.platformErrors` 0 inside the window, `quota.rateLimitedStops` 0, `latency.startGapsOverTwoIntervals` 0. `runs.onTrigger.durationMs` max 42,341 (against 360,000), `maxDurationPerUtcDayMs` 281,970 (against 5,400,000), `maxGmailCallsToday` 1,276 (against 20,000).
- **The Executions page** (the maintainer, at C3): 1 "Failed", 0 "Timed out". The failed one lasted 0 s and has no log. It took no trigger slot: the window has exactly 2,016 `onTrigger` runs (14 × 144), all ended, and no start gap is over two intervals. A 0-second execution is not a timeout, and Cloud Logging has no error entry inside the window, so nothing points to a quota.
- **Result: pass.**

### 4.6 Effort

- **Numbers:** the maintainer's list of actions after T0 is empty ("Nothing done to script / config"). `alerts.sent` and `alerts.failed` are empty. No entry point but `onTrigger` ran.
- **Listed, not counted:** the spot-check of both worksheets.
- **Result: pass**, 0 required interventions.

## 5. Changes during the window

No push to the pilot account after T0: the config copies at C1, C2 and C3 are equal, and the maintainer did nothing to the script or its config. One model answered the whole window: `jev-1.13.0`. TypeSafe's models page lists `jev-1.14` on 2026-10-21, so a later run of `jev-latest` may answer with it.

During the window, #337 (dev dependencies only; `zod` and `esbuild` unchanged) merged to `main` and was not deployed. It did not restart the clock.

## 6. Bugs

None. The pilot found no bug in the classifier or in the reducer.

## 7. Observed for the first time

- **C12, a retried request** (smoke test, "when it happens"): seen on 2026-10-08 at 05:13Z, with `rounds` 2 and `sleptMs` 422, and the request succeeded. Two runs later that day stopped with `send_deadline` before their retry round (section 4.2).
- **N20, the `Jev/Error` alert:** not seen. No thread was marked `Jev/Error`.
- **A missing-scope error text** (SD §9, §14): not seen. Every scope stayed granted.
- **Apps Script's time-limit and quota error texts** (plan section 10): not seen. After the window, on 2026-10-19 and 2026-10-20, Apps Script logged two of its generic server errors ("We're sorry, a server error occurred. Please wait a bit and try again.") and one Error Reporting notice about them. They are outside the window and count in no measure.

## 8. Limits of this report

- **One mailbox, one account kind:** the maintainer's own consumer account. No Workspace account was used (epic #16, the maintainer's answer for #160).
- **One reviewer.** Every worksheet row was judged by the maintainer, as the plan says.
- **No cross-check.** The maintainer skipped it, so coverage is measured only on what Gmail's history reported.
- **Moves:** only `move:label` ran on real mail. Archive, Spam and Trash were checked on the test account (#155), not here.
- **No manual run** was made during the window, so `coverage.manual` is all 0.
- **The cost** comes from the log alone: TypeSafe's own figure was not posted.

How each fact that `docs/pilot.md` section 10 lists as not confirmed turned out:

| Not confirmed | How it turned out |
|---------------|-------------------|
| How long the Executions page keeps an execution | Not settled: the maintainer's look at C3 gave the counts, not how far back the page went. |
| Whether the 7-day expiry of a "Testing" project stops a trigger | Avoided: the consent screen was "In production", and the trigger ran all 14 days. |
| Whether the four scopes must be listed under Data Access | No problem was noted on #157. |
| The shape of an exported entry | `jsonPayload.message`, with `resource.type` `app_script_function`, in every export. |
| Apps Script's time-limit and quota error texts | Not seen (section 7). |
| Whether Cloud Logging charges for this volume | No charge was reported. The three exports total about 15 MB. |
| Whether TypeSafe's account page shows usage for a date range | Not settled: no figure was posted. |
| When Apps Script's daily quotas start and end | Not settled. The supporting figures stay far under the limits. |
| The console labels in plan section 3.2 | No wrong label was noted on #157. |
