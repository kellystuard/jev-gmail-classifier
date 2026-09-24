# Jev Gmail Classifier: Product Requirements

> Sources: [initial-ramblings.txt](initial-ramblings.txt) and follow-up decisions made on 2026-09-24. Notes in parentheses `( )` mark inconsistencies, ambiguities, or open questions found while refining the original notes. External facts are cited in [§8](#8-references).

## 1. Overview

Jev Gmail Classifier automatically applies Gmail labels to incoming email based on what the email is about. It runs in the background as a Google Apps Script project. The script sends each new email to **Jev**, an external classification service ([§4](#4-jev-classification-service)), and uses Jev's answers to decide which labels to apply.

## 2. Problem and Goals

### 2.1 Problem

Incoming email arrives unlabeled. That makes it hard to build automatic filtering and processing on top of the inbox.

### 2.2 Goals

- Apply labels to incoming email that match its content.
- Allow more than one label on the same email when more than one category applies.
- Run in the background with no user interaction.
- Stay within Google Apps Script quotas and limits ([§6.1](#61-google-apps-script-limits)).
- Keep Jev classification costs low by batching requests ([§6.2](#62-jev-limits-and-cost)).

### 2.3 Example Scenarios

| Email content                   | Labels applied               |
| ------------------------------- | ---------------------------- |
| A request to approve something  | `Approval Required`          |
| A bill                          | `Bill`                       |
| A bill that also needs approval | `Bill`, `Approval Required`  |

(Label names are examples only. The final names come from the configuration file described in [§5](#5-configuration).)

## 3. Scope

### 3.1 Initial Version (v1)

- **Labels only.** The only thing v1 does to an email is add labels.
- **One question to one label.** Each configured question maps to exactly one label.
- **Threshold-based.** A label is applied when Jev's score for its question meets or exceeds the minimum threshold for that question: the question's own threshold if it has one, otherwise the default threshold.
- **Static configuration.** Questions, labels, and thresholds are defined in a static configuration file.

### 3.2 Future Considerations

- Take **actions** on emails (beyond labeling) based on Jev's responses.
- (Implied, not stated: more complex question-to-label mappings, such as several questions feeding one label, would lift the v1 one-to-one rule.)

## 4. Jev Classification Service

Jev is a new, external classification API. It is a decision model: it returns typed answers, not generated text.

### 4.1 Interface

- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`, authenticated with `Authorization: Bearer <API key>` [[1]](#ref-api).
- **Input:** one `state` (the email) and a map of named `questions`, all in the same request [[1]](#ref-api).
- **Output:** one answer per question, plus `usage` token counts [[1]](#ref-api).

### 4.2 Question Type

Each rule is sent as a **Noul** question: a yes/no statement for which Jev returns `noul`, the probability (0 to 1) that the answer is yes [[2]](#ref-noul). This value is the "confidence score" compared against the threshold.

(The original notes say Jev "returns a confidence score for the answer." Jev's `choice` and `score` question types return a separate `confidence` field, but Jev's documentation warns that this field measures how concentrated the answer is, not the probability that the answer is correct [[2]](#ref-noul). For yes/no rules, the Noul probability is the right value to compare against a threshold.)

### 4.3 Email Content Sent

- **Headers:** only a fixed set of headers that help classification (see below).
- **Body:** plain text only. The plain-text part is used when the email has one; otherwise the HTML body is converted to plain text.
- **Excluded:** attachments, and all headers not in the set below.
- **Truncation:** content is truncated to fit Jev's per-request limit ([§6.2](#62-jev-limits-and-cost)).

| Header             | Why it helps classification                                   |
| ------------------ | ------------------------------------------------------------- |
| `From`, `Sender`   | Who sent it (for example, a billing system or a manager).     |
| `Reply-To`         | Where replies go; often reveals the real system behind a no-reply sender. |
| `To`, `Cc`         | Whether the email is addressed directly or copied.            |
| `Subject`          | The strongest short summary of the content.                   |
| `Date`             | Context for due dates and deadlines.                          |
| `List-Id`, `List-Unsubscribe`, `Precedence` | Mark mailing-list and bulk or marketing email. |
| `Auto-Submitted`   | Marks automated notifications.                                |

Routing and signature headers, such as `Received`, `DKIM-Signature`, and `ARC-*`, are never sent. They can add thousands of tokens per email and do not help classification, and Jev charges per input token.

## 5. Configuration

v1 uses a static YAML file, `config.yaml`, at the root of the application:

```yaml
defaultThreshold: 0.8
triggerIntervalMinutes: 10

rules:
  - question: Does this email ask the recipient to approve something?
    label: Approval Required
  - question: Is this email a bill or invoice?
    label: Bill
    threshold: 0.9
```

| Field                    | Required | Description                                                          |
| ------------------------ | -------- | -------------------------------------------------------------------- |
| `defaultThreshold`       | Yes      | The minimum score used by any rule that has no threshold of its own. |
| `triggerIntervalMinutes` | No       | How often the background trigger runs. Defaults to `10` ([§6.1](#61-google-apps-script-limits)). |
| `rules[].question`       | Yes      | The yes/no question sent to Jev.                                     |
| `rules[].label`          | Yes      | The Gmail label to apply when the score meets the threshold.         |
| `rules[].threshold`      | No       | A per-rule override of `defaultThreshold`.                           |

(Apps Script projects can only contain script, HTML, and `appsscript.json` files, and Apps Script has no built-in YAML parser. `config.yaml` is therefore the source of truth in the repository, and a build step must convert it into a script file before the project is pushed to Apps Script.)

### 5.1 Secrets

For local development, the Jev API key is stored in the `.env` file at the root of the repository, which is git-ignored. A deployed Apps Script cannot read `.env`, so the key must be copied into the script's **Script Properties** during deployment.

## 6. Operational Requirements

Classification runs in the background. Apps Script has no trigger that fires when a Gmail message arrives, so a **time-driven trigger** polls for unprocessed messages. Near-real-time push would need Gmail push notifications through Google Cloud Pub/Sub, which is out of scope for v1.

### 6.1 Google Apps Script Limits

Published quotas [[3]](#ref-gas):

| Quota                         | Consumer (gmail.com) | Google Workspace |
| ----------------------------- | -------------------- | ---------------- |
| Script runtime                | 6 min / execution    | 6 min / execution |
| Total trigger runtime         | 90 min / day         | 6 hr / day       |
| `UrlFetchApp` calls           | 20,000 / day         | 100,000 / day    |
| Gmail read/write operations   | 20,000 / day         | 50,000 / day     |
| Triggers                      | 20 / user / script   | 20 / user / script |
| Script Properties value size  | 9 KB / value         | 9 KB / value     |

Implications for the design:

- **Bounded runs.** Each run processes a limited chunk of messages and stops well before the 6-minute limit. Anything left over is picked up on the next run.
- **Trigger interval.** The interval is configurable (`triggerIntervalMinutes`) and starts at **10 minutes**. At that rate the trigger fires 144 times a day, so on a consumer account runs must average under about 37 seconds to stay within the 90-minute daily budget. For comparison, a 5-minute interval leaves about 18 seconds per run, and a 1-minute interval leaves under 4. (Apps Script minute-based triggers only accept 1, 5, 10, 15, or 30 minutes, so the setting must be one of those values.)
- **Gmail operations.** Each email costs several Gmail operations (read, one per label added, and marking it processed). On a consumer account this limits throughput to a few thousand emails a day, well above typical personal volume.
- **Idempotency.** Processed messages are marked (for example, with a `Jev/Processed` label) so that they are never classified twice, and the search for new work skips them.

### 6.2 Jev Limits and Cost

Published limits and pricing (Jev 1.13):

| Item                    | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Context per request     | 64k tokens in total; 32k tokens for `state` plus the longest question [[4]](#ref-models) |
| Rate limits             | 250,000 tokens/second and 1,200 requests/minute; adjusted dynamically [[4]](#ref-models) |
| Input price             | $0.042 per million input tokens [[4]](#ref-models)                                     |
| Output price            | Free [[4]](#ref-models)                                                                |
| Retryable errors        | `429` (rate limited) and `529` (overloaded) [[1]](#ref-api)                            |

Batching strategy:

1. **All questions for one email go in one request.** Jev reads the `state` once and evaluates every question against it in parallel, so adding questions adds little latency and avoids re-sending the email for each question [[5]](#ref-fanout).
2. **One email per request.** The API accepts one `state` per request [[1]](#ref-api). Packing several emails into one state would not save money, because the price is per input token, and it would blur which answer belongs to which email.
3. **Parallel requests within a run.** A run sends its chunk of per-email requests concurrently (`UrlFetchApp.fetchAll`), staying far below 1,200 requests per minute.
4. **Keep input small.** Cost is driven entirely by input tokens, so the main savings come from truncating email bodies, limiting headers ([§4.3](#43-email-content-sent)), keeping questions short, and never classifying an email twice.

Truncation budget: `state` plus the longest question must fit in 32k tokens. The email is truncated to that budget, minus the longest question and a safety margin, using a conservative characters-per-token estimate.

Cost estimate (illustrative):

| Scenario                              | Tokens per email | Cost per email | 1,000 emails/day |
| ------------------------------------- | ---------------- | -------------- | ---------------- |
| Typical: ~2k-token email, 5 questions | ~2,250           | ~$0.00009      | ~$0.09/day (~$2.85/month) |
| Worst case: truncated to the limit    | ~32,000          | ~$0.0013       | ~$1.34/day       |

### 6.3 Retries

Failed Jev requests are retried with standard exponential backoff, as TypeSafe recommends [[1]](#ref-api):

- **Retried:** `429` (rate limited), `529` (overloaded), other `5xx` responses, and network errors.
- **Not retried:** `401` (bad API key) and `422` (invalid request). These are logged and need a fix, not a retry.
- **Delay:** the wait doubles after each failed attempt, with random jitter, up to a maximum number of attempts.
- **Runtime-aware:** waiting counts against the 6-minute execution limit and the daily trigger budget. If retries would run past the time left in the current run, the script stops and leaves the email unprocessed, so the next run picks it up.

## 7. Open Questions

None at this time. All earlier open questions were resolved on 2026-09-24.

## 8. References

1. <a id="ref-api"></a>TypeSafe AI, *API reference*. <https://docs.typesafe.ai/api.md>
2. <a id="ref-noul"></a>TypeSafe AI, *Noul* and *Confidence*. <https://docs.typesafe.ai/primitives/noul.md>, <https://docs.typesafe.ai/confidence.md>
3. <a id="ref-gas"></a>Google, *Quotas for Google Services* (Apps Script). <https://developers.google.com/apps-script/guides/services/quotas>
4. <a id="ref-models"></a>TypeSafe AI, *Models* (limits, rate limits, pricing). <https://docs.typesafe.ai/models>
5. <a id="ref-fanout"></a>TypeSafe AI, *Speculative fan-out*. <https://docs.typesafe.ai/patterns/fan-out.md>

Limits and prices were retrieved on 2026-09-24 and may change.
