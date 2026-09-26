# 20: `labelRemoved` records for a user label

- Task: #20
- Date run: (not run yet)
- Account: `<test-account>` (consumer)
- Run by: agent via #163, plus two Gmail UI removals by the maintainer

## Question

Does removing a user label such as `Jev/Error` yield `labelRemoved` history records? What is their exact shape, how many records and entries does one removal produce (one per message, or one per thread), and can the `labelId` filter on `history.list` narrow them? E3's retry path (#64, #65) is built from the answer.

Design text being tested (SD §6.3):

- "Filter `labelRemoved` records. Keep only those where `Jev/Error` was removed. These re-queue the thread with its strike count reset."
- E6 adds `Jev/Error` to a whole thread (`threads.modify`), which labels every message in it. The user removes it in the Gmail UI, usually from the whole conversation.

## How it's done

- The label is `E1-20/Error`, a test name that can't clash with a real `Jev/Error` later. Nested-label creation is #25's subject; whether the parent `E1-20` appears is recorded only in passing.
- Threads are made with `Gmail.Users.Messages.import` (`neverMarkSpam: true`), from synthetic `@example.com` senders to `<test-account>`, with replies joined by `threadId`, `In-Reply-To`, and `References`. They are imported, not delivered; label behavior shouldn't depend on that (finding 9).
- The label goes on each whole thread with `Gmail.Users.Threads.modify({addLabelIds}, 'me', threadId)`, as E6 will do.
- Everything is done through the API except S02 and S03, which are the real user path (the Gmail UI). Whether that differs from the API is part of the question.
- The test account's address is read from `getProfile` at run time and never returned: every result goes through `s20_out_`, which rewrites it to `<test-account>`.

## Functions

`spikes/20-label-removed.js`. Every function takes one optional JSON args object and returns its result (also logged).

| Function | Does |
|----------|------|
| `s20_setup()` | Finds or creates `E1-20/Error` (`Labels.list`, `Labels.create`), imports the S01–S08 threads (subjects `E1-20-Sxx label removal`; S01 has one message, the rest three), and adds the label to each with `Threads.modify`. Returns the label ID, thread and message IDs, and whether a parent `E1-20` label exists. |
| `s20_start()` | Saves `getProfile('me').historyId` as `s20.start`, after the labels are on. |
| `s20_act({only?})` | Runs S01, S04, S05, S06, S07 in order, with a `historyId` checkpoint after each. |
| `s20_list({historyTypes?, labelId?, labelFilter?, startHistoryId?})` | Pages `History.list` from `s20.start`. `historyTypes` defaults to `['labelRemoved']`. `labelFilter: true` filters on the saved label ID (or pass `labelId`). Returns every record's `id` and keys, each `labelsRemoved[]` entry (its keys, `labelIds`, and `message.{id, threadId, labelIds}` with `Object.keys(message)`), any `messagesAdded`, and a per-scenario summary: records, entries, messages covered, and whether they cover the whole thread. An exception is caught and returned. |
| `s20_state()` | `Threads.get` (minimal) for every scenario thread: each message's current `labelIds`. |
| `s20_deleteLabel()` | S08: deletes the label (`Labels.remove`, falling back to `delete`, and recording which) while it is still on the S08 thread. Returns the S08 thread before and after. |

Script Properties: `s20.label`, `s20.start`, `s20.map`, `s20.checkpoints`. No triggers.

S08 is a separate function, not part of `s20_act` as the task first sketched, so it runs **after** the first listings. Otherwise the label would already be gone when `s20_list({labelFilter: true})` runs, and finding 6 would be testing a deleted label.

## Scenarios

| # | Scenario | How |
|---|----------|-----|
| S01 | API `threads.modify` removal, single-message thread | `Threads.modify({removeLabelIds: [labelId]}, 'me', threadId)` |
| S02 | UI removal, whole conversation, 3-message thread | **M**: open the thread and click × on the label chip. |
| S03 | UI removal from the thread list, 3-message thread | **M**: select the thread in the list → Labels menu → untick. |
| S04 | API `threads.modify` removal, 3-message thread | As S01. |
| S05 | API `messages.modify` removal on one message of a 3-message thread | `Messages.modify({removeLabelIds: [labelId]}, 'me', firstMessageId)`, then the thread's labels, to see whether the other messages keep it. |
| S06 | Thread in Trash when the label is removed | `Threads.trash('me', threadId)`, then `Threads.modify` removal. |
| S07 | New message on a labelled thread, then removal | `import` a reply into the thread; read the thread (does the new message carry the label?); then `Threads.modify` removal. |
| S08 | The label itself is deleted | `s20_deleteLabel`, after the first listings, while the label is still on the S08 thread. |

## Runbook

The agent runs every step via #163 (`node spikes/run.mjs run <fn> [json-args]`) unless it's marked **M**.

1. `s20_setup`. Wait about a minute, then `s20_start`.
2. **M** Maintainer steps 1–3. The agent waits for "done".
3. `s20_act`. Wait about a minute.
4. `s20_list`, `s20_list({"labelFilter": true})`, `s20_list({"historyTypes": ["messageAdded", "labelRemoved"]})`, and `s20_state`.
5. `s20_deleteLabel`. Wait about a minute, then `s20_list` and `s20_list({"historyTypes": ["messageAdded", "labelRemoved", "labelAdded", "messageDeleted"]})` again to see what S08 produced.
6. Record all the returned JSON below.

## Maintainer steps

The agent asks for these in one comment, after `s20_setup` and `s20_start` have run (the threads and the label must exist, and the start position must come first).

1. S02: open the thread `E1-20-S02 label removal` and remove `E1-20/Error` from the whole conversation (click × on the label chip next to the subject).
2. S03: in the thread list (for example, search `subject:E1-20-S03`), tick the checkbox for `E1-20-S03 label removal`, open the Labels menu (the tag icon), untick `E1-20/Error`, and click Apply.
3. Reply "done". The agent then runs `s20_act` and the listings.

## Results

(Filled in from the returned JSON when the spike runs.)

| # | Records (count) | labelsRemoved entries per record | message IDs covered (all / some) | labelsRemoved[].labelIds | message.labelIds after removal | Present with labelId filter? | Notes |
|---|---|---|---|---|---|---|---|
| S01 | | | | | | | |
| S02 | | | | | | | |
| S03 | | | | | | | |
| S04 | | | | | | | |
| S05 | | | | | | | |
| S06 | | | | | | | |
| S07 | | | | | | | |
| S08 | | | | | | | |

### Findings

1. **Record shape.** The exact keys of `history[].labelsRemoved[]` and of its `message` (expected `message.{id, threadId, labelIds}` and `labelIds`):
2. **One record per message?** Does a whole-thread removal (UI or `threads.modify`) give one entry per message, in one record or several? E3 must de-duplicate by `threadId` either way; say which.
3. **UI vs API.** Any difference between S02–S03 and S04:
4. **Trash** (S06): is there a record, and does `message.labelIds` include `TRASH`? Should E3 re-queue a trashed thread (recommended: no, since processing ignores Trash)?
5. **New messages on a labelled thread** (S07): does a message that arrives after `threads.modify` inherit the label? (If not, E3's "a new message on such a thread does not queue it" rule must check the thread's labels, not the new message's.)
6. **`labelId` filter:** can E3 use `labelId` to fetch only `Jev/Error` removals, or must it filter on the client?
7. **Combined call:** does `historyTypes: ['messageAdded', 'labelRemoved']` return both kinds, including S07's import?
8. **Label deletion** (S08): does deleting the label produce `labelRemoved` records? If not, a user who deletes `Jev/Error` outright never retries those threads.
9. **Import stand-in:** could importing rather than delivering affect label behavior?

## Raw output

<details><summary>s20_setup, s20_start, s20_act</summary>

</details>

<details><summary>s20_list (three variants), s20_state</summary>

</details>

<details><summary>s20_deleteLabel, s20_list after S08</summary>

</details>

## Conclusion

(After the run.)

## Design changes

(SD §6.3 "Filter `labelRemoved` records" and "Threads marked `Jev/Error`", SD §14 first row, and #64, #65, after the run.)
