# 84: Jev's tokens per character, and what its input limits cover

- Task: #84 (story #82, epic #10)
- Date run: 2026-09-29
- Model: `jev-latest`, which returned `jev-1.13.0` on every successful request
- Account: none. This spike calls the Jev API directly from Node, with the key from `.env`; no Gmail account is involved.
- Run by: agent, with the maintainer's approval for up to about 100 live requests of synthetic text
- Cost: 88 requests, 884,993 input tokens (about $0.037)

## Question

SD §8.4 truncated `state` with "`chars / 4`-style estimation with a safety margin (the ratio and margin are E4's)". The API reference doesn't state the input limit, and the README's figures (32k tokens for `state` plus the longest question, 64k for `state` plus all questions) weren't measured. So:

1. How many tokens does Jev charge per character, for each kind of text a mailbox holds? What does the question cost, what does each extra message cost, and what's the fixed overhead of a request?
2. Is "32k" 32,000 or 32,768, and does it cover `state` plus one question or the whole request? Is there a 64k combined limit? What does Jev return when a request is over?
3. Which estimator, limit constants, overhead and margin should #83 implement (epic #10, decision 10)?

## Method

`spikes/84-token-ratio.mjs` is a zero-dependency Node 24 ES module (not Apps Script: `spikes/run.mjs push` only uploads `*.js`). It sends `POST https://api.typesafe.ai/v1/systemone` with `{model: "jev-latest", state, questions}` (SD §8.2), one request at a time, and records the status, `usage.input_tokens`, the returned `model` and `x-typesafe-request-id`. It reads `JEV_API_KEY` from the environment or a `.env` file and never prints it. It stops on the first 401 and at a cap of 100 live requests.

**Synthetic text only.** Every text is generated deterministically from fixed word and phrase lists and a seeded PRNG (mulberry32), so a rerun sends the same bytes. Addresses are `example.com` and `example.org`. The headers are the same on every message: `from`, `to`, `subject` and `date` (SD §8.3 keys), then `body`.

**Slopes, not ratios.** For each kind, one message's `body` is sent at 2 to 4 sizes, with the same headers and question (`"Is this email a newsletter or marketing message?"`, 48 characters). A least-squares fit of `input_tokens` against size cancels the fixed overhead. Sizes are measured three ways: UTF-16 code units of the raw body, characters of `JSON.stringify(state)`, and UTF-8 bytes of `JSON.stringify(state)`.

The task named five kinds. The first run showed that ASCII text alone spans a factor of 4, so nine more kinds were added to find the worst case:

| Kind | Content | Why |
|------|---------|-----|
| `prose` | English sentences from a fixed word list | The common case |
| `marketing` | Product lines, prices, long tracking URLs with `utm_` parameters and random IDs, "Unsubscribe" footers | A newsletter's `text/plain` part |
| `escapes` | `"`, `\`, tabs and newlines (Windows paths, code, quoted speech) | Serialized JSON longer than the raw text |
| `cjk` | Common Chinese and Japanese (kanji, hiragana, katakana) | Task kind 4 |
| `emoji` | Emoji with surrogate pairs, ZWJ sequences, skin tones and flags | Task kind 5 |
| `base64` | Random base64 in 76-character lines | PGP signatures and base64 IDs in tracking links: the densest ASCII found |
| `latin` | German, French, Spanish and Portuguese with accents | Mostly ASCII with some 2-byte characters |
| `cyrillic`, `greek`, `arabic`, `devanagari`, `thai`, `hangul` | One sentence list per script | Spam arrives in any script |
| `cjkExtA` | Rare BMP ideographs (U+3400–U+4DBF) | Characters likely outside the tokenizer's vocabulary |
| `cjkExtB` | Rare ideographs outside the BMP (surrogate pairs) | The same, 4 bytes each |
| `symbols` | Bullets, dashes, smart quotes, arrows, box drawing | Typography common in newsletters |

**Other slopes.** The question: only its length varies (English prose, 48 to 20,022 characters), with a fixed small `state`. Messages: 1, 4, 16 and 64 identical messages with tiny bodies. Questions: 1, 2, 5 and 10 copies of the 48-character question. The intercept: a minimal request, `state` `[{"body":"Hi."}]` and question `"Spam?"`, sent twice.

**Limits.** Common CJK text costs exactly one token per code unit (slope 1.000, no residual), so a CJK body of `n − 357` units gives a request of exactly `n` input tokens. That made it possible to bisect the single-question boundary to the token. The combined limit was bisected with 8 long questions of about 5,000 tokens each and a CJK `state`, stopping at a 36-token interval to stay under the request cap. Finally, two requests sized by the chosen estimator to fill the budget exactly (below), in the tightest kind measured.

## Rerun

```sh
node spikes/84-token-ratio.mjs --env /path/to/.env
```

Results are cached by request key in `spikes/84-token-ratio.results.json` (committed). A rerun with that file makes no live calls and prints the same JSON result. To measure afresh, for example after a new Jev model, pass `--cache <new-file>`: that sends all 88 requests again (under $0.04). The limit probes were sized from the slope results and from earlier limit probes, so on a model with different counts, check the bisection bounds in `limits()` first. `--phase slopes|limits` runs one phase, and `--max <n>` changes the cap.

## Results

### Fitted slopes per kind

Fits of `input_tokens` against each size measure. "Estimate ÷ actual" is the chosen estimator's estimate for the whole request (below) divided by `input_tokens`, the lowest over that kind's sizes. It must be at least 1.

| Kind | Tokens per raw code unit | Code units per token | Tokens per state-JSON char | Tokens per UTF-8 byte | Intercept (raw fit) | Max residual | Estimate ÷ actual (min) |
|---|---|---|---|---|---|---|---|
| prose | 0.173 | 5.79 | 0.172 | 0.172 | 356 | 12.2 | 4.446 |
| marketing | 0.447 | 2.24 | 0.443 | 0.443 | 374 | 30.7 | 2.073 |
| escapes | 0.412 | 2.43 | 0.332 | 0.332 | 353 | 24.7 | 2.635 |
| cjk | 1.000 | 1.00 | 0.991 | 0.334 | 357 | 0.0 | 2.607 |
| emoji | 1.019 | 0.98 | 1.008 | 0.500 | 353 | 10.5 | 1.822 |
| base64 | 0.712 | 1.40 | 0.703 | 0.703 | 337 | 9.6 | 1.427 |
| latin | 0.241 | 4.15 | 0.240 | 0.226 | 365 | 6.1 | 3.530 |
| cyrillic | 0.494 | 2.03 | 0.492 | 0.272 | 337 | 0.0 | 3.150 |
| greek | 0.673 | 1.49 | 0.670 | 0.371 | 354 | 0.0 | 2.454 |
| arabic | 0.575 | 1.74 | 0.573 | 0.320 | 368 | 0.0 | 2.731 |
| devanagari | 0.585 | 1.71 | 0.582 | 0.228 | 392 | 0.0 | 3.641 |
| thai | 1.000 | 1.00 | 0.996 | 0.340 | 357 | 0.0 | 2.734 |
| hangul | 0.708 | 1.41 | 0.702 | 0.288 | 393 | 0.0 | 3.048 |
| cjkExtB | 1.735 | 0.58 | 1.710 | 0.894 | 416 | 0.0 | 1.124 |
| cjkExtA | 2.732 | 0.37 | 2.662 | 0.990 | 362 | 0.0 | 1.018 |
| symbols | 0.701 | 1.43 | 0.696 | 0.369 | 313 | 0.0 | 2.507 |

The last nine kinds were sent at two sizes, so their fits have no residual by construction.

- **ASCII text spans a factor of 4:** 0.17 tokens per character for English, 0.44 for URL-heavy marketing text, 0.70 for base64. `chars / 4` would underestimate marketing text by 1.8× and base64 by 2.8×.
- **Non-ASCII spans a factor of 5 per code unit:** 0.49 for Cyrillic, 1.00 for common CJK and Thai, 1.73 for Extension B, 2.73 for Extension A. Per UTF-8 byte, Extension A is 0.99 tokens: Jev's tokenizer falls back to the UTF-8 bytes for characters outside its vocabulary, one token each.
- **No kind costs more than one token per UTF-8 byte.** The highest is 0.99 (Extension A), then 0.89 (Extension B) and 0.70 (base64). Everything else is 0.5 or less.
- **The JSON escapes count.** For `escapes`, the slope is 0.41 per raw code unit but 0.33 per character of the serialized JSON: estimating on `JSON.stringify(state)` covers the escaping.

### The question, messages and the intercept

| Measurement | Result |
|-------------|--------|
| Question length (4 sizes, 48 to 20,022 characters) | 0.173 tokens per character (5.78 characters per token), residual at most 2.2. The same rate as English in `state` (0.172): questions and `state` text are counted alike. |
| Messages (1, 4, 16, 64) | Exactly 88 tokens per extra message of 208 JSON characters (0.42 per character, no residual). Keys, quotes and headers cost more per character than prose, and estimating on the serialized JSON covers them. |
| Questions (1, 2, 5, 10 copies of 48 characters) | Exactly 16 tokens per extra question (no residual): about 8 for its text and 8 for Jev's wrapper. `input_tokens` counts `state` once plus every question. |
| Intercept | 279 tokens for the minimal request, the same on both sends. 353 with the four headers. |

### Limits

| Probe | Result |
|-------|--------|
| Clearly over (48,000 tokens) | HTTP **400**, body `{"detail":{"error_type":"max_tokens_exceeded"}}` (verbatim). Not 422. |
| One question, bisected | 33,002 input tokens accepted, 33,003 rejected (400, the same body). 32,000, 32,001, 32,768 and 32,769 were all accepted. |
| 3 questions of about 5,000 tokens, `state` + each question about 30,000 | Accepted, with 40,029 input tokens. |
| 10 such questions (about 75,000 in all) | Rejected (400, the same body). |
| 8 such questions, bisected | 65,771 input tokens accepted, 65,807 rejected. |

- **"32k" is 32,768**, and it applies to `state` plus **one** question. Jev doesn't count 234 tokens of its own prompt: 33,002 = 32,768 + 234.
- **The limit is per question.** A request whose `state` plus all questions is 40,029 tokens is accepted when `state` plus each question is under the limit.
- **"64k" is 65,536, for `state` plus all questions combined.** With 8 questions, Jev leaves between 235 and 270 tokens of its prompt uncounted, so the largest accepted request was 65,771.
- **An over-limit request is a 400**, `error_type: max_tokens_exceeded`, for both limits. SD §10 and the README treat a 422 as the invalid request that gets `Jev/Error`, so E5's per-status classification has to handle this 400 too (raised on #10, #83 and E5).

### Under the planned target

Two requests sized so the chosen estimator plus the margin fills the budget exactly, in `cjkExtA`, the kind whose tokens are closest to its estimate:

| Request | Rule | `state` estimate (= its budget) | Question estimates | Whole estimate | `input_tokens` | Status |
|---------|------|---------------|-----------|--------|--------|--------|
| `under-single-cjkExtA` | 32,768 | 31,410 | 48 | 31,768 | 31,279 | 200 |
| `under-combined-cjkExtA` | 65,536 | 19,383 | 4 × 10,953 | 63,535 | 63,169 | 200 |

Both succeeded, 1,723 and 2,602 tokens under the largest accepted size.

### Every request

"Body units" and the UTF-8 bytes are given for the kind requests. `input_tokens` is empty where Jev returned no usage (every 400).

| # | Request | Body units (ASCII / non-ASCII) | State JSON chars (ASCII / non-ASCII) | State JSON UTF-8 bytes | Question chars | `input_tokens` | Status |
|---|---------|------|------|------|------|------|------|
| 1 | `kind-prose-4500` | 4,500 (4,500 / 0) | 4,701 (4,701 / 0) | 4,701 | 48 | 1,138 | 200 |
| 2 | `kind-prose-18000` | 18,000 (18,000 / 0) | 18,257 (18,257 / 0) | 18,257 | 48 | 3,464 | 200 |
| 3 | `kind-prose-45000` | 45,000 (45,000 / 0) | 45,359 (45,359 / 0) | 45,359 | 48 | 8,111 | 200 |
| 4 | `kind-prose-90000` | 90,000 (90,000 / 0) | 90,549 (90,549 / 0) | 90,549 | 48 | 15,896 | 200 |
| 5 | `kind-marketing-2500` | 2,500 (2,500 / 0) | 2,712 (2,712 / 0) | 2,712 | 48 | 1,481 | 200 |
| 6 | `kind-marketing-10000` | 10,000 (10,000 / 0) | 10,276 (10,276 / 0) | 10,276 | 48 | 4,872 | 200 |
| 7 | `kind-marketing-25000` | 25,000 (25,000 / 0) | 25,420 (25,420 / 0) | 25,420 | 48 | 11,512 | 200 |
| 8 | `kind-marketing-50000` | 50,000 (50,000 / 0) | 50,638 (50,638 / 0) | 50,638 | 48 | 22,720 | 200 |
| 9 | `kind-escapes-2500` | 2,500 (2,500 / 0) | 3,252 (3,252 / 0) | 3,252 | 48 | 1,370 | 200 |
| 10 | `kind-escapes-10000` | 10,000 (10,000 / 0) | 12,574 (12,574 / 0) | 12,574 | 48 | 4,498 | 200 |
| 11 | `kind-escapes-25000` | 25,000 (25,000 / 0) | 31,148 (31,148 / 0) | 31,148 | 48 | 10,639 | 200 |
| 12 | `kind-escapes-50000` | 50,000 (50,000 / 0) | 62,132 (62,132 / 0) | 62,132 | 48 | 20,956 | 200 |
| 13 | `kind-cjk-1000` | 1,000 (9 / 991) | 1,198 (207 / 991) | 3,180 | 48 | 1,357 | 200 |
| 14 | `kind-cjk-4000` | 4,000 (36 / 3,964) | 4,225 (261 / 3,964) | 12,153 | 48 | 4,357 | 200 |
| 15 | `kind-cjk-10000` | 10,000 (87 / 9,913) | 10,276 (363 / 9,913) | 30,102 | 48 | 10,357 | 200 |
| 16 | `kind-cjk-20000` | 20,000 (180 / 19,820) | 20,369 (549 / 19,820) | 60,009 | 48 | 20,357 | 200 |
| 17 | `kind-emoji-600` | 599 (62 / 537) | 799 (262 / 537) | 1,413 | 48 | 972 | 200 |
| 18 | `kind-emoji-2400` | 2,400 (265 / 2,135) | 2,615 (480 / 2,135) | 5,083 | 48 | 2,789 | 200 |
| 19 | `kind-emoji-6000` | 6,000 (654 / 5,346) | 6,259 (913 / 5,346) | 12,451 | 48 | 6,470 | 200 |
| 20 | `kind-emoji-12000` | 11,999 (1,294 / 10,705) | 12,325 (1,620 / 10,705) | 24,655 | 48 | 12,584 | 200 |
| 21 | `question-50` | – | 209 (209 / 0) | 209 | 48 | 363 | 200 |
| 22 | `question-2000` | – | 209 (209 / 0) | 209 | 2,022 | 705 | 200 |
| 23 | `question-8000` | – | 209 (209 / 0) | 209 | 8,022 | 1,745 | 200 |
| 24 | `question-20000` | – | 209 (209 / 0) | 209 | 20,022 | 3,817 | 200 |
| 25 | `messages-1` | – | 209 (209 / 0) | 209 | 48 | 362 | 200 |
| 26 | `messages-4` | – | 833 (833 / 0) | 833 | 48 | 626 | 200 |
| 27 | `messages-16` | – | 3,329 (3,329 / 0) | 3,329 | 48 | 1,682 | 200 |
| 28 | `messages-64` | – | 13,313 (13,313 / 0) | 13,313 | 48 | 5,906 | 200 |
| 29 | `questions-1` | – | 209 (209 / 0) | 209 | 48 | 363 | 200 |
| 30 | `questions-2` | – | 209 (209 / 0) | 209 | 2 × 48 | 379 | 200 |
| 31 | `questions-5` | – | 209 (209 / 0) | 209 | 5 × 48 | 427 | 200 |
| 32 | `questions-10` | – | 209 (209 / 0) | 209 | 10 × 48 | 507 | 200 |
| 33 | `minimal-body-only` | – | 16 (16 / 0) | 16 | 5 | 279 | 200 |
| 34 | `minimal-headers` | – | 192 (192 / 0) | 192 | 5 | 353 | 200 |
| 35 | `minimal-repeat` | – | 16 (16 / 0) | 16 | 5 | 279 | 200 |
| 36 | `kind-base64-1500` | 1,500 (1,500 / 0) | 1,708 (1,708 / 0) | 1,708 | 48 | 1,412 | 200 |
| 37 | `kind-base64-7500` | 7,500 (7,500 / 0) | 7,786 (7,786 / 0) | 7,786 | 48 | 5,667 | 200 |
| 38 | `kind-base64-22500` | 22,500 (22,500 / 0) | 22,981 (22,981 / 0) | 22,981 | 48 | 16,358 | 200 |
| 39 | `kind-latin-3500` | 3,500 (3,285 / 215) | 3,705 (3,490 / 215) | 3,920 | 48 | 1,212 | 200 |
| 40 | `kind-latin-17500` | 17,500 (16,440 / 1,060) | 17,753 (16,693 / 1,060) | 18,813 | 48 | 4,572 | 200 |
| 41 | `kind-latin-52500` | 52,500 (49,340 / 3,160) | 52,935 (49,775 / 3,160) | 56,095 | 48 | 13,006 | 200 |
| 42 | `kind-cyrillic-2000` | 2,000 (385 / 1,615) | 2,197 (582 / 1,615) | 3,812 | 48 | 1,324 | 200 |
| 43 | `kind-cyrillic-8000` | 8,000 (1,532 / 6,468) | 8,221 (1,753 / 6,468) | 14,689 | 48 | 4,286 | 200 |
| 44 | `kind-greek-2000` | 2,000 (385 / 1,615) | 2,198 (583 / 1,615) | 3,813 | 48 | 1,700 | 200 |
| 45 | `kind-greek-8000` | 8,000 (1,535 / 6,465) | 8,221 (1,756 / 6,465) | 14,686 | 48 | 5,738 | 200 |
| 46 | `kind-arabic-2000` | 2,000 (411 / 1,589) | 2,201 (612 / 1,589) | 3,790 | 48 | 1,519 | 200 |
| 47 | `kind-arabic-8000` | 8,000 (1,642 / 6,358) | 8,227 (1,869 / 6,358) | 14,585 | 48 | 4,971 | 200 |
| 48 | `kind-devanagari-2000` | 2,000 (436 / 1,564) | 2,198 (634 / 1,564) | 5,326 | 48 | 1,561 | 200 |
| 49 | `kind-devanagari-8000` | 8,000 (1,749 / 6,251) | 8,226 (1,975 / 6,251) | 20,728 | 48 | 5,069 | 200 |
| 50 | `kind-thai-2000` | 2,000 (56 / 1,944) | 2,199 (255 / 1,944) | 6,087 | 48 | 2,357 | 200 |
| 51 | `kind-thai-8000` | 8,000 (233 / 7,767) | 8,223 (456 / 7,767) | 23,757 | 48 | 8,357 | 200 |
| 52 | `kind-hangul-2000` | 2,000 (527 / 1,473) | 2,209 (736 / 1,473) | 5,155 | 48 | 1,809 | 200 |
| 53 | `kind-hangul-8000` | 8,000 (2,168 / 5,832) | 8,259 (2,427 / 5,832) | 19,923 | 48 | 6,057 | 200 |
| 54 | `kind-cjkExtB-2000` | 1,999 (151 / 1,848) | 2,217 (369 / 1,848) | 4,065 | 48 | 3,884 | 200 |
| 55 | `kind-cjkExtB-8000` | 7,999 (593 / 7,406) | 8,304 (898 / 7,406) | 15,710 | 48 | 14,292 | 200 |
| 56 | `kind-cjkExtA-2000` | 2,000 (265 / 1,735) | 2,242 (507 / 1,735) | 5,712 | 48 | 5,827 | 200 |
| 57 | `kind-cjkExtA-8000` | 8,000 (1,068 / 6,932) | 8,400 (1,468 / 6,932) | 22,264 | 48 | 22,221 | 200 |
| 58 | `kind-symbols-2000` | 2,000 (1,066 / 934) | 2,202 (1,268 / 934) | 3,941 | 48 | 1,715 | 200 |
| 59 | `kind-symbols-8000` | 8,000 (4,192 / 3,808) | 8,246 (4,438 / 3,808) | 15,329 | 48 | 5,922 | 200 |
| 60 | `limit-over-48000` | – | 48,271 (1,067 / 47,204) | – | 48 | – | 400 |
| 61 | `limit-boundary-32000` | – | 32,137 (799 / 31,338) | – | 48 | 32,000 | 200 |
| 62 | `limit-boundary-32001` | – | 32,138 (799 / 31,339) | – | 48 | 32,001 | 200 |
| 63 | `limit-boundary-32768` | – | 32,911 (811 / 32,100) | – | 48 | 32,768 | 200 |
| 64 | `limit-boundary-32769` | – | 32,912 (811 / 32,101) | – | 48 | 32,769 | 200 |
| 65 | `limit-boundary-33100` | – | 33,244 (813 / 32,431) | – | 48 | – | 400 |
| 66 | `limit-boundary-34000` | – | 34,151 (827 / 33,324) | – | 48 | – | 400 |
| 67 | `limit-boundary-32934` | – | 33,077 (811 / 32,266) | – | 48 | 32,934 | 200 |
| 68 | `limit-boundary-33017` | – | 33,161 (813 / 32,348) | – | 48 | – | 400 |
| 69 | `limit-boundary-32975` | – | 33,118 (811 / 32,307) | – | 48 | 32,975 | 200 |
| 70 | `limit-boundary-32996` | – | 33,139 (811 / 32,328) | – | 48 | 32,996 | 200 |
| 71 | `limit-boundary-33006` | – | 33,149 (811 / 32,338) | – | 48 | – | 400 |
| 72 | `limit-boundary-33001` | – | 33,144 (811 / 32,333) | – | 48 | 33,001 | 200 |
| 73 | `limit-boundary-33003` | – | 33,146 (811 / 32,335) | – | 48 | – | 400 |
| 74 | `limit-boundary-33002` | – | 33,145 (811 / 32,334) | – | 48 | 33,002 | 200 |
| 75 | `limit-multi-3x5k` | – | 25,116 (643 / 24,473) | – | 3 × 29,051 | 40,029 | 200 |
| 76 | `limit-multi-10x5k` | – | 25,116 (643 / 24,473) | – | 10 × 29,051 | – | 400 |
| 77 | `limit-combined-8x5k-65770` | – | 25,886 (661 / 25,225) | – | 8 × 29,051 | 65,770 | 200 |
| 78 | `limit-combined-8x5k-65771` | – | 25,887 (661 / 25,226) | – | 8 × 29,051 | 65,771 | 200 |
| 79 | `limit-combined-8x5k-70386` | – | 30,559 (775 / 29,784) | – | 8 × 29,051 | – | 400 |
| 80 | `limit-combined-8x5k-68078` | – | 28,220 (713 / 27,507) | – | 8 × 29,051 | – | 400 |
| 81 | `limit-combined-8x5k-66924` | – | 27,055 (691 / 26,364) | – | 8 × 29,051 | – | 400 |
| 82 | `limit-combined-8x5k-66347` | – | 26,468 (671 / 25,797) | – | 8 × 29,051 | – | 400 |
| 83 | `limit-combined-8x5k-66059` | – | 26,176 (663 / 25,513) | – | 8 × 29,051 | – | 400 |
| 84 | `limit-combined-8x5k-65915` | – | 26,031 (661 / 25,370) | – | 8 × 29,051 | – | 400 |
| 85 | `limit-combined-8x5k-65843` | – | 25,959 (661 / 25,298) | – | 8 × 29,051 | – | 400 |
| 86 | `limit-combined-8x5k-65807` | – | 25,923 (661 / 25,262) | – | 8 × 29,051 | – | 400 |
| 87 | `under-single-cjkExtA` | – | 11,802 (1,998 / 9,804) | – | 48 | 31,279 | 200 |
| 88 | `under-combined-cjkExtA` | – | 7,323 (1,293 / 6,030) | – | 4 × 4,013 | 63,169 | 200 |

## Decisions

### The estimator: UTF-8 bytes

```ts
// src/core/token-estimate.ts (#83)
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) tokens += 1; // ASCII: 1 byte
    else if (c < 0x800) tokens += 2; // 2 bytes (Latin accents, Greek, Cyrillic, Arabic, Hebrew)
    else if (c >= 0xd800 && c <= 0xdfff) tokens += 2; // each half of a surrogate pair: 4 bytes a pair
    else tokens += 3; // the rest of the BMP: 3 bytes (CJK, Thai, Hangul, symbols)
  }
  return tokens;
}
```

- It counts UTF-16 code units, one `charCodeAt` walk, no code-point decoding. The result is the string's UTF-8 byte length, an integer, so there is nothing to round.
- It runs on `JSON.stringify(state)`, the text that is sent, so escapes, keys and punctuation are counted. Questions are estimated with the same function (they are counted at the same rate as `state` text).
- UTF-8 length is additive: the estimate of the serialized JSON is the sum of each string's estimate plus the ASCII structure (`[`, `{`, `"key":`, `,`). So #83 can update the estimate as it drops or cuts content, without serializing again.
- A lone surrogate counts 2, one less than the 3-byte replacement character it's sent as (in a question; `JSON.stringify` escapes one in `state` as six ASCII characters). The margin covers that.

**Why bytes, not a chars-per-token ratio.**

- **It never underestimates a measured kind.** Every token covers at least one byte, so a byte-level tokenizer can't spend more tokens than the text has bytes. The measurements agree: the highest rate is 0.99 tokens per byte (Extension A), and the estimate for the whole request is at least 1.018 × `input_tokens` for every kind.
- **Two rates (ASCII and non-ASCII) don't fix English.** Decision 10's fallback assumed English would set the ASCII rate. It doesn't: ASCII kinds range from 0.17 to 0.70 tokens per character, and a rate that covers base64 and tracking URLs overestimates English about 4×, whatever the non-ASCII rate. On the non-ASCII side, any rate under 3 per BMP code unit underestimates Extension A.
- **The one alternative that saves budget is fragile.** 0.75 per ASCII character with 3 per BMP non-ASCII unit and 2 per surrogate unit gives English about a third more room. But on Extension A text, whose spaces cost a full token each, its estimate came to 1.001 × `input_tokens`, with nothing left for the margin to cover drift.
- **It doesn't depend on the tokenizer's vocabulary**, so it holds when `jev-latest` moves to a new model with a byte-level tokenizer.

**The cost.** English is overestimated about 5.7×, common CJK about 3×. So an English thread is truncated once its `state` JSON passes about 31,000 characters, about 5,000 words, or about 5,400 real tokens. Truncation keeps the newest content ([SD §8.4](../output/solution-design.md#84-truncation)), 5,000 words of it is plenty to classify a thread, and the old content it drops is mostly quoted replies. It also saves tokens. Precision beats recall: a 400 that sends a thread to `Jev/Error` is worse than a shorter `state`.

### The limits

| Constant | Value | Covers |
|----------|-------|--------|
| `JEV_LIMIT_TOKENS` | 32,768 | `state` plus the longest question |
| `JEV_COMBINED_LIMIT_TOKENS` | 65,536 | `state` plus all questions |

Both apply to the whole estimated request. The 234 or so prompt tokens Jev leaves uncounted are extra headroom, not relied on.

### The fixed overhead

| Constant | Value | From |
|----------|-------|------|
| `REQUEST_OVERHEAD_TOKENS` | 300 | The minimal request was 279 tokens, including its own 21 bytes of content. Rounded up. |
| `QUESTION_OVERHEAD_TOKENS` | 10 per question | An extra 48-character question costs 16 tokens, about 8 of them its text. The wrapper is about 8; 10 covers a very short question. |

### The margin

| Constant | Value |
|----------|-------|
| `MARGIN_TOKENS` | 1,000, for the 32,768 limit |
| `COMBINED_MARGIN_TOKENS` | 2,000, for the 65,536 limit |

About 3% of each limit. The estimator already carries the headroom for content: the tightest kind is at 0.99 tokens per byte, and most real text is under 0.5. So the margin only covers what the estimate doesn't see: Jev's prompt and per-message or per-question wrappers growing behind `jev-latest` (about 45 counted tokens today), shapes of `state` not measured here, and a lone surrogate in a question. Both under-target requests, sized to fill the budget with the margin, were accepted.

### The budget rule (decision 10)

With `s = estimateTokens(JSON.stringify(state))`, `qᵢ = estimateTokens(question i)`, and `n` questions, both must hold:

```
s + max(qᵢ) + 300 + 10     + 1000 ≤ 32768
s + Σ qᵢ    + 300 + 10 × n + 2000 ≤ 65536
```

So the largest allowed `s` is `min(31458 − max(qᵢ), 63236 − 10 × n − Σ qᵢ)`. The first is the tighter one unless the questions other than the longest add up to more than about 31,800 bytes. `spikes/84-token-ratio.mjs` implements the same rule (`stateBudget`).

## Conclusion

Jev counts about one token per UTF-8 byte at worst, and anywhere from 0.17 to 0.99 tokens per byte depending on the text. The limits are 32,768 tokens for `state` plus one question and 65,536 for `state` plus all questions, each with a little of Jev's prompt left uncounted. An over-limit request is a 400 `max_tokens_exceeded`, not a 422. The figures in the README hold; "roughly four characters of English" per token is closer to six in `jev-1.13.0`.

## Design changes

- SD §8.4: the estimator, the limits, the overhead, the margin and the budget rule, with a link here.
- SD §13, row E4: the chars-per-token ratio and the safety margin marked **settled**.
- SD §14, row "Character-based token estimate": cites this measurement and the 400.
- README "Jev": the limits are 32,768 and 65,536, and an English token is about six characters.
- Comments on epic #10, task #83 and epic E5 (#11): the over-limit response is a 400, not a 422.
