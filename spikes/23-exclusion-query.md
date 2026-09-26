# 23: Exclusion search: grouping, date bounds, Spam/Trash, indexing lag, and the manual form

- Task: #23 (story #22, epic #7)
- Date run: 2026-09-26 (setup run token `r1790409928`)
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
- **Added in phase 2** (after the first run showed T7 couldn't answer C2):
  - `s23_probe` (C2b): one message per upload variant (`insert` or `import`, blob or `raw`, with or without `internalDateSource: 'receivedTime'`), each with a `Date` header 10 days old, and the C2 windows run on any variant whose `internalDate` differs from the header. It also runs **H1** (paging): the same search with `maxResults` 2 and 500.
  - `s23_c2Send` (C2c): a self-send with a `Date` header 10 days old, for the same purpose.
  - `s23_f1Recheck`: F1's first run reported that the imported message was never found. The cause: `import` returns only `{id}`, with no `threadId`, so the spike matched `undefined`. F1 now looks the thread up with `messages.get`, and was re-run.
- **Upload form.** `s23_upload_` sends the MIME as a `message/rfc822` blob (`Messages.insert(resource, 'me', blob, args)`). If that throws, it retries with `raw` in the resource, and reports which form worked.

## Runbook

All through #163 from this branch. Paste each returned JSON under **Raw output**.

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s23_setup`. Check every thread has `threadingOk: true`, `index.allIndexed: true`, and `internalMinusHeaderSec: 0` for every `dateHeader` message.
3. `node spikes/run.mjs run s23_runCases`. If it nears the 6-minute limit, split it: `s23_runCases '{"groups":["A","B"]}'`, then `'{"groups":["C","D","E","G"]}'` (G reuses the label spelling B1 picked). If A0 or every B1 spelling misses, the index may still be catching up: wait a minute and rerun that group.
4. `node spikes/run.mjs run s23_probe` (C2b and H1) and `node spikes/run.mjs run s23_c2Send` (C2c).
5. `node spikes/run.mjs run s23_lagProxy` (about 2 minutes). `s23_f1Recheck` re-checks its threads later.
6. `node spikes/run.mjs run s23_f2Arm`.
7. `node spikes/run.mjs run s23_f2Send` three times, at least 5 minutes apart (it refuses sooner). Each call polls for up to 2 minutes and returns that send's timings.
8. `node spikes/run.mjs run s23_f2Results` until all 3 sends have history and search times, then `node spikes/run.mjs run s23_f2Disarm`.
9. Done 2026-09-26: `s23_cleanup` moved 19 test threads to Trash. Four imported messages (F1's `import` on both runs, and the two C2b `import` variants) are still in the Inbox. `import` returns only `{id}`, so their threads weren't recorded; they are synthetic and harmless. Optional: `node spikes/run.mjs run s23_cleanup` moves every test thread to Trash and removes the trigger (`'{"clearProperties":true}'` also clears `s23.*`). Nothing is permanently deleted; the scope doesn't allow it. The test labels are left in place.

## Maintainer steps

None. F2 uses agent-run self-sends (#7, option C), and the one-time setup in #163 covers authorization.


## Results

The run was on 2026-09-26, 08:05–09:30 UTC.

**Setup** (`r1790409928`):
- All 11 threads had `threadingOk: true`.
- Every message was found by `rfc822msgid:` on the first pass (2.1 s).
- Every message's API `internalDate` equaled its `Date` header (`internalMinusHeaderSec: 0`), including T7's (see C2).
- T3's middle message had the child label. T5's second message had only `SENT`, T8's had only `TRASH`, and T8s's had only `SPAM`.

"Test threads returned" lists every test thread the search returned. T9's second message is from `bank`, so T9 appears beside T1 whenever the window covers day D. That's correct, and doesn't count against a case. All queries used `maxResults: 500`, and each fit in one page (see H1 for paging).

| Case | Query sent (exact) | Params | Expected | Test threads returned | Pages / estimate | Verdict (pass / leak / finding) |
|------|--------------------|--------|----------|-----------------------|------------------|---------------------------------|
| A0 | `from:bank-<run>.example` | default | returned: T1, T9 | T1, T9 | 1 / 2 | pass |
| A1 | `(from:bank-<run>.example) after:1789452328 before:1790489128` | default | returned: T1 | T1, T9 | 1 / 2 | pass |
| A2 | `(from:bank-<run>.example) after:1790316328 before:1790489128` | default | not: T1 | T9 | 1 / 1 | pass: the window must span the oldest message |
| A3 | `(from:bank-<run>.example) after:1789452328 before:1790489128` | default | returned: T1; not: T2 | T1, T9 | 1 / 2 | pass |
| B1.1 | `(label:spike23-<run>-private-stuff) after:1790143528 before:1790489128` | default | returned: T3 | T3 | 1 / 1 | pass |
| B1.2 | `(label:"Spike23-<run>/Private Stuff") after:1790143528 before:1790489128` | default | returned: T3 | T3 | 1 / 1 | pass |
| B1.3 | `(label:Spike23-<run>/Private-Stuff) after:1790143528 before:1790489128` | default | returned: T3 | T3 | 1 / 1 | pass |
| B1.4 | `(label:spike23-<run>/private-stuff) after:1790143528 before:1790489128` | default | returned: T3 | T3 | 1 / 1 | pass |
| B1.5 | `(label:Spike23-<run>-Private-Stuff) after:1790143528 before:1790489128` | default | returned: T3 | T3 | 1 / 1 | pass |
| B1.6 | `(label:Label_7) after:1790143528 before:1790489128` | default | returned: T3 | none | 1 / 0 | **finding**: label IDs don't work in `q` |
| B2 | `(from:bank-<run>.example OR label:spike23-<run>-private-stuff) after:1789452328 before:1790489128` | default | returned: T1, T3 | T1, T3, T9 | 1 / 3 | pass |
| B3 | `({from:bank-<run>.example label:spike23-<run>-private-stuff}) after:1789452328 before:1790489128` | default | returned: T1, T3 | T1, T3, T9 | 1 / 3 | pass |
| B4 | `(from:bank-<run>.example OR (from:lawyer-<run>.example subject:contract)) after:1789452328 before:1790489128` | default | returned: T1, T4; not: T3, T4b | T1, T4, T9 | 1 / 3 | pass |
| B4b | `(from:bank-<run>.example OR (from:lawyer-<run>.example to:desk-<run>.example)) after:1789452328 before:1790489128` | default | returned: T1, T4; not: T4b | T1, T4, T9 | 1 / 3 | pass: terms match per message |
| B5a | `from:bank-<run>.example OR label:spike23-<run>-private-stuff after:1789452328 before:1790489128` | default | returned: T1, T3 | T1, T3, T9 | 1 / 3 | pass |
| B5b | `(from:bank-<run>.example OR label:spike23-<run>-private-stuff) after:1790143528 before:1790489128` | default | returned: T3; not: T1 | T3, T9 | 1 / 2 | pass |
| B5c | `from:bank-<run>.example OR label:spike23-<run>-private-stuff after:1790143528 before:1790489128` | default | returned: T3; not: T1 | T3, T9 | 1 / 2 | **finding**: without parentheses the window still bound the whole `OR` (`OR` binds tighter) |
| B6 | `(to:lawyer-<run>.example) after:1790229928 before:1790489128` | default | returned: T5 | T5 | 1 / 1 | pass |
| C1.after.S-1 | `(from:c1-early-<run>.example) after:1790078400` | default | record | none | 1 / 0 | see C1 |
| C1.before.S-1 | `(from:c1-early-<run>.example) before:1790078400` | default | record | T6 | 1 / 1 | see C1 |
| C1.after.S | `(from:c1-exact-<run>.example) after:1790078400` | default | record | T6 | 1 / 1 | see C1 |
| C1.before.S | `(from:c1-exact-<run>.example) before:1790078400` | default | record | T6 | 1 / 1 | see C1 |
| C1.after.S+1 | `(from:c1-late-<run>.example) after:1790078400` | default | record | T6 | 1 / 1 | see C1 |
| C1.before.S+1 | `(from:c1-late-<run>.example) before:1790078400` | default | record | none | 1 / 0 | see C1 |
| C2.internal | `(from:c2-<run>.example) after:1789535128 before:1789542328` | default | record | none | 1 / 0 | **finding** (see C2) |
| C2.header | `(from:c2-<run>.example) after:1789535128 before:1789542328` | default | record | none | 1 / 0 | **finding** (see C2) |
| C3.around | `(from:c1-exact-<run>.example) after:1790067600 before:1790089200` | default | returned: T6 | T6 | 1 / 1 | pass |
| C3.later | `(from:c1-exact-<run>.example) after:1790078460 before:1790089200` | default | not: T6 | none | 1 / 0 | pass: exact to the second |
| C3.earlier | `(from:c1-exact-<run>.example) after:1790067600 before:1790078340` | default | not: T6 | none | 1 / 0 | pass: exact to the second |
| D1.default | `(from:trash-<run>.example) after:1790143528 before:1790489128` | default | record | none | 1 / 0 | **finding**: a matching message in Trash is not found |
| D1.includeSpamTrash | `(from:trash-<run>.example) after:1790143528 before:1790489128` | `includeSpamTrash: true` | record | T8 | 1 / 1 | **finding**: found |
| D2.default | `(from:spam-<run>.example) after:1790143528 before:1790489128` | default | record | none | 1 / 0 | **finding**: a matching message in Spam is not found |
| D2.includeSpamTrash | `(from:spam-<run>.example) after:1790143528 before:1790489128` | `includeSpamTrash: true` | record | T8s | 1 / 1 | **finding**: found |
| E1.manual | `(from:alice-<run>.example) (from:bank-<run>.example)` | default | not: T9 | none | 1 / 0 | **leak**: the ADR-0005 manual form misses T9 |
| E1.window | `(from:bank-<run>.example) after:1790229928 before:1790489128` | default | returned: T9 | T9 | 1 / 1 | pass |
| E2 | `(from:alice-<run>.example) -(from:bank-<run>.example)` | default | returned: T9 | T9 | 1 / 1 | **leak**: subtracting the exclusion still returns T9 |
| G1.wide | `(from:bank-<run>.example OR label:spike23-<run>-private-stuff OR to:lawyer-<run>.example) after:1789452328 before:1790489128` | default | returned: T1, T3, T5 | T1, T3, T5, T9 | 1 / 4 | pass |
| G1.perThread | `(from:bank-<run>.example OR label:spike23-<run>-private-stuff OR to:lawyer-<run>.example) ((after:1789452328 before:1790489128) OR (after:1790143528 before:1790489128) OR (after:1790229928 before:1790489128))` | default | returned: T1, T3, T5 | T1, T3, T5, T9 | 1 / 4 | pass: same as G1.wide |

`S` = 1790078400 (2026-09-22T12:00:00Z). A1 and A3 sent the same query, because T2's dates fall inside T1's window.

### C1: bound inclusivity

| Bound | Message at | Returned |
|-------|-----------|----------|
| `after:S` | S−1 | no |
| `after:S` | S | **yes** |
| `after:S` | S+1 | yes |
| `before:S` | S−1 | yes |
| `before:S` | S | **yes** |
| `before:S` | S+1 | no |

Both bounds are **inclusive** at the second. C3 shows they are exact to the second, not rounded to a day.

### C2: which date the bounds compare against

**Finding: search can use a different date from the `internalDate` that the API reports.** Search compares the bounds against the date Gmail indexed the message with. For messages uploaded with `internalDateSource: 'receivedTime'`, that's the **upload time**, while `internalDate` (and `Date`) say 10 days earlier.

| Message | API `internalDate` | ±1 h around `internalDate` / header | ±1 h around upload time |
|---------|--------------------|---------------------------------------|---------------------------|
| T7: `insert` blob, `receivedTime`, `Date` 10 days old | = `Date` header | not found | **found** |
| C2b `insert` blob, `receivedTime` | = `Date` header | not found | **found** |
| C2b `insert` blob, no `internalDateSource` (default `receivedTime`) | = `Date` header | not found | **found** |
| C2b `insert` with `raw`, `receivedTime` | = `Date` header | not found | **found** |
| C2b `import`, `receivedTime`, `neverMarkSpam` | = `Date` header | not found | **found** |
| C2b `import`, `neverMarkSpam` only (default `dateHeader`) | = `Date` header | **found** | not found |
| Every `dateHeader` insert (T1–T6, T8, T9) | = `Date` header | found (A–G, C1, C3) | n/a |
| C2c self-send with a `Date` header 10 days old | = send time | n/a | n/a: Gmail **rewrote** the `Date` header to the send time |

These come from `s23_probe`, `s23_c2Send`, and the follow-up `s23_search` queries in the raw output. Q3 in the first follow-up is T7's ±1 h window around its reported `internalDate`, and Q1 in the second is the one around its upload time.

- `internalDateSource` **is** honored, but only by search. The API's `internalDate` reported the `Date` header in every case except the self-send.
- So the SD §6.4 window, built from `internalDate` alone, missed T7 (C2.internal). Building it from the `Date` header wouldn't help either, since the two were equal.
- Delivered mail may not behave like this: Google documents `internalDate` for SMTP mail as the time Google accepted it. But E1 can't build an outside delivery (#7, option C), and the privacy guarantee shouldn't rest on it.
- **What always holds:** a message can't be indexed later than now. With the lower bound from `internalDate` and the `Date` header, every date seen here fell inside the window, since the upload time was never earlier than the header.
- **Checked:** `after:<min(internalDate, Date) − 1 d> before:<now + 1 d>` found T7 and all five C2b messages (the third `s23_search` call in the raw output).
- **Design response (SD §6.4):**
  - `lo` = the earliest `internalDate` or parsed `Date` header across the chunk's messages, minus 1 day.
  - `hi` = the latest of **now** and every message's `internalDate` or `Date` header, plus 1 day. Including the message dates is a precaution: a sender can put a future date in the `Date` header, and E1 couldn't test whether delivered mail is indexed by it.

### D: Spam and Trash

| Case | Default search | `includeSpamTrash: true` | `Threads.get(…, {format: 'full'})` |
|------|----------------|--------------------------|-----------------------------------|
| D1 (matching message in Trash) | T8 **not** returned | T8 returned | returns all 3 messages, including the trashed one (`TRASH`, with payload) |
| D2 (matching message in Spam) | T8s **not** returned | T8s returned | returns all 3 messages, including the spam one (`SPAM`, with payload) |

Without `includeSpamTrash: true`, a thread whose only matching message is in Trash or Spam passes the exclusion filter, and `threads.get` then hands that message to the state builder.

**Out of scope, reported for E4:** `threads.get` returns Spam and Trash messages, so the state builder (SD §8.3) would send them to Jev for a thread that isn't excluded.

### H1: paging

`(from:carol-<run>.example) W(all setup threads)` returned the same 8 test threads both ways:
- `maxResults: 2`: 4 pages, `resultSizeEstimate` 8.
- `maxResults: 500`: 1 page.

Paging with `pageToken` works and loses nothing.

### F1: indexing lag proxy

| Method | `internalDateSource` | Labels after upload | First hit (s) | Notes |
|--------|----------------------|---------------------|---------------|-------|
| `insert` | `receivedTime` | `INBOX` | 0.5 (first poll) | |
| `import` (`neverMarkSpam`) | `receivedTime` | `INBOX` | 0.7 (first poll) | `import` returned only `{id}`, with no `threadId` (as #25 and #26 also found). The spike looks the thread up with `messages.get`. |

- The first F1 run (`r1790410089`) matched on the missing `threadId` (`undefined`), so it reported that the imported message was never found.
- `s23_f1Recheck` showed the message was searchable in its real thread. (Its `sameThread: false` and `threadMessages: 0` come from the same `undefined`.)
- The re-run (`r1790413386`) above looks the thread up with `messages.get`, where the output field `threadIdChangedAfterUpload: true` just means the upload response lacked a `threadId`.
- Both methods were searchable at the first poll, well under a second after the upload returned.

### F2: self-send lag

Each send is one `Messages.send` to `<test-account>+s23`. Gmail stored each as **one** message labelled `UNREAD`, `SENT`, `INBOX`: no separate delivered copy, and no later `labelAdded` for `INBOX`. How the times were measured:
- "History" is the first `history.list` (`messageAdded`) poll that listed the message.
- "Search" is the first poll of `(subject:<token>n<k>) after:… before:…` that returned it.
- Polls ran about every 0.5–2 s from the moment of sending, so each time is an upper bound; the previous poll is the lower bound.

| Attempt | Sent (UTC) | History reports it (s after send) | Search finds it (s after send) | Search − history (s) | Search − `internalDate` (s) | `in:inbox` search (s) | Labels |
|---------|------------|-----------------------------------|--------------------------------|----------------------|-----------------------------|-----------------------|--------|
| 1 | 09:07:33 | 0.5 | 0.5 | 0 | 1.1 | 0.5 | `UNREAD`, `SENT`, `INBOX` |
| 2 | 09:13:21 | 0.6 | 0.6 | 0 | 0.8 | 0.6 | `UNREAD`, `SENT`, `INBOX` |
| 3 | 09:18:33 | 0.5 | 0.5 | 0 | 1.2 | 0.5 | `UNREAD`, `SENT`, `INBOX` |

For every send, history and search found the message at the **first** poll after sending (lower bound 0 s), so any lag is under about 0.6 s. That matches F1.

The 1-minute poller trigger then saw all 3 sends complete and removed itself (`done: complete`), deleting the copy from `getProjectTriggers()`. `s23_f2Disarm` found nothing left to remove.

A self-send is the closest stand-in for delivery that option C allows. Mail from outside may be indexed differently, but nothing observed here suggests a lag worth designing around.

### Quota error seen during the run

At about 08:10–08:13 UTC, three calls in a row, spread over about three minutes, failed. The Advanced Service threw this error inside `Threads.get`:

```
GoogleJsonResponseException: API call to gmail.users.threads.get failed with error: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:<spike Cloud project>'.
```

- This spike's own load at the time was small: a few dozen calls in the previous minutes.
- Other E1 spikes were running on the same account at the same time. The per-user, per-minute Gmail quota counts every caller of that account.
- The error had cleared by the next attempt, at 09:02 UTC.
- It was the Gmail API's per-user rate limit, not an Apps Script daily quota. #25 and #26 hit the same limit, reported by the REST API as `403 rateLimitExceeded`; a 5-minute backoff cleared it.

**For E7:** this error arrives as an ordinary exception thrown by the Advanced Service. The product should back off and retry in a later run, not treat it as a per-thread failure.

## Raw output

<details><summary>s23_runCases (compacted)</summary>

```json
{"cases":[{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1","T9"],"id":"A0","note":"baseline, no window: the sender term is indexed","pages":1,"params":{},"q":"from:bank-<run>.example","resultSizeEstimate":2,"returned":["T1","T9"],"totalThreads":2},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1"],"id":"A1","pages":1,"params":{},"q":"(from:bank-<run>.example) after:1789452328 before:1790489128","resultSizeEstimate":2,"returned":["T1","T9"],"totalThreads":2},{"asExpected":true,"expectNotReturned":["T1"],"expectReturned":[],"id":"A2","note":"window from the newest message only","pages":1,"params":{},"q":"(from:bank-<run>.example) after:1790316328 before:1790489128","resultSizeEstimate":1,"returned":["T9"],"totalThreads":1},{"asExpected":true,"expectNotReturned":["T2"],"expectReturned":["T1"],"id":"A3","pages":1,"params":{},"q":"(from:bank-<run>.example) after:1789452328 before:1790489128","resultSizeEstimate":2,"returned":["T1","T9"],"totalThreads":2},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T3"],"id":"B1.1","note":"label spelling","pages":1,"params":{},"q":"(label:spike23-<run>-private-stuff) after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T3"],"totalThreads":1},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T3"],"id":"B1.2","note":"label spelling","pages":1,"params":{},"q":"(label:\"Spike23-<run>/Private Stuff\") after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T3"],"totalThreads":1},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T3"],"id":"B1.3","note":"label spelling","pages":1,"params":{},"q":"(label:Spike23-<run>/Private-Stuff) after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T3"],"totalThreads":1},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T3"],"id":"B1.4","note":"label spelling","pages":1,"params":{},"q":"(label:spike23-<run>/private-stuff) after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T3"],"totalThreads":1},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T3"],"id":"B1.5","note":"label spelling","pages":1,"params":{},"q":"(label:Spike23-<run>-Private-Stuff) after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T3"],"totalThreads":1},{"asExpected":false,"expectNotReturned":[],"expectReturned":["T3"],"id":"B1.6","note":"label spelling","pages":1,"params":{},"q":"(label:Label_7) after:1790143528 before:1790489128","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1","T3"],"id":"B2","pages":1,"params":{},"q":"(from:bank-<run>.example OR label:spike23-<run>-private-stuff) after:1789452328 before:1790489128","resultSizeEstimate":3,"returned":["T1","T3","T9"],"totalThreads":3},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1","T3"],"id":"B3","pages":1,"params":{},"q":"({from:bank-<run>.example label:spike23-<run>-private-stuff}) after:1789452328 before:1790489128","resultSizeEstimate":3,"returned":["T1","T3","T9"],"totalThreads":3},{"asExpected":true,"expectNotReturned":["T3","T4b"],"expectReturned":["T1","T4"],"id":"B4","pages":1,"params":{},"q":"(from:bank-<run>.example OR (from:lawyer-<run>.example subject:contract)) after:1789452328 before:1790489128","resultSizeEstimate":3,"returned":["T1","T4","T9"],"totalThreads":3},{"asExpected":true,"expectNotReturned":["T4b"],"expectReturned":["T1","T4"],"id":"B4b","note":"T4b has from:lawyer and to:desk in different messages","pages":1,"params":{},"q":"(from:bank-<run>.example OR (from:lawyer-<run>.example to:desk-<run>.example)) after:1789452328 before:1790489128","resultSizeEstimate":3,"returned":["T1","T4","T9"],"totalThreads":3},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1","T3"],"id":"B5a","note":"no parentheses","pages":1,"params":{},"q":"from:bank-<run>.example OR label:spike23-<run>-private-stuff after:1789452328 before:1790489128","resultSizeEstimate":3,"returned":["T1","T3","T9"],"totalThreads":3},{"asExpected":true,"expectNotReturned":["T1"],"expectReturned":["T3"],"id":"B5b","note":"parenthesized control; T1 matches only outside this window","pages":1,"params":{},"q":"(from:bank-<run>.example OR label:spike23-<run>-private-stuff) after:1790143528 before:1790489128","resultSizeEstimate":2,"returned":["T3","T9"],"totalThreads":2},{"asExpected":true,"expectNotReturned":["T1"],"expectReturned":["T3"],"id":"B5c","note":"no parentheses; T1 returned means the window bound only the last OR operand","pages":1,"params":{},"q":"from:bank-<run>.example OR label:spike23-<run>-private-stuff after:1790143528 before:1790489128","resultSizeEstimate":2,"returned":["T3","T9"],"totalThreads":2},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T5"],"id":"B6","note":"SENT message","pages":1,"params":{},"q":"(to:lawyer-<run>.example) after:1790229928 before:1790489128","resultSizeEstimate":1,"returned":["T5"],"totalThreads":1},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C1.after.S-1","note":"message at S-1","pages":1,"params":{},"q":"(from:c1-early-<run>.example) after:1790078400","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C1.before.S-1","note":"message at S-1","pages":1,"params":{},"q":"(from:c1-early-<run>.example) before:1790078400","resultSizeEstimate":1,"returned":["T6"],"totalThreads":1},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C1.after.S","note":"message at S","pages":1,"params":{},"q":"(from:c1-exact-<run>.example) after:1790078400","resultSizeEstimate":1,"returned":["T6"],"totalThreads":1},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C1.before.S","note":"message at S","pages":1,"params":{},"q":"(from:c1-exact-<run>.example) before:1790078400","resultSizeEstimate":1,"returned":["T6"],"totalThreads":1},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C1.after.S+1","note":"message at S+1","pages":1,"params":{},"q":"(from:c1-late-<run>.example) after:1790078400","resultSizeEstimate":1,"returned":["T6"],"totalThreads":1},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C1.before.S+1","note":"message at S+1","pages":1,"params":{},"q":"(from:c1-late-<run>.example) before:1790078400","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C2.internal","note":"window around internalDate (receive time)","pages":1,"params":{},"q":"(from:c2-<run>.example) after:1789535128 before:1789542328","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"C2.header","note":"window around the Date header (10 days earlier)","pages":1,"params":{},"q":"(from:c2-<run>.example) after:1789535128 before:1789542328","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T6"],"id":"C3.around","note":"S inside a 6 h window","pages":1,"params":{},"q":"(from:c1-exact-<run>.example) after:1790067600 before:1790089200","resultSizeEstimate":1,"returned":["T6"],"totalThreads":1},{"asExpected":true,"expectNotReturned":["T6"],"expectReturned":[],"id":"C3.later","note":"same day, window starts 60 s after S","pages":1,"params":{},"q":"(from:c1-exact-<run>.example) after:1790078460 before:1790089200","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":true,"expectNotReturned":["T6"],"expectReturned":[],"id":"C3.earlier","note":"same day, window ends 60 s before S","pages":1,"params":{},"q":"(from:c1-exact-<run>.example) after:1790067600 before:1790078340","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"D1.default","pages":1,"params":{},"q":"(from:trash-<run>.example) after:1790143528 before:1790489128","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"D1.includeSpamTrash","pages":1,"params":{"includeSpamTrash":true},"q":"(from:trash-<run>.example) after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T8"],"totalThreads":1},{"id":"D1.threadsGet","matchingMessageReturned":true,"messageCount":3,"messages":[{"hasPayload":true,"isMatching":false,"labelIds":["INBOX"]},{"hasPayload":true,"isMatching":true,"labelIds":["TRASH"]},{"hasPayload":true,"isMatching":false,"labelIds":["INBOX"]}],"note":"Threads.get format full: does it return the trashed message?"},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"D2.default","pages":1,"params":{},"q":"(from:spam-<run>.example) after:1790143528 before:1790489128","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":null,"expectNotReturned":null,"expectReturned":null,"id":"D2.includeSpamTrash","pages":1,"params":{"includeSpamTrash":true},"q":"(from:spam-<run>.example) after:1790143528 before:1790489128","resultSizeEstimate":1,"returned":["T8s"],"totalThreads":1},{"id":"D2.threadsGet","matchingMessageReturned":true,"messageCount":3,"messages":[{"hasPayload":true,"isMatching":false,"labelIds":["INBOX"]},{"hasPayload":true,"isMatching":true,"labelIds":["SPAM"]},{"hasPayload":true,"isMatching":false,"labelIds":["INBOX"]}],"note":"Threads.get format full: does it return the spam message?"},{"asExpected":true,"expectNotReturned":["T9"],"expectReturned":[],"id":"E1.manual","note":"ADR-0005 manual form; not returned means the manual form leaks","pages":1,"params":{},"q":"(from:alice-<run>.example) (from:bank-<run>.example)","resultSizeEstimate":0,"returned":[],"totalThreads":0},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T9"],"id":"E1.window","pages":1,"params":{},"q":"(from:bank-<run>.example) after:1790229928 before:1790489128","resultSizeEstimate":1,"returned":["T9"],"totalThreads":1},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T9"],"id":"E2","note":"returned means subtracting the exclusion in the job search is unsafe","pages":1,"params":{},"q":"(from:alice-<run>.example) -(from:bank-<run>.example)","resultSizeEstimate":1,"returned":["T9"],"totalThreads":1},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1","T3","T5"],"id":"G1.wide","pages":1,"params":{},"q":"(from:bank-<run>.example OR label:spike23-<run>-private-stuff OR to:lawyer-<run>.example) after:1789452328 before:1790489128","resultSizeEstimate":4,"returned":["T1","T3","T5","T9"],"totalThreads":4},{"asExpected":true,"expectNotReturned":[],"expectReturned":["T1","T3","T5"],"id":"G1.perThread","pages":1,"params":{},"q":"(from:bank-<run>.example OR label:spike23-<run>-private-stuff OR to:lawyer-<run>.example) ((after:1789452328 before:1790489128) OR (after:1790143528 before:1790489128) OR (after:1790229928 before:1790489128))","resultSizeEstimate":4,"returned":["T1","T3","T5","T9"],"totalThreads":4}],"fn":"s23_runCases","groups":["A","B","C","D","E","G"],"labelTerm":"label:spike23-<run>-private-stuff","ranAt":"2026-09-26T08:06:25.493Z","run":"<run>"}
```

</details>

<details><summary>s23_setup (compacted)</summary>

```json
{"D":1790402728,"S":1790078400,"fn":"s23_setup","index":{"allIndexed":true,"notIndexed":[],"passes":1,"waitedMs":2134},"labelName":"Spike23-<run>/Private Stuff","run":"<run>","setupMs":21065,"threads":{"T1":{"messageCount":3,"messages":[{"dateHeader":"2026-09-16T06:05:28.000Z","from":"alerts@bank-<run>.example","i":0,"intended":"2026-09-16T06:05:28.000Z","internalDate":"2026-09-16T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-21T06:05:28.000Z","from":"carol@carol-<run>.example","i":1,"intended":"2026-09-21T06:05:28.000Z","internalDate":"2026-09-21T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"carol@carol-<run>.example","i":2,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0a8d1f92d31e2b","threadingOk":true},"T2":{"messageCount":2,"messages":[{"dateHeader":"2026-09-25T06:05:28.000Z","from":"carol@carol-<run>.example","i":0,"intended":"2026-09-25T06:05:28.000Z","internalDate":"2026-09-25T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"carol@carol-<run>.example","i":1,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0d72b35377c3c3","threadingOk":true},"T3":{"messageCount":3,"messages":[{"dateHeader":"2026-09-24T06:05:28.000Z","from":"carol@carol-<run>.example","i":0,"intended":"2026-09-24T06:05:28.000Z","internalDate":"2026-09-24T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-25T06:05:28.000Z","from":"carol@carol-<run>.example","i":1,"intended":"2026-09-25T06:05:28.000Z","internalDate":"2026-09-25T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["Label_7","INBOX"],"method":"insert/dateHeader/blob","post":"label","to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"carol@carol-<run>.example","i":2,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0d204d891e03aa","threadingOk":true},"T4":{"messageCount":2,"messages":[{"dateHeader":"2026-09-23T06:05:28.000Z","from":"counsel@lawyer-<run>.example","i":0,"intended":"2026-09-23T06:05:28.000Z","internalDate":"2026-09-23T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"desk@desk-<run>.example"},{"dateHeader":"2026-09-24T06:05:28.000Z","from":"carol@carol-<run>.example","i":1,"intended":"2026-09-24T06:05:28.000Z","internalDate":"2026-09-24T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0ccde7ccad0b5e","threadingOk":true},"T4b":{"messageCount":2,"messages":[{"dateHeader":"2026-09-23T06:05:28.000Z","from":"counsel@lawyer-<run>.example","i":0,"intended":"2026-09-23T06:05:28.000Z","internalDate":"2026-09-23T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-24T06:05:28.000Z","from":"carol@carol-<run>.example","i":1,"intended":"2026-09-24T06:05:28.000Z","internalDate":"2026-09-24T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"desk@desk-<run>.example"}],"threadId":"1a0ccde7de96adc6","threadingOk":true},"T5":{"messageCount":2,"messages":[{"dateHeader":"2026-09-25T06:05:28.000Z","from":"carol@carol-<run>.example","i":0,"intended":"2026-09-25T06:05:28.000Z","internalDate":"2026-09-25T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"<test-account>","i":1,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["SENT"],"method":"insert/dateHeader/blob","post":null,"to":"counsel@lawyer-<run>.example"}],"threadId":"1a0d72b343c257bd","threadingOk":true},"T6":{"messageCount":3,"messages":[{"dateHeader":"2026-09-22T11:59:59.000Z","from":"early@c1-early-<run>.example","i":0,"intended":"2026-09-22T11:59:59.000Z","internalDate":"2026-09-22T11:59:59.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-22T12:00:00.000Z","from":"exact@c1-exact-<run>.example","i":1,"intended":"2026-09-22T12:00:00.000Z","internalDate":"2026-09-22T12:00:00.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-22T12:00:01.000Z","from":"late@c1-late-<run>.example","i":2,"intended":"2026-09-22T12:00:01.000Z","internalDate":"2026-09-22T12:00:01.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0c8fcb38685814","threadingOk":true},"T7":{"messageCount":1,"messages":[{"dateHeader":"2026-09-16T06:05:28.000Z","from":"old@c2-<run>.example","i":0,"intended":"receive time","internalDate":"2026-09-16T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/receivedTime/blob","post":null,"to":"<test-account>"}],"threadId":"1a0dcbf98cbabeab","threadingOk":true},"T8":{"messageCount":3,"messages":[{"dateHeader":"2026-09-24T06:05:28.000Z","from":"carol@carol-<run>.example","i":0,"intended":"2026-09-24T06:05:28.000Z","internalDate":"2026-09-24T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-25T06:05:28.000Z","from":"notice@trash-<run>.example","i":1,"intended":"2026-09-25T06:05:28.000Z","internalDate":"2026-09-25T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["TRASH"],"method":"insert/dateHeader/blob","post":"trash","to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"carol@carol-<run>.example","i":2,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0d204d9762d72e","threadingOk":true},"T8s":{"messageCount":3,"messages":[{"dateHeader":"2026-09-24T06:05:28.000Z","from":"carol@carol-<run>.example","i":0,"intended":"2026-09-24T06:05:28.000Z","internalDate":"2026-09-24T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-25T06:05:28.000Z","from":"promo@spam-<run>.example","i":1,"intended":"2026-09-25T06:05:28.000Z","internalDate":"2026-09-25T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["SPAM"],"method":"insert/dateHeader/blob","post":"spam","to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"carol@carol-<run>.example","i":2,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0d204d943797d3","threadingOk":true},"T9":{"messageCount":2,"messages":[{"dateHeader":"2026-09-25T06:05:28.000Z","from":"alice@alice-<run>.example","i":0,"intended":"2026-09-25T06:05:28.000Z","internalDate":"2026-09-25T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"},{"dateHeader":"2026-09-26T06:05:28.000Z","from":"alerts@bank-<run>.example","i":1,"intended":"2026-09-26T06:05:28.000Z","internalDate":"2026-09-26T06:05:28.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert/dateHeader/blob","post":null,"to":"<test-account>"}],"threadId":"1a0d72b34770e0d9","threadingOk":true}}}
```

</details>

<details><summary>s23_probe, s23_c2Send, s23_lagProxy (first and second run)</summary>

```json
{"dateHeader":"2026-09-16T08:07:15.000Z","fn":"s23_probe","index":{"allIndexed":true,"notIndexed":[],"passes":1,"waitedMs":455},"paging":{"max2":{"pages":4,"resultSizeEstimate":8,"returned":["T1","T2","T3","T4","T4b","T5","T8","T8s"]},"max500":{"pages":1,"resultSizeEstimate":8,"returned":["T1","T2","T3","T4","T4b","T5","T8","T8s"]},"q":"(from:carol-<run>.example) after:1789452328 before:1790489128","same":true},"run":"r1790410035","variants":[{"args":{"internalDateSource":"receivedTime"},"form":"blob","internalDate":"2026-09-16T08:07:15.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert","variant":"insRT"},{"args":null,"form":"blob","internalDate":"2026-09-16T08:07:15.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert","variant":"insNone"},{"args":{"internalDateSource":"receivedTime"},"form":"raw","internalDate":"2026-09-16T08:07:15.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"insert","variant":"insRawRT"},{"args":{"internalDateSource":"receivedTime","neverMarkSpam":true},"form":"blob","internalDate":"2026-09-16T08:07:15.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"import","variant":"impRT"},{"args":{"neverMarkSpam":true},"form":"blob","internalDate":"2026-09-16T08:07:15.000Z","internalMinusHeaderSec":0,"labelIds":["INBOX"],"method":"import","variant":"impNone"}]}
{"fn":"s23_c2Send","messages":[{"dateHeader":"2026-09-26T08:07:51.000Z","internalDate":"2026-09-26T08:07:51.000Z","internalMinusHeaderSec":0,"labelIds":["UNREAD","SENT","INBOX"]}],"searchable":true,"sentHeaderDate":"2026-09-16T08:07:51.000Z","tok":"s23c2mui3xggu","waitedMs":323}
{"fn":"s23_lagProxy","note":"t=0 is after both uploads returned; times in seconds","results":[{"args":{"internalDateSource":"receivedTime"},"firstHitSec":0.4,"internalDateMinusReturnMs":-700,"labelIds":["INBOX"],"method":"insert/receivedTime/blob","polls":[{"atSec":0.4,"hit":true}],"q":"(from:f1ins-r1790410089.example) after:1790323689 before:1790496489"},{"args":{"internalDateSource":"receivedTime","neverMarkSpam":true},"firstHitSec":null,"internalDateMinusReturnMs":-1685,"labelIds":["INBOX"],"method":"import/receivedTime/blob","polls":[{"atSec":0.5,"hit":false},{"atSec":1.1,"hit":false},{"atSec":2.1,"hit":false},{"atSec":5.1,"hit":false},{"atSec":10.1,"hit":false},{"atSec":20.4,"hit":false},{"atSec":30.2,"hit":false},{"atSec":60.2,"hit":false},{"atSec":120.2,"hit":false}],"q":"(from:f1imp-r1790410089.example) after:1790323689 before:1790496489"}],"run":"r1790410089"}
{"fn":"s23_lagProxy","note":"t=0 is after both uploads returned; times in seconds","results":[{"args":{"internalDateSource":"receivedTime"},"firstHitSec":0.5,"internalDateMinusReturnMs":-990,"labelIds":["INBOX"],"method":"insert/receivedTime/blob","polls":[{"atSec":0.5,"hit":true}],"q":"(from:f1ins-r1790413386.example) after:1790326986 before:1790499786","threadIdChangedAfterUpload":false},{"args":{"internalDateSource":"receivedTime","neverMarkSpam":true},"firstHitSec":0.7,"internalDateMinusReturnMs":-1855,"labelIds":["INBOX"],"method":"import/receivedTime/blob","polls":[{"atSec":0.7,"hit":true}],"q":"(from:f1imp-r1790413386.example) after:1790326986 before:1790499786","threadIdChangedAfterUpload":true}],"run":"r1790413386"}
```

</details>

<details><summary>s23_search follow-ups (C2)</summary>

```
id, test threads returned, total threads, q  (<run> = r1790409928; C2b run = r1790410035)
-- first follow-up
Q1 ['T7'] 1 from:c2-<run>.example
Q2 ['T7'] 1 from:old@c2-<run>.example
Q3 [] 0 (from:c2-<run>.example) after:1789535128 before:1789542328      <- ±1 h around T7's internalDate (= Date header)
Q4 ['T7'] 1 (from:c2-<run>.example) after:1789452328 before:1790489128
Q5 ['T7'] 1 subject:"Spike23 T7"
Q6 ['T6'] 1 from:c1-early-<run>.example
-- second follow-up (upload times: T7 1790409928, C2b 1790410035; headers 10 days earlier)
Q1 ['T7'] 1 (from:c2-<run>.example) after:1790406328 before:1790413528   <- ±1 h around T7's upload time
Q2 [] 0 (from:c1-exact-<run>.example) after:1790406328 before:1790413528
Q3 [] 0 (from:bank-<run>.example) after:1790406328 before:1790413528
Q4 [] 1 (from:c2insrt-r1790410035.example) after:1790406435 before:1790413635
Q5 [] 0 (from:c2insrt-r1790410035.example) after:1789542435 before:1789549635
Q6 [] 1 (from:c2insnone-r1790410035.example) after:1790406435 before:1790413635
Q7 [] 0 (from:c2insnone-r1790410035.example) after:1789542435 before:1789549635
Q8 [] 1 (from:c2insrawrt-r1790410035.example) after:1790406435 before:1790413635
Q9 [] 0 (from:c2insrawrt-r1790410035.example) after:1789542435 before:1789549635
Q10 [] 1 (from:c2imprt-r1790410035.example) after:1790406435 before:1790413635
Q11 [] 0 (from:c2imprt-r1790410035.example) after:1789542435 before:1789549635
Q12 [] 0 (from:c2impnone-r1790410035.example) after:1790406435 before:1790413635
Q13 [] 1 (from:c2impnone-r1790410035.example) after:1789542435 before:1789549635
-- third follow-up: after:<min(internalDate, Date) - 1 d> before:<now + 1 d>
Q1 ['T7'] 1 (from:c2-<run>.example) after:1789452328 before:1790500188
Q2 [] 1 (from:c2insrt-r1790410035.example) after:1789459635 before:1790500188
Q3 [] 1 (from:c2insnone-r1790410035.example) after:1789459635 before:1790500188
Q4 [] 1 (from:c2insrawrt-r1790410035.example) after:1789459635 before:1790500188
Q5 [] 1 (from:c2imprt-r1790410035.example) after:1789459635 before:1790500188
Q6 [] 1 (from:c2impnone-r1790410035.example) after:1789459635 before:1790500188
```

</details>

<details><summary>F2: s23_f2Results</summary>

```json
{"armedAt":"2026-09-26T09:07:25.551Z","done":"complete","errors":[],"fn":"s23_f2Results","polls":4,"sends":[{"extraThreads":0,"gaveUp":false,"messages":[{"addedLabels":["UNREAD","SENT","INBOX"],"historyAddedAfterInternalSec":1.1,"historyAddedAfterSendSec":0.5,"historyAddedLowerBoundSec":0,"historyInboxAfterSendSec":null,"internalDate":"2026-09-26T09:07:33.000Z","isSentMessage":true,"labelIdsNow":["UNREAD","SENT","INBOX"]}],"n":1,"searchAfterInternalSec":1.1,"searchAfterSendSec":0.5,"searchInboxAfterSendSec":0.5,"searchLowerBoundSec":0,"searchMinusHistorySec":0,"sendCallSec":0.2,"sendLabelIds":["UNREAD","SENT","INBOX"],"sendStartAt":"2026-09-26T09:07:33.535Z","tok":"s23f2mui622gfn1"},{"extraThreads":0,"gaveUp":false,"messages":[{"addedLabels":["UNREAD","SENT","INBOX"],"historyAddedAfterInternalSec":0.8,"historyAddedAfterSendSec":0.6,"historyAddedLowerBoundSec":0,"historyInboxAfterSendSec":null,"internalDate":"2026-09-26T09:13:21.000Z","isSentMessage":true,"labelIdsNow":["UNREAD","SENT","INBOX"]}],"n":2,"searchAfterInternalSec":0.8,"searchAfterSendSec":0.6,"searchInboxAfterSendSec":0.6,"searchLowerBoundSec":0,"searchMinusHistorySec":0,"sendCallSec":0.3,"sendLabelIds":["UNREAD","SENT","INBOX"],"sendStartAt":"2026-09-26T09:13:21.232Z","tok":"s23f2mui622gfn2"},{"extraThreads":0,"gaveUp":false,"messages":[{"addedLabels":["UNREAD","SENT","INBOX"],"historyAddedAfterInternalSec":1.2,"historyAddedAfterSendSec":0.5,"historyAddedLowerBoundSec":0,"historyInboxAfterSendSec":null,"internalDate":"2026-09-26T09:18:33.000Z","isSentMessage":true,"labelIdsNow":["UNREAD","SENT","INBOX"]}],"n":3,"searchAfterInternalSec":1.2,"searchAfterSendSec":0.5,"searchInboxAfterSendSec":0.5,"searchLowerBoundSec":0,"searchMinusHistorySec":0,"sendCallSec":0.3,"sendLabelIds":["UNREAD","SENT","INBOX"],"sendStartAt":"2026-09-26T09:18:33.628Z","tok":"s23f2mui622gfn3"}],"token":"s23f2mui622gf","triggers":0}
```

</details>

## Conclusion

- **The scheduled exclusion search works, with three corrections.** `(<excludeQuery>) after:<lo> before:<hi>` through `threads.list` returns every thread in which any message matches, including with grouping, nested parentheses, `OR`, `{}`, and `SENT` messages. The corrections:
  1. **`includeSpamTrash: true`** (D1, D2). Without it, a thread whose only match is in Spam or Trash is missed, and `threads.get` would still hand that message over.
  2. **The upper bound is at least now + 1 day**, not newest message + 1 day (C2): the latest of now and every message's `internalDate` or `Date` header, plus 1 day. Search can index a message under a later date than the `internalDate` the API reports. The lower bound stays one day before the earliest `internalDate` or `Date` header of any chunk message. A2 shows the window must span the oldest message.
  3. **Page to the end** (H1). Paging works and loses nothing. Every case here fit in one page, but a wide window on a real mailbox won't.
- **Bounds:** epoch seconds, exact to the second, and both `after:` and `before:` are inclusive (C1, C3).
- **Parentheses:** `OR` binds tighter than the implicit AND, so an unwrapped flat `a OR b` still worked (B5c). The product still wraps `excludeQuery` in parentheses, so any user query is one operand.
- **Labels:** in `label:`, `/`, spaces, and `-` are interchangeable, matching is case-insensitive, and the quoted exact name works (B1.1–5). A label ID doesn't work (B1.6). Users can write label names naturally.
- **The ADR-0005 manual form leaks** (E1): `(<query>) (<excludeQuery>)` misses a thread whose matches are in different messages. Subtracting the exclusion leaks too (E2). The manual job search must not be the exclusion check. Manual items go through the chunk filter like scheduled items (ADR-0017).
- **Indexing lag is not a concern:**
  - F1: uploads (`insert`, `import`) were searchable within a second.
  - F2: each self-send was searchable at the same poll that `history.list` first reported it, within about 0.6 s of sending.
  - No "wait N minutes" mitigation is needed. The caveat: a self-send is stored as one `SENT` + `INBOX` message, not delivered from outside.
- **Per-message matching** is confirmed (B4b, E1). The README now tells users that space-separated terms must all match one email.

## Design changes

- **SD §6.4 step 2:** the confirmed search. Parentheses; `lo` from the earliest `internalDate` or `Date` header of any chunk message, minus 1 day; `hi` = the latest of now and every message date, plus 1 day; both bounds inclusive; `includeSpamTrash: true`; paged; no lag delay. Marked "Confirmed by E1", and it applies to scheduled and manual items.
- **SD §6.6:** the job search is `MANUAL_QUERY` and/or the timespan only. Exclusion is the §6.4 chunk filter.
- **SD §14:** the exclusion row is updated, with new rows for the unreported search date, the manual form, `threads.get` returning Spam/Trash messages (for E4), and the Gmail per-user, per-minute quota (for E7).
- **SD §10.6:** unchanged (the privacy statement still holds).
- **[ADR-0017](../output/adr/0017-exclusion-search-per-chunk-for-all-work.md)** (Proposed) supersedes ADR-0005 when accepted. It's indexed in `output/adr/README.md`.
- **README:** `excludeQuery` notes that Spam and Trash are covered and that each email is checked on its own.
- **Issues:** E3 #68, #69, #71 and E8 #130, #132, #133, #134, #135 are listed in PR #168 with the changes they need.
