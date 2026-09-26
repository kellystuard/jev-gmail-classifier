# Gmail fixtures

Synthetic Gmail API `users.threads.get` (`format: 'full'`) responses, as returned by the Apps Script Advanced Gmail Service, for E4's state builder, MIME walker, and decoder tests (#76, #77, #79, #80). E2 sets up Vitest around this folder.

They come from the spike in [`spikes/29-part-encoding.md`](../../../spikes/29-part-encoding.md) (task #29). **No real mail, addresses, or Gmail IDs are stored here.** Every message was made in the throwaway test account from synthetic text: inserted or imported by the spike, or (scenarios 12 and 14) composed in Gmail's web UI with synthetic text only.

## Files

For each scenario:

- `NN-slug.json`: the scrubbed `threads.get` response, with the same keys, nesting, and `body.data` form (always a byte array, as the Advanced Service returned it).
- `NN-slug.expected.json`: `{ "<partId>": "<decoded text>" }` for each text part (`text/*`). For a thread with more than one message, the key is `"<message number>:<partId>"`. The text is the spike's source text, except for scenario 12 (UI-composed) and 14/14b (nested parts), where it is the decoded text, checked against a marker phrase. It includes text parts inside attachments and forwarded messages, so it describes decoding, not what `basic` should send.

| File | Scenario | Covers | Made by (`insert`/`import` by the spike) | Date |
|------|----------|--------|---------|------|
| [`01-plain-utf8-7bit.json`](01-plain-utf8-7bit.json) | 1 | `text/plain` only, UTF-8, 7bit. Single-part payload (`partId` `""`). | insert | 2026-09-26 |
| [`02-html-utf8-qp.json`](02-html-utf8-qp.json) | 2 | `text/html` only, UTF-8, quoted-printable (CTE undone in `data`). | insert | 2026-09-26 |
| [`03-alternative-utf8-base64.json`](03-alternative-utf8-base64.json) | 3 | `multipart/alternative` (plain + HTML), UTF-8, base64; emoji and CJK. | insert | 2026-09-26 |
| [`03b-alternative-utf8-base64-import.json`](03b-alternative-utf8-base64-import.json) | 3b | Scenario 3 imported: extra trace headers (`Delivered-To`, `Received`, `X-Received`, …), otherwise identical. | import | 2026-09-26 |
| [`04-mixed-attachments.json`](04-mixed-attachments.json) | 4 | `multipart/mixed`: alternative body + PDF + 40-byte `.txt` attachment (both with `filename` and `attachmentId`, no inline data). | insert | 2026-09-26 |
| [`05-plain-iso-8859-1-qp.json`](05-plain-iso-8859-1-qp.json) | 5 | ISO-8859-1 declared; `data` is UTF-8 (105 bytes) while `body.size` is 95. | insert | 2026-09-26 |
| [`05b-plain-iso-8859-1-qp-import.json`](05b-plain-iso-8859-1-qp-import.json) | 5b | Scenario 5 imported: transcoded the same way. | import | 2026-09-26 |
| [`06-html-windows-1252-qp.json`](06-html-windows-1252-qp.json) | 6 | windows-1252 HTML (curly quotes, €, dashes); `data` is UTF-8. | insert | 2026-09-26 |
| [`07-plain-multibyte-base64.json`](07-plain-multibyte-base64.json) | 7 | Two `text/plain` parts, Shift_JIS and ISO-2022-JP; `data` is UTF-8. | insert | 2026-09-26 |
| [`08-plain-no-charset-8bit.json`](08-plain-no-charset-8bit.json) | 8 | Two `text/plain` parts without `charset`, 8bit: UTF-8 bytes and ISO-8859-1 bytes; both come back UTF-8. | insert | 2026-09-26 |
| [`09-plain-unknown-charset.json`](09-plain-unknown-charset.json) | 9 | `charset="x-unknown"` and `charset=utf8`, UTF-8 bytes. The declared `x-unknown` makes `getDataAsString` throw. | insert | 2026-09-26 |
| [`09b-plain-unknown-charset-latin1.json`](09b-plain-unknown-charset-latin1.json) | 9b | `charset="x-unknown"` with ISO-8859-1 bytes; `data` is UTF-8. | insert | 2026-09-26 |
| [`10-rfc2047-headers.json`](10-rfc2047-headers.json) | 10 | RFC 2047 Subject (folded, B), From (ISO-8859-1 Q), To (UTF-8 Q): values arrive decoded. | insert | 2026-09-26 |
| [`11-large-plain.json`](11-large-plain.json) | 11 | About 1 MB `text/plain` body, inline (no `attachmentId`). The fixture is 3.6 MB and the expected text 1 MB. | insert | 2026-09-26 |
| [`13-calendar-invite.json`](13-calendar-invite.json) | 13 | Calendar invite (proxy): `text/calendar` part gets `filename` `invite.ics` and an `attachmentId`; plus `application/ics` attachment. | import | 2026-09-26 |
| [`12-gmail-composed-html.json`](12-gmail-composed-html.json) | 12 | HTML mail composed in Gmail's web UI and sent to itself: Gmail-built `multipart/alternative`, a hard-wrapped plain alternative, and a decoded non-ASCII subject. From/To replaced by the test-account placeholder. | Gmail web UI | 2026-09-26 |
| [`14-forward-as-attachment.json`](14-forward-as-attachment.json) | 14 | Forward as attachment (**API-built stand-in**): `message/rfc822` attachment expanded into nested parts (`1.0`, `1.0.0`, `1.0.1`); the inner text parts have no `filename` or `attachmentId`. | insert | 2026-09-26 |
| [`14b-forward-inline-rfc822.json`](14b-forward-inline-rfc822.json) | 14b | The same inner message as an inline `message/rfc822` part (no `filename`, no `attachmentId`), also expanded. | insert | 2026-09-26 |

## Scrubbing rules

**Kept as returned:** `mimeType`, `partId`, `filename`, `body.size`, the order of header names, all MIME headers on parts (`Content-Type`, `Content-Transfer-Encoding`, `Content-Disposition`, `Content-ID`, `Content-Description`, `MIME-Version`), the SD §8.3 allowlisted headers (`From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted`), `labelIds`, `sizeEstimate`, `internalDate`, and body `data`.

**Replaced:**

- `id`, `threadId`, and `historyId` with stable fakes: `thread-NN`, `msg-NN-<n>`, `1000` (thread) and `1000 + n` (message).
- `attachmentId` values with `att-NN-<n>`.
- Every email address with one at `example.com` or `example.org` (RFC 2606). The spike's own addresses already are. The test account becomes `"Test Account" <test-account@example.com>` (display name included), and any other address becomes `userN@example.com`.
- The values of every other header (`Received`, `DKIM-Signature`, `ARC-*`, `Authentication-Results`, `Message-ID`, `Delivered-To`, `Return-Path`, `X-*`, and so on) with `"REDACTED"`. The header *names* are kept, so E4 can test that they're ignored.
- `snippet` with synthetic text.
- Body `data` is kept, since the content is synthetic. The one exception: if a body's decoded text named the test account, it was re-encoded without it (in the same form and padding style), and `body.size` was updated. The spike reports this in `scrubNotes`, and it is listed in the table above.
