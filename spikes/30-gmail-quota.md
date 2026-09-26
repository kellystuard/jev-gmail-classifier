# 30: Gmail quota accounting for the Advanced Gmail Service

- Task: #30 (story #28)
- Date run: (docs checked 2026-09-25; spike not run yet: waits for #163)
- Account: `<test-account>` (consumer)
- Run by: agent via #163

## Question

Do Advanced Gmail Service calls count toward Apps Script's "Email read/write (excluding send)" daily quota (SD §9, §14)? Apps Script can't report the remaining quota, and the maintainer ruled out testing by hitting the limit (epic #7). So this task:

1. records what the docs say, with sources and dates;
2. proves a **persisted daily Gmail-call counter** that the product can keep, across independent executions (`scripts.run` and a trigger) and across a day change;
3. samples per-call latency for E7's chunk sizing (#118, #122).

The quota is never exhausted. Total use is about 280 calls (about 100 counter calls, including the locked variant of the concurrent scenario, and about 170 latency and setup calls), far below any limit.

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
| `s30_measureLatency` | `[n]` (default `20`) | Latency stats per call kind (Part 3) |
| `s30_cleanup` | `[removeLabel]` (default `false`) | Deletes `s30.*` properties and `s30_triggerTick` triggers, and optionally the `Spike/Quota` label |

## Part 3: latency sample

`s30_measureLatency()` times `n` calls (default 20) of each kind with `Date.now()`, discards the first (warm-up), and returns min, median, p95 (nearest rank), and max in ms, plus the first call's time. On first use it inserts its own synthetic threads (one 1-message thread and one 5-message thread, threaded with `threadId`, `In-Reply-To`, `References`, and a matching Subject; saved in `s30.threads`) and creates the `Spike/Quota` label (or `Spike-Quota` if the nested name is refused). All of these calls go through the counter too.

Kinds: `getProfile`; `history.list` (from the small thread's `historyId`); `threads.list` (`q: 'in:inbox'`, `maxResults: 100`); `threads.get` metadata (`metadataHeaders: ['Subject']`) on the small thread; `threads.get` full on the small and the 5-message thread; `threads.modify` add and remove of `Spike/Quota`. That's 160 timed calls, about 3,100 quota units, which is about half the 6,000/minute per-user limit if they all fall in one minute.

## Runbook

The day-change scenario runs **last**, because it leaves the stored `day` set to tomorrow, and the next real run then resets the count (the reset rule is "the day differs", not "the day is later").

1. `node spikes/run.mjs push`.
2. `node spikes/run.mjs run s30_readCounter` (baseline; `counter` is `null` on a fresh project).
3. **Scenario 1:** three separate executions: `run s30_tick '[3]'`, `run s30_tick '[5]'`, `run s30_tick '[7]'`. Each `after.count` should be the previous `after.count` plus `n`.
4. **Scenario 2:** `run s30_installTickTrigger`, wait at least 2 minutes, then `run s30_readTriggerResult` and `run s30_readCounter`. The trigger's `after.count` should be scenario 1's last count plus 5, and `s30TriggersInstalled` should be 0.
5. **Scenario 4:** start two `node spikes/run.mjs run s30_tick '[20]'` processes at the same time (for example `cmd & cmd & wait`). Then `run s30_readCounter`. Without a lock, both read the same `before`, so one update is lost: the count rises by 20, not 40. **Scenario 4b:** repeat with `'[20, true]'` (script lock held for the whole execution): the count should rise by 40, and one run's `lockWaitMs` shows the wait. (The script lock is shared by every spike in the project. It's held for a few seconds only.)
6. **Latency:** `run s30_measureLatency`. Then `run s30_readCounter`: the count should rise by the returned `gmailCallsThisExecution`.
7. **Scenario 3 (last):** `run s30_simulateDayChange`. `resetForNewDay` should be `true` and `after.count` 1.
8. `run s30_cleanup '[true]'`.
9. Fill in the tables below, the budget analysis, and the conclusion. Update SD §9, §7.3, and §14. Post the latency table and the budget on #122, and comment on #118 and #143 (or list them in the PR).

## Maintainer steps

None.

## Results

(Filled in from the returned JSON after the run.)

### Counter

| Scenario | Execution | `executionId` | `n` | Count before | Count after | `day` | As expected? |
|----------|-----------|---------------|-----|--------------|-------------|-------|--------------|
| 1a | `scripts.run` | | 3 | | | | |
| 1b | `scripts.run` | | 5 | | | | |
| 1c | `scripts.run` | | 7 | | | | |
| 2 | trigger | | 5 | | | | |
| 4 | `scripts.run` ×2, concurrent, no lock | | 20 + 20 | | | | |
| 4b | `scripts.run` ×2, concurrent, script lock | | 20 + 20 | | | | |
| 3 | `scripts.run`, injected day | | 1 | | | | |

Counter property size: (bytes).

### Latency

| Call | Format or params | n | Min | Median | p95 | Max (ms) |
|------|------------------|---|-----|--------|-----|----------|
| `getProfile` | | 19 | | | | |
| `history.list` | `startHistoryId` | 19 | | | | |
| `threads.list` | `q: in:inbox`, `maxResults: 100` | 19 | | | | |
| `threads.get` | metadata, `Subject`, 1 message | 19 | | | | |
| `threads.get` | full, 1 message | 19 | | | | |
| `threads.get` | full, 5 messages | 19 | | | | |
| `threads.modify` | add label | 19 | | | | |
| `threads.modify` | remove label | 19 | | | | |

### Per-run call budget (an assumption)

**Assumption (unconfirmed):** Advanced Service calls count toward the documented 20,000/day consumer "Email read/write" quota. Budget = 20,000 ÷ runs per day, before manual runs.

| Interval (min) | Runs/day | Gmail calls/run | Largest chunk (threads/run) under the assumption | Trigger runtime/run (90 min ÷ runs) |
|---|---|---|---|---|
| 1 | 1,440 | about 13 | 4 | 3.75 s |
| 5 | 288 | about 69 | 32 | 18.75 s |
| 10 | 144 | about 138 | 67 | 37.5 s |
| 15 | 96 | about 208 | 102 | 56.25 s |
| 30 | 48 | about 416 | 206 | 112.5 s |

Calls per run, from the SD §6 flows:

- **Fixed:** `history.list` (1 page when there's no backlog), `labels.list` for the label cache (1), and `getProfile` only when an alert needs the owner's address (0–1). About 3.
- **Per chunk:** 1 exclusion `threads.list`.
- **Per thread:** 1 `threads.get` (full), and at most 1 `threads.modify` (labels and a move together). A `trash` move is a separate `threads.trash`, so the worst case is 2 modifying calls.
- So calls ≈ 4 + 2 × threads (one chunk), and the largest chunk ≈ (budget − 4) ÷ 2.

Other limits on the same chunk:

- **Per-minute units.** A thread costs about 50 units (`threads.get` 40 + `threads.modify` 10), so the 6,000/minute per-user limit allows about 118 threads in any one minute. That binds before the daily assumption at the 15- and 30-minute intervals if a run gets through more than about 118 threads in a minute.
- **Time.** The scheduled soft limit is 30 s (SD §10.3), and the consumer trigger budget is 90 min/day. At a 1-minute interval each run gets 3.75 s on average. (Filled in after the run: seconds per thread from the latency table, excluding Jev's time, and which limit binds first at each interval: time, daily calls, or per-minute units.)

## Recommendation

The product keeps a persisted daily Gmail-call tally like the spike's. It doesn't add a cap: the limit is undocumented for the Advanced Service, and a guessed cap could stop the product for no reason.

- **SD §7.3:** add `state.gmailCalls` = `{v, day, count}`, reset when the day changes in the script's time zone, like `state.budget` (SD §10.2). It is read once at run start and written once at run end, under the script lock.
- **`run.end` summary (SD §10.5, owned by #143):** add `gmailCalls` (this run) and `gmailCallsToday`, so usage can be compared with the documented 20,000/day.
- The day boundary is the script's time zone, but Apps Script quotas reset 24 hours after the first request. So `gmailCallsToday` is an approximation of the quota window, which is good enough for comparison.

## Raw output

<details><summary>Counter runs</summary>

</details>

<details><summary>s30_measureLatency</summary>

</details>

## Conclusion

(After the run.)

## Design changes

(After the run: SD §9 quota bullet, SD §7.3 table, SD §14 quota row; comments on #122, #118, #143.)
