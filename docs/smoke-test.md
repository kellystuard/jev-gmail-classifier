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
