# ADR-0011: Extract plain text with a `basic` converter behind a `BodyConverter` interface

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Solution Design §8.3](../solution-design.md#83-state-layout)

## Context

- `GmailMessage.getPlainBody()` only exists on `GmailApp`, which needs the full scope ([ADR-0003](0003-advanced-gmail-service-and-scopes.md)).
- It doesn't document how it converts HTML, and it has known bugs: it returns `null` on some HTML mail and throws on calendar invites.
- The Gmail API returns the MIME tree, and part data may arrive as base64url text or as a byte array.
- Most mail has a `text/plain` part. HTML-only mail is mostly marketing.
- `html-to-text` (MIT, about 75 KB gzipped) works in Apps Script's runtime with an `atob` shim.

## Decision

- Add a `plainTextMethod` config field, default `basic`.
- **`basic`** uses the `text/plain` part if there is one. Otherwise it converts the `text/html` part with an in-house converter that has no dependencies:
  - drops `<head>`, `<style>`, and `<script>`;
  - turns block tags and `<br>` into line breaks;
  - strips the remaining tags;
  - decodes common entities;
  - collapses whitespace.
- **`advanced`** is reserved and rejected by the build in v1.
- All converters implement one `BodyConverter` interface.
- E4 checks `basic` on real HTML-only mail using the local probe.

## Consequences

- There are no runtime dependencies for v1 conversion.
- A better converter can be added later as one class plus one config value.

## Alternatives Considered

- **`getPlainBody()`:** needs the full scope, and has known failures.
- **`html-to-text` now:** bundle size and a shim, before there's evidence it's needed.
