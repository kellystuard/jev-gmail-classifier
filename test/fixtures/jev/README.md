# Jev fixtures

Real responses from the Jev API (`POST https://api.typesafe.ai/v1/systemone`), recorded live by [`spikes/90-jev-fixtures.mjs`](../../../spikes/90-jev-fixtures.mjs) (E5, task #90), for the tests of `interpretResponse` (#89), the classification table (#92) and the sender (#96). SD §12 and ES §8 say why they are here.

**Everything sent was synthetic** (`example.com`/`example.org` addresses and invented text). No real mail, account detail or key is stored here. Recorded 2026-09-30 from Node with `jev-latest`, which Jev answered as **`jev-1.13.0`**. The key stayed in `.env` and was never printed or written.

Each file is `{"status", "headers", "body"}`. `body` is the exact response text (not re-serialized). `headers` holds only the names worth keeping, lower-cased and sorted: `content-type`, `x-typesafe-request-id`, `retry-after`, `retry-after-ms`, `x-ratelimit-*` and `ratelimit-*`. Everything else is dropped, since it can identify the account or the session.

**Requests and cost.** The fixtures took 11 requests. The latency phase ran three times (about 30 requests each, with one calibration request in the last), because the first two sized the large burst too big and got 400s, which Jev doesn't bill. About 100 requests in all and about 188,000 billed input tokens, so about **$0.008** at $0.042 per million.

## Files

| File | Status | Request | Covers |
|------|--------|---------|--------|
| [`200-four-rules.json`](200-four-rules.json) | 200 | Two-message newsletter thread (a reply and the original with list headers); the four rules of `config.example.yaml` (`approval`, `bill`, `newsletter`, `shipping`) | The normal case: `model`, `answers.<id>.{type,noul}`, `usage.{input_tokens,output_tokens}` |
| [`200-edge-rule-ids.json`](200-edge-rule-ids.json) | 200 | One short message; rule ids `a`, `constructor` and a 32-character id (`a`, then `-_` fifteen times, then `z`) | Jev echoes our keys verbatim at the edges of the id pattern, `constructor` included |
| [`401-wrong-key.json`](401-wrong-key.json) | 401 | A made-up key (not a variation of the real one) | `auth`. `detail.error_type` is `authentication_error` |
| [`403-no-key.json`](403-no-key.json) | 403 | No `Authorization` header | A missing key is **403**, not 401. Same `error_type`, message "Must supply an API key!" |
| [`400-unknown-model.json`](400-unknown-model.json) | 400 | `model: "jev-does-not-exist"` | The unknown-model response (see below) |
| [`400-unknown-model-typo.json`](400-unknown-model-typo.json) | 400 | `model: "jev-1.99.0"` | Same shape, so it isn't special to one name |
| [`400-question-type-yesno.json`](400-question-type-yesno.json) | 400 | A question with `type: "yesno"` | A 400 that is **not** the unknown model: same `error_type`, different message |
| [`422-empty-questions.json`](422-empty-questions.json) | 422 | `questions: {}` | A validation error (an array in `detail`), echoing the input |
| [`422-missing-state.json`](422-missing-state.json) | 422 | No `state` field | Same shape, `type: "missing"`; echoes the whole request body |
| [`422-state-wrong-type.json`](422-state-wrong-type.json) | 422 | `state: 42` | Same shape, one entry per accepted `state` type (string, object, list) |
| [`400-max-tokens-exceeded.json`](400-max-tokens-exceeded.json) | 400 | One message with 34,000 common-CJK characters (about 34,400 tokens, per #84), one question | `{"detail":{"error_type":"max_tokens_exceeded"}}`: `invalid`, never retried |

## Statuses and error bodies

- **What tells the unknown model from other 400s.** The unknown model, a bad question type and (below) the other validation-style 400s all have `detail.error_type` `api_usage_error`; only `detail.message` differs. The unknown model's message is `Unknown model: <name>`, a bad question type's is `Invalid request.`. So #92 must match on the message prefix `Unknown model: `, not on status and `error_type` alone. Jev answers a bad model with a 400, not a 200 with a different `model`.
- **400 `max_tokens_exceeded`** has `detail.error_type` only, with no message. The other 400 seen is `api_usage_error`. Any 400 that isn't one of the two stays `exceptional`.
- **401 and 403** have `detail: {error_type: "authentication_error", message}`. A wrong key is 401; no key at all is 403. Both are `auth` under maintainer answer 1a on #92.
- **422** has `detail` as an **array** of `{type, loc, msg, input, ctx?}` (Pydantic style), unlike the other errors (an object). `type` was `too_short`, `missing` or a `*_type` code.
- **Error bodies echo the request.** Every 422 has an `input` field holding the offending value, and `422-missing-state.json` holds the whole request (questions and model). Here the content is synthetic; with real mail, an echoed `state` would be a message body. **An error body must never be logged** (#89 relies on this: it reads `detail.error_type`, `detail[].type` and `x-typesafe-request-id` only).
- **429.** None came back. Nothing was retried or provoked: the one burst of 20 concurrent small requests (repeated in three runs) all got 200, so there is no 429 fixture, and any rate limit is above 20 concurrent small requests. The `retryable` rows for 408, 429, 502, 503, 504 and 529 rest on the docs and TypeSafe's SDK, not on a recording.
- **The 200 body** is `{"model", "answers": {"<id>": {"type": "noul", "noul": <0..1>}}, "usage": {"input_tokens", "output_tokens"}}`. Probabilities had two decimals here.

## Headers

Names seen, by status (the kept ones are marked **bold**). Nothing else was kept.

| Status | Header names |
|--------|-------------|
| 200, 403 | `cf-cache-status`, `cf-ray`, `connection`, `content-encoding`, **`content-type`**, `date`, `server`, `set-cookie`, `transfer-encoding`, `x-envoy-upstream-service-time`, **`x-typesafe-request-id`** |
| 400, 401, 422 | the same, with `content-length` instead of `content-encoding` and `transfer-encoding` |

`x-typesafe-request-id` (`req_<32 hex>`) is present on **every** response, errors included. **No `retry-after`, `retry-after-ms`, `x-ratelimit-*` or `ratelimit-*` header appeared** on any status, so no fixture has one. `content-type` is `application/json` everywhere. `HttpPort` lower-cases names; `UrlFetchApp` may return them in another case, so the adapter must do it (#94).

## Latency

Measured from Node's `fetch` (WSL2, one machine, 2026-09-30). **Node's concurrency isn't `UrlFetchApp.fetchAll`'s**: Apps Script adds its own overhead per call, and #94's spike can measure it if needed.

| Measure | Result |
|---------|--------|
| Single small 200s (5 one at a time, three runs: 15 in all) | 113 to 275 ms; median about 130 ms; the first request of a run was the slowest (about 270 ms, connection setup) |
| Small errors (401, 403, 400, 422) | 77 to 228 ms |
| The 34,000-character `max_tokens_exceeded` | 146 ms |
| Burst of 20 concurrent small requests (367 tokens each), three runs | wall 512, 547 and 579 ms; median request 344 to 366 ms; slowest 508 to 575 ms; all 200 |
| Burst of 5 concurrent large requests (about 29,600 tokens each, English prose) | wall 625 ms; fastest 434, median 483, slowest 621 ms; all 200 |

Latency grows with size (about 130 ms small, about 480 ms at 30,000 tokens) and with concurrency (a burst of 20 takes about 4 times one request). It stays under a second here. Requests over the limit are rejected fast (about 270 ms for five at once).

**Suggested `INITIAL_ROUND_ESTIMATE_MS`: 5000** (#96 may adjust). Node's slowest round was 0.6 s; the rest is headroom for `fetchAll`'s overhead, a batch of 20 large requests (up to 65,536 tokens each, which no measurement covers) and a slow first call. The estimate only matters until the first round of a call has been timed, and then the measured round replaces it.

## How to rerun

```
node spikes/90-jev-fixtures.mjs --env <main checkout>/.env            # sends only missing fixtures
node spikes/90-jev-fixtures.mjs --env <.env> --latency --max 40       # also the latency phase (about 31 requests)
node spikes/90-jev-fixtures.mjs --dry-run                             # lists what it would send
node spikes/90-jev-fixtures.mjs --env <.env> --force four-rules       # re-record one fixture
```

A fixture whose file already exists (any status) is never re-sent, so a plain rerun sends nothing. `--max` caps live requests per run (default 60). The script stops at the first 401 on a request that used the real key. It needs `JEV_API_KEY` in the environment or in the `--env` file, and never prints the key or a request header. The 422 candidates are tried in order, and the ones after the first 422 are skipped unless named with `--force` (`missing-state` and `state-wrong-type` were).
