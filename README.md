# Jev Gmail Classifier

A Google Apps Script project that automatically labels incoming Gmail messages by content, using the **Jev** classification API.

> **Status:** Design phase. No code has been written yet. This README describes the intended result. See [docs/refined-ramblings.md](docs/refined-ramblings.md) for the full requirements.

## Why

Unlabeled email is hard to filter and process automatically. This project gives each new email labels that reflect what the email is about, so Gmail filters and later automation have something reliable to act on.

| Email                          | Labels applied               |
| ------------------------------ | ---------------------------- |
| A request to approve something | `Approval Required`          |
| A bill                         | `Bill`                       |
| A bill that needs approval     | `Bill`, `Approval Required`  |

## How It Works

1. A time-driven Apps Script trigger (every 10 minutes by default) finds new, unprocessed emails.
2. For each email, the script sends one request to Jev containing the email and every configured yes/no question (for example, *"Is this email a bill or invoice?"*). The email is sent as:
   - a fixed set of headers that help classification: `From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, and `Auto-Submitted`;
   - the body as plain text only (HTML-only emails are converted to plain text), truncated to fit Jev's request limit.

   Attachments are never sent.
3. Jev returns a probability from 0 to 1 for each question.
4. For each question whose probability meets its threshold, the script applies the matching Gmail label, then marks the email as processed.

An email can receive any number of labels, including none.

## Features (v1)

- **Content-based labeling.** Labels come from what the email says, not from sender or subject rules.
- **One question, one label.** Each configured question maps to exactly one Gmail label.
- **Default and per-question thresholds.** Each question uses the default threshold unless it sets its own.
- **Static configuration.** Questions, labels, thresholds, and the trigger interval live in a single YAML file.
- **Retries with backoff.** Rate-limit, overload, and server errors from Jev are retried with exponential backoff. Emails that still fail are picked up on the next run.
- **Quota-aware.** Works in bounded chunks so that it stays within Apps Script runtime, `UrlFetchApp`, and Gmail quotas.
- **Cost-aware.** Sends one request per email with all questions together, sends only useful headers, trims the body, and never classifies the same email twice.

## Configuration

Configuration lives in `config.yaml` at the root of the application:

```yaml
defaultThreshold: 0.8        # used by any rule without its own threshold
triggerIntervalMinutes: 10   # 1, 5, 10, 15, or 30

rules:
  - question: Does this email ask the recipient to approve something?
    label: Approval Required
  - question: Is this email a bill or invoice?
    label: Bill
    threshold: 0.9           # overrides defaultThreshold
```

Apps Script cannot read YAML files directly, so a build step converts `config.yaml` into a script file before deployment.

### API Key

Keep the Jev API key in a `.env` file at the repository root. The file is git-ignored:

```dotenv
JEV_API_KEY=your-key-here
```

Apps Script cannot read `.env` at runtime, so the key is supplied to the deployed script through **Script Properties**.

## Limits and Cost

### Jev

Jev is published by TypeSafe AI. Figures below are for version 1.13, retrieved on 2026-09-24:

| Item                | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Context per request | 32k tokens for the email plus the longest question (64k in total) |
| Rate limits         | 1,200 requests/minute and 250,000 tokens/second (subject to change) |
| Price               | $0.042 per million input tokens; output is free                    |

**Batching approach.** Jev reads the email once and answers every question in parallel, so all questions for an email go in one request. The API accepts one email (`state`) per request. Merging emails would not save money anyway, because billing is per input token. Instead, each run sends its per-email requests concurrently with `UrlFetchApp.fetchAll`, and savings come from sending fewer tokens: truncated bodies, short questions, and no repeat classifications.

**Estimated cost.** A typical email of about 2,000 tokens with five questions costs about **$0.00009**, which works out to roughly **$0.09 per 1,000 emails**. An email truncated to the full 32k-token limit costs about $0.0013.

### Google Apps Script

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

- [Refined requirements](docs/refined-ramblings.md): product requirements, scope, configuration, limits, retries, and cost model.
- [Original notes](docs/initial-ramblings.txt): the lightly edited source notes.

### External References

- [TypeSafe API reference](https://docs.typesafe.ai/api.md)
- [TypeSafe models, limits, and pricing](https://docs.typesafe.ai/models)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)

## License

Licensed under the [Apache License 2.0](LICENSE).
