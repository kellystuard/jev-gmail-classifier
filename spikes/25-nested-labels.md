# 25: Nested label creation and label ID lookup

- Task: #25
- Date run: 2026-09-26 (UI observations and cleanup: pending)
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs`), plus the maintainer's Gmail web UI observations
- Test thread: synthetic messages (3, grouped by subject; see the notes under Results), created with `Gmail.Users.Messages.import` (placeholder From `s25-sender@example.test`, `neverMarkSpam: true`, labels `INBOX`, `UNREAD`)

## Question

E6 builds a per-run name→ID cache from `labels.list` and creates missing labels, including nested names like `Finance/Bill` (SD §6.5, #106). This spike answers:

1. Does `labels.create` for `A/B/C` auto-create the parents `A` and `A/B`, or must E6 create them first?
2. Are label names case-insensitive?
3. What exactly does a duplicate, a reserved (system) name, a label name in place of an ID, and an unknown ID return?
4. What visibility does a label created with only `name` get, and what should E6 set?
5. Can a label be created and applied by ID in the same execution?

## Functions

| Function | What it does |
|----------|--------------|
| `s25_setup()` | Imports the test thread and stores its ID in `s25.threadId`. |
| `s25_runLabelCases()` | Cases 1–11. Each group lists the S25 labels before and after, and reports labels that appeared without a create call (`appearedWithoutCreate`), which is how auto-created parents show up. |
| `s25_applyCases(threadId?)` | Cases 12–14 on the test thread (defaults to `s25.threadId`). Records the thread's per-message `labelIds` after each case. |
| `s25_listSpikeLabels()` | Every label whose name contains `S25` (any case), plus any label ID this spike created (tracked in `s25.created`, so reserved-name cases like `Unread` are found too). |
| `s25_cleanup()` | Deletes those labels, deepest names first, with `Gmail.Users.Labels.remove`. Leaves the imported thread. |

Every call is wrapped in `try/catch`. A failure records `e.name`, `e.message` verbatim, and `e.details`. A success records `id`, `name`, `type`, `labelListVisibility`, and `messageListVisibility` (`(absent)` when Gmail omits the field).

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s25_setup`
3. `node spikes/run.mjs run s25_runLabelCases`
4. `node spikes/run.mjs run s25_applyCases` (uses the stored thread ID; or pass `'["<threadId>"]'`)
5. Ask the maintainer for the UI observations (below), in one PR comment. Hold cleanup until they're done.
6. `node spikes/run.mjs run s25_cleanup`, then `node spikes/run.mjs run s25_listSpikeLabels` to confirm no S25 labels remain.

The workflow path works the same way: `gh workflow run spikes.yml --ref e1/25-nested-labels -f function=s25_setup`, and so on.

## Maintainer steps

Asked for in one PR comment after runbook steps 1–4, not before (there is nothing to look at until the labels exist):

1. Open Gmail on the web and reload the page (the label list is cached).
2. For each label in the results table, write down how the left-hand label list shows it: nested under its parent or flat, and whether any parent labels appear that the script never created. Pay particular attention to `S25none/B/C` (case 1), the odd forms in case 9 (`S25odd/`, `/S25odd`, `S25odd//X`, `S25odd / X`, `S25odd/ X`), and `S25vis` (case 10: is it shown at all?).
3. Open the thread "S25 nested label test thread" and note which labels it shows.

## Results

Run 2026-09-26 through `node spikes/run.mjs`. Every failure is a `GoogleJsonResponseException` whose `e.message` is `API call to gmail.users.<method> failed with error: <text>`; the table gives `<text>`, and `e.details` holds `{code, message, errors: [{domain: "global", reason, message}]}`. Labels created through the API had `labelListVisibility: labelShow` and `messageListVisibility: show` in every case. `labels.create` doesn't return `type` (`labels.list` gives `user`). The UI column is pending the maintainer's observations.

| # | Input | Result (ok / HTTP status) | Returned `id` | Returned `name` | Visibility fields | `e.name` and `e.message` | Gmail web UI observation |
|---|-------|---------------------------|---------------|-----------------|-------------------|--------------------------|--------------------------|
| 1 | create `S25none/B/C` | ok | `Label_8` | `S25none/B/C` | `labelShow` / `show` | — | (pending) |
| 2 | list; then create `S25none/B`, `S25none` | list: neither parent exists; both creates ok | `Label_9`, `Label_10` | `S25none/B`, `S25none` | `labelShow` / `show` | — (**no parents were auto-created**, so creating them later succeeds) | (pending) |
| 3 | create `S25some`, then `S25some/B/C` | ok, ok | `Label_11`, `Label_12` | as input | `labelShow` / `show` | — (`S25some/B` was not created) | (pending) |
| 4 | create `S25all`, `S25all/B`, `S25all/B/C` | ok ×3 | `Label_13`–`Label_15` | as input | `labelShow` / `show` | — | (pending) |
| 5 | create `S25all/B/C` again | **409** | — | — | — | `GoogleJsonResponseException`: `Label name exists or conflicts` (`reason: aborted`) | — |
| 6 | create `s25all/b/c`, `S25ALL` | **409**, **409** | — | — | — | `Label name exists or conflicts` (`reason: aborted`) for both: **names are case-insensitive** | — |
| 7 | create `Inbox`, `INBOX`, `inbox`, `Spam`, `Trash`, `Sent`, `Drafts`, `Starred`, `Important`, `Unread`, `Chats`, `Social` | **400** for all but `Social`; `Social` ok | `Social`: `Label_16` | `Social` | `labelShow` / `show` | `Invalid label name` (`reason: invalidArgument`) for `Inbox`, `INBOX`, `inbox`, `Spam`, `Trash`, `Sent`, `Drafts`, `Starred`, `Important`, `Unread`, `Chats` | (pending: does `Social` clash with the category?) |
| 8 | create `Inbox/S25x`, `Spam/S25x` | ok, ok | `Label_17`, `Label_18` | as input | `labelShow` / `show` | — (a reserved name is allowed as a **parent** segment) | (pending) |
| 9 | create `S25odd/`, `/S25odd`, `S25odd//X`, `S25odd / X`, `S25odd/ X` | ok ×4, then **409** | `Label_19`–`Label_22` | stored **exactly as given** (no trimming or collapsing) | `labelShow` / `show` | `S25odd/ X`: `Label name exists or conflicts`: it conflicts with `S25odd / X`, so Gmail compares names ignoring spaces around `/` | (pending) |
| 10 | create `S25vis` (name only), `S25vis2` (`labelShow`, `show`) | ok, ok | `Label_23`, `Label_24` | as input | **both** `labelShow` / `show`: the defaults already show the label | — | (pending: is `S25vis` shown?) |
| 11 | `labels.list` shape | ok | user IDs all `Label_<n>`; system IDs are names (`INBOX`, `SPAM`, `CATEGORY_SOCIAL`, …) | full path with slashes, for example `S25none/B/C` | `labelShow` / `show`, `type: user` | response keys: `labels` only; **no `nextPageToken`** (38 labels in the account) | — |
| 12 | create `S25apply/X/Y` (no parents) and apply it by ID in the same execution; apply `S25none/B/C` by ID | ok, ok, ok | `Label_25` | `S25apply/X/Y` | `labelShow` / `show` | — (every message in the thread got `Label_25` and `Label_8`) | (pending: does the UI invent `S25apply` parents?) |
| 13 | `threads.modify` `addLabelIds: ['S25none/B/C']` (a name) | **400** | — | — | — | `Invalid label: S25none/B/C` (`reason: invalidArgument`); the thread is unchanged | — |
| 14 | `threads.modify` `addLabelIds: ['Label_999999999']` | **400** | — | — | — | `labelId not found` (`reason: invalidArgument`); the thread is unchanged | — |

Notes:

- **Test thread.** `Messages.import` returns only `{id}` (no `threadId` or `labelIds`), which broke the first two `s25_setup` attempts. The spike now reads the message back with `Messages.get` (`format: minimal`). The two earlier attempts had already imported a message each, and Gmail grouped all three imports into one thread, because they share a subject. So the test thread has 3 messages, all labelled `UNREAD`, `INBOX`, and cases 12–14 apply to all 3.
- **Case 7:** `Social` is not reserved, though `CATEGORY_SOCIAL` exists. `Chats` is reserved.

## Raw output

Results from `node spikes/run.mjs`, reduced to the fields that matter. Error details keep `code` and `reason`.

<details><summary>s25_setup</summary>

```json
{
 "import": {
  "importResponseKeys": [
   "id"
  ],
  "labelIds": [
   "UNREAD",
   "INBOX"
  ],
  "method": "import (media blob)",
  "ok": true
 }
}
```

</details>

<details><summary>s25_runLabelCases</summary>

```json
[
 {
  "appearedWithoutCreate": [],
  "case": 1,
  "listAfter": [
   "S25none/B/C"
  ],
  "steps": [
   {
    "input": "create {\"name\":\"S25none/B/C\"}",
    "label": {
     "id": "Label_8",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25none/B/C"
    },
    "ok": true
   }
  ],
  "title": "No parents exist"
 },
 {
  "appearedWithoutCreate": [],
  "case": 2,
  "listAfter": [
   "S25none",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "input": "labels.list: look for S25none and S25none/B",
    "result": {
     "S25none": false,
     "S25none/B": false
    }
   },
   {
    "input": "create {\"name\":\"S25none/B\"}",
    "label": {
     "id": "Label_9",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25none/B"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25none\"}",
    "label": {
     "id": "Label_10",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25none"
    },
    "ok": true
   }
  ],
  "title": "Were parents auto-created?"
 },
 {
  "appearedWithoutCreate": [],
  "case": 3,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "input": "create {\"name\":\"S25some\"}",
    "label": {
     "id": "Label_11",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25some"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25some/B/C\"}",
    "label": {
     "id": "Label_12",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25some/B/C"
    },
    "ok": true
   }
  ],
  "title": "Only the top parent exists"
 },
 {
  "appearedWithoutCreate": [],
  "case": 4,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "input": "create {\"name\":\"S25all\"}",
    "label": {
     "id": "Label_13",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25all"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25all/B\"}",
    "label": {
     "id": "Label_14",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25all/B"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25all/B/C\"}",
    "label": {
     "id": "Label_15",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25all/B/C"
    },
    "ok": true
   }
  ],
  "title": "All parents exist"
 },
 {
  "appearedWithoutCreate": [],
  "case": 5,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "code": 409,
    "input": "create {\"name\":\"S25all/B/C\"}",
    "message": "API call to gmail.users.labels.create failed with error: Label name exists or conflicts",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "aborted"
   }
  ],
  "title": "Exact duplicate"
 },
 {
  "appearedWithoutCreate": [],
  "case": 6,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "code": 409,
    "input": "create {\"name\":\"s25all/b/c\"}",
    "message": "API call to gmail.users.labels.create failed with error: Label name exists or conflicts",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "aborted"
   },
   {
    "code": 409,
    "input": "create {\"name\":\"S25ALL\"}",
    "message": "API call to gmail.users.labels.create failed with error: Label name exists or conflicts",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "aborted"
   }
  ],
  "title": "Case variant"
 },
 {
  "appearedWithoutCreate": [],
  "case": 7,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "Social",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "code": 400,
    "input": "create {\"name\":\"Inbox\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"INBOX\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"inbox\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Spam\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Trash\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Sent\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Drafts\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Starred\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Important\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Unread\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "code": 400,
    "input": "create {\"name\":\"Chats\"}",
    "message": "API call to gmail.users.labels.create failed with error: Invalid label name",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "invalidArgument"
   },
   {
    "input": "create {\"name\":\"Social\"}",
    "label": {
     "id": "Label_16",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "Social"
    },
    "ok": true
   }
  ],
  "title": "System-name clash"
 },
 {
  "appearedWithoutCreate": [],
  "case": 8,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "Social",
   "Inbox/S25x",
   "Spam/S25x",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "input": "create {\"name\":\"Inbox/S25x\"}",
    "label": {
     "id": "Label_17",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "Inbox/S25x"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"Spam/S25x\"}",
    "label": {
     "id": "Label_18",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "Spam/S25x"
    },
    "ok": true
   }
  ],
  "title": "Nested under a system name"
 },
 {
  "appearedWithoutCreate": [],
  "case": 9,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "Social",
   "Inbox/S25x",
   "Spam/S25x",
   "S25odd/",
   "/S25odd",
   "S25odd//X",
   "S25odd / X",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "input": "create {\"name\":\"S25odd/\"}",
    "label": {
     "id": "Label_19",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25odd/"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"/S25odd\"}",
    "label": {
     "id": "Label_20",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "/S25odd"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25odd//X\"}",
    "label": {
     "id": "Label_21",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25odd//X"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25odd / X\"}",
    "label": {
     "id": "Label_22",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25odd / X"
    },
    "ok": true
   },
   {
    "code": 409,
    "input": "create {\"name\":\"S25odd/ X\"}",
    "message": "API call to gmail.users.labels.create failed with error: Label name exists or conflicts",
    "name": "GoogleJsonResponseException",
    "ok": false,
    "reason": "aborted"
   }
  ],
  "title": "Odd forms"
 },
 {
  "appearedWithoutCreate": [],
  "case": 10,
  "listAfter": [
   "S25none",
   "S25some",
   "S25some/B/C",
   "S25all",
   "S25all/B",
   "S25all/B/C",
   "Social",
   "Inbox/S25x",
   "Spam/S25x",
   "S25odd/",
   "/S25odd",
   "S25odd//X",
   "S25odd / X",
   "S25vis",
   "S25vis2",
   "S25none/B/C",
   "S25none/B"
  ],
  "steps": [
   {
    "input": "create {\"name\":\"S25vis\"}",
    "label": {
     "id": "Label_23",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25vis"
    },
    "ok": true
   },
   {
    "input": "create {\"name\":\"S25vis2\",\"labelListVisibility\":\"labelShow\",\"messageListVisibility\":\"show\"}",
    "label": {
     "id": "Label_24",
     "labelListVisibility": "labelShow",
     "messageListVisibility": "show",
     "name": "S25vis2"
    },
    "ok": true
   }
  ],
  "title": "Default visibility"
 },
 {
  "case": 11,
  "hasNextPageToken": false,
  "responseKeys": [
   "labels"
  ],
  "spikeLabels": [
   "Label_10 S25none type=user labelShow/show",
   "Label_11 S25some type=user labelShow/show",
   "Label_12 S25some/B/C type=user labelShow/show",
   "Label_13 S25all type=user labelShow/show",
   "Label_14 S25all/B type=user labelShow/show",
   "Label_15 S25all/B/C type=user labelShow/show",
   "Label_17 Inbox/S25x type=user labelShow/show",
   "Label_18 Spam/S25x type=user labelShow/show",
   "Label_19 S25odd/ type=user labelShow/show",
   "Label_20 /S25odd type=user labelShow/show",
   "Label_21 S25odd//X type=user labelShow/show",
   "Label_22 S25odd / X type=user labelShow/show",
   "Label_23 S25vis type=user labelShow/show",
   "Label_24 S25vis2 type=user labelShow/show",
   "Label_8 S25none/B/C type=user labelShow/show",
   "Label_9 S25none/B type=user labelShow/show"
  ],
  "systemIds": [
   "CHAT",
   "SENT",
   "INBOX",
   "IMPORTANT",
   "TRASH",
   "DRAFT",
   "SPAM",
   "CATEGORY_FORUMS",
   "CATEGORY_UPDATES",
   "CATEGORY_PERSONAL",
   "CATEGORY_PROMOTIONS",
   "CATEGORY_SOCIAL",
   "STARRED",
   "UNREAD"
  ],
  "totalLabels": 38,
  "userIdsAllMatchLabel_N": true
 }
]
```

</details>

<details><summary>s25_applyCases</summary>

```json
{
 "cases": [
  {
   "case": 12,
   "steps": [
    {
     "input": "create {\"name\":\"S25apply/X/Y\"}",
     "label": {
      "id": "Label_25",
      "labelListVisibility": "labelShow",
      "messageListVisibility": "show",
      "name": "S25apply/X/Y"
     },
     "ok": true
    },
    {
     "input": "threads.modify addLabelIds [\"Label_25\"] (new label S25apply/X/Y by ID)",
     "ok": true
    },
    {
     "input": "threads.modify addLabelIds [\"Label_8\"] (existing S25none/B/C by ID (Label_8))",
     "ok": true
    }
   ],
   "threadAfter": [
    {
     "id": "1a0dcc0143f370e9",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    },
    {
     "id": "1a0dcc06232cb5e7",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    },
    {
     "id": "1a0dcc0ecf29b0b8",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    }
   ],
   "title": "Apply by ID"
  },
  {
   "case": 13,
   "steps": [
    {
     "code": 400,
     "input": "threads.modify addLabelIds [\"S25none/B/C\"] (name S25none/B/C)",
     "message": "API call to gmail.users.threads.modify failed with error: Invalid label: S25none/B/C",
     "ok": false
    }
   ],
   "threadAfter": [
    {
     "id": "1a0dcc0143f370e9",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    },
    {
     "id": "1a0dcc06232cb5e7",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    },
    {
     "id": "1a0dcc0ecf29b0b8",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    }
   ],
   "title": "Apply by name"
  },
  {
   "case": 14,
   "steps": [
    {
     "code": 400,
     "input": "threads.modify addLabelIds [\"Label_999999999\"] (unknown ID Label_999999999)",
     "message": "API call to gmail.users.threads.modify failed with error: labelId not found",
     "ok": false
    }
   ],
   "threadAfter": [
    {
     "id": "1a0dcc0143f370e9",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    },
    {
     "id": "1a0dcc06232cb5e7",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    },
    {
     "id": "1a0dcc0ecf29b0b8",
     "labelIds": [
      "UNREAD",
      "Label_8",
      "Label_25",
      "INBOX"
     ]
    }
   ],
   "title": "Apply unknown ID"
  }
 ],
 "labelNames": {
  "Label_10": "S25none",
  "Label_11": "S25some",
  "Label_12": "S25some/B/C",
  "Label_13": "S25all",
  "Label_14": "S25all/B",
  "Label_15": "S25all/B/C",
  "Label_17": "Inbox/S25x",
  "Label_18": "Spam/S25x",
  "Label_19": "S25odd/",
  "Label_20": "/S25odd",
  "Label_21": "S25odd//X",
  "Label_22": "S25odd / X",
  "Label_23": "S25vis",
  "Label_24": "S25vis2",
  "Label_25": "S25apply/X/Y",
  "Label_8": "S25none/B/C",
  "Label_9": "S25none/B"
 },
 "threadBefore": [
  {
   "id": "1a0dcc0143f370e9",
   "labelIds": [
    "UNREAD",
    "INBOX"
   ]
  },
  {
   "id": "1a0dcc06232cb5e7",
   "labelIds": [
    "UNREAD",
    "INBOX"
   ]
  },
  {
   "id": "1a0dcc0ecf29b0b8",
   "labelIds": [
    "UNREAD",
    "INBOX"
   ]
  }
 ]
}
```

</details>

## Conclusion

(Final after the maintainer's UI observations and cleanup.)

- **Are parents auto-created?** No. `labels.create` for `A/B/C` succeeds without `A` or `A/B` and creates only `A/B/C` (cases 1, 3, 12). Creating a parent later succeeds (case 2). Whether the web UI still nests the label under a parent it shows is pending.
- **Are names case-insensitive?** Yes. `s25all/b/c` and `S25ALL` conflict with the existing labels (409). Gmail also ignores spaces around `/` when it compares names (case 9).
- **What each failure returns:**
  - duplicate or case variant: 409 `Label name exists or conflicts` (`reason: aborted`)
  - reserved name: 400 `Invalid label name` (`reason: invalidArgument`) for `Inbox` (any case), `Spam`, `Trash`, `Sent`, `Drafts`, `Starred`, `Important`, `Unread`, `Chats`; `Social` and reserved names used as a parent segment (`Inbox/S25x`) are allowed
  - a name in place of an ID: 400 `Invalid label: <name>`
  - unknown ID: 400 `labelId not found`
- **Visibility on create:** a name-only create already gets `labelShow` / `show`. E6 can pass both explicitly anyway, so the result doesn't depend on a default.
- **Create-then-apply in one execution:** works (case 12).

**For E6 (#106):** create missing labels by name, and look names up case-insensitively, with spaces around `/` ignored. Treat a 409 on create as "exists": refresh the cache from `labels.list` and look it up again once. Whether E6 must also create parents depends on the pending UI observations (for the web UI's nesting only; the API doesn't need them). **For #41 (config schema):** reject label names that are reserved (`Inbox`, `Spam`, `Trash`, `Sent`, `Drafts`, `Starred`, `Important`, `Unread`, `Chats`, any case), and reject two rules whose labels differ only in case or in spaces around `/`.

## Design changes

(Pending: SD §6.5 "Labels" bullet; #106 and #41.)
