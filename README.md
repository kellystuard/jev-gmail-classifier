# Jev Gmail Classifier

> [!IMPORTANT]
> This is an independent project. It is not affiliated with, endorsed by, or sponsored by [TypeSafe AI](https://typesafe.ai/), the maker of [Jev](https://docs.typesafe.ai/models), or by [Google](https://about.google/), the maker of [Gmail](https://www.google.com/gmail/about/) and [Google Apps Script](https://developers.google.com/apps-script).

A [Google Apps Script](https://developers.google.com/apps-script) project that automatically sorts your Gmail conversations by what they are about: it adds [Gmail labels](https://support.google.com/mail/answer/118708) and, if you choose, moves conversations to Archive, Spam, or Trash. Apps Script is Google's platform for running JavaScript inside your own Google account, so the classifier runs in the background with no server to host.

To decide what a conversation is about, the script asks **[Jev](https://docs.typesafe.ai/models)**, a paid classification model from [TypeSafe AI](https://typesafe.ai/). You write plain-English yes/no questions, such as *"Is this email a bill or invoice?"*. Jev answers each one with a probability, and the script applies the question's label, or makes its move, when the answer is likely enough.

> **Privacy:** The content of your email (selected headers and the plain-text body) is sent to TypeSafe AI's API for classification. Attachments are never sent, and you can keep any mail from being sent at all with an [exclusion query](#configuration). See [What is sent to Jev](#what-is-sent-to-jev).

> **Status:** Design phase. No code has been written yet. This README describes the intended result. See the [Product Vision](output/product-vision.md) and [Product Design Document](output/product-design-document.md) for why and what, and the [Solution Design](output/solution-design.md) for how.

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

### Labels and moves

Each rule either adds a **label** or **moves** the thread:

| Destination   | Effect                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `archive`     | Removes the thread from the Inbox.                                      |
| `spam`        | Moves the thread to Spam.                                               |
| `trash`       | Moves the thread to Trash. Gmail deletes it permanently after 30 days.  |
| `label:<name>` | Adds the label and removes the thread from the Inbox, like Gmail's "Move to." |

- Every label rule that fires is applied. Missing labels, including nested names such as `Finance/Bill`, are created automatically.
- At most one move is applied. If several move rules fire, the first one in `config.yaml` wins.
- Moves only happen for a **brand-new** thread, meaning all of its email arrived since the last check, or during a manual run with the `applyMoves` option. When a reply arrives on an existing thread, it is reclassified and only labels are added. That way the classifier never undoes your own correction, such as clicking "Not spam."
- Labels are never removed.
- The classifier adds only your classification labels, plus `Jev/Error` for threads that need your attention (see [Failures](#failures)).

### What is sent to Jev

Each request sends the thread as Jev's [`state`](https://docs.typesafe.ai/concepts/state), which is Jev's term for the input being classified. It is a list of the thread's emails, newest first. For each email it includes:

- a fixed set of headers that help classification: `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, and `Auto-Submitted`. Headers an email doesn't have are left out;
- the body as plain text only. For HTML-only emails, the HTML is converted to plain text (see `plainTextMethod` in [Configuration](#configuration)).

If the thread is too long for [Jev's request limit](#jev), the oldest content is cut first. Attachments and all other headers are never sent. Threads matching your exclusion query are never sent at all: if **any** email in a thread matches, the whole thread is kept back.

### Keeping track of new mail

The classifier keeps its place using Gmail's [history](https://developers.google.com/workspace/gmail/api/guides/sync), a record of changes to the mailbox. The position is stored in the script's Script Properties. Each run reads only the changes since the saved position, so a thread is classified once, and again only when it receives a new email, because the reply can change what the conversation is about. Drafts, Spam, and Trash are ignored.

No "processed" label is added to your mail. Each run's log reports how many threads were classified, excluded, retried, and marked as errors.

If the classifier stops for so long that Gmail no longer has the history it needs (typically more than a week), it falls back to a date-based search from its last successful run, and emails you an alert.

### Failures

- **Temporary errors** (rate limits, overload, network errors) are retried with exponential backoff: each wait doubles, with random jitter, up to a fixed number of attempts, as [TypeSafe recommends](https://docs.typesafe.ai/api#handling-rate-limits). If a thread still fails, it stays queued so the next run tries it again.
- **Repeated failures:** a thread that fails on 3 consecutive runs gets a `Jev/Error` label and is no longer retried automatically.
- **Invalid request** (HTTP `422`): the thread gets `Jev/Error` immediately, because retrying the same content will not help.
- **Bad API key** (HTTP `401`): the run stops and logs the error, and no thread is marked. Once the key is fixed, the next run continues where it left off.
- **Daily token budget reached:** no more requests are sent until the next day (see [Configuration](#configuration)). Queued threads wait.
- **Missing permission:** if a permission was not granted (see [Permissions](#permissions)), the run logs which one and what it disables, emails you an alert, and carries on with what still works. For example, if a move can't be made, the labels are still applied and the log records the skipped move.

To retry a thread marked `Jev/Error`, remove that label in Gmail. The next run picks it up. A new reply on its own does not retry a thread marked `Jev/Error`, and manual runs skip such threads.

### Monitoring

- **Execution logs** are structured JSON. For each thread they list its ID, subject, sender, each question's probability (by rule `id`), and the actions taken. Each run ends with a summary of counts, tokens used, and time taken. Email bodies are never logged. Use the probabilities to tune thresholds.
- **Alert emails** are sent to you when:
  - the API key is rejected or missing;
  - threads are newly marked `Jev/Error`;
  - runs fail or time out repeatedly;
  - the daily token budget is reached;
  - a permission is missing;
  - the configuration is invalid;
  - Gmail's history had expired.

  Each condition sends at most one alert per day.

### Manual runs

A manual run classifies existing mail, which scheduled runs skip. Apps Script editor functions can't take arguments, so you set the run's options as Script Properties (**Project Settings → Script Properties**) and then run `startManualRun` from the editor:

| Property             | Example            | Meaning                                                                 |
| -------------------- | ------------------ | ----------------------------------------------------------------------- |
| `MANUAL_QUERY`       | `label:Receipts`   | A [Gmail search query](https://support.google.com/mail/answer/7190).    |
| `MANUAL_TIMESPAN`    | `2h`, `7d`         | Only mail from this recent period. It can be combined with `MANUAL_QUERY`. |
| `MANUAL_APPLY_MOVES` | `true`             | Also apply move rules. The default is labels only.                      |
| `MANUAL_REPLACE`     | `true`             | Replace a manual run that hasn't finished yet.                          |

At least one of `MANUAL_QUERY` or `MANUAL_TIMESPAN` is required. Your exclusion query is always applied, and threads marked `Jev/Error` are skipped. Every matching thread is reclassified. Use this after adding or changing questions, since scheduled runs don't revisit old threads.

With `MANUAL_APPLY_MOVES`, **move rules apply** to every matching thread. A new `trash` rule with `applyMoves` can move a lot of old mail. The run log reports how many threads went to each destination.

A large manual run cannot finish within a single execution (see [Google Apps Script limits](#google-apps-script)). It continues in the spare time of scheduled runs, after new mail has been handled. To go faster, run `continueManualRun` from the editor as many times as you like. `cancelManualRun` stops it.

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
excludeQuery: from:mybank.com OR label:Private   # threads with any matching email are never sent to Jev
plainTextMethod: basic         # how HTML-only emails become plain text

rules:
  - id: approval
    question: Does this email ask the recipient to approve something?
    label: Approval Required
  - id: bill
    question: Is this email a bill or invoice?
    label: Bill
    threshold: 0.9             # overrides defaultThreshold
  - id: marketing
    question: Is this email unsolicited marketing?
    action: move               # default is label
    destination: spam          # archive, spam, trash, or label:<name>
    threshold: 0.95
```

| Field                    | Required        | Description                                                        |
| ------------------------ | --------------- | ------------------------------------------------------------------ |
| `defaultThreshold`       | Yes             | Minimum probability for any rule without its own `threshold`.      |
| `triggerIntervalMinutes` | No              | How often scheduled runs happen. Defaults to `10`. Accounts with more quota (such as Workspace) can run more often. |
| `jevModel`               | No              | Jev model version. Defaults to `jev-latest`. Pin a version if you want thresholds to stay stable across model releases. |
| `dailyTokenBudget`       | No              | Maximum Jev input tokens per day, across all runs. Defaults to `20000000`. |
| `excludeQuery`           | No              | A Gmail search describing mail that must never be sent to Jev. If any email in a thread matches, the whole thread is skipped, including emails in Spam or Trash. Applied to every run. Each email is checked on its own: `from:lawyer.example subject:contract` needs one email that matches both, so use `OR` to exclude either. |
| `plainTextMethod`        | No              | How HTML-only emails are converted to text. `basic` (default) uses the email's plain-text version when it has one, otherwise a simple built-in HTML-to-text conversion. `advanced` is reserved for a future, fuller converter. |
| `rules[].id`             | Yes             | A short, unique name for the rule, such as `bill`. Used in the request to Jev and in the logs, so it should stay the same when you reword or reorder rules. |
| `rules[].question`       | Yes             | The yes/no question sent to Jev.                                   |
| `rules[].action`         | No              | `label` (default) or `move`.                                       |
| `rules[].label`          | For `label`     | The label to add.                                                  |
| `rules[].destination`    | For `move`      | `archive`, `spam`, `trash`, or `label:<name>`.                     |
| `rules[].threshold`      | No              | Per-rule override of `defaultThreshold`. Consider a high value for move rules. |

Apps Script cannot read YAML files, so a build step validates `config.yaml` and converts it into a script file before [deployment](#setup-planned). An invalid config fails the build. The script checks the configuration again each time it runs, and stops with an alert if the configuration is invalid.

**Time zone.** "A day" for the token budget and for alert limits follows the script's time zone, set by `timeZone` in `appsscript.json`. It defaults to `Etc/UTC`. Change it to your own zone, such as `America/New_York`, if you prefer.

### API Key

The Jev API key is kept in a `.env` file at the repository root. The file is git-ignored:

```dotenv
JEV_API_KEY=your-key-here
```

A deployed Apps Script cannot read `.env`. You copy the key into the script's [Script Properties](https://developers.google.com/apps-script/guides/properties), Apps Script's built-in key-value store, once during [setup](#setup-planned).

## Permissions

When you run `install`, Google asks you to grant the script these permissions ([OAuth scopes](https://developers.google.com/apps-script/concepts/scopes)). Nothing else is requested.

| Permission (scope) | Why it's needed | If not granted |
| ------------------ | --------------- | -------------- |
| `https://www.googleapis.com/auth/gmail.modify` | Read your mail's change history and threads, search for excluded mail, create and apply labels, and move threads to Archive, Spam, or Trash. Also reads your address, to send alerts. | Nothing works. |
| `https://www.googleapis.com/auth/script.external_request` | Send thread content to the Jev API. | Nothing is classified. |
| `https://www.googleapis.com/auth/script.scriptapp` | Create and remove the timed trigger, and check which permissions were granted. | `install` and `uninstall` fail. |
| `https://www.googleapis.com/auth/script.send_mail` | Send alert emails to you. | Alerts are only written to the log. |

**Moving to Trash needs only `gmail.modify`.** Permanent deletion would need the full-access scope `https://mail.google.com/`, which the classifier **never requests**, so it can't permanently delete mail even by mistake. The code uses Gmail's [Advanced Gmail Service](https://developers.google.com/apps-script/advanced/gmail) rather than `GmailApp` for exactly this reason: `GmailApp` requires the full-access scope.

Google may let you untick individual permissions on the consent screen. If a permission is missing, the script logs which one and what it disables, emails you (if it can), and keeps doing what it still can. To fix it, run `install` again and grant the missing permission.

## Setup (planned)

1. Copy `config.example.yaml` to `config.yaml` and write your rules.
2. Build: `npm run build` validates `config.yaml` and converts it into a script file.
3. Create an Apps Script project, copy `.clasp.json.example` to `.clasp.json` with your script ID, and push the code with [clasp](https://developers.google.com/apps-script/guides/clasp), Google's command-line tool for Apps Script projects.
4. In the Apps Script editor, go to **Project Settings → Script Properties** and add `JEV_API_KEY` with the value from `.env`.
5. In the editor, run the `install` function once. It asks for the [permissions](#permissions) above, saves its starting position in your mail's history, and creates the time-driven trigger. Only mail that arrives after this point is classified automatically.

After changing `triggerIntervalMinutes`, build, push, and run `install` again to replace the trigger. Running `install` again keeps the saved position, so no mail is skipped or classified twice. To upgrade, pull, build, and push; labels and stored state carry over.

To stop the classifier, run the `uninstall` function. It removes the trigger and stored state, and leaves all labels and your API key in place. Mail that arrives while it is uninstalled is only classified with a [manual run](#manual-runs).

## Limits and Cost

### Jev

Figures below are for the Jev model version `jev-1.13.0` (the current [`jev-latest`](https://docs.typesafe.ai/models)), retrieved on 2026-09-24. Jev measures input size in **tokens**, small chunks of text of roughly four characters of English each. Limits and billing are both counted in tokens.

| Item                | Value                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Context per request | 32k tokens for `state` plus the longest single question; 64k tokens for `state` plus all questions combined |
| Rate limits         | 1,200 requests/minute and 250,000 tokens/second (subject to change)                                     |
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
