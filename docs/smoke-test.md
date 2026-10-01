Draft: #154 turns this into the release checklist.

Manual checks for the code that can't be unit-tested against a mocked Apps Script global (Engineering Standards §8). Each adapter has its own section, added by the task that writes it.

## Gmail adapter (GasGmailAdapter)

Since E7 (#121) the entry points use this adapter (`install` calls `getProfile`; `onTrigger` the rest), and the "Entry points" section below checks it end to end. The checks here call single methods with chosen arguments, so they run from a scratch function in the throwaway test account (see `spikes/README.md`). Never write the account's address anywhere (write `<test-account>`).

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
12. `searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, pageToken: 'not-a-token' })` returns `{ ok: false, kind: 'invalid_page_token', message }` (Gmail's text is "Invalid pageToken") and doesn't throw (spike 287). The same call with no `pageToken` is a normal search.

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

These run in a real deployment: since E7 (#121) every wired entry point builds a `GasStateAdapter` per execution. Each check is a step and the expected result. Use Project Settings → Script Properties to look at and edit properties, and the execution log to see the errors. Never write the test account's address anywhere (write `<test-account>`).

1. Run the classifier at least once (a trigger run or `install`). In Script Properties, every key the classifier wrote starts with `state.`, and every value is one line of JSON starting with `{"v":`. `JEV_API_KEY` and any `MANUAL_*` inputs are unchanged.
2. Edit `state.position` by hand to text that isn't JSON, for example `{"v":1,`. The next run fails with `StateError` and `reason: parse` in the log, and the log line has the key but not the stored text. The value is left exactly as edited (not reset). Restore it.
3. Edit `state.position` to `{"v":99}`. The next run fails with `StateError` and `reason: version`, and the value is left as is. Restore it.
4. With a full queue (E7 or E8 makes one), each `state.queue.<n>` value is at most 9 KB, and the shard numbers have no gaps after a run that finished.
5. Set `MANUAL_QUERY` by hand, then run `startManualRun` (E8). A started job deletes all four `MANUAL_*` properties (`MANUAL_QUERY`, `MANUAL_TIMESPAN`, `MANUAL_APPLY_MOVES`, `MANUAL_REPLACE`); a refused start leaves them.
6. Set `RESET_POSITION=true` by hand, then run `install` (E7). `state.position` is reset, and `install` honors the input.

## UTF-8 decoder (gasDecodeUtf8)

Since E7 (#121) `onTrigger` decodes every body with it, so check 6 also runs end to end in the "Entry points" section. Checks 1–5 call it with chosen bytes, so they run from a scratch function in the throwaway test account (`spikes/README.md`). Each check is a call and the expected result. Never write the test account's address anywhere (write `<test-account>`).

1. `gasDecodeUtf8([])` returns `''`.
2. `gasDecodeUtf8([72, 105])` returns `'Hi'`.
3. `gasDecodeUtf8([-61, -87, -26, -105, -91, -16, -97, -103, -126])` returns `'é日🙂'` (length 4 in UTF-16: the emoji is a surrogate pair).
4. `gasDecodeUtf8([-17, -69, -65, 65])` returns a string of length 2 starting with U+FEFF. If Apps Script drops the BOM instead, change `nodeDecodeUtf8` to match and record it here.
5. `gasDecodeUtf8([-1])` returns `'\uFFFD'` (the replacement character) and doesn't throw.
6. On a `getThread(id, { format: 'full' })` of a message with a non-UTF-8 declared charset (for example spike 29's scenario 05), decoding its part's `body.data` gives readable text (`café`, not `cafÃ©`).

## HTTP and secrets adapters (GasHttpAdapter, GasSecretsAdapter)

Since E7 (#121) `onTrigger` uses both (and `install` the secrets adapter), so checks 3 and 6 also run end to end in the "Entry points" section. The checks here send chosen requests, so they run from a scratch function in the throwaway test account (`spikes/README.md`). Each check is a call and the expected result. `spikes/94-fetch-all.md` recorded what `UrlFetchApp` does underneath. Never write the test account's address anywhere (write `<test-account>`), and never paste the key, an `Authorization` header or a response body that echoes a request into an issue or a log.

The "Jev request" below is `{ url: 'https://api.typesafe.ai/v1/systemone', method: 'post', headers: {}, contentType: 'application/json', payload: <a minimal synthetic JSON body with one noul question> }`.

1. `sendAll([])` returns `[]`.
2. `sendAll([<Jev request>])` (no `Authorization` header) returns `[{ ok: true, status: 403, … }]` (Jev's "no key" answer: spike #94 and `test/fixtures/jev/`), every header name is lower-case (`content-type`, `x-typesafe-request-id`, `set-cookie`), and `body` is the JSON text `{"detail":{"error_type":"authentication_error",…}}`.
3. With the real key from Script Properties in `headers: { Authorization: 'Bearer ' + key }`, the same request returns status 200, an `x-typesafe-request-id` header, and a body with `usage.input_tokens`.
4. `sendAll([<Jev request>, { url: 'https://jev-smoke.invalid/', method: 'get', headers: {} }, { url: 'https://www.google.com/generate_204', method: 'get', headers: {} }])` returns three `{ ok: false, kind: 'transport', message: 'DNS error: https://jev-smoke.invalid/' }` results and doesn't throw. No `message` contains `Bearer`, the key, or the payload.
5. `sendAll([{ url: 'https://google.com/', method: 'get', headers: {} }])` returns status 301 with a `location` header, not the redirected page.
6. `new GasSecretsAdapter().getJevApiKey()`: with `JEV_API_KEY` unset → `undefined`; set to `'   '` → `undefined`; set to `' test-key '` → `'test-key'`. Restore the real key afterwards.
7. Not observed (accepted v1 risk, SD §14): with `script.external_request` unticked at consent, every result is `{ ok: false, kind: 'scope' }` and nothing throws.

## Script lock adapter (GasLockAdapter)

Checks 1–6 call the adapter directly, from a scratch function in the throwaway test account (`spikes/README.md`); check 7 runs through the entry points, which use the adapter since E7 (#121). Each check is a call and the expected result. Checks 3 and 4 need two executions at the same time: start one from the editor and the other with `node spikes/run.mjs run`, or from two terminals. Never write the test account's address anywhere (write `<test-account>`).

1. With no other execution running, `new GasLockAdapter().tryAcquire()` returns `true`.
2. In the same execution, a second `tryAcquire()` on the same adapter returns `true` (re-entrant for the holder, as `FakeLock` models). If it returns `false`, change `FakeLock` to match and record it here.
3. Execution A calls `tryAcquire()` (`true`), then `Utilities.sleep(60000)`, then `release()`. While A sleeps, execution B calls `tryAcquire()`: it returns `false` in well under a second (B's execution log shows no wait). After A finishes, B's next `tryAcquire()` returns `true`.
4. While A holds the lock, B calls `release()` on its own adapter: nothing throws, and A still holds the lock (a third execution's `tryAcquire()` still returns `false`).
5. Execution A calls `tryAcquire()` (`true`) and then throws without releasing. A following execution's `tryAcquire()` returns `true`: Apps Script freed the lock when A ended.
6. `release()` on a fresh adapter (no `tryAcquire()` first), and a second `release()` after a release, don't throw.
7. Through the entry points: run `install` from the editor while a scheduled `onTrigger` run is in progress (or run the check-3 sleeper first); the log shows `run.skipped` with `reason: busy` and nothing else for that execution.

## Trigger adapter (GasTriggerAdapter)

Since E7 (#121) `install` calls `replaceRecurringTrigger('onTrigger', triggerIntervalMinutes)` and `uninstall` calls `deleteTriggers('onTrigger')`, so checks 1–4 run through those entry points. Check 5 needs both calls in one execution, so it runs from a scratch function in the throwaway test account (`spikes/README.md`). Check the results on the editor's **Triggers** page. Never write the test account's address anywhere (write `<test-account>`).

1. With no triggers and `triggerIntervalMinutes: 10`, `install` returns `triggerMinutes: 10`, and the Triggers page shows exactly one time-driven `onTrigger` trigger, every 10 minutes.
2. Set `triggerIntervalMinutes: 5`, `npm run push`, and run `install` again: there is still exactly one `onTrigger` trigger, now every 5 minutes. Set it back to 10 and push again.
3. Create a second `onTrigger` trigger and one for `smokeOther` by hand (`ScriptApp.newTrigger(...).timeBased().everyHours(1).create()`). `install` leaves exactly one `onTrigger` trigger (every 10 minutes) and the `smokeOther` one untouched.
4. `uninstall` returns `triggersDeleted: 1`, and `smokeOther` is still there. A second `uninstall` returns `triggersDeleted: 0`.
5. In **one** scratch execution, `new GasTriggerAdapter()`'s `replaceRecurringTrigger('onTrigger', 10)` then `deleteTriggers('onTrigger')` returns `{ ok: true, deleted: 1 }` with no HTTP 500 (the pitfall from E1 #163 is avoided).
6. Not observed (accepted v1 risk, SD §14): with `script.scriptapp` unticked at consent, both methods return `{ ok: false, kind: 'scope' }` and don't throw.

Afterwards, delete the `smokeOther` trigger.

## Auth adapter (GasAuthAdapter)

Since E7 (#121) `install` (both methods) and `onTrigger` (the scope check) use it, so the checks run through those entry points. A scratch function in the throwaway test account can call `new GasAuthAdapter()` directly to see the raw result. Write `<test-account>`, never the address.

1. With all four scopes granted, `install` returns `missingScopes: []`, and neither `install` nor `onTrigger` logs `scope_missing`. (Directly: `new GasAuthAdapter().missingScopes()` returns `{ ok: true, missing: [] }` and doesn't throw.)
2. Not observed (accepted v1 risk, SD §14; partly granted states): with one scope unticked at consent, `missing` is exactly that scope. With `script.scriptapp` unticked, record whether it returns `missing: ['https://www.googleapis.com/auth/script.scriptapp']` or `{ ok: false, kind: 'unknown' }`. In no state does it throw.
3. With all four scopes granted, `requireScopes(INSTALL_REQUIRED_SCOPES)` returns without throwing, and `install` goes on.
4. Not observed (accepted v1 risk, SD §14; partly granted states): running `install` from the editor with `gmail.modify`, `script.external_request` or `script.scriptapp` unticked shows the consent screen again (or throws an authorization error with a link to it), and `install` writes nothing. With only `script.send_mail` unticked, `install` finishes and its report lists it in `missingScopes`.

## Mail adapter (GasMailAdapter)

The adapter is wired by #303, and the "Alerts" section checks it end to end. These checks call `send` with chosen arguments from a scratch function in the throwaway test account (`spikes/README.md`). They have not been run live yet: E10 (#154) runs them. Never write the test account's address anywhere (write `<test-account>`).

1. `new GasMailAdapter().send('<test-account>', '[Jev Gmail Classifier] Smoke test', 'Line 1\nLine 2')` returns `{ ok: true }`. The email arrives in the account's own mailbox: the sender shows as `Jev Gmail Classifier` with the account's own address, the subject is exact, and the body is plain text with the line break kept. It has no HTML styling and no attachment.
2. Record what Gmail does with that self-sent message: its labels (`INBOX`, `SENT`, `UNREAD`?) and whether it is its own thread.
3. Send the same subject twice: record whether the second email joins the first one's thread or starts a new one.
4. A body with non-ASCII text (`café … 日本`) and a 5,000-character body arrive unchanged.
5. `send('not-an-address', 'x', 'y')` throws `UnexpectedResponseError` with `service: 'mail'`. Record Apps Script's exact text. The error's message has `<recipient>` in place of the address.
6. Not observed (accepted v1 risk, SD §14): with `script.send_mail` unticked at consent, `send` returns `{ ok: false, kind: 'scope' }` and doesn't throw. If this state is ever run, record the exact error text here, in SD §9 and in `scope-errors.ts`.
7. Not tested (don't exhaust the quota): past the daily email quota, `send` returns `{ ok: false, kind: 'quota' }`. `MailApp.getRemainingDailyQuota()` in a scratch function shows what is left (about 100 a day on a consumer account). If the real text is ever seen, record it here and in `mail-errors.ts`.

## Clock, random and log adapters (GasClockAdapter, GasRandomAdapter, GasLogAdapter)

Every wired entry point builds these per execution (E7, #121), so the checks read the log of an entry-point run (the editor's **Executions** page, or the log pane after running from the editor). The log adapter's line format is also unit-tested (`test/adapters/gas/gas-log-adapter.test.ts`). It is minimal until E9 (#142) adds `redact`. Never write the test account's address anywhere (write `<test-account>`).

1. Every line an entry point writes is one JSON object that starts with `event`, `runId`, `entry` and `ts`, at the event's level (`info`, `warn` or `error`).
2. All the lines of one execution share one `runId` (a UUID), and two executions have different ones. `entry` is the entry point's name (`onTrigger`, `install`, `uninstall`, `startManualRun`, `continueManualRun` or `cancelManualRun`).
3. `ts` is an ISO 8601 time in UTC (`…Z`) within the execution's start and end (the clock adapter's `Date.now()`).
4. The time zone: `state.gmailCalls`'s `day` and `state.budget`'s day follow `timeZone` in `appsscript.json` (`Session.getScriptTimeZone()`), not UTC. With `timeZone` set to a zone far from UTC, a run just after local midnight starts a new `day`.
5. The sleep and the jitter (only if Jev answers 429 or 503 during the pilot; skip it otherwise): a `jev.batch` line with `rounds` > 1 has `sleptMs` > 0, and the execution lasts at least that long (`Utilities.sleep`, with the random adapter's jitter in the delay).
6. No line contains a message body, the API key, an `Authorization` header or a request's `state`.

## Entry points

The composition root (`src/entry/main.ts`, E7 #121) wires `install`, `onTrigger` and `uninstall`. E8 (#288) wires `startManualRun`, `continueManualRun` and `cancelManualRun` the same way; the "Manual runs" section below checks them. Run this on the throwaway test account only (ADR-0016), with synthetic mail only (a made-up sender at `example.test`, sent or imported into `<test-account>`). Never write the test account's address anywhere. Push with `npm run push` from a `config.yaml` with `triggerIntervalMinutes: 10` and one label rule that fires on the synthetic message (for example "Is this a test message from example.test?"), and set `JEV_API_KEY` in Script Properties. E10 (#154) uses this section; it has not been run live yet.

1. **Install.** Run `install` from the editor. It returns `{ entry: 'install', status: 'ok', position: 'set', historyId, triggerMinutes: 10, missingScopes: [] }`. The Triggers page shows one `onTrigger` trigger, every 10 minutes. Script Properties has `state.position`, `state.installedAt` and `state.gmailCalls`. The log has `run.start` and `run.end` for `install`, and no `run.failed`.
2. **Install again.** A second `install` returns `position: 'kept'` with the same `historyId`, and there is still one trigger.
3. **A scheduled run.** Deliver one synthetic message. Wait for the next `onTrigger`, or run it from the editor: it returns `{ entry: 'onTrigger', status: 'ok', stopped, summary, alerts: [] }`. The log has `run.start`, `thread.classified` for the thread (with the rule's probability), and `run.end` with `ingested` ≥ 1 and `classified: 1`. The thread has the rule's label. `state.runs` has `lastOutcome: 'ok'` and `consecutiveFailures: 0`.
4. **Nothing new.** Another `onTrigger` with no new mail returns `stopped: 'drained'`; its `run.end` has `ingested: 0` and `classified: 0`.
5. **Two at once.** Start two `onTrigger` executions at the same time (one from the editor and one with `node spikes/run.mjs run onTrigger`, or one from the editor during a scheduled run). One returns `{ entry: 'onTrigger', status: 'skipped', reason: 'busy' }` and logs exactly one line, `run.skipped`. The other runs normally.
6. **Missing key.** Delete `JEV_API_KEY` from Script Properties and run `onTrigger`. The execution shows as **Failed**. Right after `run.start`, the log has `run.failed` with `error: 'RunAbortError'`, `reason: 'missing_key'` and `alerts: ['auth']` (no Gmail or Jev call came first). `state.runs` has `lastOutcome: 'failed'` and `consecutiveFailures: 1`, and no thread is marked. Restore the key: the next run sets `consecutiveFailures` back to 0.
7. **Uninstall.** Run `uninstall`. It returns `{ entry: 'uninstall', status: 'ok', triggersDeleted: 1, keysDeleted }`. The Triggers page has no `onTrigger` trigger, and Script Properties has no `state.*` key (nothing is written after the delete). `JEV_API_KEY` and the Gmail labels (the rule's, and `Jev/Error` if any) are still there.
8. **After uninstall.** Run `onTrigger` from the editor: it fails with `StateError` (`state.position` is missing: install writes it). Run `install` to set it up again, or `uninstall` once more to remove the `state.runs` that run wrote.

Afterwards, delete the synthetic threads and the rule's label.

## Manual runs

The entry points `startManualRun`, `continueManualRun` and `cancelManualRun` (E8, #288), and the manual spare-time hook in `onTrigger`. Run this on the throwaway test account only (ADR-0016), with synthetic mail only (a made-up sender at `example.test`, sent or imported into `<test-account>`). Never write the test account's address anywhere. Push with `npm run push` from a `config.yaml` with `triggerIntervalMinutes: 10`, one label rule that fires on the synthetic mail, one `archive` move rule, and an `excludeQuery` that matches one marked thread; `install` it and set `JEV_API_KEY`. It has not been run live yet; E10 (#154) runs it.

1. **No inputs.** With no `MANUAL_*` property, run `startManualRun`. It returns `{ entry: 'startManualRun', status: 'rejected', reason: 'no_input' }`. The execution is **Completed**, the log has `manual.rejected` (at `warn`) and no `run.end`, and there is no `state.manual`.
2. **Bad timespan.** Set `MANUAL_QUERY` and `MANUAL_TIMESPAN=1m`, then run `startManualRun`: `rejected`, `reason: 'invalid_timespan'`, and both properties are still there.
3. **A job over about 30 threads.** Import about 30 synthetic threads. Set `MANUAL_QUERY` (a query that matches them) and `MANUAL_TIMESPAN=7d`, then run `startManualRun`. The log has `manual.started` with the exact final query `(<query>) after:<seconds>`, and all four `MANUAL_*` properties are deleted. The threads get the label rule's label. The log has `manual.progress`, then `manual.completed` with `labels` counts, and `state.manual` is gone.
4. **Labels only.** Without `MANUAL_APPLY_MOVES`, a firing move rule moves nothing: the threads stay in the inbox.
5. **With moves.** Repeat with `MANUAL_APPLY_MOVES=true` and the `archive` rule firing: the threads leave the inbox, and `manual.completed` has `moves.archive`.
6. **Exclusion.** A thread that matches `excludeQuery` is logged as `thread.excluded`, is never sent to Jev, and is counted in `excluded`. The query in `manual.started` does not contain `excludeQuery`.
7. **`Jev/Error`.** A thread labelled `Jev/Error` is logged as `thread.skipped` with `reason: 'jev_error'`.
8. **An unfinished job.** Delete `JEV_API_KEY`, set `MANUAL_QUERY` and run `startManualRun`. The job is saved (`state.manual` exists), the execution is **Failed**, and `run.failed` has `reason: 'missing_key'`. Restore the key.
9. **A second start.** With that job unfinished, set `MANUAL_QUERY` and start again: `rejected`, `reason: 'job_unfinished'`, and the properties are kept. Add `MANUAL_REPLACE=true`: `manual.cancelled` with `reason: 'replaced'`, then `manual.started` with `replaced: true`.
10. **Spare time.** With a job unfinished and the trigger installed, the next `onTrigger` logs `manual.progress`, and its `run.end` has `spare`.
11. **Continue.** Run `continueManualRun`: more of the job is done (`{ entry: 'continueManualRun', status: 'ok', job, stopped, summary }`). Run it while another execution holds the lock: `{ entry: 'continueManualRun', status: 'skipped', reason: 'busy' }`.
12. **Cancel.** Run `cancelManualRun` on an unfinished job: `{ entry: 'cancelManualRun', status: 'ok', cancelled: true, removed }`. `state.manual` is gone, no manual item is left in `state.queue.*`, and the labels already applied are still there. The log has `manual.cancelled` and no `run.end`; `state.runs` is unchanged. Run it again: `cancelled: false, removed: 0`.
13. **No job.** Run `continueManualRun` with no job: `job: 'none'`, `stopped: 'no_job'`, and `run.end` has `stopped: 'no_job'`.
14. **Optional, over 300 matching threads.** The job needs several executions, and a later one continues from the saved page token: `seen` grows in `manual.progress`, and there is no `manual.cursor_reset`.

Afterwards, delete the synthetic threads and the rule's labels.
