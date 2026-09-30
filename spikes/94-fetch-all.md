# 94: `UrlFetchApp.fetchAll` with the adapter's options
- Task: #94
- Date run: 2026-09-30
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs run s94_run`, run twice; the second run added the httpbin check in S4)

## Question

How does `UrlFetchApp.fetchAll` behave with the options `GasHttpAdapter` uses (`muteHttpExceptions: true`, `followRedirects: false`, `contentType` and `payload` only when present)? Epic #11's decision 11 assumes that any status comes back as a response, that `fetchAll` throws once for the whole batch when a request can't be sent, and that header names need lower-casing. The spike also measures a batch's latency for the sender's round estimate (#96).

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s94_run`

`s94_run` calls Jev **without** any key (no `Authorization` header), so it costs nothing and needs no secret. It returns header names only (values only for `content-type`, `location` and the httpbin test headers), and replaces identifiers with `<id>`.

## Maintainer steps

None.

## Results

| # | Scenario | What was done | Observed | Matches design? |
|---|----------|---------------|----------|-----------------|
| S1 | Jev with no key | `fetchAll([POST /v1/systemone])`, minimal synthetic body, no `Authorization` | **403**, `content-type: application/json`, `x-typesafe-request-id` present, body `{"detail":{"error_type":"authentication_error","message":"Must supply an API key! Check your request and try again."}}`. Header names come back in the server's casing (`Content-Type`, `Set-Cookie`, `x-typesafe-request-id`), so lower-casing is needed. 159–166 ms. | Yes, with 403 instead of the 401 the issue guessed. #90's fixtures already record this 403, and #92 classifies 403 as `auth` (maintainer answer 1a). |
| S2 | A batch with an unresolvable host | `fetchAll([S1's request, GET https://jev-smoke.invalid/, GET https://www.google.com/generate_204])` | `fetchAll` **threw** for the whole batch: no per-request results. The exception's `name` is `Exception` (an `Error`), its `message` exactly `DNS error: https://jev-smoke.invalid/`. It threw after 148–149 ms. | Yes (decision 11). The message holds the failing URL, but no header or payload. |
| S3 | A redirect | `GET https://google.com/` with `followRedirects: false` | **301**, with a `Location: https://www.google.com/` header; the redirect wasn't followed. | Yes. |
| S4 | A repeated header | Read `getAllHeaders()` value types in S1 and S3, then `GET https://httpbin.org/response-headers?X-S94-Rep=a&X-S94-Rep=b&Set-Cookie=…&Set-Cookie=…` | S1 and S3 had no repeated header (every value a string; Jev sends one `Set-Cookie`). In the httpbin response, a repeated header's value is an **array** of strings (`Set-Cookie: ["s94a=1","s94b=2"]`, `x-s94-rep: ["a","b"]`). | Yes: `normalizeHeaders` joins an array with `", "`. |
| S5 | Batch latency | `fetchAll` of 5 copies of S1's request, 3 times | 264, 264 and 255 ms (all 403). One request alone took 159–166 ms. | For #96: a batch of 5 cheap responses costs about 260 ms of overhead; #90's fixtures give the 200 latency. |

## Raw output

<details><summary>Second run (scrubbed)</summary>

```json
{"at":"2026-09-30T05:07:35.767Z","s1":{"headerTypes":{"Content-Type":"string","x-typesafe-request-id":"string","Connection":"string","cf-ray":"string","Server":"string","cf-cache-status":"string","x-envoy-upstream-service-time":"string","Set-Cookie":"string","Content-Encoding":"string","Transfer-Encoding":"string","Date":"string"},"status":403,"contentType":"application/json","hasRequestId":true,"elapsedMs":166,"body":"{\"detail\":{\"error_type\":\"authentication_error\",\"message\":\"Must supply an API key! Check your request and try again.\"}}","headerNames":["Content-Type","Transfer-Encoding","Set-Cookie","Content-Encoding","Date","x-typesafe-request-id","cf-cache-status","cf-ray","Server","Connection","x-envoy-upstream-service-time"]},"s2":{"message":"DNS error: https://jev-smoke.invalid/","elapsedMs":149,"errorType":"[object Error]","threw":true,"errorName":"Exception"},"s3":{"status":301,"headerNames":["Content-Security-Policy-Report-Only","X-XSS-Protection","X-Frame-Options","Location","Content-Type","Date","Content-Length","Server","Cache-Control","Expires","Alt-Svc"],"location":"https://www.google.com/"},"s4":[{"from":"s1","headerTypes":{"Content-Encoding":"string","Server":"string","Date":"string","cf-ray":"string","Content-Type":"string","Set-Cookie":"string","x-typesafe-request-id":"string","cf-cache-status":"string","Transfer-Encoding":"string","x-envoy-upstream-service-time":"string","Connection":"string"}},{"from":"s3-again","headerTypes":{"Content-Length":"string","Location":"string","X-XSS-Protection":"string","Content-Type":"string","Date":"string","Alt-Svc":"string","Expires":"string","Cache-Control":"string","X-Frame-Options":"string","Content-Security-Policy-Report-Only":"string","Server":"string"}},{"setCookie":["s94a=1","s94b=2"],"headerTypes":{"Date":"string","Server":"string","Access-Control-Allow-Credentials":"string","Set-Cookie":"array(2)","Content-Type":"string","x-s94-rep":"array(2)","Content-Length":"string","Connection":"string","Access-Control-Allow-Origin":"string"},"status":200,"from":"httpbin-repeated","repeated":["a","b"]}],"s5":[{"elapsedMs":264,"statuses":[403,403,403,403,403]},{"elapsedMs":264,"statuses":[403,403,403,403,403]},{"statuses":[403,403,403,403,403],"elapsedMs":255}]}
```

The first run (05:07:11Z) gave the same S1, S2 and S3 results; its S5 batches took 270, 273 and 435 ms.

</details>

## Conclusion

Decision 11 holds as written:

- With `muteHttpExceptions: true`, every status (403, 301, 200) comes back as a response.
- A request that can't be sent makes `fetchAll` throw one `Exception` for the whole batch, so the adapter gives every request in the batch the same `transport` (or `scope`) result. Its message names the failing URL, never a header or payload.
- `followRedirects: false` returns a 3xx as its status with a `Location` header.
- Header names keep the server's casing, and a repeated header is an array, so `normalizeHeaders` lower-cases names and joins arrays.

One consequence for the sender (#96): when a batch throws, the other requests in it may still have reached Jev (S2 threw after about one request's latency), and a retry of a `transport` result can then send the same thread twice. That is rare (a DNS or network failure) and costs at most one batch's tokens; nothing in E5 changes because of it.

## Design changes

- SD §5.2's `HttpPort` row and `src/ports/http-port.ts`: `transport` and `scope` are batch-wide, and redirects aren't followed.
- `docs/smoke-test.md`: the "HTTP and secrets adapters" section, with S1's 403 instead of the issue's 401.
