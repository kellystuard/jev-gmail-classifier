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
7. Not observed yet (#125): with `gmail.modify` unticked at consent, a call returns `{ ok: false, kind: 'scope' }` and doesn't throw.

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
11. Not run until #125: with `gmail.modify` unticked at consent, both methods return `{ ok: false, kind: 'scope' }` and don't throw.

## Script Properties adapter (GasStateAdapter)

These run in a real deployment once E7 wires `new GasStateAdapter()` into `src/entry/`. Until then nothing calls the adapter. Each check is a step and the expected result. Use Project Settings → Script Properties to look at and edit properties, and the execution log to see the errors. Never write the test account's address anywhere (write `<test-account>`).

1. Run the classifier at least once (a trigger run or `install`). In Script Properties, every key the classifier wrote starts with `state.`, and every value is one line of JSON starting with `{"v":`. `JEV_API_KEY` and any `MANUAL_*` inputs are unchanged.
2. Edit `state.position` by hand to text that isn't JSON, for example `{"v":1,`. The next run fails with `StateError` and `reason: parse` in the log, and the log line has the key but not the stored text. The value is left exactly as edited (not reset). Restore it.
3. Edit `state.position` to `{"v":99}`. The next run fails with `StateError` and `reason: version`, and the value is left as is. Restore it.
4. With a full queue (E7 or E8 makes one), each `state.queue.<n>` value is at most 9 KB, and the shard numbers have no gaps after a run that finished.
5. Set `MANUAL_QUERY` by hand, then run `startManualRun` (E8). It reads the value and deletes the property afterwards.
6. Set `RESET_POSITION=true` by hand, then run `install` (E7). `state.position` is reset, and `install` honors the input.
