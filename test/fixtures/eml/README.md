# `.eml` fixtures

Synthetic `.eml` files for the probe's `.eml` → `GmailThread` step (`scripts/eml-thread.ts`, E5, task #102). Each one is the same message as a spike 29 scenario in [`../gmail/`](../gmail/README.md): the same MIME structure, boundaries, headers, charsets, transfer encodings and source text, as built by `s29_build_` in [`spikes/29-part-encoding.js`](../../../spikes/29-part-encoding.js). `test/scripts/eml-thread.test.ts` checks that each file gives the Gmail fixture's part tree, text, nested headers and `state`.

**No real mail.** Addresses are at `example.com` or `example.org`, and the text is the spike's invented text. The files were generated once on 2026-09-30 from a Node port of the spike's MIME builder (non-UTF-8 text encoded with `iconv-lite` and, for ISO-2022-JP, `encoding-japanese`), and are committed as bytes: don't reformat them, since line endings (CRLF) and 8-bit bytes matter.

| File | Scenario | What it exercises |
|------|----------|-------------------|
| `01-plain-utf8-7bit.eml` | 01 | Single-part `text/plain`, UTF-8, 7bit (`partId` `""`) |
| `02-html-utf8-qp.eml` | 02 | Single-part `text/html`, UTF-8, quoted-printable with soft breaks |
| `03-alternative-utf8-base64.eml` | 03 | `multipart/alternative`, base64, emoji and CJK |
| `04-mixed-attachments.eml` | 04 | `multipart/mixed` with a nested alternative, a PDF and a `.txt` attachment (`attachmentId`, no `data`) |
| `05-plain-iso-8859-1-qp.eml` | 05 | ISO-8859-1 (read as windows-1252), quoted-printable: `size` 95, UTF-8 `data` 105 bytes |
| `06-html-windows-1252-qp.eml` | 06 | windows-1252 HTML: curly quotes, €, dashes |
| `07-plain-multibyte-base64.eml` | 07 | Shift_JIS and ISO-2022-JP parts |
| `08-plain-no-charset-8bit.eml` | 08 | No `charset`: UTF-8 bytes, then ISO-8859-1 bytes (falls back to windows-1252) |
| `09-plain-unknown-charset.eml` | 09 | `charset="x-unknown"` with UTF-8 bytes, and `charset=utf8` |
| `09b-plain-unknown-charset-latin1.eml` | 09b | `charset="x-unknown"` with ISO-8859-1 bytes (falls back to windows-1252) |
| `10-rfc2047-headers.eml` | 10 | RFC 2047 `Subject` (folded, B), `From` (ISO-8859-1, Q), `To` (UTF-8, Q) |
| `14-forward-as-attachment.eml` | 14 | A `message/rfc822` attachment, expanded (`1` → `1.0` → `1.0.0`) |
| `14b-forward-inline-rfc822.eml` | 14b | The same inner message inline, with no filename |
| `not-mime.eml` | — | Prose with no header block: `emlToThread` throws, and the probe reports `stage: "parse"` |

The `Message-ID` values are `<s29-NN@example.com>`. The Gmail fixtures show `REDACTED` there, so the tests compare those values by name only.
