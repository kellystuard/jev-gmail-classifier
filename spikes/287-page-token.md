# 287: A rejected `threads.list` page token

- Task: #287 (E8, epic #14; informs #134 and #135)
- Date run: 2026-10-01
- Account: `<test-account>` (consumer)
- Run by: agent, through `node spikes/run.mjs` (Node 22)

## Question

A manual job keeps a `threads.list` page token in `state.manual` between executions (E8, decision 6), and nobody has checked that a token still works later. So:

1. How does Gmail reject a token it doesn't accept: an error, and with what code, reason and text? Does the text carry the query?
2. Does a token from a real search still work 10 minutes later, and return the same page?
3. Does Gmail notice a token used with a different `q`?
4. Does a token look like a position (an opaque key) or an offset?

## Runbook

1. `node spikes/run.mjs push`
2. `node spikes/run.mjs run s287_start`: lists page 1 (`q: in:anywhere`, `includeSpamTrash: true`, `maxResults: 5`), reads page 2 with the returned token, saves `{savedAt, q, token, page IDs}` under `s287.saved`, and returns counts and the token's shape (length, digits only, the #134 character rule, equals a page 1 thread ID read as hexadecimal).
3. `node spikes/run.mjs run s287_garbage`: lists with `not-a-token`, `0`, `99999999999999999999`, an empty string, and the saved token with `q: in:inbox`.
4. At least 10 minutes after step 2: `node spikes/run.mjs run s287_check` (refuses under 10 minutes unless `{"force": true}`).
5. `node spikes/run.mjs run s287_cleanup`: deletes the `s287.` properties.

The spike is read-only: only `Gmail.Users.Threads.list` and Script Properties. It returns counts, booleans, lengths and error shapes, never mail content, a token, or the address.

## Maintainer steps

None.

## Results

| # | Scenario | What was done | Observed | Matches design? |
|---|----------|---------------|----------|-----------------|
| 1 | Token shape | `s287_start`: page 1 then page 2 | Both pages hold 5 threads and a `nextPageToken`. The token is 20 characters, all decimal digits, and matches `/^[!#-[\]-~]+$/`. It equals no page 1 thread ID read as hexadecimal. | Fits #134's rule (1 to 2,048 printable ASCII without `"` and `\`). |
| 2 | Garbage token | `pageToken: 'not-a-token'` | Throws: HTTP 400, reason `invalidArgument`, text `Invalid pageToken`; message `API call to gmail.users.threads.list failed with error: Invalid pageToken`. No query in the message. | Yes: the default matcher (400 and `pagetoken`) fits. |
| 3 | Large number | `pageToken: '99999999999999999999'` | The same 400 `Invalid pageToken`. | Yes. |
| 4 | Zero | `pageToken: '0'` | **No error**: an empty page (0 threads) with `hasNext: true`. | Not detectable by the adapter; the caller sees an empty page and a next token. |
| 5 | Empty string | `pageToken: ''` | No error: the same IDs as page 1. | Gmail treats it as no token. |
| 6 | Token with a different `q` | the saved token with `q: in:inbox` | No error: 5 threads, a next token, not the saved page 2. | Gmail doesn't bind a token to its `q`; the fake needn't either. |
| 7 | Token age 10.99 minutes | `s287_check` | `ok`, 5 threads, the same IDs as when fresh, a next token. No mail changed in between. | Yes: decision 6's token works at 11 minutes. |

Not tested: tokens older than 11 minutes (the session ended before the hour-later check), and a token after the mailbox changed.

## Raw output

<details><summary>Log</summary>

`s287_start`:

```json
{"q":"in:anywhere","maxResults":5,"page1Count":5,"hasNextPageToken":true,"page2Count":5,"page2HasNext":true,"tokenLength":20,"tokenAllDigits":true,"tokenMatchesPrintableAscii":true,"tokenEqualsPage1ThreadIdAsHex":false}
```

`s287_garbage` (error cases shown in full, `q` text absent):

```json
{"cases":[
 {"name":"not-a-token","ok":false,"code":400,"reasons":["invalidArgument"],"detailsMessage":"Invalid pageToken","message":"API call to gmail.users.threads.list failed with error: Invalid pageToken","hasDetails":true,"messageContainsQuery":false},
 {"name":"0","ok":true,"count":0,"hasNext":true,"sameAsPage1":false,"sameAsPage2":false},
 {"name":"99999999999999999999","ok":false,"code":400,"reasons":["invalidArgument"],"detailsMessage":"Invalid pageToken","message":"API call to gmail.users.threads.list failed with error: Invalid pageToken","hasDetails":true,"messageContainsQuery":false},
 {"name":"empty-string","ok":true,"count":5,"hasNext":true,"sameAsPage1":true,"sameAsPage2":false},
 {"name":"real-token-other-q","ok":true,"count":5,"hasNext":true,"sameAsPage1":false,"sameAsPage2":false}
]}
```

`s287_check` (started 06:38:45 UTC, run about 06:49:40 UTC):

```json
{"ok":true,"count":5,"hasNext":true,"sameAsPage1":false,"sameAsPage2":true,"sameIdsAsWhenFresh":true,"ageMinutes":10.99}
```

</details>

## Conclusion

- Gmail rejects a garbage token with an error: HTTP 400, reason `invalidArgument`, text `Invalid pageToken`. The text never carries `q`. The adapter maps it to `invalid_page_token` by code and text (with `details`) or by text alone.
- A token 11 minutes old returned the same IDs as when fresh. Longer ages are unverified.
- Gmail doesn't reject every bad token. `0` gives an empty page with a next token, and a token from another query gives that query's list from some position. So a caller can't rely on `invalid_page_token` to catch a token that is stale in a quieter way: #135 should keep its count of IDs already read and compare, not trust the error alone.
- The token is a 20-digit decimal number that is no thread ID. That `0` returns an empty page, not page 1, suggests a position (a key into the sort order), not an offset, but this is inferred and not proven.

## Design changes

- `GmailPort.searchThreadIds` can return `invalid_page_token`; `gmail-errors.ts` has the matcher (400 and `invalid pagetoken`); the fake and the two callers follow (this PR).
- SD §5.2, §6.3, §6.4, §9, §14 and `docs/smoke-test.md` updated.
- #135: see the third bullet of the conclusion. #134: the observed token fits its codec's bound.
