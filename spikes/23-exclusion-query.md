# 23: Exclusion search: grouping, date bounds, Spam/Trash, indexing lag, and the manual form

- Task: #23 (story #22, epic #7)
- Date run: _pending (phase 2, after #163)_
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs`)
- Spike: [`23-exclusion-query.js`](23-exclusion-query.js)

## Question

Does the exclusion search in [SD §6.4](../output/solution-design.md#64-process-classify-a-chunk) step 2, `(<excludeQuery>) after:<oldest message in the chunk − 1 d> before:<newest + 1 d>` through `Gmail.Users.Threads.list`, return **every** thread in which **any** message matches `excludeQuery`? And is the manual-run form from [ADR-0005](../output/adr/0005-positive-thread-level-exclusion.md), `(<query>) (<excludeQuery>)`, safe, given that API search terms match per message ("The Gmail UI allows users to perform thread-wide searches, but the API doesn't")?

Sub-questions: grouping (parentheses, nested parentheses, `OR`, `{}`), what epoch `after:`/`before:` compare against (`internalDate` or the `Date` header) and whether they're inclusive and exact to the second, how `label:` must spell a name with `/` and spaces, whether matching messages in Spam or Trash are found (with and without `includeSpamTrash`), paging, and how soon a new message is searchable.

## Method

- **Test threads** are built with `Gmail.Users.Messages.insert` and raw RFC 2822 MIME, using `internalDateSource: 'dateHeader'` to set chosen dates without waiting. `insert` skips spam scanning, so nothing lands in Spam unless a case puts it there. Every message's resulting `internalDate` is read back and reported, never assumed.
- **Threading:** each reply carries the thread's `threadId`, `In-Reply-To`, `References`, and the same `Subject`. `s23_setup` checks with `Threads.get(…, {format: 'minimal'})` that every message landed in its thread.
- **No outside sender** (#7, option C). All senders are synthetic `From` headers on inserted mail, with the run token in the domain (`alerts@bank-<run>.example`), so an old run's mail never matches a new run's queries. The token is never an extra search term.
- **Indexing wait:** after setup, every message is polled with `rfc822msgid:<Message-ID>` (`includeSpamTrash: true`) until found. `A0` (the sender term with no window) is a second baseline.
- **Search:** `Gmail.Users.Threads.list('me', {q, maxResults: 500, pageToken})`, paged until `nextPageToken` is absent. The result is intersected with the test thread IDs. Every case reports `q`, params, pages, `resultSizeEstimate`, total threads, and which test threads came back (including test threads not named in the case's expectation).
- **Window** `W(t…)` is the SD §6.4 window: `after:<min internalDate/1000 − 86400> before:<max internalDate/1000 + 86400>` over every message of the given threads, with dates read fresh from `Threads.get(…, {format: 'metadata'})`.

### Test threads

`D` is two hours before setup. `S` is 12:00:00 UTC four days before `D`. All messages are `INBOX` unless noted.

| Thread | Messages (date, sender) | Purpose |
|--------|-------------------------|---------|
| T1 | D−10 `bank`, D−5 `carol`, D `carol` | Only the oldest message matches |
| T2 | D−1 `carol`, D `carol` | Never matches |
| T3 | D−2, D−1, D, all `carol`; only D−1 has label `Spike23-<run>/Private Stuff` | Label spelling |
| T4 | D−3 `lawyer` to `desk`, D−2 `carol`; subject contains "contract" | Nested group matches one message |
| T4b | D−3 `lawyer`, D−2 `carol` to `desk` | Nested group split across two messages |
| T5 | D−1 `carol`, D `SENT` from `<test-account>` to `lawyer` | Sent messages count |
| T6 | S−1 `c1-early`, S `c1-exact`, S+1 `c1-late` | Bound inclusivity and precision |
| T7 | one `c2` message, `internalDateSource: 'receivedTime'`, `Date` header D−10 | Which date the bounds use |
| T8 | D−2 `carol`, D−1 `trash` (then `Messages.trash`), D `carol` | Matching message in Trash |
| T8s | D−2 `carol`, D−1 `spam` (then `SPAM` added, `INBOX` removed), D `carol` | Matching message in Spam |
| T9 | D−1 `alice`, D `bank` | Manual form, split across messages |

Sender shorthand: `bank` is `alerts@bank-<run>.example`, and so on (see `s23_senders_`).

### Cases

`EX` is the case's `excludeQuery`. "Expect" is the prediction; a different result is a finding.

| ID | Query | Expect |
|----|-------|--------|
| A0 | `from:bank` (no window) | T1, T9 (baseline: indexed) |
| A1 | `(from:bank) W(T1)` | T1 |
| A2 | `(from:bank) after:<newest(T1) − 1 d> before:<newest(T1) + 1 d>` | T1 **not** returned: the window must span the oldest message |
| A3 | `(from:bank) W(T1,T2)` | T1, not T2 |
| B1.1–6 | `(label:<spelling>) W(T3)` for `spike23-<run>-private-stuff`, `"Spike23-<run>/Private Stuff"`, `Spike23-<run>/Private-Stuff`, `spike23-<run>/private-stuff`, `Spike23-<run>-Private-Stuff`, and the label ID | Record which work. The first working name form is used below as `<L>`. |
| B2 | `(from:bank OR <L>) W(T1,T3)` | T1, T3 |
| B3 | `({from:bank <L>}) W(T1,T3)` | T1, T3 |
| B4 | `(from:bank OR (from:lawyer subject:contract)) W(T1,T3,T4,T4b)` | T1, T4; not T3, T4b |
| B4b | `(from:bank OR (from:lawyer to:desk)) W(T1,T4,T4b)` | T1, T4; not T4b (terms match per message) |
| B5a | `from:bank OR <L> W(T1,T3)` (no parentheses) | Record |
| B5b | `(from:bank OR <L>) W(T3)` | T3, not T1 (T1 matches only outside this window) |
| B5c | `from:bank OR <L> W(T3)` (no parentheses) | Record: T1 returned means the window bound only the last `OR` operand |
| B6 | `(to:lawyer) W(T5)` | T5 (sent messages count) |
| C1 | `(from:<sender of the S−1, S, or S+1 message>) after:S`, and the same with `before:S` (6 queries) | Record inclusivity |
| C2 | `(from:c2)` with a ±1 h window around T7's `internalDate`, then around its `Date` header | Record which date the bounds use |
| C3 | `(from:c1-exact)` with windows `[S−3h, S+3h]`, `[S+60 s, S+3h]`, `[S−3h, S−60 s]` | Returned, not, not (if bounds are exact to the second) |
| D1 | `(from:trash) W(T8)`, default and with `includeSpamTrash: true`; plus `Threads.get(T8, {format: 'full'})` | Record both searches and whether `threads.get` returns the trashed message |
| D2 | As D1 with T8s and `from:spam` | As D1 |
| E1 | `(from:alice) (from:bank)` (ADR-0005 manual form), then `(from:bank) W(T9)` | T9 **not** returned (the manual form leaks), then T9 returned |
| E2 | `(from:alice) -(from:bank)` | T9 returned (subtracting the exclusion in the job search is unsafe too) |
| F1 | One new message each via `insert` (`receivedTime`) and `import` (`receivedTime`, `neverMarkSpam`); poll `(from:<sender>) W(thread)` at 0, 1, 2, 5, 10, 20, 30, 60, 120 s | Record time to first hit (proxy only) |
| F2 | 3 self-sends to `<test-account>+s23`, at least 5 minutes apart; `EX` is `subject:<token>n<k>` | Record lag from send and `internalDate` to history and to search |
| G1 | `(EX) W(T1,T3,T5)` vs `(EX) ((W(T1)) OR (W(T3)) OR (W(T5)))`, `EX` = `from:bank OR <L> OR to:lawyer` | Same threads (T1, T3, T5) |

### Deviations from the task text, and why

- **`Threads.get` argument order.** The task writes `Threads.get(id, 'me', …)`. The Advanced Gmail Service takes path parameters in REST order, so it is `Threads.get('me', id, …)`, and a request body comes first (`Messages.modify(body, 'me', id)`, `Messages.insert(resource, 'me', blob, args)`).
- **T4b uses `to:` instead of `subject:`.** Threading requires a matching `Subject`, so `subject:contract` can't be in one message of a thread and not another. The split case (B4b) groups `from:lawyer to:desk` instead; B4 keeps the task's `subject:contract` query, with T4 as the positive case.
- **Added cases:** A0 (baseline), B1.6 (label ID), B4b, B5b and B5c (a window that actually tells the two `OR` precedences apart; B5a alone can't, because both parses return T1 and T3).
- **F2 polls in two places.** `s23_f2Send` polls history and search every 2 s for up to 120 s in its own execution (tight timing from the moment of sending), and the 1-minute trigger `s23_f2Poll` keeps polling any send still pending. Both merge "first seen" times under the script lock and keep the earliest. Each record also has a lower bound (the previous poll's time).
- **F2 trigger runtime is bounded.** Each trigger run polls for at most 25 s, and only while a send is pending; a send is given up after 30 minutes, and the trigger removes itself after 3 complete sends or 2 hours. Consumer accounts get 90 minutes of trigger runtime a day, shared by every spike in the project (#21's retention trigger too), so 50 s per minute for 2 hours would have exhausted it.
- **F2 also records `labelAdded` with `INBOX`, and `in:inbox` search.** A self-send may be stored as one message with `SENT` and `INBOX` (so the "delivery" is a label, not a new message), or as a separate copy. Both are recorded, and a copy in another thread is found by its Subject.
- **`import`'s default `internalDateSource`** is `dateHeader` per Google's reference; F1 sets `receivedTime` explicitly for both methods.
- **Upload form.** `s23_upload_` sends the MIME as a `message/rfc822` blob (`Messages.insert(resource, 'me', blob, args)`). If that throws, it retries with `raw` in the resource, and reports which form worked.

## Runbook

All through #163 from this branch. Paste each returned JSON under **Raw output**.

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s23_setup`. Check every thread has `threadingOk: true`, `index.allIndexed: true`, and `internalMinusHeaderSec: 0` for every `dateHeader` message.
3. `node spikes/run.mjs run s23_runCases`. If it nears the 6-minute limit, split it: `s23_runCases '{"groups":["A","B"]}'`, then `'{"groups":["C","D","E","G"]}'` (G reuses the label spelling B1 picked). If A0 or every B1 spelling misses, the index may still be catching up: wait a minute and rerun that group.
4. `node spikes/run.mjs run s23_lagProxy` (about 2 minutes).
5. `node spikes/run.mjs run s23_f2Arm`.
6. `node spikes/run.mjs run s23_f2Send` three times, at least 5 minutes apart (it refuses sooner). Each call polls for up to 2 minutes and returns that send's timings.
7. `node spikes/run.mjs run s23_f2Results` until all 3 sends have history and search times, then `node spikes/run.mjs run s23_f2Disarm`.
8. Optional: `node spikes/run.mjs run s23_cleanup` moves every test thread to Trash and removes the trigger (`'{"clearProperties":true}'` also clears `s23.*`). Nothing is permanently deleted; the scope doesn't allow it. The test labels are left in place.

## Maintainer steps

None. F2 uses agent-run self-sends (#7, option C), and the one-time setup in #163 covers authorization.

## Results

_Pending (phase 2)._

| Case | Query sent (exact) | Params | Expected | Test threads returned | Pages / estimate | Verdict (pass / leak / finding) |
|------|--------------------|--------|----------|-----------------------|------------------|---------------------------------|
| | | | | | | |

### C1: bound inclusivity

| Bound | Message at | Returned |
|-------|-----------|----------|
| `after:S` | S−1 | |
| `after:S` | S | |
| `after:S` | S+1 | |
| `before:S` | S−1 | |
| `before:S` | S | |
| `before:S` | S+1 | |

### F1: indexing lag proxy

| Method | `internalDate` source | Labels after upload | First hit (s) |
|--------|-----------------------|---------------------|---------------|
| `insert` | `receivedTime` | | |
| `import` (`neverMarkSpam`) | `receivedTime` | | |

### F2: self-send lag

| Attempt | History reports it (s after send) | Search finds it (s after send) | Search − history (s) | Search − `internalDate` (s) | `in:inbox` search (s) | Notes |
|---------|-----------------------------------|--------------------------------|----------------------|-----------------------------|-----------------------|-------|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

## Raw output

_Pending._

## Conclusion

_Pending._

## Design changes

_Pending: SD §6.4 step 2, SD §14 exclusion row, SD §6.6 and a Proposed ADR superseding ADR-0005 if E1 shows the manual form leaks, and the affected E3 (#68, #69, #71) and E8 (#130, #132, #133, #134, #135) issues._
