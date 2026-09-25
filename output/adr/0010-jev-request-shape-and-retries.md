# ADR-0010: Jev request shape, `state` layout, and retry rounds

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §8](../solution-design.md#8-jev-integration)

## Context

- **Request** ([TypeSafe API](https://docs.typesafe.ai/api)): `questions` is a map keyed by IDs we choose, and answers come back under the same keys.
- **`state`** may be a string, an object, or an array. TypeSafe advises descriptive names, and arrays for sequences of messages.
- **Errors:** 401, 422, 429, and 529 are documented. The official SDK retries 408, 429, and 5xx, starting at 500 ms and doubling to 5 s, with jitter, and honours `Retry-After`.
- **The SDK needs `fetch`**, which Apps Script lacks. Apps Script also has no timers, and `fetchAll` blocks until every request returns.

## Decision

- **A hand-written client.** Pure request building and response handling go in `core/`; the transport goes through `HttpPort` over `UrlFetchApp.fetchAll`.
- **Question keys** are the required, unique `rules[].id` from config.
- **`state`** is an array of message objects, newest first, with **descriptive keys** (`from`, `replyTo`, `listId`, …, `body`). Missing headers are omitted.
- **Truncation** works on that structure: oldest bodies first, then the oldest messages, then the end of the newest body.
- **Retries happen in rounds:** `fetchAll`, sort the responses, sleep for the largest backoff among the ones to retry (honouring `Retry-After`, capped by the deadline), and re-send only those.
- **The starting policy follows the SDK.** The implementer classifies each status as retryable, normal, or exceptional ([ADR-0006](0006-results-and-error-boundaries.md)).
- **Logged with every call:** `x-typesafe-request-id`, the returned `model`, and `usage.input_tokens`.

## Consequences

- Stable IDs keep probability logs comparable across config edits.
- Descriptive keys cost a few tokens per message, in return for classification quality.

## Alternatives Considered

- **Keys from rule position (`r1`, `r2`, …):** shift when rules are reordered.
- **Short keys (`f`, `t`):** rejected, because they may hurt accuracy for negligible savings.
- **A flat text transcript:** goes against TypeSafe's guidance.
