Draft: #154 turns this into the release checklist.

Manual checks for the code that can't be unit-tested against a mocked Apps Script global (Engineering Standards §8). Each adapter has its own section, added by the task that writes it.

## Gmail adapter (GasGmailAdapter)

These run through the product's entry points once E7 wires the adapter. Until then they're a draft: run them from a scratch function in the throwaway test account (see `spikes/README.md`), and never write the account's address anywhere (write `<test-account>`).

Each check gives the call and the expected result.

1. `getProfile()` returns `{ ok: true, emailAddress, historyId }`: the owner's address and a `historyId` of digits.
2. Send yourself a message, then `listHistory({ startHistoryId: <step 1's historyId>, historyTypes: ['messageAdded'] })` returns a record whose `messagesAdded[0].message` is that message, and a `historyId` of digits.
3. After two more self-sends, the same call with `maxResults: 1` returns a `nextPageToken`, and following it (passing `pageToken`) returns the next record. The last page has no `nextPageToken`.
4. Listing from a record's `id` returns only the records after it.
5. Listing from `startHistoryId: '1'` returns `{ ok: false, kind: 'history_expired' }` and doesn't throw.
6. With nothing new since the position, `records` is `[]`.
7. Not observed (accepted v1 risk, SD §14): with `gmail.modify` unticked at consent, a call returns `{ ok: false, kind: 'scope' }` and doesn't throw.

### Thread search and reads (`searchThreadIds`, `getThread`)

Same setup. Use a mailbox with at least 3 threads in the inbox, and keep the IDs from one check for the next.

1. `searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, maxResults: 2 })` returns `{ ok: true, threadIds }` with 2 IDs and a `nextPageToken`. Calling it again with `pageToken: <that token>` returns the next IDs, and none repeats an ID from the first page. Following the tokens ends on a page with no `nextPageToken` (the key is absent, not empty).
2. `searchThreadIds({ q: 'in:inbox', includeSpamTrash: false })` with no `maxResults` still works, and `resultSizeEstimate`, snippets and history IDs aren't in the result.
3. A query that matches nothing (for example `q: 'subject:jev-smoke-no-such-subject-91f3'`) returns `threadIds: []` and no `nextPageToken`.
4. Trash one thread whose only matching message is the one you search for. `searchThreadIds` for that message with `includeSpamTrash: false` doesn't return it, and with `includeSpamTrash: true` does (spike 23, D1).
5. `getThread(id, { format: 'metadata', metadataHeaders: ['Date'] })` returns every message of the thread with `id`, `labelIds` and `internalDate` (a string), only the `Date` header in `payload.headers`, and no body `data`.
6. `getThread(id, { format: 'full' })` returns payloads whose `body.data` is an array of numbers (signed bytes), not a string, and `internalDate` is still a string.
7. `getThread(id, { format: 'minimal' })` returns messages with `id`, `threadId`, `labelIds` and `internalDate`, and no `payload`.
8. `getThread` on a thread that has a Trash or Spam message returns that message too, with `TRASH` or `SPAM` in its `labelIds` (SD §14).
9. `getThread` on a thread deleted forever in the Gmail UI returns `{ ok: false, kind: 'not_found' }` and doesn't throw.
10. `getThread('not-a-thread-id', { format: 'minimal' })` throws `UnexpectedResponseError` (`service: 'gmail'`, `status: 400`; note the status if it differs), and the error holds no header text.
11. Not observed (accepted v1 risk, SD §14): with `gmail.modify` unticked at consent, both methods return `{ ok: false, kind: 'scope' }` and don't throw.

### Labels and moves (`listLabels`, `createLabel`, `modifyThread`)

Same setup. Import synthetic threads first (for example with `Gmail.Users.Messages.import`, from a made-up sender at `example.test`), and make sure no label named `JevSmoke` or starting with `JevSmoke/` exists. Keep the IDs from one check for the next.

1. `listLabels()` returns `{ ok: true, labels }` in one response (no paging): system labels (IDs such as `INBOX`, `SPAM`) and user labels (`Label_<n>`), each with an `id` and a `name`.
2. `createLabel('JevSmoke/A/B')` returns `{ ok: true, label }` with a `Label_<n>` ID and the name `JevSmoke/A/B`. `listLabels()` then shows only that leaf: no `JevSmoke` or `JevSmoke/A` was created.
3. `createLabel('JevSmoke/A/B')` again, and `createLabel('jevsmoke / a / b')`, each return `{ ok: false, kind: 'label_exists', message }` and don't throw.
4. `createLabel('Inbox')` returns `{ ok: false, kind: 'invalid_label_name', message }` and doesn't throw.
5. `modifyThread(id, { addLabelIds: [<step 2's ID>], removeLabelIds: [] })` returns `{ ok: true }`, and every message of the thread has the label. Repeating it returns `{ ok: true }` and changes nothing.
6. `modifyThread` with a label **name** (`'JevSmoke/A/B'`) in `addLabelIds`, and with `'Label_999999999'`, each return `{ ok: false, kind: 'invalid_label', message }`, and the thread is unchanged.
7. On four fresh synthetic threads, each call returns `{ ok: true }` and the labels match SD §6.5:
   - archive: `removeLabelIds: ['INBOX']`; the thread leaves the inbox and keeps its other labels;
   - label move: add step 2's ID and remove `INBOX`;
   - spam: add `SPAM` and remove `INBOX`; user labels are kept;
   - trash: add `TRASH` only; `INBOX` goes too, and user labels are kept.
8. `modifyThread` on a thread deleted forever in the Gmail UI returns `{ ok: false, kind: 'not_found' }` and doesn't throw.
9. Not observed (accepted v1 risk, SD §14): with `gmail.modify` unticked at consent, each of the three methods returns `{ ok: false, kind: 'scope' }` and doesn't throw.

Afterwards, delete the `JevSmoke` labels and the synthetic threads.

## Script Properties adapter (GasStateAdapter)

These run in a real deployment once E7 wires `new GasStateAdapter()` into `src/entry/`. Until then nothing calls the adapter. Each check is a step and the expected result. Use Project Settings → Script Properties to look at and edit properties, and the execution log to see the errors. Never write the test account's address anywhere (write `<test-account>`).

1. Run the classifier at least once (a trigger run or `install`). In Script Properties, every key the classifier wrote starts with `state.`, and every value is one line of JSON starting with `{"v":`. `JEV_API_KEY` and any `MANUAL_*` inputs are unchanged.
2. Edit `state.position` by hand to text that isn't JSON, for example `{"v":1,`. The next run fails with `StateError` and `reason: parse` in the log, and the log line has the key but not the stored text. The value is left exactly as edited (not reset). Restore it.
3. Edit `state.position` to `{"v":99}`. The next run fails with `StateError` and `reason: version`, and the value is left as is. Restore it.
4. With a full queue (E7 or E8 makes one), each `state.queue.<n>` value is at most 9 KB, and the shard numbers have no gaps after a run that finished.
5. Set `MANUAL_QUERY` by hand, then run `startManualRun` (E8). It reads the value and deletes the property afterwards.
6. Set `RESET_POSITION=true` by hand, then run `install` (E7). `state.position` is reset, and `install` honors the input.

## UTF-8 decoder (gasDecodeUtf8)

These run from a scratch function in the throwaway test account (`spikes/README.md`) until E7 wires `gasDecodeUtf8` into `src/entry/`. Each check is a call and the expected result. Never write the test account's address anywhere (write `<test-account>`).

1. `gasDecodeUtf8([])` returns `''`.
2. `gasDecodeUtf8([72, 105])` returns `'Hi'`.
3. `gasDecodeUtf8([-61, -87, -26, -105, -91, -16, -97, -103, -126])` returns `'é日🙂'` (length 4 in UTF-16: the emoji is a surrogate pair).
4. `gasDecodeUtf8([-17, -69, -65, 65])` returns a string of length 2 starting with U+FEFF. If Apps Script drops the BOM instead, change `nodeDecodeUtf8` to match and record it here.
5. `gasDecodeUtf8([-1])` returns `'\uFFFD'` (the replacement character) and doesn't throw.
6. On a `getThread(id, { format: 'full' })` of a message with a non-UTF-8 declared charset (for example spike 29's scenario 05), decoding its part's `body.data` gives readable text (`café`, not `cafÃ©`).

## HTTP and secrets adapters (GasHttpAdapter, GasSecretsAdapter)

These run from a scratch function in the throwaway test account (`spikes/README.md`) until E7 wires `new GasHttpAdapter()` and `new GasSecretsAdapter()` into `src/entry/`. Each check is a call and the expected result. `spikes/94-fetch-all.md` recorded what `UrlFetchApp` does underneath. Never write the test account's address anywhere (write `<test-account>`), and never paste the key, an `Authorization` header or a response body that echoes a request into an issue or a log.

The "Jev request" below is `{ url: 'https://api.typesafe.ai/v1/systemone', method: 'post', headers: {}, contentType: 'application/json', payload: <a minimal synthetic JSON body with one noul question> }`.

1. `sendAll([])` returns `[]`.
2. `sendAll([<Jev request>])` (no `Authorization` header) returns `[{ ok: true, status: 403, … }]` (Jev's "no key" answer: spike #94 and `test/fixtures/jev/`), every header name is lower-case (`content-type`, `x-typesafe-request-id`, `set-cookie`), and `body` is the JSON text `{"detail":{"error_type":"authentication_error",…}}`.
3. With the real key from Script Properties in `headers: { Authorization: 'Bearer ' + key }`, the same request returns status 200, an `x-typesafe-request-id` header, and a body with `usage.input_tokens`.
4. `sendAll([<Jev request>, { url: 'https://jev-smoke.invalid/', method: 'get', headers: {} }, { url: 'https://www.google.com/generate_204', method: 'get', headers: {} }])` returns three `{ ok: false, kind: 'transport', message: 'DNS error: https://jev-smoke.invalid/' }` results and doesn't throw. No `message` contains `Bearer`, the key, or the payload.
5. `sendAll([{ url: 'https://google.com/', method: 'get', headers: {} }])` returns status 301 with a `location` header, not the redirected page.
6. `new GasSecretsAdapter().getJevApiKey()`: with `JEV_API_KEY` unset → `undefined`; set to `'   '` → `undefined`; set to `' test-key '` → `'test-key'`. Restore the real key afterwards.
7. Not observed (accepted v1 risk, SD §14): with `script.external_request` unticked at consent, every result is `{ ok: false, kind: 'scope' }` and nothing throws.

## Script lock adapter (GasLockAdapter)

These run from a scratch function in the throwaway test account (`spikes/README.md`) until E7 wires `new GasLockAdapter()` into `src/entry/` (#121); after that, through the entry points. Each check is a call and the expected result. Checks 3 and 4 need two executions at the same time: start one from the editor and the other with `node spikes/run.mjs run`, or from two terminals. Never write the test account's address anywhere (write `<test-account>`).

1. With no other execution running, `new GasLockAdapter().tryAcquire()` returns `true`.
2. In the same execution, a second `tryAcquire()` on the same adapter returns `true` (re-entrant for the holder, as `FakeLock` models). If it returns `false`, change `FakeLock` to match and record it here.
3. Execution A calls `tryAcquire()` (`true`), then `Utilities.sleep(60000)`, then `release()`. While A sleeps, execution B calls `tryAcquire()`: it returns `false` in well under a second (B's execution log shows no wait). After A finishes, B's next `tryAcquire()` returns `true`.
4. While A holds the lock, B calls `release()` on its own adapter: nothing throws, and A still holds the lock (a third execution's `tryAcquire()` still returns `false`).
5. Execution A calls `tryAcquire()` (`true`) and then throws without releasing. A following execution's `tryAcquire()` returns `true`: Apps Script freed the lock when A ended.
6. `release()` on a fresh adapter (no `tryAcquire()` first), and a second `release()` after a release, don't throw.
7. Once #121 has merged (entry points): run `install` from the editor while a scheduled `onTrigger` run is in progress (or run the check-3 sleeper first); the log shows `run.skipped` with `reason: busy` and nothing else for that execution.

## Auth adapter (GasAuthAdapter)

This runs through `install` / `onTrigger` once E7 (#121) wires `new GasAuthAdapter()` into `src/entry/main.ts`; until then, from a scratch function in the throwaway test account. Write `<test-account>`, never the address.

1. With all four scopes granted, `new GasAuthAdapter().missingScopes()` returns `{ ok: true, missing: [] }` and doesn't throw.
2. Not observed (accepted v1 risk, SD §14; partly granted states): with one scope unticked at consent, `missing` is exactly that scope. With `script.scriptapp` unticked, record whether it returns `missing: ['https://www.googleapis.com/auth/script.scriptapp']` or `{ ok: false, kind: 'unknown' }`. In no state does it throw.
3. With all four scopes granted, `requireScopes(INSTALL_REQUIRED_SCOPES)` returns without throwing, and `install` goes on.
4. Not observed (accepted v1 risk, SD §14; partly granted states): running `install` from the editor with `gmail.modify`, `script.external_request` or `script.scriptapp` unticked shows the consent screen again (or throws an authorization error with a link to it), and `install` writes nothing. With only `script.send_mail` unticked, `install` finishes and its report lists it in `missingScopes`.
