# Gmail fixtures

Synthetic Gmail API `users.threads.get` (`format: 'full'`) responses, as returned by the Apps Script Advanced Gmail Service, for E4's state builder, MIME walker, and decoder tests (#76, #77, #79, #80). E2 sets up Vitest around this folder.

They come from the spike in [`spikes/29-part-encoding.md`](../../../spikes/29-part-encoding.md) (task #29). **No real mail, addresses, or Gmail IDs are stored here.** Every message was made in the throwaway test account from synthetic text: inserted or imported by the spike, or (scenarios 12 and 14) composed in Gmail's web UI with synthetic text only.

## Files

For each scenario:

- `NN-slug.json`: the scrubbed `threads.get` response, with the same keys, nesting, and `body.data` form (string or byte array) the Advanced Service returned.
- `NN-slug.expected.json`: `{ "<partId>": "<decoded text>" }` for each text part (`text/*`). For a thread with more than one message, the key is `"<message number>:<partId>"`. The text is the spike's source text, except for the UI-composed scenarios (12 and 14), where it is the decoded text.

| File | Scenario | Covers | Made by | Date |
|------|----------|--------|---------|------|
| (added when the spike runs) | | | | |

## Scrubbing rules

**Kept as returned:** `mimeType`, `partId`, `filename`, `body.size`, the order of header names, all MIME headers on parts (`Content-Type`, `Content-Transfer-Encoding`, `Content-Disposition`, `Content-ID`, `Content-Description`, `MIME-Version`), the SD §8.3 allowlisted headers (`From`, `Sender`, `Reply-To`, `To`, `Cc`, `Subject`, `Date`, `List-Id`, `List-Unsubscribe`, `Precedence`, `Auto-Submitted`), `labelIds`, `sizeEstimate`, `internalDate`, and body `data`.

**Replaced:**

- `id`, `threadId`, and `historyId` with stable fakes: `thread-NN`, `msg-NN-<n>`, `1000` (thread) and `1000 + n` (message).
- `attachmentId` values with `att-NN-<n>`.
- Every email address with one at `example.com` or `example.org` (RFC 2606). The spike's own addresses already are. The test account becomes `"Test Account" <test-account@example.com>` (display name included), and any other address becomes `userN@example.com`.
- The values of every other header (`Received`, `DKIM-Signature`, `ARC-*`, `Authentication-Results`, `Message-ID`, `Delivered-To`, `Return-Path`, `X-*`, and so on) with `"REDACTED"`. The header *names* are kept, so E4 can test that they're ignored.
- `snippet` with synthetic text.
- Body `data` is kept, since the content is synthetic. The one exception: if a body's decoded text named the test account, it was re-encoded without it (in the same form and padding style), and `body.size` was updated. The spike reports this in `scrubNotes`, and it is listed in the table above.
