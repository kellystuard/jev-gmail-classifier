# 25: Nested label creation and label ID lookup

- Task: #25
- Date run: (YYYY-MM-DD, filled in after the run)
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs`), plus the maintainer's Gmail web UI observations
- Test thread: one synthetic message, created with `Gmail.Users.Messages.import` (placeholder From `s25-sender@example.test`, `neverMarkSpam: true`, labels `INBOX`, `UNREAD`)

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

(Filled in from the runs and the maintainer's observations.)

| # | Input | Result (ok / HTTP status) | Returned `id` | Returned `name` | Visibility fields | `e.name` and `e.message` | Gmail web UI observation |
|---|-------|---------------------------|---------------|-----------------|-------------------|--------------------------|--------------------------|
| 1 | create `S25none/B/C` | | | | | | |
| 2 | list; create `S25none/B`, `S25none` | | | | | | |
| 3 | create `S25some`, `S25some/B/C` | | | | | | |
| 4 | create `S25all`, `S25all/B`, `S25all/B/C` | | | | | | |
| 5 | create `S25all/B/C` again | | | | | | |
| 6 | create `s25all/b/c`, `S25ALL` | | | | | | |
| 7 | create `Inbox`, `INBOX`, `inbox`, `Spam`, `Trash`, `Sent`, `Drafts`, `Starred`, `Important`, `Unread`, `Chats`, `Social` | | | | | | |
| 8 | create `Inbox/S25x`, `Spam/S25x` | | | | | | |
| 9 | create `S25odd/`, `/S25odd`, `S25odd//X`, `S25odd / X`, `S25odd/ X` | | | | | | |
| 10 | create `S25vis` (name only), `S25vis2` (`labelShow`, `show`) | | | | | | |
| 11 | `labels.list` shape | | | | | | |
| 12 | create `S25apply/X/Y` and apply by ID in one execution; apply `S25none/B/C` by ID | | | | | | |
| 13 | apply by name `S25none/B/C` | | | | | | |
| 14 | apply unknown ID `Label_999999999` | | | | | | |

## Raw output

<details><summary>s25_setup</summary>

</details>

<details><summary>s25_runLabelCases</summary>

</details>

<details><summary>s25_applyCases</summary>

</details>

<details><summary>s25_cleanup and s25_listSpikeLabels</summary>

</details>

## Conclusion

(Filled in from the results.)

- Are parents auto-created?
- Are names case-insensitive?
- What a duplicate, a reserved name, a name in place of an ID, and an unknown ID return:
- What visibility E6 should set on create:
- Create-then-apply in one execution:

## Design changes

(Filled in: SD §6.5 "Labels" bullet confirmed or corrected; #106 updated or listed; config-schema findings listed for #41.)
