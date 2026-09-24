# Jev Gmail Classifier

A [Google Apps Script](https://developers.google.com/apps-script) project that automatically adds [Gmail labels](https://support.google.com/mail/answer/118708) to your conversations based on what they are about. Apps Script is Google's platform for running JavaScript inside your own Google account, so the classifier runs in the background with no server to host.

To decide what a conversation is about, the script asks **[Jev](https://docs.typesafe.ai/models)**, a paid classification model from [TypeSafe AI](https://typesafe.ai/). You write plain-English yes/no questions, such as *"Is this email a bill or invoice?"*. Jev answers each one with a probability, and the script applies a label for every question whose answer is likely enough.

> **Privacy:** The content of your email (selected headers and the plain-text body) is sent to TypeSafe AI's API for classification. Attachments are never sent. See [What is sent to Jev](#what-is-sent-to-jev).

> **Status:** Design phase. No code has been written yet. This README describes the intended result. See the [product requirements](docs/refined-ramblings.md) for more detail.

## Why

Unlabeled email is hard to find, sort, and process automatically. This project labels each conversation according to its content, so that Gmail searches, saved views, and your own downstream automation have something reliable to work with.

The classifier only *adds* labels. It never reacts to labels itself. Acting on emails is on the [roadmap](#roadmap).

| Email                          | Labels applied              |
| ------------------------------ | --------------------------- |
| A request to approve something | `Approval Required`         |
| A bill                         | `Bill`                      |
| A bill that needs approval     | `Bill`, `Approval Required` |

## How It Works

Gmail groups messages into **threads** (conversations), and Gmail labels in Apps Script are applied to whole threads ([`GmailThread`](https://developers.google.com/apps-script/reference/gmail/gmail-thread)). The classifier therefore works on threads too. In this README, "email" means one message and "thread" means the conversation that contains it.

### Scheduled runs

1. Apps Script cannot react when mail arrives. Instead, a [time-driven trigger](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers) runs the classifier on a timer: every 10 minutes by default, configurable in [Configuration](#configuration).
2. Each run searches Gmail for threads that need classification (see [Avoiding reprocessing](#avoiding-reprocessing)). Scheduled runs only look at threads with mail received since the classifier was [installed](#setup-planned). To classify older mail, use a [manual run](#manual-runs).
3. For each thread, the script sends one request to Jev. The request contains the thread's content and every configured question (see [What is sent to Jev](#what-is-sent-to-jev)).
4. Jev returns a probability from 0 to 1 for each question: its estimate that the answer is "yes". The value comes from Jev's yes/no question type, [Noul](https://docs.typesafe.ai/primitives/noul).
5. The script adds a question's label to the thread when that question's probability is at least its **threshold**, the minimum probability required to apply the label (see [Configuration](#configuration)). Labels are only ever added, never removed. A thread can receive any number of labels, including none.
6. The thread is marked as processed.

### What is sent to Jev

Each request sends the thread as Jev's [`state`](https://docs.typesafe.ai/concepts/state), which is Jev's term for the input being classified. For each email in the thread, `state` includes:

- a fixed set of headers that help classification: `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, and `Auto-Submitted`;
- the body as plain text only (HTML-only emails are converted to plain text).

Emails are ordered newest first. If the thread is too long for [Jev's request limit](#jev), the oldest content is cut first. Attachments and all other headers are never sent.

### Avoiding reprocessing

After classifying a thread, the script adds a `Jev/Processed` label to it and excludes processed threads from the normal work search:

    -label:Jev/Processed -label:Jev/Error after:<install date>

Gmail search matches labels at the thread level (a thread matches if any message in it has the label), so an already-processed thread will not match this query again even if it later receives a new message. If “reclassify on new replies” is required, the fallback is to persist each thread’s last-seen message ID (or timestamp) and compare it during polling.

### Failures

- **Temporary errors** (rate limits, overload, server and network errors) are retried with exponential backoff: each wait doubles, up to a fixed number of attempts, as [TypeSafe recommends](https://docs.typesafe.ai/api#handling-rate-limits). If a thread still fails, it is left unprocessed so the next run tries it again.
- **Repeated failures:** a thread that fails on 3 consecutive runs gets a `Jev/Error` label and is no longer retried automatically.
- **Invalid request** (HTTP `422`): the thread gets `Jev/Error` immediately, because retrying the same content will not help.
- **Bad API key** (HTTP `401`): the run stops and logs the error, and no thread is marked. Once the key is fixed, the next run continues normally.

To retry a thread marked `Jev/Error`, remove that label in Gmail.

### Manual runs

A manual run classifies existing mail, which scheduled runs skip. You start it from the Apps Script editor and give it a [Gmail search query](https://support.google.com/mail/answer/7190), for example `newer_than:1y`. It also takes an option to reprocess threads already marked `Jev/Processed`. Use that option after adding or changing questions, since scheduled runs do not revisit old threads.

A large manual run cannot finish within a single execution (see [Google Apps Script limits](#google-apps-script)). It works through matching threads in chunks and continues across executions until it is done.

## Features (v1)

- **Content-based labeling.** Labels come from what an email says, not from sender or subject rules that you write and maintain by hand.
- **One question, one label.** Each configured question maps to exactly one Gmail label. Missing labels are created automatically. Nested names such as `Finance/Bill` are allowed.
- **Default and per-question thresholds.**
- **Static configuration** in a single YAML file.
- **Thread-aware.** A thread is classified once, and again only when it receives a new email.
- **Retries and error handling** as described in [Failures](#failures).
- **Quota-aware.** Works in bounded chunks to stay within the [Google Apps Script limits](#google-apps-script).
- **Cost-aware.** One request per thread with all questions together, only useful headers, trimmed content, and no repeat classification of unchanged threads.

## Configuration

Configuration lives in `config.yaml` at the repository root. Each entry under `rules` pairs one yes/no question with the label to apply:

```yaml
defaultThreshold: 0.8        # used by any rule without its own threshold
triggerIntervalMinutes: 10   # 1, 5, 10, 15, or 30 (the intervals Apps Script supports)

rules:
  - question: Does this email ask the recipient to approve something?
    label: Approval Required
  - question: Is this email a bill or invoice?
    label: Bill
    threshold: 0.9           # overrides defaultThreshold
```

Apps Script cannot read YAML files, so a build step converts `config.yaml` into a script file before [deployment](#setup-planned).

### API Key

The Jev API key is kept in a `.env` file at the repository root. The file is git-ignored:

```dotenv
JEV_API_KEY=your-key-here
```

A deployed Apps Script cannot read `.env`. You copy the key into the script's [Script Properties](https://developers.google.com/apps-script/guides/properties), Apps Script's built-in key-value store, once during [setup](#setup-planned).

## Setup (planned)

1. Build: convert `config.yaml` into a script file.
2. Push the code to Apps Script with [clasp](https://developers.google.com/apps-script/guides/clasp), Google's command-line tool for Apps Script projects.
3. In the Apps Script editor, go to **Project Settings → Script Properties** and add `JEV_API_KEY` with the value from `.env`.
4. In the editor, run the `install` function once. It asks for Gmail and external-request permissions, records the install date, and creates the time-driven trigger.

After changing `triggerIntervalMinutes`, build, push, and run `install` again to replace the trigger.

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

- [ ] v1: Apply labels from question and threshold rules.
- [ ] Take actions on emails (beyond labeling) based on Jev's responses.

## Documentation

- [Product requirements](docs/refined-ramblings.md): scope, configuration, limits, retries, and cost model.
- [Original notes](docs/initial-ramblings.txt): the lightly edited source notes.

### External References

- [Jev models, limits, and pricing](https://docs.typesafe.ai/models)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Gmail search operators](https://support.google.com/mail/answer/7190)

## License

Licensed under the [Apache License 2.0](LICENSE).
