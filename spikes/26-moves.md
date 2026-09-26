# 26: Archive, spam, trash, and move-to-label through the Gmail API

- Task: #26
- Date run: (YYYY-MM-DD, filled in after the run)
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs`), plus the maintainer's Gmail web UI observations and one "Report spam" click
- Test threads: see [How each test thread was created](#how-each-test-thread-was-created)

## Question

SD §6.5 assumes: `archive` removes `INBOX`; `spam` adds `SPAM` and removes `INBOX`; `label:<name>` adds the label and removes `INBOX`; `trash` calls `threads.trash`; label adds and the `INBOX` removal go into as few `threads.modify` calls as possible. This spike answers, for E6 (#107) and the README Permissions section (#151):

1. Can one `threads.modify` add several labels and remove `INBOX`?
2. Does adding `SPAM` remove `INBOX` by itself?
3. Can `TRASH` be added through `threads.modify`, or only through `threads.trash`? Are user labels kept in Trash, and can they be added after trashing?
4. What happens to a thread's `SENT` message on spam and trash?
5. Are repeats safe (no error, no change)?
6. Which history records do the moves create? (No `messageAdded`, so E3 won't re-queue a thread the classifier just moved.)
7. Where does a later reply land after each move? Can import stand in for delivery?
8. Does adding `SPAM` through the API report the sender to Google?

## How each test thread was created

| Thread | How | Notes |
|--------|-----|-------|
| `S26-A1`, `-L1`, `-L2`, `-S1`, `-S2`, `-T1`–`-T4`, `-U1` | `Messages.import`, labels `INBOX`, `UNREAD`, `neverMarkSpam: false` | Placeholder From on `example.test`. S2's From is **X** (`s26-x@`), U1's is **Y** (`s26-y@`). If import itself gives one `SPAM`, that is recorded and it is re-imported with `neverMarkSpam: true`. |
| `S26-S3`, `S26-T5` ("with sent") | As above, plus an imported reply in the same thread with label `SENT` and the test account as From | The `SENT` message is **synthetic** (imported, not sent), so S3/T5 evidence is weaker than a real sent reply. |
| `S26-RA`, `-RL`, `-RS`, `-RT` | Self-sent with `Messages.send` from `<test-account>` to `<test-account>+s26` | Gmail's own delivery path. There's no outside sender (#7, option C), and self-sent messages also carry `SENT`, so R evidence is weaker than a reply from outside. |
| R replies | Self-sent into each R thread (`threadId`, `In-Reply-To`, `References`) | Same caveat. |
| RI replies | `Messages.import` into A1, L1, S2, T1 with `threadId` and **no** `labelIds` | Compared with R1–R3 to see whether import can stand in for delivery. |
| Follow-ups X, Y, Z | `Messages.import`, neutral subject and body, no `labelIds`, `neverMarkSpam: false` | Z (`s26-z@`) had no earlier action: the baseline. |
| Follow-up self-send | `Messages.send` to `<test-account>+s26`, neutral subject | After RS was spammed through the API. |

## Functions

| Function | What it does |
|----------|--------------|
| `s26_setup()` | Creates `S26`, `S26/Moved`, `S26/Tag`; imports the test threads (and the synthetic `SENT` replies); saves the history ID. |
| `s26_applyMoves()` | Saves the history ID, then applies A1, L1, L2, S1, S2, S3, T1–T5 and records per-message `labelIds` before and after each. |
| `s26_repeatMoves()` | I1: saves the history ID, then repeats the actions on A1, L1, S2, T1. |
| `s26_listOwnHistory()` | H1: history records since the ID saved by `s26_applyMoves`, per case, split into "moves" and "repeat or later". Records on other spikes' threads are only counted. |
| `s26_importReplies()` | RI: imports a reply with no `labelIds` into A1, L1, S2, T1. |
| `s26_spamFollowUp()` | Spam evidence 3: imports a neutral message from X, Y, and Z. Run after the maintainer reports U1. |
| `s26_sendReal()` | Self-sends `S26-RA`, `-RL`, `-RS`, `-RT`. |
| `s26_applyRealMoves()` | RA archive, RL move to `S26/Moved`, RS spam (add `SPAM`, remove `INBOX`), RT trash. |
| `s26_sendReplies()` | R1–R3: self-sends a reply into each R thread. |
| `s26_sendFollowUp()` | Spam evidence 4: self-sends a neutral message. |
| `s26_inspect()` | Per-message `labelIds` of every tracked thread, and minutes since the follow-ups. |
| `s26_cleanup()` | Un-spams (removes `SPAM`, adds `INBOX`), untrashes, deletes the `S26` labels. Keeps `s26.*` state if anything fails, so it can be re-run. |

State between runs is in Script Properties: `s26.t.<case>` per thread, and `s26.labels`, `s26.historyStart`, `s26.historyBeforeMoves`, `s26.historyBeforeRepeat`, `s26.followUp`, `s26.spamOnImport`. Every result is scrubbed of the test account's address (and any other address not on `example.test`).

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s26_setup`
3. `node spikes/run.mjs run s26_applyMoves`, then `s26_repeatMoves`, `s26_listOwnHistory`, `s26_importReplies`.
4. `node spikes/run.mjs run s26_sendReal`. Wait about a minute for delivery, then `s26_applyRealMoves`, `s26_sendReplies`, and `s26_sendFollowUp`.
5. Post the maintainer request (below) as one PR comment, with the `needs: maintainer` label.
6. After the maintainer has reported U1 as spam: `s26_spamFollowUp`. Record the time.
7. Wait at least 10 minutes after steps 4 and 6 (Gmail's spam filter can be slow), then `s26_inspect`. Record the wait.
8. `s26_cleanup`. Tell the maintainer cleanup is done (maintainer step 4).

Runbook step 4 changes the task's "How it runs" step 3, which predates option C: the agent self-sends the R threads instead of the maintainer sending them.

## Maintainer steps

Asked for in one PR comment after runbook step 4, so every thread already exists:

1. In Gmail on the web, reload, and note where each thread shows: Inbox, All Mail, Spam, Trash, Sent, or the `S26/Moved` label. The subjects are `S26-A1`, `S26-L1`, `S26-L2`, `S26-S1`, `S26-S2`, `S26-S3`, `S26-T1` to `S26-T5`, `S26-U1`, and the self-sent `S26-RA`, `S26-RL`, `S26-RS`, `S26-RT` (with their replies).
2. Open `S26-S2` in Spam and copy the exact banner text (for example, "Why is this message in spam?" and its explanation).
3. Open `S26-U1` in the Inbox, click **Report spam**, then open it in Spam and copy its banner text. Reply on the PR when done, so the agent can run the follow-up.
4. After the agent says cleanup is done: if `S26-U1` is still in Spam, click **Not spam**. Confirm that no `S26` labels remain in the left-hand label list.

## Results

(Filled in from the runs and the maintainer's observations.)

| # | Call(s) | ok / error (`e.name`, `e.message`) | Per-message `labelIds` before | Per-message `labelIds` after | Gmail web UI observation |
|---|---------|------------------------------------|-------------------------------|------------------------------|--------------------------|
| A1 | modify: remove `INBOX` | | | | |
| L1 | modify: add `S26/Moved`, remove `INBOX` | | | | |
| L2 | modify: add `S26/Tag`, `S26/Moved`, remove `INBOX` | | | | |
| S1 | modify: add `SPAM` only | | | | |
| S2 | modify: add `SPAM`, `S26/Tag`, remove `INBOX` | | | | |
| S3 | same as S2, thread with synthetic `SENT` | | | | |
| T1 | `threads.trash` | | | | |
| T2 | modify: add `TRASH` | | | | |
| T3 | modify: add `S26/Tag`; then `threads.trash` | | | | |
| T4 | `threads.trash`; then modify: add `S26/Tag` | | | | |
| T5 | `threads.trash`, thread with synthetic `SENT` | | | | |
| I1 | repeat A1, L1, S2, T1 | | | | |
| H1 | `history.list` since before the moves | | | | |
| R1 | reply to RA (archived) and RL (`S26/Moved`), self-sent | | | | |
| R2 | reply to RS (spammed), self-sent | | | | |
| R3 | reply to RT (trashed), self-sent | | | | |
| RI | imported reply, no `labelIds`, in A1, L1, S2, T1 | | | | |

### Spam reporting evidence

| Evidence | Source | Result |
|----------|--------|--------|
| 1. Docs | Gmail API reference and guides, Apps Script Gmail service, Gmail Help [Report spam](https://support.google.com/mail/answer/1366858) (quotes, URLs, date checked) | |
| 2. Banner | S2 (API-spammed) vs U1 (UI "Report spam") | |
| 3. Follow-up import | X (API-spammed From), Y (UI-reported From), Z (baseline); wait time | |
| 4. Follow-up self-send | After RS was spammed through the API; wait time | |

## Raw output

<details><summary>s26_setup</summary>

</details>

<details><summary>s26_applyMoves and s26_repeatMoves</summary>

</details>

<details><summary>s26_listOwnHistory</summary>

</details>

<details><summary>s26_importReplies, s26_sendReal, s26_applyRealMoves, s26_sendReplies, s26_sendFollowUp</summary>

</details>

<details><summary>s26_spamFollowUp and s26_inspect</summary>

</details>

<details><summary>s26_cleanup</summary>

</details>

## Conclusion

(Filled in from the results.)

- One `threads.modify` for several label adds plus `INBOX` removal:
- Does `SPAM` remove `INBOX` by itself:
- `TRASH` via modify; labels and Trash:
- `SENT` messages on spam and trash:
- Repeats:
- History records created by moves:
- Where later replies land (R1–R3), and whether import can stand in (RI):
- **Spam reporting:** "reports", "does not report", or "unknown", with the evidence. The evidence is weaker than a multi-sender test: there is no outside sender, only imported mail with placeholder From addresses and self-sends.

## Notes for README Permissions (#151)

(Filled in: the Spam finding and draft wording. A starting point: "The `spam` destination adds Gmail's Spam label through the Gmail API. Google doesn't document whether this counts as a spam report or trains your spam filter, so assume it might. Use `spam` only for mail you would report yourself.")

## Design changes

(Filled in: SD §6.5 "Apply" bullets, the §13 E6 row, and the §14 Spam row; #107 updated or listed; a Proposed ADR only if `threads.trash` or `SPAM` needs more than `gmail.modify`; anything that contradicts PDD §10 flagged in the PR.)
