# 29: Message part encoding and charsets

- Task: #29 (story #28)
- Date run: (not run yet: waits for #163)
- Account: `<test-account>` (consumer)
- Run by: agent via #163

## Question

How does the Advanced Gmail Service return MIME part data (`payload.parts[].body.data`) from `threads.get` (`format: 'full'`): as a base64url string or a byte array, padded or not, with the Content-Transfer-Encoding already undone or not? How is it decoded to text in Apps Script, which has no `atob` or `TextDecoder` (SD §3), for UTF-8, ISO-8859-1, windows-1252, multibyte charsets, and missing or unknown charsets? How do header values (RFC 2047), attachments, a calendar invite, a forwarded `message/rfc822` part, and a large body appear?

The answers settle SD §8.3 ("Part data may arrive as a base64url string or as a byte array, and both must be handled") and feed E4: #76 (headers), #77 (attachment exclusion), #79 (decoding), #80 (MIME walker). The run also saves synthetic `threads.get` fixtures in `test/fixtures/gmail/` for E4's unit tests.

## How the test mail is made

All mail is synthetic and made in `<test-account>` itself. No outside sender is used (epic #7, option C).

| # | Scenario | How made | Main thing to check |
|---|----------|----------|---------------------|
| 1 | `text/plain` only, UTF-8, 7bit | insert (also the call-form probe, below) | Baseline: data form and padding |
| 2 | `text/html` only, UTF-8, quoted-printable | insert | Is the CTE already undone? |
| 3 | `multipart/alternative` (plain + HTML), UTF-8, base64 | insert | Part tree, `partId`s, CTE undone |
| 3b | Scenario 3's MIME again | import (`neverMarkSpam: true`) | Any insert/import difference |
| 4 | `multipart/mixed`: alternative body + PDF + small `.txt` attachment | insert | `filename`, `attachmentId`, `body.size`. Does a small attachment arrive inline? |
| 5 | `text/plain`, ISO-8859-1, quoted-printable | insert | Charset decode |
| 6 | `text/html`, windows-1252, quoted-printable | insert | Bytes 0x80–0x9F |
| 7 | Two `text/plain` parts: Shift_JIS and ISO-2022-JP, base64 | insert | Multibyte and stateful charsets |
| 8 | Two `text/plain` parts, **no** `charset`, 8bit: (a) UTF-8 bytes, (b) ISO-8859-1 bytes | insert | Which fallback is readable |
| 9 | Two `text/plain` parts: `charset="x-unknown"` and `charset=utf8`, both UTF-8 bytes | insert | Unknown and alias names |
| 10 | Subject (`=?UTF-8?B?…?=`, folded, two words), From (`=?ISO-8859-1?Q?…?=`), To (`=?UTF-8?Q?…?=`) | insert | Header values decoded or raw? |
| 11 | `text/plain` body of about 1 MB | insert | Inline, or behind an `attachmentId` with no `filename`? |
| 12 | HTML mail composed in Gmail's web UI, non-ASCII subject | maintainer (sent to self) | Same as 3 and 10 on Gmail-built MIME |
| 13 | Calendar invite: `multipart/mixed` → `multipart/alternative` (plain, HTML, `text/calendar; method=REQUEST`) + `application/ics` `invite.ics` | import (proxy) | How the `text/calendar` part appears |
| 14 | Scenario 12 forwarded as an attachment (`message/rfc822`) | maintainer (sent to self) | Inner message expanded into `parts`, or an attachment? |

Notes on the method:

- The spike builds each MIME message as **bytes**, so non-UTF-8 bodies really carry those charsets (`Utilities.newBlob('').setDataFromString(text, charset).getBytes()`, then base64, quoted-printable, or raw 8bit). The builder was checked locally: every scenario's MIME parses with Python's `email` package and decodes back to the source text (Node has no Shift_JIS or ISO-2022-JP encoder, so those two were checked for structure only).
- Every message uses `internalDateSource: 'dateHeader'` and a fixed `Date` header, so fixture dates are stable. Addresses are `@example.com` / `@example.org`.
- **Insert call forms.** Scenario 1 is inserted three ways, to record which the Advanced Service accepts: `raw` (`insert({raw: base64EncodeWebSafe(bytes), labelIds}, 'me', null, opts)`), `media` (`insert({labelIds}, 'me', <message/rfc822 blob>, opts)`), and `raw-noopts` (`insert({raw, labelIds}, 'me')`, no options). The rest use the first form that worked, falling back to the next. The name of the import method is also recorded (`import` is a JavaScript reserved word, and the Advanced Service renames some methods, for example `delete` to `remove`).
- **Scenario 13 is a proxy.** No real invite is delivered: it is imported MIME modelled on Google Calendar's structure. Part structure comes from the MIME, not from delivery. If the proxy leaves doubt, a real invite can be added later.
- **Scenario 14 forwards scenario 12, not scenario 1** (a change from the task text). That way both maintainer steps can be done before any spike has run, in one sitting, and the inner message is Gmail-built MIME with a non-ASCII subject, which is the more demanding case for E4's walker.
- Decode paths tried on each text part (from the task): **A** `newBlob(base64DecodeWebSafe(data)).getDataAsString(charset)`; **B** the same with padding stripped, and padded to a multiple of 4; **C** `newBlob(data).getDataAsString(charset)` for a byte array, and **C2** treating the array as the ASCII bytes of base64url text; **D** UTF-8, ISO-8859-1, and windows-1252 fallbacks. Each is compared with the known source text (normalized for line endings and trailing whitespace; `exact` records a byte-for-byte match too). For the UI scenarios, it checks for the marker `Größe café 日本`.
- `s29_utilitiesChecks()` needs no Gmail mail. It tests which charset names `getDataAsString` accepts (including aliases and unknown names), whether `base64DecodeWebSafe` needs padding, and whether byte arrays are signed.
- **Privacy.** The spike reads the account's address at run time (`getProfile`) only to remove it: every result is scrubbed and checked before it's returned. For fixtures, address headers that name the account are replaced whole (display name included) with `"Test Account" <test-account@example.com>`, and any body whose decoded text names the account is re-encoded without it (and noted).

## Spike functions

| Function | Args (JSON) | Returns |
|----------|-------------|---------|
| `s29_utilitiesChecks` | none | Charset-name table, padding checks, signed-byte check |
| `s29_createTestMessages` | `[force]` (default `false`) | `{insertForms, importMethodName, scenarios: {key: {id, threadId, method, labelIds, internalDate}}, errors}`. Saves `s29.threads`. Idempotent unless `force`. |
| `s29_inspect` | `[threadIdOrScenario]` (for example `["03b"]`) | Per message: `labelIds`, headers (Subject, From, To) and the raw MIME values; per part: `partId`, `mimeType`, `filename`, `attachmentId`?, `body.size`, header names, Content-Type/CTE/Disposition, `data` facts (`typeof`, `isArray`, length, first 8, padding, alphabet, min/max bytes), `attachments.get` facts, and decode attempts A–D |
| `s29_inspectAll` | none | `s29_inspect` for every scenario, including the probes and 12/14 (found by subject) |
| `s29_dumpFixture` | `[scenario, page, pageSize]` (defaults `0`, `250000`) | A page of the JSON text `{"fixture": …, "expected": …}` plus `page`, `pages`, `fileBase`, `scrubNotes` |
| `s29_reset` | none | Deletes the `s29.*` Script Properties (the mail stays) |

## Runbook

1. `node spikes/run.mjs push`.
2. `node spikes/run.mjs run s29_utilitiesChecks`. Fill in the charset table.
3. `node spikes/run.mjs run s29_createTestMessages`. Record the insert forms, import method name, and label IDs (3 vs 3b, 13).
4. Check that the maintainer steps below are done (they can be done before step 1). If not, ask for them in one comment on #29 and add `needs: maintainer`.
5. `node spikes/run.mjs run s29_inspectAll`. Fill in the per-part, headers, and structure tables. If the response is too large for `scripts.run`, run `s29_inspect` per scenario instead, and record the limit here.
6. For each scenario (`01` … `14`, `03b`): `node spikes/run.mjs run s29_dumpFixture '["NN", 0]'`, then pages 1 … `pages - 1`. Join the `json` strings, parse, and save `fixture` as `test/fixtures/gmail/NN-slug.json` and `expected` as `NN-slug.expected.json` (pretty-printed, two spaces). Check each file for the account address before committing (`grep -i` against `GMAIL_EMAIL`, without printing it).
7. Record whether `scripts.run` has a response-size limit (scenario 11's fixture is over 2 MB of JSON).
8. Fill in the results, conclusion, and date below. Update SD §8.3 and §12, and list the affected E4 issues in the PR.

## Maintainer steps

Two Gmail web UI actions, done once, signed in as `<test-account>`. Neither needs a spike to have run, so they can be done at any time.

1. **Compose (scenario 12).** Compose a new message to `<test-account>` (itself), with:
   - Subject, exactly: `s29-12 Größe café 日本`
   - Body, exactly: `Synthetic s29-12 body: bold words and a link. Größe café 日本.`, then make **bold words** bold and turn **a link** into a link to `https://example.com/`.
   - Send it. No other text, no signature, no attachments.
2. **Forward as attachment (scenario 14).** Open the `s29-12` message you just sent. In its **⋮ (More)** menu, choose **Forward as attachment**. Send it to `<test-account>` with subject, exactly: `s29-14 forward`, and an empty body.

## Results

(Filled in from the returned JSON after the run.)

### Insert and import

| Item | Result |
|------|--------|
| `raw` form (`insert(resource, 'me', null, opts)`) | |
| `media` form (`insert(resource, 'me', blob, opts)`) | |
| `raw-noopts` form (`insert(resource, 'me')`) | |
| Import method name on `Gmail.Users.Messages` | |
| Labels on inserted mail (scenario 3) | |
| Labels on imported mail (scenarios 3b, 13) | |
| Insert vs import differences (structure, `data` form, headers) | |

### Per part

| Scenario | partId | mimeType | Declared charset | CTE header | `filename`? | `attachmentId`? | `body.size` | `data` form | Padded? | CTE already undone? | Working decode path | Decoded text correct? |
|----------|--------|----------|------------------|------------|-------------|-----------------|-------------|-------------|---------|---------------------|---------------------|-----------------------|

### Charsets

| Charset name | `getDataAsString` result | Recommended handling |
|--------------|--------------------------|----------------------|

### Headers

| Scenario | Header | Raw value in the MIME | Value returned by the API |
|----------|--------|-----------------------|---------------------------|

### Structure notes

| Case | Observed |
|------|----------|
| Calendar invite (13) | |
| Forwarded message (14) | |
| Large body (11) | |
| Small attachment (4, `notes.txt`) | |
| `scripts.run` response size | |

## Raw output

<details><summary>s29_utilitiesChecks</summary>

</details>

<details><summary>s29_createTestMessages</summary>

</details>

<details><summary>s29_inspectAll</summary>

</details>

## Conclusion

(After the run.)

## Design changes

(After the run: SD §8.3 body and headers bullets, SD §12 fixtures row, and the E4 issues #76, #77, #79, #80.)
