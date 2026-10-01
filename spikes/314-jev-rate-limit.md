# 314: does a batch of 20 large Jev requests hit the token rate limit?

- Task: #314 (bug under #153, epic #16)
- Date run: 2026-10-01
- Model: `jev-latest` (`jev-1.13.0`)
- Account: none. The script calls the Jev API directly from Node with the key from `.env`; no Gmail account is involved.
- Run by: agent, once, with the cap from the issue (200 requests)
- Cost: 61 requests, 759,641 input tokens (about $0.032)

## Question

On 2026-10-01 <https://docs.typesafe.ai/models> says the rate limit is "100K tokens per second / 40 requests per second" (the README had 1,200 requests/minute and 250,000 tokens/second, retrieved 2026-09-24). The sender (`sendJevRequests`) sends up to 20 requests at once with no regard to size, and a request can hold 32,768 tokens, so one batch can carry up to about 650,000 tokens at once. Does Jev refuse such a batch with 429? If so, do the retry rounds (3 attempts, 375 to 500 ms then 750 to 1,000 ms) recover, or would threads be struck?

## Method

`spikes/314-jev-rate-limit.mjs` is a zero-dependency Node 24 ES module (not Apps Script). Synthetic text only: seeded pseudo-random English prose from a fixed word list (the generator of `spikes/90-jev-fixtures.mjs`), `example.com` and `example.org` addresses, two Noul questions. Each burst is `Promise.all` of 20 `fetch` calls, as `UrlFetchApp.fetchAll` would send them, with a pause of at least 5 s (6 s) before each. Per request it records the status, `usage.input_tokens`, `retry-after`, `retry-after-ms`, any `x-ratelimit-*` or `ratelimit-*` header, the error body's type, and the time. If a burst had got a 429, the script would send it again and follow `retryDelay`'s waits for up to 3 attempts, re-sending only the 429s (that branch was not needed). One calibration request of 20,000 characters sized the bursts: 4,259 tokens, so 4.7 characters per token for this prose. The key is never printed or written.

## Results

| Burst (20 requests, concurrent) | Characters each | Sent | 200s | 429s | Other | `Retry-After` | Input tokens in the burst | Wall time |
| ------------------------------- | --------------- | ---- | ---- | ---- | ----- | ------------- | ------------------------- | --------- |
| About 2,000 tokens each         | 9,391           | 20   | 20   | 0    | 0     | none          | 44,077                    | 615 ms    |
| About 8,000 tokens each         | 37,567          | 20   | 20   | 0    | 0     | none          | 154,128                   | 596 ms    |
| About 30,000 tokens each        | 140,878         | 20   | 20   | 0    | 0     | none          | 557,177                   | 1,010 ms  |

- No 429 and no other non-200 status in any burst, so the retry branch ("the same burst again with up to 3 attempts") never ran: nothing to recover.
- No `retry-after`, `retry-after-ms` or rate-limit header appeared on any response (the script records them; `headerNames` was empty).
- The 30,000-token burst moved 557,177 tokens in about 1 s, more than five times the published 100K tokens per second, and 20 requests in 0.6 to 1.0 s, under the 40 requests per second. So the token limit as published is not enforced against a burst of this size today. The calibration request and the three bursts were the only requests (61 in all, under the 200 cap).
- No new response shape was seen, so there is no new fixture (`test/fixtures/jev/` holds no 429, as before).

## Verdict

The sender is fine as it is: batches of 20, no token cap. No thread would be struck for the rate limit in the cases measured, and no follow-up bug is filed.

Caveats: Jev's page says "rate limits are adjusting dynamically", the measurement is one run on one day, and the requests came from one Node process, not from Google's `fetchAll` servers. A 429 stays `retryable` (SD §8.5). If a real run ever logs 429s, or a thread is struck after 3 attempts with 429s, rerun this script and consider filling batches up to a token budget (`estimateStateTokens`) and waiting at least one second between rounds.

## Rerun

```sh
node spikes/314-jev-rate-limit.mjs --dry-run
node spikes/314-jev-rate-limit.mjs --env /path/to/.env [--out raw.json]
```

A rerun sends a new calibration request and 60 more (more if a burst gets 429s, up to the `--max` cap of 200), about $0.03 to $0.13.
