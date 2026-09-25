# Jev Gmail Classifier

> [!IMPORTANT]
> This is an independent project. It is not affiliated with, endorsed by, or sponsored by [TypeSafe AI](https://typesafe.ai/), the maker of [Jev](https://docs.typesafe.ai/models), or by [Google](https://about.google/), the maker of [Gmail](https://www.google.com/gmail/about/) and [Google Apps Script](https://developers.google.com/apps-script).

A [Google Apps Script](https://developers.google.com/apps-script) project that automatically sorts your Gmail conversations by what they are about: it adds [Gmail labels](https://support.google.com/mail/answer/118708) and, if you choose, moves conversations to Archive, Spam, or Trash. Apps Script is Google's platform for running JavaScript inside your own Google account, so the classifier runs in the background with no server to host.

To decide what a conversation is about, the script asks **[Jev](https://docs.typesafe.ai/models)**, a paid classification model from [TypeSafe AI](https://typesafe.ai/). You write plain-English yes/no questions, such as *"Is this email a bill or invoice?"*. Jev answers each one with a probability, and the script applies the question's label, or makes its move, when the answer is likely enough.

> **Privacy:** The content of your email (selected headers and the plain-text body) is sent to TypeSafe AI's API for classification. Attachments are never sent, and you can keep any mail from being sent at all with an [exclusion query](#configuration). See [What is sent to Jev](#what-is-sent-to-jev).

> **Status:** Design phase. No code has been written yet. This README describes the intended result. See the [Product Vision](output/product-vision.md) and [Product Design Document](output/product-design-document.md) for why and what.

## Why

Unlabeled email is hard to find, sort, and process automatically. This project labels and routes each conversation according to its content, so that Gmail searches, saved views, and your own downstream automation have something reliable to work with. Because other automation builds on its labels, it favors precision: a missing label is better than a wrong one.

The classifier adds labels and moves conversations. In v1 it never removes your labels, and it never replies to, forwards, sends, or permanently deletes mail.

| Email                          | Outcome                          |
| ------------------------------ | -------------------------------- |
| A request to approve something | Label `Approval Required`        |
| A bill                         | Label `Bill`                     |
| A bill that needs approval     | Labels `Bill`, `Approval Required` |
| Unsolicited marketing          | Moved to Spam                    |

## How It Works

Gmail groups messages into **threads** (conversations), and Gmail labels in Apps Script are applied to whole threads ([`GmailThread`](https://developers.google.com/apps-script/reference/gmail/gmail-thread)). The classifier therefore works on threads too. In this README, "email" means one message and "thread" means the conversation that contains it.

### Scheduled runs

1. Apps Script cannot react when mail arrives. Instead, a [time-driven trigger](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers) runs the classifier on a timer: every 10 minutes by default, configurable in [Configuration](#configuration).
2. Each run searches Gmail for threads that need classification (see [Avoiding reprocessing](#avoiding-reprocessing)). Scheduled runs only look at threads with mail received since the classifier was [installed](#setup-planned), and skip anything matching your exclusion query. To classify older mail, use a [manual run](#manual-runs).
3. For each thread, the script sends one request to Jev. The request contains the thread's content and every configured question (see [What is sent to Jev](#what-is-sent-to-jev)).
4. Jev returns a probability from 0 to 1 for each question: its estimate that the answer is "yes". The value comes from Jev's yes/no question type, [Noul](https://docs.typesafe.ai/primitives/noul).
5. A question's rule **fires** when its probability is at least its **threshold**, the minimum probability required (see [Configuration](#configuration)). The script then applies the outcomes (see [Labels and moves](#labels-and-moves)). A thread can receive any number of labels, including none.
6. The thread is marked as processed.

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
- Moves only happen the **first** time a thread is classified (or during a manual run with the reprocess option). When a reply makes a processed thread eligible again, only labels are added. That way the classifier never undoes your own correction, such as clicking "Not spam."
- Labels are never removed.

### What is sent to Jev

Each request sends the thread as Jev's [`state`](https://docs.typesafe.ai/concepts/state), which is Jev's term for the input being classified. For each email in the thread, `state` includes:

- a fixed set of headers that help classification: `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, and `Auto-Submitted`;
- the body as plain text only (HTML-only emails are converted to plain text).

Emails are ordered newest first. If the thread is too long for [Jev's request limit](#jev), the oldest content is cut first. Attachments and all other headers are never sent. Mail matching your exclusion query is never sent at all.

### Avoiding reprocessing

After classifying a thread, the script adds a `Jev/Processed` label to it and excludes processed threads from the normal work search:

```text
-label:Jev/Processed -label:Jev/Error after:<install date> <exclusion query>
```

This search finds new threads, and also processed threads that have received a new email since they were classified. A thread with no new email never matches, so it is never sent to Jev again. When a thread gets a new email, the whole thread is reclassified, because the reply can change what the conversation is about. Gmail search skips Spam and Trash, so threads there are never reclassified.

(This relies on Gmail matching `-label:` per email rather than per thread. It should be confirmed with a quick test before building on it.)

### Failures

- **Temporary errors** (rate limits, overload, server and network errors) are retried with exponential backoff: each wait doubles, with random jitter, up to a fixed number of attempts, as [TypeSafe recommends](https://docs.typesafe.ai/api#handling-rate-limits). If a thread still fails, it is left unprocessed so the next run tries it again.
- **Repeated failures:** a thread that fails on 3 consecutive runs gets a `Jev/Error` label and is no longer retried automatically.
- **Invalid request** (HTTP `422`): the thread gets `Jev/Error` immediately, because retrying the same content will not help.
- **Bad API key** (HTTP `401`): the run stops and logs the error, and no thread is marked. Once the key is fixed, the next run continues normally.
- **Daily token budget reached:** no more requests are sent until the next day (see [Configuration](#configuration)).

To retry a thread marked `Jev/Error`, remove that label in Gmail.

### Monitoring

- **Execution logs** list, for each thread, its ID, subject, sender, each question's probability, and the actions taken. Email bodies are never logged. Use the probabilities to tune thresholds.
- **Alert emails** are sent to you when the API key is rejected, threads are newly marked `Jev/Error`, runs fail or time out repeatedly, or the daily token budget is reached. Each condition sends at most one alert per day.

### Manual runs

A manual run classifies existing mail, which scheduled runs skip. You start it from the Apps Script editor and give it a [Gmail search query](https://support.google.com/mail/answer/7190), for example `newer_than:1y`. Your exclusion query is always added to it. It also takes an option to reprocess threads already marked `Jev/Processed`. Use that option after adding or changing questions, since scheduled runs do not revisit old threads.

Reprocessing counts as a first classification, so **move rules apply**. A new `trash` rule with reprocess can move a lot of old mail; the run log reports how many threads went to each destination.

A large manual run cannot finish within a single execution (see [Google Apps Script limits](#google-apps-script)). It works through matching threads in chunks and continues across executions until it is done.

## Features (v1)

- **Content-based sorting.** Labels and moves come from what an email says, not from sender or subject rules that you write and maintain by hand.
- **One question, one outcome.** Each configured question maps to exactly one label or one move (Archive, Spam, Trash, or Move to label).
- **Default and per-question thresholds.**
- **Static configuration** in a single YAML file, validated at build time.
- **Thread-aware.** A thread is classified once, and again only when it receives a new email.
- **Privacy control.** An exclusion query keeps matching mail from ever being sent to Jev.
- **Retries and error handling** as described in [Failures](#failures).
- **Monitoring** through execution logs and alert emails.
- **Quota-aware.** Works in bounded chunks to stay within the [Google Apps Script limits](#google-apps-script).
- **Cost-aware.** One request per thread with all questions together, only useful headers, trimmed content, no repeat classification of unchanged threads, and a daily token budget.

## Configuration

Configuration lives in `config.yaml` at the repository root. Each entry under `rules` pairs one yes/no question with a label or a move:

```yaml
defaultThreshold: 0.8          # used by any rule without its own threshold
triggerIntervalMinutes: 10     # 1, 5, 10, 15, or 30 (the intervals Apps Script supports)
jevModel: jev-latest           # or a pinned version, such as jev-1.13.0
dailyTokenBudget: 20000000     # about $1.00/day at $0.042 per million tokens
excludeQuery: -from:mybank.com -label:Private   # mail matching this is never sent to Jev

rules:
  - question: Does this email ask the recipient to approve something?
    label: Approval Required
  - question: Is this email a bill or invoice?
    label: Bill
    threshold: 0.9             # overrides defaultThreshold
  - question: Is this email unsolicited marketing?
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
| `excludeQuery`           | No              | Gmail search terms for mail that must never be sent to Jev. Applied to every run. |
| `rules[].question`       | Yes             | The yes/no question sent to Jev.                                   |
| `rules[].action`         | No              | `label` (default) or `move`.                                       |
| `rules[].label`          | For `label`     | The label to add.                                                  |
| `rules[].destination`    | For `move`      | `archive`, `spam`, `trash`, or `label:<name>`.                     |
| `rules[].threshold`      | No              | Per-rule override of `defaultThreshold`. Consider a high value for move rules. |

Apps Script cannot read YAML files, so a build step validates `config.yaml` and converts it into a script file before [deployment](#setup-planned). An invalid config fails the build.

### API Key

The Jev API key is kept in a `.env` file at the repository root. The file is git-ignored:

```dotenv
JEV_API_KEY=your-key-here
```

A deployed Apps Script cannot read `.env`. You copy the key into the script's [Script Properties](https://developers.google.com/apps-script/guides/properties), Apps Script's built-in key-value store, once during [setup](#setup-planned).

## Setup (planned)

1. Build: validate `config.yaml` and convert it into a script file.
2. Push the code to Apps Script with [clasp](https://developers.google.com/apps-script/guides/clasp), Google's command-line tool for Apps Script projects.
3. In the Apps Script editor, go to **Project Settings → Script Properties** and add `JEV_API_KEY` with the value from `.env`.
4. In the editor, run the `install` function once. It asks for Gmail, email-sending, and external-request permissions, records the install date, and creates the time-driven trigger.

After changing `triggerIntervalMinutes`, build, push, and run `install` again to replace the trigger. To upgrade, pull, build, and push; labels and stored state carry over.

To stop the classifier, run the `uninstall` function. It removes the trigger and stored state, and leaves all labels in place.

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

The default 10-minute trigger fires 144 times a day. On a consumer account, that leaves an average of about 37 seconds per run within the 90-minute daily runtime budget.

## Roadmap

- [ ] v1: Label and move threads from question and threshold rules.
- [ ] Remove labels when a newer classification no longer matches.
- [ ] Dry run or evaluation harness for tuning questions.
- [ ] Periodic digest email.
- [ ] Automated deployment from `main` through a GitHub Action.
- [ ] Real-time processing.
- [ ] Workspace Add-on or Marketplace listing with a settings UI.

See the [Product Vision](output/product-vision.md#possible-future-directions) for context. These are possibilities, not commitments.

## Documentation

- [Product Vision](output/product-vision.md): who the product is for, its principles, success measures, and non-goals.
- [Product Design Document](output/product-design-document.md): v1 scope, design, risks, release criteria, and epics.
- [Archive](docs/archive/): the original notes and the superseded product requirements.

### External References

- [Jev models, limits, and pricing](https://docs.typesafe.ai/models)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Gmail search operators](https://support.google.com/mail/answer/7190)

## License

Licensed under the [Apache License 2.0](LICENSE).
