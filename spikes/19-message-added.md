# 19: `messageAdded` history records

- Task: #19
- Date run: (not run yet)
- Account: `<test-account>` (consumer)
- Run by: agent via #163

## Question

Which `messageAdded` records does `users.history.list` return for each kind of mail (received, sent, sent to self, replies, drafts, Spam, Trash, category-labelled, filter-archived or filter-labelled), and what do they contain? Do a record's `labelIds` show the state when the message was added or the state at list time? What do a message's `historyId` and `internalDate` mean, and how should E3 compute the "first classification" flag?

Design text being tested (SD §6.3):

- "Ignore drafts (`DRAFT`), and messages in `SPAM` or `TRASH`. Received and sent messages both count."
- "A thread is marked **first classification** when every one of its messages arrived after the classifier's position." The design doesn't yet say how to compute "arrived after".

## How mail is made

There is no outside sender (epic #7, option C), so every message is made in the test account:

| Method | Call | Stands in for | Evidence |
|--------|------|---------------|----------|
| import | `Gmail.Users.Messages.import(resource, 'me', blob, optionalArgs)`, `resource = {labelIds: ['INBOX', 'UNREAD'], threadId?}`, `neverMarkSpam: true` unless the case is about Spam | Received mail. Google documents it as applying "standard email delivery scanning and classification similar to receiving via SMTP". | Weaker than real delivery; whether filters run is one of the questions (finding 9). |
| insert | `Gmail.Users.Messages.insert(resource, 'me', blob)` with explicit `labelIds` | A message with exact labels (S04b `SENT`, S08a `SPAM`, S12b `CATEGORY_PROMOTIONS`) | Shows the record shape only; no scanning or classification. |
| send | `Gmail.Users.Messages.send({raw, threadId?}, 'me')` to `<test-account>`, or a plus-address `<test-account>+sNN` | Sent mail. Really sent, but Gmail also delivers it back to the test account. | Not a pure send to a third party. |
| drafts | `Gmail.Users.Drafts.create/update/send/remove` | Drafts written in a client | API only; Gmail UI autosave is not tested. |
| UI | Maintainer in the Gmail web UI | Block sender (S08c), Delete forever (S15) | Real user path. |

All subjects start `E1-19-`, all synthetic `From` addresses are `@example.com`, `@example.net`, or `.example`, and bodies are synthetic. The test account's address is read from `getProfile` at run time and never returned: every result goes through `s19_out_`, which rewrites it (and any plus-address) to `<test-account>`.

## Functions

`spikes/19-message-added.js`. Every function takes one optional JSON args object and returns its result (also logged).

| Function | Does |
|----------|------|
| `s19_prepare()` | Before the start position: imports the S02 "before" thread (`E1-19-S02 before-thread`, 2 messages) and the S08c seed (`From: blocked-sender@example.net`). Resets `s19.map` and `s19.checkpoints`. |
| `s19_start()` | Saves `getProfile('me').historyId` and the time as `s19.start`. |
| `s19_act({from?, to?, skip?})` | Runs the API scenarios in the order S01, S02, S03, S04a, S04b, S05, S06, S07, S08a, S08b, S08c, S09, S10, S11, S12b, S12c, S13, S14, S15, D1, D2, D3, saving IDs to `s19.map` and a `getProfile` `historyId` checkpoint after each (`s19.checkpoints`). `from`/`to` run a range; `skip` lists scenarios to leave out. It stops before 4.5 minutes and says where to resume. |
| `s19_listAdded({startHistoryId?, maxResults?})` | Pages `History.list` with `historyTypes: ['messageAdded']` and `maxResults: 5` (to exercise paging). Returns each record's `id`, its keys, and each `messagesAdded[].message` (`id`, `threadId`, `labelIds`, `Object.keys`), tagged with its scenario; whether `history[].messages` is present and matches `messagesAdded`; the response `historyId` per page; and duplicate records or messages. |
| `s19_listAll(...)` | The same with `['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']`. |
| `s19_afterList()` | Trashes the S11 message. |
| `s19_details()` | For every message in `s19.map`: `Messages.get` (format `metadata`, headers `Subject` and `Date`), returning current `labelIds`, `historyId`, `internalDate` (epoch ms and ISO), `Subject`, `Date`, and `internalDate − Date`. A deleted message returns its 404. Also every message now in each scenario's thread (`Threads.get` minimal), which shows any copy Gmail made. |
| `s19_modifyOne()` | Marks the oldest S02 "before" message read and returns its `historyId` before and after, against the start position. |
| `s19_cleanup()` | Takes S09 out of Spam and back to the inbox. |

Script Properties: `s19.start`, `s19.map`, `s19.checkpoints`. No triggers.

## Scenarios

| # | Scenario | How |
|---|----------|-----|
| S01 | Received, new thread | `import` from `alice@example.com`. |
| S02 | Reply in a thread that existed before the start position | `import` a reply into the `s19_prepare` thread (`threadId`, `In-Reply-To`, `References`). |
| S03 | Reply in a thread created after the start position | `import` a reply to S01. |
| S04a | Sent, new thread | `send` to `<test-account>+s04`. |
| S04b | Sent, new thread (label only) | `insert` with `labelIds: ['SENT']`, `From: <test-account>`, `To: dave@example.com`. |
| S05 | Sent reply in an existing thread | `send` a reply into S01's thread, to `<test-account>+s05`. |
| S06 | Sent to self | `send` to `<test-account>`. |
| S07 | Draft lifecycle | `Drafts.create`, `Drafts.update` twice, `Drafts.send` (to `<test-account>+s07`). A second draft is created and deleted with `Drafts.remove` (the Advanced Service's name for `drafts.delete`; the code falls back to `delete` and records which it used). Every draft message ID is recorded per step. |
| S08a | Straight into Spam (label only) | `insert` with `labelIds: ['SPAM']`. |
| S08b | Straight into Spam (classifier), optional | `import` an obvious lottery-scam message with `neverMarkSpam: false`. Record whether it lands in Spam; don't rely on it. |
| S08c | Straight into Spam, blocked sender, optional | **M** blocks `blocked-sender@example.net` (the seed from `s19_prepare`). `s19_act` imports a new message from it with `neverMarkSpam: false`. |
| S09 | Moved to Spam after arrival, before listing | `import`, then `Messages.modify` add `SPAM`, remove `INBOX`. `s19_cleanup` undoes it after listing. |
| S10 | Trashed after arrival, before listing | `import`, then `Messages.trash`. |
| S11 | Trashed after being listed once | `import`; listed; `s19_afterList` trashes it; listed again. |
| S12a | Category, natural | No action: read the `CATEGORY_*` labels that S01 and the other imports got. |
| S12b | Category, explicit | `insert` with `labelIds: ['INBOX', 'CATEGORY_PROMOTIONS']`. |
| S12c | Category via filter | **M** filter on `E1-19-S12c`; `import` and `send` to `<test-account>+s12c`. |
| S13 | Filter archives on arrival | **M** filter on `E1-19-S13`; `import` and `send` to `<test-account>+s13`. |
| S14 | Filter labels on arrival | **M** filter on `E1-19-S14`; `import` and `send` to `<test-account>+s14`. |
| S15 | Deleted forever before listing, optional | `s19_act` imports it; **M** trashes it in the UI and chooses "Delete forever" before the listing. (The API can't: `messages.delete` needs `https://mail.google.com/`.) |
| D1 | `internalDate` source, import default | `import` with a `Date` header 3 hours in the past, no `internalDateSource`. |
| D2 | `internalDate` source, import `receivedTime` | As D1 with `internalDateSource: 'receivedTime'`. |
| D3 | `internalDate` source, insert default | `insert` (`INBOX`, `UNREAD`) with a `Date` header 3 hours in the past. |

D1–D3 are extra to the task's list. They answer finding 7 directly: with a `Date` header 3 hours old, `internalDate` shows whether each method took the header or the receive time. Every other message's `Date` header is the send time, so it can't tell the two apart.

S12c's filter matches `E1-19-S12c`, not `E1-19-S12` as the task first wrote, so it can't also catch S12b (`E1-19-S12b …`) and blur whether `insert` runs filters.

## Runbook

The agent runs every step via #163 (`node spikes/run.mjs run <fn> [json-args]`) unless it's marked **M**.

1. `s19_prepare`. This creates the S08c seed the maintainer needs.
2. **M** Maintainer steps 1–3 (filters, inbox type, block the seed's sender). The agent waits for confirmation.
3. Wait about a minute, then `s19_start`.
4. `s19_act`. If it stops early, rerun with `{"from": "<next scenario>"}`.
5. Optional S15: **M** step 4 (delete the S15 message forever). If the maintainer isn't available, skip S15 and record why.
6. Wait about a minute. `s19_listAdded`, then `s19_afterList`.
7. Wait about a minute. `s19_listAdded`, `s19_listAll`, `s19_details`, `s19_modifyOne`, then `s19_cleanup`.
8. Record every returned JSON below. Check that no real address appears (the scrub should already have replaced it with `<test-account>`).
9. **M** step 5: unblock the sender and delete the three filters.

## Maintainer steps

Steps 1–2 don't depend on any spike having run, so they can be done at any time before step 3 of the runbook.

1. In Gmail Settings → Filters and Blocked Addresses, create three filters (creating them through the API needs the `gmail.settings.basic` scope, which the spike project doesn't declare):
   - Subject contains `E1-19-S12c` → Categorize as: Promotions
   - Subject contains `E1-19-S13` → Skip the Inbox (Archive it)
   - Subject contains `E1-19-S14` → Apply the label `E1-19-filtered` (create it in the filter dialog)
2. Confirm the inbox type is **Default** with category tabs on (Settings → Inbox; at least Primary and Promotions ticked).
3. Optional (S08c), after the agent says `s19_prepare` has run: open the message `E1-19-S08c seed (block this sender)` from `blocked-sender@example.net`, and choose ⋮ → Block "blocked-sender". Reply "blocked".
4. Optional (S15), when the agent asks: open `E1-19-S15 delete forever`, move it to Trash, then in Trash choose "Delete forever". Reply "deleted".
5. When the agent says it's done: unblock `blocked-sender@example.net` (Settings → Filters and Blocked Addresses) and delete the three filters.

## Results

(Filled in from the returned JSON when the spike runs.)

| # | Created by (import / insert / send / drafts / UI) | messageAdded record? (count) | labelIds on the record | labelIds now (Messages.get) | Other record types seen | Would SD §6.3's filter keep it? Should it? | Notes |
|---|---|---|---|---|---|---|---|
| S01 | import | | | | | | |
| S02 | import | | | | | | |
| S03 | import | | | | | | |
| S04a | send | | | | | | |
| S04b | insert | | | | | | |
| S05 | send | | | | | | |
| S06 | send | | | | | | |
| S07 | drafts | | | | | | |
| S08a | insert | | | | | | |
| S08b | import | | | | | | |
| S08c | import + UI | | | | | | |
| S09 | import | | | | | | |
| S10 | import | | | | | | |
| S11 | import | | | | | | |
| S12a | import | | | | | | |
| S12b | insert | | | | | | |
| S12c | import / send | | | | | | |
| S13 | import / send | | | | | | |
| S14 | import / send | | | | | | |
| S15 | import + UI | | | | | | |
| D1 | import | | | | | | |
| D2 | import | | | | | | |
| D3 | insert | | | | | | |

### Findings

1. **Record fields.** The keys of `messagesAdded[].message` (expected `id`, `threadId`, `labelIds` only):
2. **`labelIds` timing** (S09, S10, S11): the state when the message was added, or at list time?
3. **Drafts** (S07): does every update add a new message ID (`messageAdded` with `DRAFT`, then `messageDeleted`)? What does the sent message look like?
4. **Spam on arrival** (S08a, and S08b/S08c if they ran):
5. **Send to self** (S06): one message with both `SENT` and `INBOX`, or two messages?
6. **`historyId` on a message** (`s19_modifyOne`): does the old S02 message's `historyId` move past the start position once it is read?
7. **`internalDate`** (checkpoints, `Date` header, D1–D3): a reliable arrival time for imported, sent, and draft-sent messages? Which `internalDateSource` does `import` use by default?
8. **Paging:** every record exactly once? Any message in more than one `messageAdded` record?
9. **Import vs. delivery:** did filters and categories apply to imported mail? Which cases used a stand-in?

## Raw output

<details><summary>s19_prepare, s19_start, s19_act</summary>

</details>

<details><summary>s19_listAdded (first), s19_afterList, s19_listAdded (second), s19_listAll</summary>

</details>

<details><summary>s19_details, s19_modifyOne, s19_cleanup</summary>

</details>

## Conclusion

(After the run: the `messageAdded` filter E3 should use, and the first-classification rule chosen from (a) `internalDate` after `position.savedAt` minus a skew margin, (b) every message ID seen in a `messageAdded` record since the position, or (c) every message's `historyId` above the position, with edge cases such as a draft created before the position and sent after it.)

## Design changes

(SD §6.3, SD §14 first row, and #62, #63, #67, after the run.)
