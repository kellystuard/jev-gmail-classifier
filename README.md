# Jev Gmail Classifier

> [!IMPORTANT]
> This is an independent project. It is not affiliated with, endorsed by, or sponsored by [TypeSafe AI](https://typesafe.ai/), the maker of [Jev](https://docs.typesafe.ai/models), or by [Google](https://about.google/), the maker of [Gmail](https://www.google.com/gmail/about/) and [Google Apps Script](https://developers.google.com/apps-script).

A [Google Apps Script](https://developers.google.com/apps-script) project that automatically sorts your Gmail conversations by what they are about: it adds [Gmail labels](https://support.google.com/mail/answer/118708) and, if you choose, moves conversations to Archive, Spam, or Trash. Apps Script is Google's platform for running JavaScript inside your own Google account, so the classifier runs in the background with no server to host.

To decide what a conversation is about, the script asks **[Jev](https://docs.typesafe.ai/models)**, a paid classification model from [TypeSafe AI](https://typesafe.ai/). You write plain-English yes/no questions, such as *"Is this email a bill or invoice?"*. Jev answers each one with a probability, and the script applies the question's label, or makes its move, when the answer is likely enough.

> **Privacy:** The content of your email (selected headers and the plain-text body) is sent to TypeSafe AI's API for classification. Attachments are never sent, and you can keep any mail from being sent at all with an [exclusion query](#configuration). See [What is sent to Jev](#what-is-sent-to-jev).

> **Status:** Pre-release (version 0.9.0). The classifier is built and works end to end. It is in a pilot on the maintainer's own mailbox before v1.0.0, so expect changes until then. See the [Product Vision](output/product-vision.md) and [Product Design Document](output/product-design-document.md) for why and what, and the [Solution Design](output/solution-design.md) for how.

## Why

Unlabeled email is hard to find, sort, and process automatically. This project labels and routes each conversation according to its content, so that Gmail searches, saved views, and your own downstream automation have something reliable to work with. Because other automation builds on its labels, it favors precision: a missing label is better than a wrong one.

The classifier adds labels and moves conversations. It never removes labels, and it never replies to, forwards, sends, or permanently deletes mail. It isn't even given permission to permanently delete (see [Permissions](#permissions)).

| Email                          | Outcome                          |
| ------------------------------ | -------------------------------- |
| A request to approve something | Label `Approval Required`        |
| A bill                         | Label `Bill`                     |
| A bill that needs approval     | Labels `Bill`, `Approval Required` |
| Unsolicited marketing          | Moved to Spam                    |

## How It Works

Gmail groups messages into **threads** (conversations), and Gmail labels apply to whole threads. The classifier therefore works on threads too. In this README, "email" means one message and "thread" means the conversation that contains it.

### Scheduled runs

1. Apps Script cannot react when mail arrives. Instead, a [time-driven trigger](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers) runs the classifier on a timer: every 10 minutes by default, configurable in [Configuration](#configuration).
2. Each run asks Gmail what has changed since the last run (see [Keeping track of new mail](#keeping-track-of-new-mail)). Each thread that got a new email, received or sent, is queued for classification. Threads matching your exclusion query are dropped from the queue before anything is read for Jev. To classify mail from before installation, use a [manual run](#manual-runs).
3. For each thread, the script sends one request to Jev. The request contains the thread's content and every configured question (see [What is sent to Jev](#what-is-sent-to-jev)).
4. Jev returns a probability from 0 to 1 for each question: its estimate that the answer is "yes". The value comes from Jev's yes/no question type, [Noul](https://docs.typesafe.ai/primitives/noul).
5. A question's rule **fires** when its probability is at least its **threshold**, the minimum probability required (see [Configuration](#configuration)). The script then applies the outcomes (see [Labels and moves](#labels-and-moves)). A thread can receive any number of labels, including none.
6. Each run stops well before Apps Script's time limit, and before it uses too much of Gmail's per-minute quota. Whatever is still queued waits for the next run, and a thread is classified at most once per run. If Gmail reports its rate limit, the run stops its Gmail work and the next run carries on.

### Labels and moves

Each rule either adds a **label** or **moves** the thread:

| Destination   | Effect                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `archive`     | Removes the thread from the Inbox.                                      |
| `spam`        | Moves the thread to Spam.                                               |
| `trash`       | Moves the thread to Trash. Gmail deletes it permanently after 30 days.  |
| `label:<name>` | Adds the label and removes the thread from the Inbox, like Gmail's "Move to." |

- Every label rule that fires is applied. Missing labels, including nested names such as `Finance/Bill`, are created automatically. Missing parent labels are created too (`Finance` for `Finance/Bill`), so Gmail shows the label nested.
- At most one move is applied. If several move rules fire, the first one in `config.yaml` wins.
- Moves only happen for a **brand-new** thread, meaning all of its email arrived since the last check, or during a manual run with `MANUAL_APPLY_MOVES`. When a reply arrives on an existing thread, it is reclassified and only labels are added (a move rule's `label:<name>` label isn't added either, because it is part of the move). That way the classifier never undoes your own correction, such as clicking "Not spam."
- Labels are never removed.
- The classifier adds only your classification labels, plus `Jev/Error` for threads that need your attention (see [Failures](#failures)).

### What is sent to Jev

Each request sends the thread as Jev's [`state`](https://docs.typesafe.ai/concepts/state), which is Jev's term for the input being classified. It is a list of the thread's emails, newest first. For each email it includes:

- a fixed set of headers that help classification: `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, and `Auto-Submitted`. Headers an email doesn't have are left out, and a header that appears twice is sent once with both values;
- the body as plain text only. For HTML-only emails, the HTML is converted to plain text (see `plainTextMethod` in [Configuration](#configuration)).

If the thread is too long for [Jev's request limit](#jev), the oldest content is cut first. Attachments and all other headers are never sent, and neither are drafts or emails in Spam or Trash. Threads matching your exclusion query are never sent at all: if **any** email in a thread matches, the whole thread is kept back.

### Keeping track of new mail

The classifier keeps its place using Gmail's [history](https://developers.google.com/workspace/gmail/api/guides/sync), a record of changes to the mailbox. The position is stored in the script's Script Properties. Each run reads only the changes since the saved position, so a thread is classified once, and again only when it receives a new email, because the reply can change what the conversation is about. Drafts, Spam, and Trash are ignored.

No "processed" label is added to your mail. Each run's log reports how many threads were classified, excluded, retried, and marked as errors.

If the classifier stops for so long that Gmail no longer has the history it needs (typically more than a week), it falls back to a date-based search from its last successful run, and emails you an alert.

### Failures

- **Temporary errors** (rate limits, overload, network errors) are retried with exponential backoff: each wait doubles, with random jitter, up to a fixed number of attempts, as [TypeSafe recommends](https://docs.typesafe.ai/api#handling-rate-limits). If a thread still fails, it stays queued so the next run tries it again.
- **Repeated failures:** a thread that fails on 3 runs gets a `Jev/Error` label and is no longer retried automatically. A failure is a temporary error that outlasts the retries, or an unexpected response. A run cut short (by the time limit, the daily token budget, or a Jev outage) doesn't count against the thread: it just stays queued.
- **Invalid request** (HTTP `422`, or a `400` saying the request is over Jev's token limit): the thread gets `Jev/Error` immediately, because retrying the same content will not help.
- **Bad API key** (HTTP `401`, `402` or `403`): the run stops and logs the error, and no thread is marked. Once the key is fixed, the next run continues where it left off.
- **Daily token budget reached:** no more requests are sent until the next day (see [Configuration](#configuration)). Queued threads wait.
- **Missing permission:** if a permission was not granted (see [Permissions](#permissions)), the run logs which one and what it disables, emails you an alert (if it can), and carries on with what still works. For example, if a move can't be made, the labels are still applied and the log records the skipped move.

To retry a thread marked `Jev/Error`, remove that label in Gmail. The next run picks it up. A new reply on its own does not retry a thread marked `Jev/Error`, and manual runs skip such threads.

### Monitoring

- **Execution logs** are structured JSON. For each thread they list its ID, subject, sender, each question's probability (by rule `id`), and the actions taken. Each run ends with a summary of counts, tokens used, and time taken. Email bodies are never logged. To tune thresholds from the probabilities, see [Tuning](#tuning).
  - **Where:** the Apps Script **Executions** page, <https://script.google.com/home/executions>. Open an execution to see its log.
  - **Format:** each line is one JSON object with an `event` name, such as `thread.classified` or `run.end`. The lines of one execution share a `runId`.
  - **Levels:** most events are `info`. A problem the run got past is `warn`. That includes a `thread.classified` whose content was truncated, or whose move or labels were skipped. A failed run is `error` (`run.failed`).
  - **Scrubbing:** the code never logs the API key, an `Authorization` header or what was sent to Jev. As a last line of defence, the logger also scrubs every line: it replaces the API key and `Authorization` values wherever they appear, and cuts very long text. A log excerpt still holds the subjects and senders of your mail (including your own address, on mail you sent and on alert emails), thread IDs, label names, rule IDs, and the search query of a manual run (`manual.started`). An error text from Gmail or Google's mail service is logged as that service wrote it. So read an excerpt before you share it.
- **Alert emails** are sent to you when one of these happens. Each links to what to do about it, in [Troubleshooting and recovery](#troubleshooting-and-recovery):
  - [the API key is rejected or missing](#jev-api-key-missing-or-rejected);
  - [threads are newly marked `Jev/Error`](#threads-marked-jeverror). The email lists up to 50 of them as links, plus a link to the label;
  - [runs fail or don't finish 3 times in a row](#runs-are-failing-repeatedly). A run cut off by Apps Script's 6-minute limit counts;
  - [the daily token budget is reached](#daily-token-budget-reached);
  - [a permission is missing](#a-permission-is-missing);
  - [the configuration is invalid](#configuration-is-invalid);
  - [Gmail's history had expired](#gmail-history-expired-catching-up). After a long outage, the classifier catches up on the missed mail over several runs.

  What to know about them:
  - **Where they go:** to your own address, from your own account, as plain text, with the sender name `Jev Gmail Classifier`.
  - **How to find them:** every subject starts with `[Jev Gmail Classifier]`, so you can search or filter for them. Each email says what happened, what the classifier did about it, what to do, and where to look in the log.
  - **At most one email per condition per day,** in the script's [time zone](#configuration). So threads marked `Jev/Error` later the same day aren't mailed again: look at the label.
  - **When an alert can't be sent:** the `script.send_mail` permission isn't granted, Google's daily email quota is used up, or your address can't be read. The log then has `alert.failed`, the run carries on, and the next run that sees the problem tries again. Without `script.send_mail`, alerts are only in the log, so check the Executions page yourself.
  - **What it can't notice:** a trigger that no longer fires (deleted, or stopped by Apps Script). Nothing runs then, so nothing alerts.
  - **`uninstall` and `cancelManualRun` never send an alert.** You run them from the editor and see the result there.

### Manual runs

A manual run classifies existing mail, which scheduled runs skip. Apps Script editor functions can't take arguments, so you set the run's options as Script Properties (**Project Settings → Script Properties**) and then run `startManualRun` from the editor:

| Property             | Example          | Meaning                                                                                                                                                                                                                               |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANUAL_QUERY`       | `label:Receipts` | A [Gmail search query](https://support.google.com/mail/answer/7190), at most 1,000 characters.                                                                                                                                         |
| `MANUAL_TIMESPAN`    | `2h`, `7d`, `4w` | Only mail from this recent period: a whole number directly followed by `h` (hours), `d` (days) or `w` (weeks), in either case. `m` and `y` aren't accepted, so write days (`30d`, `365d`). No spaces, decimals or combinations like `1d12h`. The period is counted back from the moment the job starts and then stays fixed. It can be combined with `MANUAL_QUERY`. |
| `MANUAL_APPLY_MOVES` | `true`           | Also apply move rules. `true` or `false` in any case. The default (unset) is `false`, labels only. Any other value is refused, not guessed.                                                                                            |
| `MANUAL_REPLACE`     | `true`           | Replace a manual run that hasn't finished yet. `true` or `false` in any case. The default (unset) is `false`. Any other value is refused.                                                                                              |

At least one of `MANUAL_QUERY` or `MANUAL_TIMESPAN` is required. The search is your query as typed, `after:<time>` for a timespan alone, or `(<query>) after:<time>` for both. The log entry `manual.started` shows the exact search. Your exclusion query is not part of it, but it is always applied to every thread, as for scheduled mail, and threads marked `Jev/Error` are skipped. Every matching thread is reclassified. Use this after adding or changing questions, since scheduled runs don't revisit old threads.

**With `MANUAL_APPLY_MOVES`, move rules apply to every matching thread. A new `trash` rule can move a lot of old mail, and cancelling a job doesn't undo anything it has already done.** Run the job without `MANUAL_APPLY_MOVES` first, read the probabilities and the counts in the log, and only then run it again with `MANUAL_APPLY_MOVES` set to `true`.

Once a job starts, all four `MANUAL_*` properties are deleted, so a leftover `MANUAL_APPLY_MOVES` or `MANUAL_REPLACE` can't act on a later run. If the start is refused, they stay as they are, so you can fix one and run again. A refusal is not a failure: the execution completes, `startManualRun` returns `status: 'rejected'` with a `reason`, and the log has `manual.rejected` with the same reason. The reasons are:

- `no_input`: neither a query nor a timespan is set.
- `invalid_timespan`: the timespan doesn't follow the rules above.
- `query_too_long`, `invalid_query`: the query is over 1,000 characters, or contains control characters (a line break, for example).
- `invalid_apply_moves`, `invalid_replace`: the value isn't `true` or `false`.
- `job_unfinished`: another manual job is still running. Only one job runs at a time. Wait for it, cancel it, or set `MANUAL_REPLACE` to `true` to replace it.

A large manual run cannot finish within a single execution (see [Google Apps Script limits](#google-apps-script)). `startManualRun` itself processes the first part right away. After that, the job continues in the spare time of scheduled runs, after new mail has been handled. A scheduled run that has time left does about one chunk of manual work: 20 threads (5 at a 1-minute trigger). To go faster, run `continueManualRun` from the editor as many times as you like. Each of those runs works for up to 4.5 minutes and handles about 140 threads. An editor run does manual work only, so new mail waits for the next scheduled run. Without `install` (no trigger), only editor runs make progress.

`cancelManualRun` stops the job. It deletes the job and the manual work still queued. Labels and moves already applied stay. Replacing a job with `MANUAL_REPLACE` cancels the old one the same way.

To follow a job, read the log. Each execution that works on the job logs `manual.progress`: what this execution did and how much is still queued. When the job is done, it logs `manual.completed`: the search, how long it took, the totals (classified, excluded, skipped, marked `Jev/Error`), the number of threads per label (`labels`) and the number per move destination (`moves`: `archive`, `spam`, `trash` and `label:<name>`). A thread that gets new mail while it waits is classified by a scheduled run and counted there, not in the job. A thread that fails keeps the job open until it is classified or, after failing on 3 runs, marked `Jev/Error`, so one bad thread can add a few executions. If the log shows the job's search stuck on empty pages, end the job with `cancelManualRun`.

The search result isn't a snapshot of your mailbox. Mail that changes while the job runs can be classified twice, which is harmless: labels and moves are applied the same way again. In rare cases a matching thread can be missed, if Gmail loses its place in the results and earlier matches were deleted meanwhile. Mail in Spam and Trash is never part of a job. A thread marked `Jev/Error` is skipped: remove the label to retry it. As a caution, if a job's own moves take threads out of its search (for example `in:inbox` with an `archive` rule and `MANUAL_APPLY_MOVES`), it may skip some threads. Run the same job again until it finds nothing, or use a search that its moves don't change.

Manual work counts against `dailyTokenBudget` like scheduled work, so a large job can use up the day's budget, and new mail then waits until the next day. For a big backfill, use a narrower query or timespan.

## Features (v1)

- **Content-based sorting.** Labels and moves come from what an email says, not from sender or subject rules that you write and maintain by hand.
- **One question, one outcome.** Each configured question maps to exactly one label or one move (Archive, Spam, Trash, or Move to label).
- **Default and per-question thresholds.**
- **Static configuration** in a single YAML file, validated at build time and again when the script runs.
- **Thread-aware.** A thread is classified once, and again only when it receives a new email.
- **Clean labels.** Only your classification labels are added, plus `Jev/Error` when something needs attention.
- **Privacy control.** An exclusion query keeps matching threads from ever being sent to Jev.
- **Least privilege.** The script can't permanently delete mail.
- **Retries and error handling** as described in [Failures](#failures).
- **Monitoring** through structured execution logs and alert emails.
- **Quota-aware.** Works in bounded chunks to stay within the [Google Apps Script limits](#google-apps-script).
- **Cost-aware.** One request per thread with all questions together, only useful headers, trimmed content, no repeat classification of unchanged threads, and a daily token budget.

## Configuration

Configuration lives in `config.yaml` at the repository root. It is git-ignored, because your rules and exclusion query describe your mail. Start by copying `config.example.yaml` to `config.yaml`. Each entry under `rules` pairs one yes/no question with a label or a move:

```yaml
defaultThreshold: 0.8          # used by any rule without its own threshold
triggerIntervalMinutes: 10     # 1, 5, 10, 15, or 30 (the intervals Apps Script supports)
jevModel: jev-latest           # or a pinned version, such as jev-1.13.0
dailyTokenBudget: 20000000     # about $1.00/day at $0.042 per million tokens
excludeQuery: from:bank.example OR label:Private   # threads with any matching email are never sent to Jev
plainTextMethod: basic         # how HTML-only emails become plain text

rules:
  - id: approval
    question: Does this email ask the recipient to approve something?
    label: Approval Required
  - id: bill
    question: Is this email a bill or invoice?
    label: Finance/Bill        # use / to nest labels
    threshold: 0.9             # overrides defaultThreshold
  - id: newsletter
    question: Is this email a newsletter the recipient subscribed to?
    action: move               # default is label
    destination: label:Newsletters   # archive, spam, trash, or label:<name>
    threshold: 0.95
```

`config.example.yaml` holds the same settings plus a rule that archives. Its first line points editors at the committed `config.schema.json`, so an editor that uses the YAML language server (for example the VS Code YAML extension) offers completion and checks the shape of the file as you type. The schema can't express every rule, such as the label-name rules and unique `id`s, so `npm run build` checks the rest.

| Field                    | Required        | Description                                                        |
| ------------------------ | --------------- | ------------------------------------------------------------------ |
| `defaultThreshold`       | Yes             | Minimum probability, from 0 to 1, for any rule without its own `threshold`. |
| `triggerIntervalMinutes` | No              | How often scheduled runs happen. Defaults to `10`. 1 and 5 minutes are for light mail or accounts with more quota (such as Workspace): with a backlog they can use more than a consumer account's 90 minutes a day of trigger time. |
| `jevModel`               | No              | Jev model version. Defaults to `jev-latest`. Pin a version if you want thresholds to stay stable across model releases. |
| `dailyTokenBudget`       | No              | Maximum Jev input tokens per day, across all runs: a whole number, at least 1. Defaults to `20000000`. |
| `excludeQuery`           | No              | A Gmail search describing mail that must never be sent to Jev. If any email in a thread matches, the whole thread is skipped, including emails in Spam or Trash. Applied to every run. Each email is checked on its own: `from:lawyer.example subject:contract` needs one email that matches both, so use `OR` to exclude either. To exclude nothing, delete the line: an empty `excludeQuery:` fails the build. |
| `plainTextMethod`        | No              | How HTML-only emails are converted to text. `basic` (default) uses the email's plain-text version when it has one, otherwise a simple built-in HTML-to-text conversion. `advanced` is reserved for a future, fuller converter. |
| `rules`                  | Yes             | The list of rules. At least one.                                   |
| `rules[].id`             | Yes             | A short, unique name for the rule, such as `bill`. Used in the request to Jev and in the logs, so it should stay the same when you reword or reorder rules. It starts with a lowercase letter and uses only `a-z`, `0-9`, `-` and `_`, up to 32 characters. |
| `rules[].question`       | Yes             | The yes/no question sent to Jev.                                   |
| `rules[].action`         | No              | `label` (default) or `move`.                                       |
| `rules[].label`          | For `label`     | The label to add. Use `/` to nest, as in `Finance/Bill`. See **Label names** below. |
| `rules[].destination`    | For `move`      | `archive`, `spam`, `trash`, or `label:<name>`, with no space after the colon. The name follows the same **Label names** rules. |
| `rules[].threshold`      | No              | Per-rule override of `defaultThreshold`, from 0 to 1. Consider a high value for move rules. |

Unknown fields fail the build, so a typo such as `treshold` is caught instead of being silently ignored. Each error names the field it's about, such as `rules[2].destination`.

**Label names.** Gmail stores a label name exactly as typed but compares names loosely, so the build rejects names that would surprise you:

- Gmail's system labels can't be used: `Inbox`, `Spam`, `Trash`, `Sent`, `Drafts`, `Starred`, `Important`, `Unread` and `Chats`, in any case. They can't be the first part of a nested name either: Gmail would show `Inbox/Receipts` as a separate label, not under the Inbox. `Work/Inbox` is fine.
- `Jev` and every name under `Jev/` are reserved for the classifier's own `Jev/Error` label.
- Each part between `/` must be non-empty, with no spaces around the `/`: write `Finance/Bill`, not `Finance / Bill` or `Finance//Bill`.
- Several rules can add the same label, but they must spell it the same way. Gmail treats `Finance/Bill` and `finance/bill` as one label, so the build rejects the pair.

Apps Script cannot read YAML files, so a build step validates `config.yaml` and converts it into a script file before [deployment](#setup). An invalid config fails the build. The script checks the configuration again each time it runs, and stops with an alert if the configuration is invalid.

**Time zone.** "A day" for the token budget and for alert limits follows the script's time zone, set by `timeZone` in `appsscript.json`. It defaults to `Etc/UTC`. Change it to your own zone, such as `America/New_York`, if you prefer.

### API Key

The Jev API key lives in two places, for two jobs. The `.env` file at the repository root (git-ignored; copy `.env.example`) holds `JEV_API_KEY` for the local [probe](#development) only. The deployed script cannot read `.env`: it reads `JEV_API_KEY` from its [Script Properties](https://developers.google.com/apps-script/guides/properties), Apps Script's built-in key-value store, which you set once during [setup](#setup). The script never logs the key, and every log line is scrubbed of it.

## Permissions

When you run `install`, Google asks you to grant the script these permissions ([OAuth scopes](https://developers.google.com/apps-script/concepts/scopes)). Nothing else is requested.

| Permission (scope) | Why it's needed | If not granted |
| ------------------ | --------------- | -------------- |
| `https://www.googleapis.com/auth/gmail.modify` | Read your mail's change history and threads, search for excluded mail, create and apply labels, and move threads to Archive, Spam, or Trash. Also reads your address, to send alerts. | Nothing works. |
| `https://www.googleapis.com/auth/script.external_request` | Send thread content to the Jev API. | Nothing is classified; new mail waits in the queue. |
| `https://www.googleapis.com/auth/script.scriptapp` | Create and remove the timed trigger, and check which permissions were granted. | `install` and `uninstall` stop; runs already scheduled keep going. |
| `https://www.googleapis.com/auth/script.send_mail` | Send alert emails to you. | Alerts are only written to the log. |

**Moving to Trash needs only `gmail.modify`.** Permanent deletion would need the full-access scope `https://mail.google.com/`, which the classifier **never requests**, so it can't permanently delete mail even by mistake. The code uses Gmail's [Advanced Gmail Service](https://developers.google.com/apps-script/advanced/gmail) rather than `GmailApp` for exactly this reason: `GmailApp` requires the full-access scope.

Google may let you untick individual permissions on the consent screen. `install` asks again until you grant the first three (`gmail.modify`, `script.external_request` and `script.scriptapp`): without them the classifier can't do its job. Alert email (`script.send_mail`) is optional. The classifier also checks which permissions were granted at the start of every run. If a permission is missing, the script logs which one and what it disables, emails you (if it can), and keeps doing what it still can. To fix it, run `install` again and grant the missing permission.

## Setup

Follow these steps from top to bottom. Each one says what to do and what you should then see. They take about half an hour, most of it in Google's pages.

1. **Before you start.** You need:
   - Node 24 (the repository's `.nvmrc`; run `fnm use` or `nvm use`), npm and git. `clasp` needs no separate install: it comes with `npm ci` and you run it as `npx clasp`.
   - The Google account whose mail is to be classified.
   - A Jev API key from [TypeSafe AI](https://typesafe.ai/). Jev is a paid service: see [Limits and Cost](#limits-and-cost).

   Your mail's content is sent to TypeSafe AI to be classified: read [What is sent to Jev](#what-is-sent-to-jev) first.

2. **Get the code.**

   ```sh
   git clone https://github.com/kellystuard/jev-gmail-classifier.git
   cd jev-gmail-classifier
   npm ci
   ```

   `npm ci` ends without errors.

3. **Write your config.** Copy the example and edit it:

   ```sh
   cp config.example.yaml config.yaml
   ```

   The rules in the example are starting points, not tested recommendations. Replace them with your own questions: see [Configuration](#configuration) for every field. A cautious start is label rules only. Read the log for a while, then add move rules (see [Tuning](#tuning)).

4. **Build.**

   ```sh
   npm run build
   ```

   The build checks `config.yaml` and typechecks the code. On success it writes `dist/Code.js` and `dist/appsscript.json`. An invalid config fails the build with one line per problem, each naming the field (such as `rules[2].destination`), and writes nothing. Without a `config.yaml` the build stops and tells you to copy the example. To try the build before you write your own config, run `npm run build -- --config config.example.yaml`.

5. **Create the Apps Script project and connect `clasp`.**
   1. Turn on the Apps Script API for your account at <https://script.google.com/home/usersettings>.
   2. Run `npx clasp login`. It opens a browser: sign in with the account whose mail is to be classified.
   3. At <https://script.google.com>, create a standalone project and give it a name. Google shows that name later, on the consent screen.
   4. In the editor, open **Project Settings** and copy the **Script ID**.
   5. Copy the example and put the ID in `scriptId`. Leave `rootDir` as `dist`:

      ```sh
      cp .clasp.json.example .clasp.json
      ```

      `.clasp.json` is git-ignored.

6. **Set the time zone (optional, before the first push).** "A day" for the [daily token budget](#limits-and-cost) and for the once-a-day alert limit follows the script's time zone. It is `Etc/UTC` unless you change it. To change it, edit `timeZone` in `appsscript.json` at the repository root, for example `"timeZone": "America/New_York"`. The build copies that file into `dist/`, and each push overwrites the project's manifest, so a change made in the Apps Script editor is lost at the next push. Two side effects matter only if you also develop the classifier: `appsscript.json` is a tracked file, so `git status` shows your change, and `npm test` then fails one manifest test that expects `Etc/UTC`.

7. **Push.**

   ```sh
   npm run push
   ```

   It builds from `config.yaml` and pushes `dist/` with `clasp`. If `clasp` asks "Manifest file has been updated. Do you want to push and overwrite?", answer yes. Reload the project in the editor. [`clasp` documents that](https://github.com/google/clasp) it pushes a `.js` file as a `.gs` file, so the editor lists two files: `Code.gs` and `appsscript.json`.

8. **Add the Jev key.** In the editor, open **Project Settings → Script Properties**, add a property named `JEV_API_KEY` and paste your key as its value. The script never logs the key.

9. **Run `install`.** In the editor, choose `install` in the function list and click **Run**. Google then asks for permission:
   1. The screen says "Google hasn't verified this app". This is expected: the project is your own copy of the code and has not been through Google's app verification, and only your own code runs in it. Click **Advanced**, then **Go to** your project's name **(unsafe)**.
   2. The screen lists four permissions as checkboxes. **None of the four boxes is pre-ticked: tick all four,** then click **Allow**. [Permissions](#permissions) says what each one is for.

   `install` then saves the starting position in your mail's history and creates the time-driven trigger, which runs `onTrigger` every `triggerIntervalMinutes` minutes. Only mail that arrives after this point is classified automatically; use a [manual run](#manual-runs) for older mail. Running `install` again is always safe.

   If something is wrong, `install` says so and goes no further:
   - If a permission box was left unticked, `install` asks for the missing permissions again, or stops with an error that names the permission. See [Permissions](#permissions).
   - If the `JEV_API_KEY` property is missing, `install` stops with "JEV_API_KEY is missing: set JEV_API_KEY in Script Properties, then run install again" and writes nothing. Add the property and run `install` again. See [Troubleshooting and recovery](#troubleshooting-and-recovery).

10. **Check that it works.**
    1. Open the execution log of the `install` run. It ends with a `run.end` line that has `position` (`set` on a first install), `historyId` and `triggerMinutes`. A `missingScopes` field means a permission is missing: see [Permissions](#permissions).
    2. Open the editor's **Triggers** page. It lists one time-driven trigger for `onTrigger`.
    3. After one interval, open the **Executions** page (<https://script.google.com/home/executions>). It shows an `onTrigger` execution that completed. Its log ends with a `run.end` line; when there was nothing to do, its `stopped` is `drained`. A failed run logs `run.failed` and the execution shows as Failed.
    4. Send yourself a test mail that one of your rules should match. After about two intervals, the label is on the thread in Gmail, and the log has a `thread.classified` line with the rule's probability.

    [Monitoring](#monitoring) lists the log events and the alert emails.

### Changing the config or the interval

Edit `config.yaml` and run `npm run push`. After changing `triggerIntervalMinutes`, also run `install` again to replace the trigger. `install` keeps the saved position, so no mail is skipped or classified twice.

### Upgrading

Run `git pull`, `npm ci` and `npm run push`. Labels and stored state carry over. A release may change the permissions the script asks for: if it does, run `install` again and tick every box. If you changed `appsscript.json` (the time zone), `git pull` can conflict with an upstream change to that file: keep your `timeZone`.

### Starting from now

To start from now instead, add the Script Property `RESET_POSITION` with the value `true` and run `install`. It saves a new starting position and deletes the property. Mail that arrived since the old position isn't classified automatically (use a [manual run](#manual-runs) for it), and threads already queued stay queued. Any other value is ignored, with a warning in the log.

### Stopping and removing

To stop the classifier, run the `uninstall` function. It removes the trigger and stored state (including an unfinished manual job), and leaves all labels and your API key in place, and also any `RESET_POSITION` and `MANUAL_*` properties. Its log ends with a `run.end` line with `triggersDeleted` and `keysDeleted`. Running `uninstall` again is safe. If the `script.scriptapp` permission isn't granted, `uninstall` stops without changing anything. Mail that arrives while it is uninstalled is only classified with a [manual run](#manual-runs).

`uninstall` does not remove the permissions you granted or the Apps Script project. To remove the rest:

- **The permissions.** Open <https://myaccount.google.com/connections>, find the project by its name and delete all its connections.
- **The project.** If you no longer want it, delete the Apps Script project from <https://script.google.com>. This step has not been observed for this project: see [Google's Apps Script documentation](https://developers.google.com/apps-script) if the dashboard differs.
- **The labels.** Delete them in Gmail if you want to: the classifier never removes a label.

## Tuning

Tuning means choosing, for each rule, a threshold and a question wording that catch the right mail and nothing else. You tune from the log: it holds every probability Jev returned, and never an email body. Precision comes first, because other automation builds on the labels: a missing label is better than a wrong one. When in doubt, raise a threshold.

**Where the numbers are.** Open the Executions page, <https://script.google.com/home/executions>, open an execution, and find its `thread.classified` lines. There is one for each thread it classified. This example is made up, and it is split over several lines here; in the log it is one line:

```json
{
  "event": "thread.classified",
  "runId": "3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b",
  "entry": "onTrigger",
  "ts": "2026-01-15T09:30:04.512Z",
  "threadId": "18d0a1b2c3d4e5f6",
  "source": "scheduled",
  "subject": "Your January invoice",
  "from": "Example Billing <billing@example.test>",
  "probabilities": { "approval": 0.03, "bill": 0.97, "newsletter": 0.41, "shipping": 0.02 },
  "fired": ["bill"],
  "actions": ["label:Finance/Bill"],
  "model": "jev-1.13.0",
  "inputTokens": 1840
}
```

- `probabilities` is Jev's answer for every rule, by rule `id`, from 0 to 1.
- `fired` lists the rules whose probability was at least their threshold, in the order of `config.yaml`.
- `actions` is what the classifier did to the thread: `label:<name>` for each label added, then `move:archive`, `move:spam`, `move:trash` or `move:label:<name>` if it moved the thread.

A rule can be in `fired` and not in `actions`. That happens to a move rule when moves aren't allowed (a reply on an existing thread, or a manual run without `MANUAL_APPLY_MOVES`), and when an earlier move rule also fired: only the first one moves the thread (see [Labels and moves](#labels-and-moves)). A line with `truncated` means the thread was too long and its oldest content was cut, so the probabilities come from the newer part only.

For totals, read `run.end`, the summary line of a scheduled run: `labels` counts the threads per label in that run, and `moves` the threads per destination.

**Choosing a threshold.**

1. Collect one rule's probabilities, over a few days of mail or over a manual run (see below).
2. In Gmail, check which of those threads really are what the question asks about.
3. Put the threshold above the highest probability of a thread that was wrong.

If a rule fires on mail it shouldn't, raise its threshold. If it misses mail it should catch, lower the threshold, or reword the question. If the right and the wrong threads get about the same probabilities, no threshold separates them: reword the question.

A rule's own `threshold` overrides `defaultThreshold` (see [Configuration](#configuration)). A probability equal to the threshold fires. After a change to `config.yaml`, run `npm run push` (see [Setup](#setup)). The new value applies to mail classified from then on: scheduled runs don't revisit threads they already classified, and labels are never removed.

**Move rules need high thresholds.** A wrong label is easy to see and to remove. A wrong move hides mail from you. So start a move rule as a label rule, or at a high threshold such as the example's `0.95`, and watch `moves` in `run.end` to see how many threads it moves. `trash` and `spam` are the costly destinations: [Labels and moves](#labels-and-moves) says what each one does.

**Try a rule on old mail first.** A [manual run](#manual-runs) **without** `MANUAL_APPLY_MOVES` classifies existing mail and applies labels only. Each thread's probabilities are in its `thread.classified` line. A move rule that would have moved the thread is in `fired` and not in `actions`. `manual.completed` gives the job's totals, with `labels` and `moves`. Such a run still **adds labels**, and labels are never removed, so it is not a dry run. Start with a narrow `MANUAL_QUERY` or a short `MANUAL_TIMESPAN`. A dry-run mode is on the [Roadmap](#roadmap), not in v1.

**Try one email before deploying.** The probe sends one saved email to Jev with your key and prints each rule's probability, its threshold and whether it fires. It deploys nothing and changes no mail. See [Development](#development).

**Wording a question.** Write one yes/no question per rule. Make it specific, and ask about the content of the email. Changing a question changes its probabilities, so look at the rule's threshold again afterwards. Keep the rule's `id` when you reword its question, so the log stays comparable.

**Pinning the model.** With `jevModel: jev-latest`, the classifier follows TypeSafe's new releases, and a new release can shift the probabilities without any change on your side. The `model` field of `thread.classified` shows which version answered. To keep your thresholds stable, set `jevModel` to a version, such as `jev-1.13.0`. After you change the version, or after `model` changes under `jev-latest`, read the probabilities again and adjust the thresholds.

**The example rules** in `config.example.yaml` are starting points to tune on your own mail, not tested defaults.

## Troubleshooting and recovery

The classifier reports a problem by email, at most once per condition per day (see [Monitoring](#monitoring)). Each entry below is headed like the email's subject, after the prefix `[Jev Gmail Classifier]`, and names the log events to search for on the Executions page, <https://script.google.com/home/executions>. What the classifier does on each kind of failure is in [Failures](#failures). This section says what **you** do.

### Jev API key missing or rejected

- **What it means:** `JEV_API_KEY` is missing from Script Properties, or Jev rejected it: Jev answered HTTP `401`, `402` or `403`.
- **What the classifier did:** it stopped the run and marked no thread. Mail that was waiting is still waiting. Every run stops like this until the key is fixed, and the first run after the fix carries on from there.
- **What to do:** in the Apps Script editor, open **Project Settings → Script Properties** and set `JEV_API_KEY` to a valid key. If it is already set, check the key and your TypeSafe account.
- **Search the log for:** `run.failed`. Its `reason` is `missing_key` or `auth`.

### Threads marked `Jev/Error`

- **What it means:** Jev could not classify one or more threads. It rejected the request (invalid, or over its size limit), or the thread failed on 3 runs. The email links to up to 50 of the threads, then to the label.
- **What the classifier did:** it added `Jev/Error` to each of them and stopped retrying them. Other mail is not affected.
- **What to do:** open each thread and decide. To retry one, remove its `Jev/Error` label in Gmail: a later run classifies it again, labels only (it is not moved). A new reply alone does not retry it, and manual runs skip it. A thread that Jev rejected (`reason` is `invalid` in `thread.errored`) is sent with the same content again, so expect it to fail again: label it by hand. Threads that get `Jev/Error` later the same day are not mailed again, so look at the label in Gmail.
- **Search the log for:** `thread.errored` (its `reason`, `status` and `errorType`) and `thread.failed`.

### Runs are failing repeatedly

- **What it means:** 3 runs in a row failed or did not finish. A run that did not finish was stopped by Apps Script (for example at its 6-minute limit) or by hand.
- **What the classifier did:** each of those runs stopped early. Mail they did not get to is still waiting, and later runs try again.
- **What to do:** find the cause in the log and fix it. If you also got an alert about the API key, the configuration or a permission, fix that first: it is the likely cause. Otherwise see [A run failed, and no alert explains it](#problems-without-an-alert).
- **Search the log for:** `run.failed` (its `error`, `reason` and `errorMessage`) and `run.unfinished`. Both carry `consecutiveFailures`, the count so far, when it could be counted.

### Daily token budget reached

- **What it means:** today's token budget (`dailyTokenBudget` in `config.yaml`) is used up.
- **What the classifier did:** it stopped sending threads to Jev for today. New mail is still queued and waits. Sending starts again on the next day, in the script's [time zone](#configuration).
- **What to do:** nothing, if this is expected. To classify more mail per day, raise `dailyTokenBudget` in `config.yaml`, then run `npm run push`. A large [manual run](#manual-runs) uses the same budget.
- **Search the log for:** `budget.reached` (its `inputTokens` and `dailyTokenBudget`).

### A permission is missing

- **What it means:** a permission (OAuth scope) the classifier needs is not granted. The email lists each missing one with what it disables, or says that the check itself failed.
- **What the classifier did:** it carried on with what still works and skipped the rest. `install` and `uninstall` stop when a permission they need is missing.
- **What to do:** run `install` again from the Apps Script editor and grant every permission on the consent screen. [Permissions](#permissions) has the details: what each permission is for, and what the classifier does without it.
- **Search the log for:** `scope_missing` (its `scope`, `feature` and `disables`). A `thread.classified` line with `moveSkipped` or `labelsSkipped` is a thread whose move or labels were skipped.

### Configuration is invalid

- **What it means:** the deployed script's configuration failed validation, or Jev did not accept the model in `jevModel`.
- **What the classifier did:** it stopped the run and marked no thread. Mail that was waiting is still waiting. Every run stops like this until the configuration is fixed.
- **What to do:** fix `config.yaml` (for a rejected model, the `jevModel` value), then run `npm run push`, which builds and pushes (see [Setup](#setup)). The build runs the same validation and names each field that is wrong.
- **Search the log for:** `run.failed`. Its `issues` list what is wrong. For a rejected model its `reason` is `config_invalid`.

### Gmail history expired: catching up

- **What it means:** Gmail no longer had the change history from the classifier's last saved position (see [Keeping track of new mail](#keeping-track-of-new-mail)). This happens when the classifier has not run for about a week or more, and sometimes sooner.
- **What the classifier did:** it is catching up by search instead. It looks for mail from one hour before its last successful run until now, oldest first, over several runs. Mail that arrives meanwhile is handled after the catch-up.
- **What to do:** nothing, in most cases. Two things are not recovered. If you removed `Jev/Error` from a thread during the gap, that thread is not retried. If the log has `history.fallback_missed`, some threads were skipped because too many arrived at once. Use a [manual run](#manual-runs) for either. If you don't know why the classifier had stopped, see [Nothing seems to run](#problems-without-an-alert).
- **Search the log for:** `history.expired`, `ingest.done` (its `fallback` fields) and `history.fallback_missed`.

### Problems without an alert

**A run failed, and no alert explains it.** On the Executions page the execution shows as Failed. Open it and read its `run.failed` line: `error` is the kind of error, and `reason`, `errorMessage` or `issues` say more when they are present. One failed run needs no action: the mail it did not get to is still waiting, and later runs try again. After 3 in a row you get [Runs are failing repeatedly](#runs-are-failing-repeatedly).

If `error` is `StateError`, a value the classifier stored in Script Properties is invalid, and the `key` field names it. The classifier never resets such a value itself.

- If `key` is `state.position` (the saved position), add the Script Property `RESET_POSITION` with the value `true` and run `install` (see [Setup](#setup)). It saves a new starting position. Mail that arrived since the old position isn't classified automatically: use a [manual run](#manual-runs) for it.
- For any other key, run `uninstall`, then `install`. `uninstall` removes the trigger and all stored state, the invalid value included, and `install` saves a new starting position and creates the trigger again. Your labels and your API key stay. The cost: the queue and an unfinished manual job are gone, so mail that was still queued, or that arrives between the two steps, is classified only by a manual run.

If runs keep ending as `run.unfinished` and you didn't stop them by hand, that is a bug in the classifier: every run is meant to end well before Apps Script's limit. Please [open an issue](https://github.com/kellystuard/jev-gmail-classifier/issues), and read any log excerpt before you share it (see [Monitoring](#monitoring)).

**Nothing seems to run.** No alert can report this: when no run starts, nothing can send an email. Look at the Executions page for recent `onTrigger` executions, and at the editor's **Triggers** page for the `onTrigger` trigger. If the trigger is gone, run `install` again. It creates the trigger again and keeps the saved position, so the mail that arrived meanwhile is picked up. After a long gap, expect the [Gmail history expired](#gmail-history-expired-catching-up) alert. A `run.skipped` line with the `reason` `busy` is normal: another execution was still running. A run that finds no new mail is normal too.

**No alert emails arrive.** Each condition is mailed at most once a day, and `alert.sent` (its `condition` and `day`) shows that one went out. If an email was due and could not be sent, the log has `alert.failed` with a `reason`:

- `scope`: the `script.send_mail` permission is not granted. Alerts are then only in the log, so check the Executions page yourself, or grant the permission (see [Permissions](#permissions)).
- `quota`: Google's daily email quota is used up. The next run that sees the problem tries again.
- `no_owner`: your address could not be read. `kind` says why: `scope` (a missing permission, see [Permissions](#permissions)) or `rate_limited` (Gmail's rate limit, which passes).

**A label or a move looks wrong.** Find the thread's `thread.classified` line by its subject or its `threadId`, read the probability of the rule that fired, and adjust the rule (see [Tuning](#tuning)). Then fix the thread by hand: the classifier never removes a label and never undoes a move. It won't repeat a move you corrected: moves only happen for brand-new threads, or in a manual run with `MANUAL_APPLY_MOVES` (see [Labels and moves](#labels-and-moves)).

## Limits and Cost

### Jev

Figures below are for the Jev model version `jev-1.13.0` (the current [`jev-latest`](https://docs.typesafe.ai/models)), retrieved on 2026-10-01; the limits and the token rate were measured on 2026-09-29 ([`spikes/84-token-ratio.md`](spikes/84-token-ratio.md)). Jev measures input size in **tokens**, small chunks of text of roughly six characters of English each (fewer for URLs, and often one or more per character in other scripts). Limits and billing are both counted in tokens.

| Item                | Value                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Context per request | 32k (32,768) tokens for `state` plus the longest single question; 64k (65,536) tokens for `state` plus all questions combined |
| Rate limits         | Jev's page says 100K tokens/second and 40 requests/second on 2026-10-01, and that a request over either limit returns a 429, which the classifier retries (subject to change: the limits adjust dynamically). A burst of 20 large requests was not refused when [measured](spikes/314-jev-rate-limit.md) on 2026-10-01. |
| Price               | $0.042 per million input tokens; output is free                                                        |

Jev reads the `state` once and evaluates every question against it in parallel. That is why one limit covers the `state` plus only the *longest* question.

**Request strategy.** All questions for a thread go in one request, so the thread is read once. The API accepts one `state` per request, so each thread is its own request. Each run sends its requests concurrently with [`UrlFetchApp.fetchAll`](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app#fetchAll(Object)), Apps Script's way of making several HTTP requests at once. Savings come from sending fewer tokens: trimmed content, short questions, and no repeat classifications.

**Estimated cost.** A typical thread of about 2,000 tokens with five questions costs about **$0.00009**. That is roughly **$0.09 per 1,000 classifications**. A thread truncated to the full 32k-token limit costs about $0.0013. A thread is charged again each time a new email makes it eligible for reclassification.

**Budget.** The `dailyTokenBudget` caps spend. The default of 20 million tokens is about $1.00 a day at the price above. A run may overshoot the budget by at most one batch of requests.

### Google Apps Script

Published [quotas](https://developers.google.com/apps-script/guides/services/quotas):

| Quota                 | Consumer (gmail.com) | Google Workspace  |
| --------------------- | -------------------- | ----------------- |
| Script runtime        | 6 min / execution    | 6 min / execution |
| Total trigger runtime | 90 min / day         | 6 hr / day        |
| `UrlFetchApp` calls   | 20,000 / day         | 100,000 / day     |
| Gmail read/write      | 20,000 / day         | 50,000 / day      |
| Email recipients      | See quota page        | See quota page      |

The default 10-minute trigger fires 144 times a day. On a consumer account, that leaves an average of about 37 seconds per run within the 90-minute daily runtime budget. Only one execution runs at a time; a run that starts while another is still going exits immediately.

Each scheduled run stops starting new work after a soft limit (8 s at 1 minute, 15 s at 5 minutes, 30 s at 10, 15 or 30 minutes) and plans at most 1,000 to 3,000 Gmail quota units, so it stays under Gmail's per-minute limit. Runs you start yourself from the editor work for up to 4.5 minutes (about 140 threads of manual work). Under a constant backlog the 10, 15 and 30 minute intervals fit the consumer 90 minutes a day; 1 and 5 minutes may not. A quiet mailbox uses only a second or two per run.

## Roadmap

- [ ] v1: Label and move threads from question and threshold rules.
- [ ] Remove labels when a newer classification no longer matches.
- [ ] Dry run or evaluation harness for tuning questions.
- [ ] Periodic digest email.
- [ ] A fuller HTML-to-text converter (`plainTextMethod: advanced`).
- [ ] Automated deployment from `main` through a GitHub Action.
- [ ] Real-time processing.
- [ ] Workspace Add-on or Marketplace listing with a settings UI.

See the [Product Vision](output/product-vision.md#possible-future-directions) for context. These are possibilities, not commitments.

## Development

Use Node 24 (`.nvmrc`; `fnm use` or `nvm use`), then `npm ci`. The commands ([Engineering Standards §2](output/engineering-standards.md#2-toolchain)):

- `npm run build`: validates `config.yaml`, then writes `dist/Code.js` and `dist/appsscript.json`. Without your own `config.yaml`, run `npm run build -- --config config.example.yaml`.
- `npm run lint`: ESLint and a Prettier check. `npm run format` rewrites files with Prettier.
- `npm run typecheck`: `tsc --noEmit`.
- `npm test`: Vitest once, with coverage. `npm run test:watch` runs it in watch mode.
- `npm run push`: `build` from `config.yaml`, then `clasp push` to the project in your `.clasp.json`.
- `npm run probe -- [--config <file>] [--show-state] [--json] [--env <file>] <file.eml>...`: the local Jev probe.

**The probe** is for checking your rules' question wording, and how well an email's body converts to text, before you deploy. Save an email as an `.eml` file (in Gmail: the message's ⋮ menu, "Download message") and run, for example, `npm run probe -- --config config.example.yaml message.eml`. For each file it builds the same `state` the script would send, calls Jev once (no retries), and prints each rule's probability, its threshold and whether it fires, with the model, the request ID, the input tokens and anything truncation cut. `--show-state` also prints the `state` sent, and `--json` prints one JSON object per file. The config defaults to `config.yaml`. The key is `JEV_API_KEY`: from the environment, else the file given by `--env`, else `.env` (copy `.env.example`). The probe never prints it.

The probe **sends the email's content to Jev with your key**, and each request costs tokens. Use only mail you are happy to send.

## Documentation

- [Product Vision](output/product-vision.md): who the product is for, its principles, success measures, and non-goals.
- [Product Design Document](output/product-design-document.md): v1 scope, design, risks, release criteria, and epics.
- [Solution Design](output/solution-design.md): architecture, components, runtime flows, data, and integrations.
- [Engineering Standards](output/engineering-standards.md): tooling, code conventions, testing, git workflow, and the Definition of Done.
- [Architecture Decision Records](output/adr/README.md): the reasoning behind each significant technical decision.
- [Archive](docs/archive/): the original notes and the superseded product requirements.

### External References

- [Jev models, limits, and pricing](https://docs.typesafe.ai/models)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Gmail API: synchronizing clients (history)](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail search operators](https://support.google.com/mail/answer/7190)

## License

Licensed under the [Apache License 2.0](LICENSE).
