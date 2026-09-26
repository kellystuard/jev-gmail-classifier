# 26: Archive, spam, trash, and move-to-label through the Gmail API

- Task: #26
- Date run: 2026-09-26 (spam follow-up and UI observations: pending)
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs`), plus the maintainer's Gmail web UI observations and one "Report spam" click
- Test threads: see [How each test thread was created](#how-each-test-thread-was-created). Run tag `rwc25` (in every subject of the clean run).

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
| `S26-A1`, `-L1`, `-L2`, `-S1`, `-S2`, `-T1`–`-T4`, `-U1` | `Messages.import` (media-blob form), labels `INBOX`, `UNREAD`, **`neverMarkSpam: true`** | Placeholder From on `example.test`. S2's From is **X** (`s26-x@`), U1's is **Y** (`s26-y@`). The first run used `neverMarkSpam: false` and every import went to Spam (see [First run](#first-run-discarded)). |
| `S26-S3`, `S26-T5` ("with sent") | As above, plus an imported reply with label `SENT` and the test account as From | The `SENT` message is **synthetic** (imported, not sent), so S3/T5 evidence is weaker than a real sent reply. `import` rejected `threadId` (`400 threadId not allowed`); without it, the reply joined the thread through its `In-Reply-To`/`References` headers. |
| `S26-RA`, `-RL`, `-RS`, `-RT` | Self-sent with `Messages.send` from `<test-account>` to `<test-account>+s26` | Gmail's own delivery path. Each is **one** message labelled `SENT`, `INBOX`, `UNREAD`. There's no outside sender (#7, option C), so R evidence is weaker than a reply from outside. |
| R replies | Self-sent into each R thread (`threadId`, `In-Reply-To`, `References`) | Same caveat. All four joined their threads. |
| RI replies | `Messages.import` into A1, L1, S2, T1 with **no** `labelIds`, `neverMarkSpam: true` | `threadId` rejected as above, so they rely on headers. `neverMarkSpam: true` because with `false` every `example.test` import is spam-classified, which would hide where threading alone puts the reply. |
| Follow-ups X, Y, Z | `Messages.import`, neutral subject and body, no `labelIds`, `neverMarkSpam: false` | Z (`s26-z@`) had no earlier action: the baseline. (Pending.) |
| Follow-up self-send | `Messages.send` to `<test-account>+s26`, neutral subject | After RS was spammed through the API. |

## Functions

| Function | What it does |
|----------|--------------|
| `s26_setup(opts?)` | Creates `S26`, `S26/Moved`, `S26/Tag`; imports the test threads (and the synthetic `SENT` replies) with a per-run subject tag; saves the history ID. `opts.neverMarkSpam` defaults to `true`. |
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
| `s26_reset()` | Starts over: trashes every thread this spike tracks, deletes the `S26` labels, clears `s26.*`. Used once, after the first run. |

State between runs is in Script Properties: `s26.t.<case>` per thread, and `s26.run`, `s26.labels`, `s26.historyStart`, `s26.historyBeforeMoves`, `s26.historyBeforeRepeat`, `s26.followUp`, `s26.spamOnImport`. Every result is scrubbed of the test account's address (and any other address not on `example.test`).

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s26_setup`
3. `node spikes/run.mjs run s26_applyMoves`, then `s26_repeatMoves`, `s26_listOwnHistory`, `s26_importReplies`.
4. `node spikes/run.mjs run s26_sendReal`. Wait about a minute for delivery, then `s26_applyRealMoves`, `s26_sendReplies`, and `s26_sendFollowUp`.
5. Post the maintainer request (below) as one comment, with the `needs: maintainer` label.
6. After the maintainer has reported U1 as spam: `s26_spamFollowUp`. Record the time.
7. Wait at least 10 minutes after steps 4 and 6 (Gmail's spam filter can be slow), then `s26_inspect`. Record the wait.
8. `s26_cleanup`. Tell the maintainer cleanup is done (maintainer step 5).

Runbook step 4 changes the task's "How it runs" step 3, which predates option C: the agent self-sends the R threads instead of the maintainer sending them.

**What actually happened (2026-09-26):** step 2 first ran with `neverMarkSpam: false` and was discarded ([First run](#first-run-discarded)); `s26_reset` trashed those threads (its first attempt failed on one thread with `400 Precondition check failed`, and a retry a minute later succeeded), and step 2 was re-run. Step 4's first `s26_sendReal` hit Gmail's per-user rate limit (other stories share the account); after a 5-minute backoff it succeeded. Step 5 was posted on #26.

## Maintainer steps

Asked for in one comment on #26 after runbook step 4, so every thread already exists:

1. In Gmail on the web, reload, and note where each thread shows: Inbox, All Mail, Spam, Trash, Sent, or the `S26/Moved` label (search `rwc25 in:anywhere`).
2. Open `S26-S2` in Spam and copy the exact banner text.
3. Open `S26-U1` in the Inbox, click **Report spam**, then open it in Spam and copy its banner text. Reply when done, so the agent can run the follow-up.
4. (Reply with notes.)
5. After the agent says cleanup is done: if `S26-U1` is still in Spam, click **Not spam**. Confirm that no `S26` labels remain in the left-hand label list.

## Results

Clean run, 2026-09-26 (run tag `rwc25`). Label lists are per message, in thread order; `S26/Moved` and `S26/Tag` stand for their `Label_N` IDs. "Synthetic SENT" is the imported reply in S3 and T5. The UI column is pending the maintainer's observations.

| # | Call(s) | ok / error | Per-message `labelIds` before | Per-message `labelIds` after | Gmail web UI observation |
|---|---------|------------|-------------------------------|------------------------------|--------------------------|
| A1 | modify: remove `INBOX` | ok | `UNREAD, INBOX` | `UNREAD` | (pending) |
| L1 | modify: add `S26/Moved`, remove `INBOX` | ok | `UNREAD, INBOX` | `UNREAD, S26/Moved` | (pending) |
| L2 | modify: add `S26/Tag`, `S26/Moved`, remove `INBOX` (one call) | ok | `UNREAD, INBOX` | `UNREAD, S26/Moved, S26/Tag` | (pending) |
| S1 | modify: add `SPAM` only | ok | `UNREAD, INBOX` | `UNREAD, SPAM`: **`INBOX` removed by Gmail** | (pending) |
| S2 | modify: add `SPAM`, `S26/Tag`, remove `INBOX` | ok | `UNREAD, INBOX` | `UNREAD, S26/Tag, SPAM`: the user label survives in Spam | (pending; banner) |
| S3 | same as S2, thread with synthetic `SENT` | ok | original `UNREAD, INBOX`; sent `SENT` | original `UNREAD, S26/Tag, SPAM`; sent **`S26/Tag, SENT, SPAM`** | (pending: still in Sent?) |
| T1 | `threads.trash` | ok | `UNREAD, INBOX` | `UNREAD, TRASH`: `INBOX` removed | (pending) |
| T2 | modify: add `TRASH` | **ok** | `UNREAD, INBOX` | `UNREAD, TRASH`: same result as `threads.trash` | (pending) |
| T3 | modify: add `S26/Tag`; then `threads.trash` | ok, ok | `UNREAD, INBOX` | `UNREAD, S26/Tag, TRASH`: the label is kept in Trash | (pending) |
| T4 | `threads.trash`; then modify: add `S26/Tag` | ok, ok | `UNREAD, INBOX` | `UNREAD, S26/Tag, TRASH`: a label can be added after trashing; the thread stays in Trash | (pending) |
| T5 | `threads.trash`, thread with synthetic `SENT` | ok | original `UNREAD, INBOX`; sent `SENT` | original `UNREAD, TRASH`; sent **`TRASH, SENT`** | (pending) |
| I1 | repeat A1, L1, S2, T1 | all ok | as "after" above | **unchanged** | — |
| H1 | `history.list` from before the moves | ok, 1 page | — | 26 label records on our threads (15 `labelsAdded`, 11 `labelsRemoved`), **0 `messagesAdded`**, and **no records at all from the repeats**. One record per label change (L2's call gave 3 records). S1 records `labelsRemoved INBOX` although only `SPAM` was requested. Some records carry only `messages`, with no change type. | — |
| R1 | self-sent reply to RA (archived) and RL (`S26/Moved`) | ok, joined | RA: `UNREAD, SENT`; RL: `UNREAD, S26/Moved, SENT` | reply: `UNREAD, SENT, INBOX`. **Back in the Inbox; the reply does not get `S26/Moved`.** The earlier message is unchanged. | (pending) |
| R2 | self-sent reply to RS (spammed) | ok, joined | `UNREAD, SENT, SPAM` | reply: `UNREAD, SENT, INBOX`: **Inbox, not Spam**; the earlier message stays in Spam | (pending) |
| R3 | self-sent reply to RT (trashed) | ok, joined | `UNREAD, TRASH, SENT` | reply: `UNREAD, SENT, INBOX`: **Inbox, not Trash**; the earlier message stays in Trash | (pending) |
| RI | imported reply, no `labelIds`, in A1, L1, S2, T1 | ok (`threadId` dropped: `400 threadId not allowed`) | as "after" above | reply: **no labels at all** (not `INBOX`, not even `UNREAD`). Joined A1, L1, T1 through headers; in S2 (Spam) it started a **new** thread. Import doesn't stand in for delivery. | (pending) |

### Errors seen

| Where | Error (verbatim) | Notes |
|-------|------------------|-------|
| `Messages.import` with `resource.threadId` (media-blob and `resource.raw` forms, with and without `labelIds`) | `GoogleJsonResponseException: API call to gmail.users.messages.import failed with error: threadId not allowed` (`details.code` 400, `reason: invalidArgument`) | Import can't be pinned to a thread; threading comes from headers and subject. |
| `Messages.import` return value | Only `{id}` (no `threadId`, no `labelIds`) | The spike reads each message back with `Messages.get` (`format: minimal`). |
| `Threads.trash` in `s26_reset` (1 of 12 threads) | `GoogleJsonResponseException: API call to gmail.users.threads.trash failed with error: Precondition check failed.` (`details.code` 400, `reason: failedPrecondition`) | Succeeded on retry about a minute later. The thread had been imported about 3 minutes earlier. E6 should treat this as transient. |
| `Messages.send` (all 4, first `s26_sendReal`) | `GoogleJsonResponseException: API call to gmail.users.messages.send failed with error: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:<project-number>'.` (`details.code` 403, `reason: rateLimitExceeded`, `domain: usageLimits`) | A per-user, per-minute limit, shared with other spikes on the account. Succeeded after a 5-minute backoff. A 403 that isn't a scope error: E6/E7 must not map every 403 to `scope`. |

### First run (discarded)

The first `s26_setup` imported all 12 threads with `neverMarkSpam: false` and `labelIds: ['INBOX', 'UNREAD']`. **Gmail put every one in Spam:** the stored labels were `UNREAD, CATEGORY_PERSONAL, SPAM`, and the requested `INBOX` was dropped. The re-import with `neverMarkSpam: true` and the same subject then **joined the Spam copy's thread** (no `References` header), so each case thread held a Spam message and an Inbox message. That run was discarded: `s26_reset` trashed the 12 threads, and setup now imports with `neverMarkSpam: true` and a per-run subject tag. For other spikes: unauthenticated `example.test` mail imported with `neverMarkSpam: false` is spam-classified, and Gmail threads imports that share a subject.

### Spam reporting evidence

| Evidence | Source | Result |
|----------|--------|--------|
| 1. Docs (checked 2026-09-26) | [Gmail API: Manage labels](https://developers.google.com/workspace/gmail/api/guides/labels) lists `SPAM` as a label that can be applied, and says nothing about reporting or filter training. [`users.threads.modify`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/modify) says nothing about it either. [Gmail Help: Report spam in Gmail](https://support.google.com/mail/answer/1366858), under "Report emails as spam": "Important: When you report spam or move an email into Spam, Google receives a copy of the email and may analyze it to help protect users from spam and abuse." The same page: "As you report more spam, Gmail identifies similar emails as spam more efficiently." A public Google Issue Tracker request is titled "Add API to 'Report Spam' that generates a complaint" ([329687280](https://issuetracker.google.com/issues/329687280); only its title is readable without signing in). | The Help Center wording covers "move an email into Spam", with no exception for the API, and the API docs are silent. The issue-tracker title suggests the API has no explicit "report" action, but it's unverified. Neither says whether an API `SPAM` label is a report. |
| 2. Banner | S2 (API-spammed) vs U1 (UI "Report spam") | (pending: maintainer) |
| 3. Follow-up import | X (API-spammed From), Y (UI-reported From), Z (baseline); wait time | (pending). Expect weak evidence: the first run shows `example.test` imports with `neverMarkSpam: false` go to Spam regardless, so Z will likely be Spam too. |
| 4. Follow-up self-send | Sent 2026-09-26T09:10Z, after RS was spammed through the API | At send time: `UNREAD, SENT, INBOX`. (Re-checked by `s26_inspect`, pending.) |

## Raw output

Results from `node spikes/run.mjs`, reduced to the fields that matter, with `Label_N` IDs shown as names.

<details><summary>s26_setup, first run (neverMarkSpam false; discarded): per case, labels after import</summary>

```json
{
 "A1": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "L1": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "L2": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "S1": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "S2": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "S3": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "T1": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "T2": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "T3": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "T4": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "T5": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ],
 "U1": [
  {
   "labelIds": [
    "UNREAD",
    "CATEGORY_PERSONAL",
    "SPAM"
   ],
   "neverMarkSpam": false
  },
  {
   "labelIds": [
    "UNREAD",
    "INBOX"
   ],
   "neverMarkSpam": true
  }
 ]
}
```

</details>

<details><summary>s26_setup, clean run (run tag rwc25)</summary>

```json
{
 "cases": {
  "A1": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "L1": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "L2": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "S1": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "S2": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "S3": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": {
    "labelIds": [
     "SENT"
    ],
    "ok": true,
    "threadIdDropped": true,
    "threadIdError": "API call to gmail.users.messages.import failed with error: threadId not allowed"
   },
   "sentReplyJoinedThread": true,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    },
    {
     "labelIds": [
      "SENT"
     ],
     "role": "sent reply (import, synthetic SENT)"
    }
   ]
  },
  "T1": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "T2": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "T3": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "T4": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  },
  "T5": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": {
    "labelIds": [
     "SENT"
    ],
    "ok": true,
    "threadIdDropped": true,
    "threadIdError": "API call to gmail.users.messages.import failed with error: threadId not allowed"
   },
   "sentReplyJoinedThread": true,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    },
    {
     "labelIds": [
      "SENT"
     ],
     "role": "sent reply (import, synthetic SENT)"
    }
   ]
  },
  "U1": {
   "attempt": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "method": "import (media blob)",
     "neverMarkSpam": true
    }
   ],
   "sentReply": null,
   "sentReplyJoinedThread": null,
   "snapshot": [
    {
     "labelIds": [
      "UNREAD",
      "INBOX"
     ],
     "role": "original (import)"
    }
   ]
  }
 },
 "historyStart": {
  "ok": true,
  "value": "36559123"
 }
}
```

</details>

<details><summary>s26_applyMoves</summary>

```json
{
 "A1": {
  "after": [
   {
    "labelIds": [
     "UNREAD"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "L1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"S26/Moved (Label_32)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "L2": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved",
     "S26/Tag"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"S26/Tag (Label_33)\",\"S26/Moved (Label_32)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "S1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "SPAM"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"SPAM\"]}",
    "ok": true
   }
  ]
 },
 "S2": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "SPAM"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"SPAM\",\"S26/Tag (Label_33)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "S3": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "SPAM"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [
     "S26/Tag",
     "SENT",
     "SPAM"
    ],
    "role": "sent reply (import, synthetic SENT)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [
     "SENT"
    ],
    "role": "sent reply (import, synthetic SENT)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"SPAM\",\"S26/Tag (Label_33)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "T1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.trash",
    "ok": true
   }
  ]
 },
 "T2": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"TRASH\"]}",
    "ok": true
   }
  ]
 },
 "T3": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"S26/Tag (Label_33)\"]}",
    "ok": true
   },
   {
    "call": "threads.trash",
    "ok": true
   }
  ]
 },
 "T4": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.trash",
    "ok": true
   },
   {
    "call": "threads.modify {\"addLabelIds\":[\"S26/Tag (Label_33)\"]}",
    "ok": true
   }
  ]
 },
 "T5": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [
     "TRASH",
     "SENT"
    ],
    "role": "sent reply (import, synthetic SENT)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "INBOX"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [
     "SENT"
    ],
    "role": "sent reply (import, synthetic SENT)"
   }
  ],
  "calls": [
   {
    "call": "threads.trash",
    "ok": true
   }
  ]
 }
}
```

</details>

<details><summary>s26_repeatMoves (I1)</summary>

```json
{
 "A1": {
  "after": [
   {
    "labelIds": [
     "UNREAD"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "L1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"S26/Moved (Label_32)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "S2": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "SPAM"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "SPAM"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"SPAM\",\"S26/Tag (Label_33)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "T1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "calls": [
   {
    "call": "threads.trash",
    "ok": true
   }
  ]
 }
}
```

</details>

<details><summary>s26_listOwnHistory (H1), one line per record</summary>

```json
{
 "foreignRecords": 0,
 "messagesAddedOnOurThreads": 0,
 "records": [
  "36559125 moves (messages only, no change type)",
  "36559126 moves labelsRemoved A1 ['INBOX']",
  "36559127 moves (messages only, no change type)",
  "36559147 moves (messages only, no change type)",
  "36559148 moves labelsAdded L1 ['S26/Moved']",
  "36559149 moves labelsRemoved L1 ['INBOX']",
  "36559150 moves (messages only, no change type)",
  "36559174 moves (messages only, no change type)",
  "36559175 moves labelsAdded L2 ['S26/Moved']",
  "36559176 moves labelsAdded L2 ['S26/Tag']",
  "36559177 moves labelsRemoved L2 ['INBOX']",
  "36559178 moves (messages only, no change type)",
  "36559208 moves labelsAdded S1 ['SPAM']",
  "36559209 moves labelsRemoved S1 ['INBOX']",
  "36559210 moves (messages only, no change type)",
  "36559250 moves labelsAdded S2 ['SPAM']",
  "36559251 moves labelsAdded S2 ['S26/Tag']",
  "36559252 moves labelsRemoved S2 ['INBOX']",
  "36559253 moves (messages only, no change type)",
  "36559284 moves labelsAdded S3 ['SPAM']; labelsAdded S3 ['SPAM']",
  "36559285 moves labelsAdded S3 ['S26/Tag']; labelsAdded S3 ['S26/Tag']",
  "36559286 moves labelsRemoved S3 ['INBOX']",
  "36559287 moves (messages only, no change type)",
  "36559288 moves (messages only, no change type)",
  "36559320 moves labelsAdded T1 ['TRASH']",
  "36559321 moves labelsRemoved T1 ['INBOX']",
  "36559322 moves (messages only, no change type)",
  "36559348 moves labelsAdded T2 ['TRASH']",
  "36559349 moves labelsRemoved T2 ['INBOX']",
  "36559350 moves (messages only, no change type)",
  "36559384 moves labelsAdded T3 ['S26/Tag']",
  "36559399 moves labelsAdded T3 ['TRASH']",
  "36559400 moves labelsRemoved T3 ['INBOX']",
  "36559401 moves (messages only, no change type)",
  "36559430 moves labelsAdded T4 ['TRASH']",
  "36559431 moves labelsRemoved T4 ['INBOX']",
  "36559432 moves (messages only, no change type)",
  "36559468 moves labelsAdded T4 ['S26/Tag']",
  "36559470 moves labelsAdded T5 ['TRASH']; labelsAdded T5 ['TRASH']",
  "36559471 moves labelsRemoved T5 ['INBOX']",
  "36559472 moves (messages only, no change type)",
  "36559473 moves (messages only, no change type)"
 ],
 "repeatHistoryId": "36559509",
 "startHistoryId": "36559123",
 "typeCounts": {
  "labelsAdded": 15,
  "labelsRemoved": 11
 }
}
```

</details>

<details><summary>s26_importReplies (RI)</summary>

```json
{
 "A1": {
  "after": [
   {
    "labelIds": [
     "UNREAD"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [],
    "role": "RI reply (import, no labelIds)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD"
    ],
    "role": "original (import)"
   }
  ],
  "import": {
   "labelIds": [],
   "ok": true,
   "threadIdDropped": true,
   "threadIdError": "API call to gmail.users.messages.import failed with error: threadId not allowed"
  },
  "joinedThread": true
 },
 "L1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [],
    "role": "RI reply (import, no labelIds)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved"
    ],
    "role": "original (import)"
   }
  ],
  "import": {
   "labelIds": [],
   "ok": true,
   "threadIdDropped": true,
   "threadIdError": "API call to gmail.users.messages.import failed with error: threadId not allowed"
  },
  "joinedThread": true
 },
 "S2": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "SPAM"
    ],
    "role": "original (import)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Tag",
     "SPAM"
    ],
    "role": "original (import)"
   }
  ],
  "import": {
   "labelIds": [],
   "ok": true,
   "threadIdDropped": true,
   "threadIdError": "API call to gmail.users.messages.import failed with error: threadId not allowed"
  },
  "joinedThread": false
 },
 "T1": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   },
   {
    "labelIds": [],
    "role": "RI reply (import, no labelIds)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH"
    ],
    "role": "original (import)"
   }
  ],
  "import": {
   "labelIds": [],
   "ok": true,
   "threadIdDropped": true,
   "threadIdError": "API call to gmail.users.messages.import failed with error: threadId not allowed"
  },
  "joinedThread": true
 }
}
```

</details>

<details><summary>s26_sendReal (second attempt; the first hit the rate limit)</summary>

```json
{
 "RA": {
  "labelIds": [
   "UNREAD",
   "SENT",
   "INBOX"
  ],
  "ok": true
 },
 "RL": {
  "labelIds": [
   "UNREAD",
   "SENT",
   "INBOX"
  ],
  "ok": true
 },
 "RS": {
  "labelIds": [
   "UNREAD",
   "SENT",
   "INBOX"
  ],
  "ok": true
 },
 "RT": {
  "labelIds": [
   "UNREAD",
   "SENT",
   "INBOX"
  ],
  "ok": true
 }
}
```

</details>

<details><summary>s26_applyRealMoves</summary>

```json
{
 "RA": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "SENT"
    ],
    "role": "original (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "original (self-send)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "RL": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved",
     "SENT"
    ],
    "role": "original (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "original (self-send)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"S26/Moved (Label_32)\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "RS": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "SPAM"
    ],
    "role": "original (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "original (self-send)"
   }
  ],
  "calls": [
   {
    "call": "threads.modify {\"addLabelIds\":[\"SPAM\"],\"removeLabelIds\":[\"INBOX\"]}",
    "ok": true
   }
  ]
 },
 "RT": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH",
     "SENT"
    ],
    "role": "original (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "original (self-send)"
   }
  ],
  "calls": [
   {
    "call": "threads.trash",
    "ok": true
   }
  ]
 }
}
```

</details>

<details><summary>s26_sendReplies (R1–R3)</summary>

```json
{
 "RA": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "SENT"
    ],
    "role": "original (self-send)"
   },
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "reply (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "SENT"
    ],
    "role": "original (self-send)"
   }
  ],
  "joinedThread": true,
  "send": {
   "labelIds": [
    "UNREAD",
    "SENT",
    "INBOX"
   ],
   "ok": true
  }
 },
 "RL": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved",
     "SENT"
    ],
    "role": "original (self-send)"
   },
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "reply (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "S26/Moved",
     "SENT"
    ],
    "role": "original (self-send)"
   }
  ],
  "joinedThread": true,
  "send": {
   "labelIds": [
    "UNREAD",
    "SENT",
    "INBOX"
   ],
   "ok": true
  }
 },
 "RS": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "SPAM"
    ],
    "role": "original (self-send)"
   },
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "reply (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "SPAM"
    ],
    "role": "original (self-send)"
   }
  ],
  "joinedThread": true,
  "send": {
   "labelIds": [
    "UNREAD",
    "SENT",
    "INBOX"
   ],
   "ok": true
  }
 },
 "RT": {
  "after": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH",
     "SENT"
    ],
    "role": "original (self-send)"
   },
   {
    "labelIds": [
     "UNREAD",
     "SENT",
     "INBOX"
    ],
    "role": "reply (self-send)"
   }
  ],
  "before": [
   {
    "labelIds": [
     "UNREAD",
     "TRASH",
     "SENT"
    ],
    "role": "original (self-send)"
   }
  ],
  "joinedThread": true,
  "send": {
   "labelIds": [
    "UNREAD",
    "SENT",
    "INBOX"
   ],
   "ok": true
  }
 }
}
```

</details>

<details><summary>s26_sendFollowUp</summary>

```json
{
 "at": "2026-09-26T09:10:54.115Z",
 "labelIds": [
  "UNREAD",
  "SENT",
  "INBOX"
 ],
 "ok": true
}
```

</details>

## Conclusion

(Partial: the UI observations and spam evidence 2–4 are pending.)

- **One `threads.modify` for several label adds plus `INBOX` removal:** yes (L2).
- **Does `SPAM` remove `INBOX` by itself:** yes (S1), and history records the `INBOX` removal.
- **`TRASH` via modify:** works, same labels as `threads.trash` (T2). User labels are kept in Trash (T3) and can be added after trashing (T4). User labels are kept in Spam (S2).
- **`SENT` messages:** get `SPAM` or `TRASH` (and user labels) like the rest of the thread, but keep `SENT` (S3, T5). Whether the UI still lists them in Sent is pending.
- **Repeats:** safe. No error, no label change, and no history records (I1, H1).
- **History:** moves create only `labelsAdded` / `labelsRemoved` records, one per label change, and no `messagesAdded`, so E3 won't re-queue a thread the classifier moved.
- **Later replies (R1–R3):** a self-sent reply lands in the Inbox whether the thread was archived, moved to a label, spammed, or trashed. It doesn't inherit the thread's user label, `SPAM`, or `TRASH`, and the earlier messages stay where they were. This matches PDD §10 for archive; the Spam and Trash cases go further (weaker evidence: self-sent).
- **Import vs delivery (RI):** import doesn't stand in for delivery. With no `labelIds`, an imported reply gets no labels at all, and in a Spam thread it started a new thread.
- **Spam reporting:** (pending evidence 2–4.)

## Notes for README Permissions (#151)

(Draft; final after the pending evidence.) "The `spam` destination adds Gmail's Spam label through the Gmail API. Google says that when you report spam or move an email into Spam, it receives a copy of the email and may analyze it. It doesn't say whether a move made through the API is treated as a spam report or trains your spam filter, so assume it might. Use `spam` only for mail you would report yourself."

## Design changes

(Pending: SD §6.5 "Apply" bullets, the §13 E6 row, and the §14 Spam row; #107 updated or listed. No Proposed ADR: everything worked with `gmail.modify`.)
