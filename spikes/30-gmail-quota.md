# 30: Gmail quota accounting for the Advanced Gmail Service

- Task: #30 (story #28)
- Date run: 2026-09-26 (docs checked 2026-09-25)
- Account: `<test-account>` (consumer)
- Run by: agent via #163

## Question

Do Advanced Gmail Service calls count toward Apps Script's "Email read/write (excluding send)" daily quota (SD §9, §14)? Apps Script can't report the remaining quota, and the maintainer ruled out testing by hitting the limit (epic #7). So this task:

1. records what the docs say, with sources and dates;
2. proves a **persisted daily Gmail-call counter** that the product can keep, across independent executions (`scripts.run` and a trigger) and across a day change;
3. samples per-call latency for E7's chunk sizing (#118, #122).

The quota is never exhausted. Actual use was 481 counted calls in one day (including two latency attempts that hit the per-user rate limit, below), far below the 20,000/day figure.

## Part 1: what the docs say

Checked 2026-09-25.

| Quota or limit | Figure | Source | Page last updated |
|----------------|--------|--------|-------------------|
| Apps Script "Email read/write (excluding send)", consumer | 20,000 / day | [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) | 2026-09-03 |
| Same, Google Workspace (reference only; out of scope for E1) | 50,000 / day | same | 2026-09-03 |
| When Apps Script quotas reset | "Quotas are per user and reset 24 hours after the first request." (Not at midnight, and not in the script's time zone.) | same | 2026-09-03 |
| Whether advanced services count | Not stated. The page says only: "Using a product's Apps Script service counts toward all associated quota reserves." | same | 2026-09-03 |
| Triggers total runtime, consumer | 90 min / day | same | 2026-09-03 |
| Script runtime | 6 min / execution | same | 2026-09-03 |
| Properties value size | 9 KB / value | same | 2026-09-03 |
| Gmail API, per user per project | 6,000 quota units / minute | [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota) | 2026-09-10 |
| Gmail API, per project | 1,200,000 quota units / minute | same | 2026-09-10 |
| Gmail API, per project per day | 80,000,000 quota units: a threshold "before charges apply". The page also says "Exceeding the quota request limits is planned to incur charges to your Google Cloud billing account later in 2026." (New since the SD was written.) | same | 2026-09-10 |
| Unit cost: `getProfile` | 1 | same | 2026-09-10 |
| Unit cost: `labels.list` | 1 | same | 2026-09-10 |
| Unit cost: `history.list` | 2 | same | 2026-09-10 |
| Unit cost: `labels.create` | 5 | same | 2026-09-10 |
| Unit cost: `threads.list` | 10 | same | 2026-09-10 |
| Unit cost: `threads.modify` | 10 | same | 2026-09-10 |
| Unit cost: `threads.trash` | 20 | same | 2026-09-10 |
| Unit cost: `messages.get`, `messages.attachments.get` | 20 | same | 2026-09-10 |
| Unit cost: `messages.insert`, `messages.import` | 25 | same | 2026-09-10 |
| Unit cost: `threads.get` (any format) | 40 | same | 2026-09-10 |

The unit costs match the figures in the task (checked 2026-09-25). They contradict SD §9's "`threads.get` full is the largest": `threads.get` costs 40 units in any format.

**Community reports** (searched 2026-09-25: Stack Overflow, the Apps Script issue tracker, Google Groups, Google Developer forums):

| Source | Date | What it shows |
|--------|------|---------------|
| [Google Groups: "Service invoked too many times for one day: gmail (no sending mails just reading attachments)"](https://groups.google.com/g/google-apps-script-community/c/8FU8WoiF318) | 2020-05-18 | The daily `gmail` error from reading only, after about 300 executions. The thread doesn't say whether `GmailApp` or the Advanced Service was used, and no reply addresses it. |
| [OctoGAS issue #4](https://github.com/mastahyeti/OctoGAS/issues/4) | 2014-06-23 | "Service invoked too many times in a short time: gmail rateMax", from `GmailApp`. A short-term rate limit, not the daily quota. |
| Max Makhrov, "MMailApp for Google Apps Script: GmailApp+MailApp+Gmail API" (Medium) | unknown | A search snippet quotes the author: "using Gmail API does not change my daily quota calculated earlier. And it seems to be free." The page returned 403, so this is **unverified**. |
| [Google Developer forums: "Quota limit for gmail service"](https://discuss.google.dev/t/quota-limit-for-gmail-service/193428) | 2025-07-04 | About the send quota. Doesn't mention advanced services. |

No official or reliable community source says whether Advanced Gmail Service calls count toward the 20,000/day "Email read/write" quota. The one claim that they don't is unverified. **The question stays undocumented, and is deliberately not tested.** If the quota is ever hit, Apps Script throws "Service invoked too many times for one day: gmail", which E7's error handling should treat as "stop sending Gmail calls until tomorrow", not as a thread failure.

## Part 2: the persisted daily Gmail-call counter

The pattern the product would use:

- Script Property `s30.gmailCalls` = `{"day": "YYYY-MM-DD", "count": N}`. `day` is today in the script's time zone (`Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')`). (The task names the key `spike.gmailCalls`; it's `s30.gmailCalls` here to keep to the shared project's `s30.` prefix rule, and likewise `s30.triggerResult`.)
- It is read **once** per execution. Every Gmail call goes through `gmailCall(fn)`, which increments an in-memory count (before the call, since a call that throws may still have used quota). If the stored `day` isn't today, the count starts at 0.
- It is written **once**, at the end of the execution, in a `finally`, to save Script Properties writes.

Spike functions:

| Function | Args (JSON) | Returns |
|----------|-------------|---------|
| `s30_tick` | `[n, useLock]` (defaults `3`, `false`) | `{executionId, n, day, before, resetForNewDay, after, counterBytes, readAt, writtenAt, useLock, lockWaitMs}` |
| `s30_simulateDayChange` | `[day]` (default: tomorrow) | A tick of 1 with "today" injected, plus `realDay` and `simulatedDay` |
| `s30_installTickTrigger` | none | `{installedAt, handler, triggerId, staleTriggersRemoved}` |
| `s30_triggerTick` | (trigger event) | Runs `tick(5)`, saves the result in `s30.triggerResult`, deletes its own trigger |
| `s30_readTriggerResult` | none | `{result, pending, s30TriggersInstalled}` |
| `s30_readCounter` | none | `{counter, counterBytes, today, timeZone}` |
| `s30_measureLatency` | `[n, unitsPerSecond]` (defaults `20`, `25`) | Latency stats per call kind (Part 3) |
| `s30_cleanup` | `[removeLabel]` (default `false`) | Deletes `s30.*` properties and `s30_triggerTick` triggers, and optionally the `Spike/Quota` label |

## Part 3: latency sample

`s30_measureLatency()` times `n` calls (default 20) of each kind with `Date.now()`, discards the first (warm-up), and returns min, median, p95 (nearest rank), and max in ms, plus the first call's time. On first use it inserts its own synthetic threads (one 1-message thread and one 5-message thread, threaded with `threadId`, `In-Reply-To`, `References`, and a matching Subject; saved in `s30.threads`) and creates the `Spike/Quota` label (or `Spike-Quota` if the nested name is refused). All of these calls go through the counter too.

Kinds: `getProfile`; `history.list` (from the small thread's `historyId`); `threads.list` (`q: 'in:inbox'`, `maxResults: 100`); `threads.get` metadata (`metadataHeaders: ['Subject']`) on the small thread; `threads.get` full on the small and the 5-message thread; `threads.modify` add and remove of `Spike/Quota`. That's 160 timed calls, about 3,100 quota units. After each call it sleeps so that calls are spread at `unitsPerSecond` quota units per second (default 25, a quarter of the 6,000/minute per-user limit); the first, unpaced version hit that limit (see Results). The reported times exclude the sleep.

## Runbook

The day-change scenario runs **last**, because it leaves the stored `day` set to tomorrow, and the next real run then resets the count (the reset rule is "the day differs", not "the day is later").

1. `node spikes/run.mjs push`.
2. `node spikes/run.mjs run s30_readCounter` (baseline; `counter` is `null` on a fresh project).
3. **Scenario 1:** three separate executions: `run s30_tick '[3]'`, `run s30_tick '[5]'`, `run s30_tick '[7]'`. Each `after.count` should be the previous `after.count` plus `n`.
4. **Scenario 2:** `run s30_installTickTrigger`, wait at least 2 minutes, then `run s30_readTriggerResult` and `run s30_readCounter`. The trigger's `after.count` should be scenario 1's last count plus 5, and `s30TriggersInstalled` should be 0.
5. **Scenario 4:** start two `node spikes/run.mjs run s30_tick '[20]'` processes at the same time (for example `cmd & cmd & wait`). Then `run s30_readCounter`. Without a lock, both read the same `before`, so one update is lost: the count rises by 20, not 40. **Scenario 4b:** repeat with `'[20, true]'` (script lock held for the whole execution): the count should rise by 40, and one run's `lockWaitMs` shows the wait. (The script lock is shared by every spike in the project. It's held for a few seconds only.)
6. **Latency:** `run s30_measureLatency` (paced; if another story's spikes are busy, wait a few minutes first). Then `run s30_readCounter`: the count should rise by the returned `gmailCallsThisExecution`.
7. **Scenario 3 (last):** `run s30_simulateDayChange`. `resetForNewDay` should be `true` and `after.count` 1.
8. `run s30_cleanup '[true]'`.
9. Fill in the tables below, the budget analysis, and the conclusion. Update SD §9, §7.3, and §14. Post the latency table and the budget on #122, and comment on #118 and #143 (or list them in the PR).

## Maintainer steps

None.

## Results

All results come from the JSON the spike functions returned (raw output below). Run 2026-09-26 between 08:05 and 09:06 UTC, through `node spikes/run.mjs` from an agent.

### Counter

| Scenario | Execution | `executionId` | `n` | Count before | Count after | `day` | As expected? |
|----------|-----------|---------------|-----|--------------|-------------|-------|--------------|
| baseline | `scripts.run` (`s30_readCounter`) | — | 0 | `null` | `null` | 2026-09-26 | Yes |
| 1a | `scripts.run` | `b8913f27` | 3 | `null` | 3 | 2026-09-26 | Yes |
| 1b | `scripts.run` | `427c87e7` | 5 | 3 | 8 | 2026-09-26 | Yes |
| 1c | `scripts.run` | `47cdcfff` | 7 | 8 | 15 | 2026-09-26 | Yes |
| 2 | time-driven trigger (installed 08:06:06, fired 08:07:35) | `1d2dc173` | 5 | 15 | 20 | 2026-09-26 | Yes. `s30_readCounter` then read 20, and the trigger had deleted itself (`s30TriggersInstalled: 0`). |
| 4 | two `scripts.run` started together, no lock | `c2264085`, `228177e9` | 20 + 20 | 20, 20 | 40, 40 | 2026-09-26 | Yes, as predicted: **one update was lost**. Both read 20 (at 08:09:57.6 and 57.7) and both wrote 40, so the stored count was 40, not 60. |
| 4b | two `scripts.run` started together, script lock held | `1c943569`, `5f8267e2` | 20 + 20 | 40, 60 | 60, 80 | 2026-09-26 | Yes: exact. The second waited 1,833 ms for the lock (`lockWaitMs`), then read the first's 60. |
| latency (unpaced, first attempt) | `scripts.run` | — | 127 calls | 80 | 207 | 2026-09-26 | Yes: the execution threw (rate limit, below), and the `finally` still saved every call it made, including the failed one. |
| latency (second attempt) | `scripts.run` | — | 112 calls | 207 | 319 | 2026-09-26 | Yes (it also threw; see below). |
| latency (paced) | `scripts.run` | `d4e94cc2` | 162 calls | 319 | 481 | 2026-09-26 | Yes: `gmailCallsThisExecution` 162 = 481 − 319. |
| 3 | `scripts.run`, injected day 2026-09-27 | `b1e0e081` | 1 | 481 (day 2026-09-26) | 1 (day 2026-09-27) | 2026-09-27 (injected) | Yes: `resetForNewDay: true`, then +1. |

The counter property is 30–32 bytes (`{"day":"2026-09-26","count":481}`), far under the 9 KB limit. Every Gmail call in the spike went through `gmailCall`, and the counter rose by exactly the number of calls each execution made, across 12 independent executions, one of them a trigger. `s30_cleanup` then deleted the `s30.*` properties and the `Spike/Quota` label (the synthetic threads stay in the throwaway account).

**Does the counter need `LockService` to be exact?** Yes, if two executions can overlap: without a lock, the read-once/write-once pattern loses the earlier writer's calls (scenario 4). With the script lock held for the whole execution, it's exact (4b). The product already runs under one script lock taken with `tryLock(0)` (SD §10.4, ADR-0008), so its counter is exact as long as it is read and written inside the lock. That's a note for E7 (#118), not a flaw.

### Gmail rate limit hit (per user, per minute)

The first, unpaced `s30_measureLatency` run (back-to-back calls) failed after about 18 s and 127 calls, about 2,900 quota units, with this exact error (the Cloud project number is replaced):

```
GoogleJsonResponseException: API call to gmail.users.threads.get failed with error: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:<project-number>'.
```

- It is the documented 6,000 units/minute per-user limit, not the daily quota. It came back as a normal script error (`USER_ERROR`) from `Gmail.Users.Threads.get`.
- It tripped at about 160 units/s, sustained for 18 s: about 2,900 units, half of 6,000. Two explanations fit, and the spike can't tell them apart without probing the limit (which it deliberately doesn't do): Google may enforce the limit as a rate (6,000/min is 100 units/s) rather than as a total over a fixed minute; or other stories' spikes, which share this user and Cloud project, were using units in the same minute.
- A second attempt, 50 minutes later, failed the same way after 112 calls (24.7 s). That run executed the unpaced code, because a concurrent `push` from another branch had briefly restored the older file. The paced run afterwards (25 units/s) had no errors.
- **Another data point (#25/#26, same day):** those spikes hit the same limit once, reported as `403 rateLimitExceeded` with "Units per minute per user", while four stories were running spikes on the account at once. A 5-minute backoff cleared it. So the error is a 403 (not a 429), and it recovers within minutes.
- **For the product:** back-to-back `threads.get` (40 units, ~160 ms) runs at about 250 units/s, and a get + modify pair per thread at about 150 units/s. Both are above 100 units/s. So a run that processes threads as fast as it can will hit this limit within seconds, well before the 30 s soft limit. E7 must (a) size chunks by quota units as well as time, and (b) treat this error as "stop starting Gmail work in this run; retry next run", not as a thread failure. It is not the daily quota, so it must not trigger the daily stop.

### Latency

Paced run (`s30_measureLatency`, 25 units/s, 20 calls per kind, first discarded; p95 is nearest-rank, so with n = 19 it equals the max). Times are for the call only, not the pacing sleep.

| Call | Format or params | Units | n | Min | Median | p95 | Max (ms) | First call (ms) |
|------|------------------|-------|---|-----|--------|-----|----------|-----------------|
| `getProfile` | | 1 | 19 | 86 | 92 | 105 | 105 | 132 |
| `history.list` | `startHistoryId` (a few records) | 2 | 19 | 219 | 290 | 457 | 457 | 292 |
| `threads.list` | `q: in:inbox`, `maxResults: 100` | 10 | 19 | 145 | 158 | 802 | 802 | 339 |
| `threads.get` | metadata, `Subject`, 1 message | 40 | 19 | 88 | 154 | 180 | 180 | 174 |
| `threads.get` | full, 1 message | 40 | 19 | 104 | 159 | 683 | 683 | 597 |
| `threads.get` | full, 5 messages | 40 | 19 | 156 | 170 | 233 | 233 | 175 |
| `threads.modify` | add label | 10 | 19 | 149 | 170 | 196 | 196 | 181 |
| `threads.modify` | remove label | 10 | 19 | 148 | 165 | 219 | 219 | 146 |

The account holds about 41.7k messages; `threads.list` returned 100 threads. Calls take about 90–300 ms at the median, with occasional outliers up to about 0.8 s.

### Per-run call budget (an assumption)

**Assumption (unconfirmed):** Advanced Service calls count toward the documented 20,000/day consumer "Email read/write" quota. Budget = 20,000 ÷ runs per day, before manual runs.

Calls per run, from the SD §6 flows:

- **Fixed:** `history.list` (1 page when there's no backlog), `labels.list` for the label cache (1), and `getProfile` only when an alert needs the owner's address (0–1). About 3.
- **Per chunk:** 1 exclusion `threads.list`.
- **Per thread:** 1 `threads.get` (full), and at most 1 `threads.modify` (labels and a move together). A `trash` move is a separate `threads.trash`, so the worst case is 2 modifying calls.
- So calls ≈ 4 + 2 × threads (one chunk), and the largest chunk ≈ (budget − 4) ÷ 2.

Gmail time per run, from the medians (Jev's time **not** included; it runs concurrently through `fetchAll` and adds to this): fixed about 0.55 s (`history.list` 0.29, `labels.list` about 0.1, exclusion `threads.list` 0.16), plus about 0.33 s per thread (`threads.get` full 0.16–0.17 + `threads.modify` 0.17). Units per thread: about 50.

| Interval (min) | Runs/day | Gmail calls/run (assumption) | Largest chunk by daily calls | Time per run (90 min/day ÷ runs, capped at the 30 s soft limit) | Largest chunk by time (Gmail only) | Largest chunk by the per-user rate (100 units/s over the run's time) | Binds first |
|---|---|---|---|---|---|---|---|
| 1 | 1,440 | about 13 | **4** | 3.75 s | 9 | 7 | Daily calls (assumption) |
| 5 | 288 | about 69 | **32** | 18.75 s | 55 | 37 | Daily calls (assumption) |
| 10 | 144 | about 138 | 67 | 30 s | 89 | **about 60** | Per-user rate |
| 15 | 96 | about 208 | 102 | 30 s | 89 | **about 60** | Per-user rate |
| 30 | 48 | about 416 | 206 | 30 s | 89 | **about 60** | Per-user rate |

- The rate column assumes the limit is enforced as 100 units/s (the conservative reading of the error above). If it is really a total per fixed minute, a 30 s run could use up to about 6,000 units (about 118 threads), and time (89) would bind at 10, 15, and 30 minutes instead.
- At a **1-minute interval**, the daily-call assumption allows only about 4 threads per run, and the average trigger time only about 9 (before Jev's time). That's a very small chunk; flagged on #122.
- At 5 minutes, the average trigger time per run (18.75 s) is already below the 30 s soft limit, so the 90 min/day trigger budget, not the soft limit, sets the time.

## Conclusion

1. **Whether Advanced Gmail Service calls count toward the 20,000/day "Email read/write" quota is undocumented** (checked 2026-09-25), and it was deliberately not tested by exhausting it. No reliable community report settles it either way.
2. **A persisted daily Gmail-call tally works.** A tiny Script Property (`{day, count}`, about 31 bytes), read once and written once per execution in a `finally`, increased by exactly the calls made across 12 independent executions (`scripts.run` and a time-driven trigger), kept failed executions' calls, and reset when the day changed. It is exact only when executions don't overlap. The product's script lock already guarantees that.
3. **The binding Gmail limit in practice is the per-user rate limit, not the daily quota.** Back-to-back calls tripped "Units per minute per user" at about 2,900 units in 18 s. Per-call latency is about 90–300 ms (median), so the product can call Gmail faster than the rate limit allows. E7 should size chunks by quota units, not only by time, and treat that error as "stop Gmail work for this run".
4. `threads.get` costs 40 units in any format (the docs), so `format: 'metadata'` saves latency (a little) but no quota.

## Recommendation

The product keeps a persisted daily Gmail-call tally like the spike's. It doesn't add a daily cap: the daily limit is undocumented for the Advanced Service, and a guessed cap could stop the product for no reason.

- **SD §7.3:** add `state.gmailCalls` = `{v, day, count}`, reset when the day changes in the script's time zone, like `state.budget` (SD §10.2). It is read once at run start and written once at run end, in a `finally`, inside the script lock.
- **`run.end` summary (SD §10.5, owned by #143):** add `gmailCalls` (this run) and `gmailCallsToday`, so usage can be compared with the documented 20,000/day.
- The day boundary is the script's time zone, but Apps Script quotas reset 24 hours after the first request. So `gmailCallsToday` approximates the quota window, which is good enough for comparison.
- **E7 (#122, #118):** keep each run's Gmail usage under the per-user rate limit (budget quota units per run, or pace calls), and handle the "Units per minute per user" error as a stop-for-this-run condition.

## Raw output

<details><summary>Counter runs (one JSON object per execution)</summary>

```
# s30-baseline
{"counter": null, "counterBytes": 0, "timeZone": "Etc/UTC", "today": "2026-09-26"}
# s30-1a
{"after": {"count": 3, "day": "2026-09-26"}, "before": null, "counterBytes": 30, "day": "2026-09-26", "executionId": "b8913f27-9dc8-42e1-8a70-118665e35f3d", "lockWaitMs": null, "n": 3, "readAt": "2026-09-26T08:05:55.191Z", "resetForNewDay": false, "useLock": false, "writtenAt": "2026-09-26T08:05:55.567Z"}
# s30-1b
{"after": {"count": 8, "day": "2026-09-26"}, "before": {"count": 3, "day": "2026-09-26"}, "counterBytes": 30, "day": "2026-09-26", "executionId": "427c87e7-d73e-481a-b021-05c22d41b2b6", "lockWaitMs": null, "n": 5, "readAt": "2026-09-26T08:05:56.981Z", "resetForNewDay": false, "useLock": false, "writtenAt": "2026-09-26T08:05:57.302Z"}
# s30-1c
{"after": {"count": 15, "day": "2026-09-26"}, "before": {"count": 8, "day": "2026-09-26"}, "counterBytes": 31, "day": "2026-09-26", "executionId": "47cdcfff-fa5c-4389-b397-83b31540b971", "lockWaitMs": null, "n": 7, "readAt": "2026-09-26T08:05:58.620Z", "resetForNewDay": false, "useLock": false, "writtenAt": "2026-09-26T08:05:59.117Z"}
# s30-2-install
{"handler": "s30_triggerTick", "installedAt": "2026-09-26T08:06:06.066Z", "next": "wait at least 2 minutes, then run s30_readTriggerResult and s30_readCounter", "staleTriggersRemoved": 0, "triggerId": "4854448279498260480"}
# s30-2-result
{"pending": false, "result": {"after": {"count": 20, "day": "2026-09-26"}, "before": {"count": 15, "day": "2026-09-26"}, "counterBytes": 31, "day": "2026-09-26", "executionId": "1d2dc173-0ca0-49c8-af96-4614f297c3c5", "lockWaitMs": null, "n": 5, "readAt": "2026-09-26T08:07:35.427Z", "resetForNewDay": false, "triggerUid": "4854448279498260480", "triggersDeleted": 1, "useLock": false, "via": "trigger", "writtenAt": "2026-09-26T08:07:36.099Z"}, "s30TriggersInstalled": 0}
# s30-2-counter
{"counter": {"count": 20, "day": "2026-09-26"}, "counterBytes": 31, "timeZone": "Etc/UTC", "today": "2026-09-26"}
# s30-4-x
{"after": {"count": 40, "day": "2026-09-26"}, "before": {"count": 20, "day": "2026-09-26"}, "counterBytes": 31, "day": "2026-09-26", "executionId": "c2264085-1f75-4a52-a074-1bbfe0a51b05", "lockWaitMs": null, "n": 20, "readAt": "2026-09-26T08:09:57.719Z", "resetForNewDay": false, "useLock": false, "writtenAt": "2026-09-26T08:09:59.330Z"}
# s30-4-y
{"after": {"count": 40, "day": "2026-09-26"}, "before": {"count": 20, "day": "2026-09-26"}, "counterBytes": 31, "day": "2026-09-26", "executionId": "228177e9-3261-498c-b7f5-44059adedb5d", "lockWaitMs": null, "n": 20, "readAt": "2026-09-26T08:09:57.607Z", "resetForNewDay": false, "useLock": false, "writtenAt": "2026-09-26T08:09:59.412Z"}
# s30-4-counter
{"counter": {"count": 40, "day": "2026-09-26"}, "counterBytes": 31, "timeZone": "Etc/UTC", "today": "2026-09-26"}
# s30-4b-x
{"after": {"count": 80, "day": "2026-09-26"}, "before": {"count": 60, "day": "2026-09-26"}, "counterBytes": 31, "day": "2026-09-26", "executionId": "5f8267e2-f394-452f-9a0c-31c17de69e2c", "lockWaitMs": 1833, "n": 20, "readAt": "2026-09-26T08:10:12.337Z", "resetForNewDay": false, "useLock": true, "writtenAt": "2026-09-26T08:10:13.549Z"}
# s30-4b-y
{"after": {"count": 60, "day": "2026-09-26"}, "before": {"count": 40, "day": "2026-09-26"}, "counterBytes": 31, "day": "2026-09-26", "executionId": "1c943569-fff9-44ef-9f86-fd2640c0cd3c", "lockWaitMs": 71, "n": 20, "readAt": "2026-09-26T08:10:10.441Z", "resetForNewDay": false, "useLock": true, "writtenAt": "2026-09-26T08:10:12.107Z"}
# s30-4b-counter
{"counter": {"count": 80, "day": "2026-09-26"}, "counterBytes": 31, "timeZone": "Etc/UTC", "today": "2026-09-26"}
# s30-3
{"after": {"count": 1, "day": "2026-09-27"}, "before": {"count": 481, "day": "2026-09-26"}, "counterBytes": 30, "day": "2026-09-27", "executionId": "b1e0e081-2d51-4ecd-9d27-a16dd3fda1ad", "lockWaitMs": null, "n": 1, "readAt": "2026-09-26T09:05:17.929Z", "realDay": "2026-09-26", "resetForNewDay": true, "simulatedDay": "2026-09-27", "useLock": false, "writtenAt": "2026-09-26T09:05:18.068Z"}
# s30-3-counter
{"counter": {"count": 1, "day": "2026-09-27"}, "counterBytes": 30, "timeZone": "Etc/UTC", "today": "2026-09-26"}
# s30-cleanup
{"deletedLabel": "Spike/Quota", "deletedProperties": ["s30.gmailCalls", "s30.triggerResult", "s30.threads"], "deletedTriggers": 0}
```

</details>

<details><summary>s30_measureLatency (paced run)</summary>

```json
{
 "counterAfter": {
  "count": 481,
  "day": "2026-09-26"
 },
 "counterBefore": {
  "count": 319,
  "day": "2026-09-26"
 },
 "counterBytes": 32,
 "discarded": 1,
 "durationMs": 130917,
 "executionId": "d4e94cc2-c0d5-4edd-9d0f-9d4f8d716d74",
 "gmailCallsThisExecution": 162,
 "nPerKind": 20,
 "pacedUnitsPerSecond": 25,
 "results": [
  {
   "call": "getProfile",
   "firstCallMs": 132,
   "max": 105,
   "median": 92,
   "min": 86,
   "n": 19,
   "p95": 105,
   "params": "",
   "resultSize": "(historyId, omitted)",
   "units": 1
  },
  {
   "call": "history.list",
   "firstCallMs": 292,
   "max": 457,
   "median": 290,
   "min": 219,
   "n": 19,
   "p95": 457,
   "params": "startHistoryId = the small thread's historyId",
   "resultSize": 91,
   "units": 2
  },
  {
   "call": "threads.list",
   "firstCallMs": 339,
   "max": 802,
   "median": 158,
   "min": 145,
   "n": 19,
   "p95": 802,
   "params": "q: in:inbox, maxResults: 100",
   "resultSize": 100,
   "units": 10
  },
  {
   "call": "threads.get",
   "firstCallMs": 174,
   "max": 180,
   "median": 154,
   "min": 88,
   "n": 19,
   "p95": 180,
   "params": "format: metadata, metadataHeaders: [Subject], 1-message thread",
   "resultSize": 1,
   "units": 40
  },
  {
   "call": "threads.get",
   "firstCallMs": 597,
   "max": 683,
   "median": 159,
   "min": 104,
   "n": 19,
   "p95": 683,
   "params": "format: full, 1-message thread",
   "resultSize": 1,
   "units": 40
  },
  {
   "call": "threads.get",
   "firstCallMs": 175,
   "max": 233,
   "median": 170,
   "min": 156,
   "n": 19,
   "p95": 233,
   "params": "format: full, 5-message thread",
   "resultSize": 5,
   "units": 40
  },
  {
   "call": "threads.modify",
   "firstCallMs": 181,
   "max": 196,
   "median": 170,
   "min": 149,
   "n": 19,
   "p95": 196,
   "params": "addLabelIds: [Spike/Quota]",
   "units": 10
  },
  {
   "call": "threads.modify",
   "firstCallMs": 146,
   "max": 219,
   "median": 165,
   "min": 148,
   "n": 19,
   "p95": 219,
   "params": "removeLabelIds: [Spike/Quota]",
   "units": 10
  }
 ],
 "setup": {
  "created": false,
  "labelName": "Spike/Quota"
 }
}
```

</details>

## Design changes

- **SD §9, "Gmail API quota" bullet:** rewritten with the documented unit costs (`threads.get` 40 in any format), the per-user 6,000 units/minute limit and the rate-limit finding, the undocumented daily quota, and the `state.gmailCalls` tally.
- **SD §7.3:** added `state.gmailCalls`.
- **SD §14, quota row:** restated as undocumented and not tested by exhausting it; tracked in `state.gmailCalls` and `run.end`; handled by E7 and E9. Added a row for the per-user rate limit.
- **Issues:** the latency table and per-run budget are posted on #122. #118 (run controller keeps the tally, handles the rate error) and #143 (`run.end` fields) are commented on.
