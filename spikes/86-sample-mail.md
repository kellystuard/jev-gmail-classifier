# 86: Real HTML-only mail for the `basic` conversion check

- Task: #86 (story #85, epic #11)
- Date run: 2026-09-30
- Account: `<test-account>` (consumer), read-only
- Run by: agent, with `spikes/86-sample-mail.mjs` (Node, not Apps Script) and `npm run probe`
- Cost: 3 probe runs over the samples, about 48,000 Jev input tokens (well under a cent)

## Question

Is `basic` (SD §8.3, ADR-0011) good enough on real HTML-only mail for classification? The bar (#86 step 5, accepted by the maintainer): **zero** conversion-caused false positives, conversion-caused false negatives in at most 1 sample in 10, and every conversion defect fixed or filed.

## Runbook

1. `node spikes/86-sample-mail.mjs --env <main checkout>/.env --out <dir outside the repo> [--query <q>] [--max <n>]`. It gets its token from `session` in `spikes/run.mjs` (so `accountGuard` refuses any account but `GMAIL_EMAIL`) and calls only `users.messages.list` and `users.messages.get` (`format: full`, then `format: raw` for the candidates it keeps). It keeps a message when it has a `text/html` part and no `text/plain` part outside excluded parts (epic #10 decision 6: a part with a `filename`, a `body.attachmentId`, or a `message/rfc822` type is excluded with its subtree). It writes each candidate's `.eml` and a local index to `--out`, and prints counts only. On Gmail's per-minute quota error it waits 30 s and retries.
2. The agent chose samples by kind and copied them into the git-ignored `probe-samples/`, named `<kind>-NN.eml`.
3. The agent wrote `probe-samples/probe-config.yaml` (the four rules of `config.example.yaml` plus five generic ones) and `probe-samples/expectations.yaml` (yes/no for every sample and rule, judged from the original HTML, not from `basic`'s output) **before** any probing.
4. `npm run probe -- --config probe-samples/probe-config.yaml --json probe-samples/*.eml > probe-samples/results.jsonl`, then scoring against the expectations, then `--show-state` locally to attribute each disagreement.

Nothing from `probe-samples/` is committed; the folder is in `.gitignore`.

## Maintainer steps

None.

## Results

**Candidates** (the two queries overlap):

| Query | Inspected | HTML-only | By Gmail category | With `List-Unsubscribe` |
|-------|-----------|-----------|-------------------|-------------------------|
| Default (`category:promotions OR updates OR purchases OR forums OR social`, no spam, trash or drafts) | 300 | 92 | Updates 54, Promotions 38 | 87 |
| Receipt and notification words (`receipt`, `"your order"`, `invoice`, `pedido`, `recibo`, `password`, `payment`, …) | 150 | 42 | Updates 19, Promotions 22, Personal 1 | 35 |

So about 3 in 10 of the account's commercial mail is HTML-only.

**Samples:** 19, all HTML-only. 4 receipts or order notices, 5 service notifications, 5 newsletters and 5 marketing. English, Spanish and German. Receipts were the scarcest kind. Two first picks were swapped out before any probing because the expected answer was ambiguous. Every probe request returned 200 (`jev-1.13.0`), and none was truncated.

**Scoring:** 9 rules × 19 samples = 171 pairs. 158 agree (92.4%), 13 disagree: 4 false positives, 9 false negatives. **0 are conversion-caused.** The per-rule table is in SD §14.

**Conversion check:** every sample's `basic` body was checked by a script for step 4's defect patterns (CSS or template text, raw tags or attributes, undecoded entities, invisible padding characters, runs of blank lines), and each disagreement's body was read. None was found. Main content was present and in reading order in every sample, including table layouts. One sample holds U+FFFD characters, but the sender's own bytes contain them (`=EF=BF=BD` in the quoted-printable source), so no converter would do better.

**Observation, not a defect:** image-heavy marketing and newsletters carry some of their copy in `alt` text, which `basic` drops by design (epic #10 decision 9). One newsletter had about 6,700 characters of alt text (image descriptions, each twice), and one marketing mail put its offer only in images with placeholder alt text. No disagreement came from it: every marketing sample fired `promotion`, since the offer is also in the text or the subject. It's recorded for a future look at `advanced`, not as a `basic` gap.

## Conclusion

`basic` meets the bar: zero conversion-caused false positives, zero conversion-caused false negatives, and no defect to fix or file. All 13 disagreements come from question wording or thresholds (`newsletter` at 0.95 fired on no newsletter, and `account_notice` fires on order notices).

## Design changes

SD §14 (row "How well `basic` HTML conversion works for classification" and a per-rule table), SD §13 row E4, PDD §13, and CLAUDE.md "Project status".
