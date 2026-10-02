# Smoke test: the release checklist

This is the checklist that verifies the Apps Script adapters and the six entry points in a real Gmail account. The adapters in `src/adapters/gas/` are thin and are not unit-tested with mocked Apps Script globals: that would test the mock, not the platform ([Engineering Standards §8](../output/engineering-standards.md#8-testing), [Solution Design §12](../output/solution-design.md#12-testing-architecture)). This checklist is the only place they are verified.

- **When it is run:** before each release, and after any change to an adapter.
- **Where:** on a throwaway test account only, never on a real mailbox ([ADR-0016](../output/adr/0016-run-spikes-from-agents-and-a-manual-workflow.md)). The account is written `<test-account>` everywhere. Its address is never written down.
- **Who:** a person in the Apps Script editor, or an agent through the spike runner (`spikes/README.md`). The checks are written for both.
- **Results:** one row per check ID in `docs/smoke-test-results.md` ("the results" below), in a new dated section for each run: pass, fail (with the bug's number), or not run (with the reason).
- **It passes** when every **required** check has its expected result. A failed check is a bug: it is filed, fixed in its own PR, and the section is run again. An expected result is never changed to make a check pass. If a check is wrong against the code and the Solution Design, correct the check in a PR that gives the reason.

Run it from top to bottom. The sections are ordered so that the config is rebuilt as few times as possible.

## How to read a check

Each check is one row: **ID**, **Marking**, **Who**, **Do**, **Expect**.

- **ID.** A section letter and a number (`K5`, `N12`). An ID is unique and is never reused: a removed check's ID is retired, and a new check takes the next free number in its section.
- **Marking.** Every check has exactly one:
  - **required**: it must pass for the release.
  - **not observed**: an accepted v1 risk. It needs a partly granted install (some permissions left unticked at consent) or an exhausted daily email quota, and nobody runs those on purpose. It is recorded as not run and does not block the release. It is written down so that the first person who sees the real behaviour knows what to record and where. Each one names its row in [Solution Design §14](../output/solution-design.md#14-technical-risks-and-items-to-verify).
  - **when it happens**: it can't be forced. If it is seen, in a smoke run or in the pilot, record what the check says. Otherwise it is recorded as not seen.
- **Who.** `person` means someone at the screen has to do or see a step: a consent screen, `clasp`, the Gmail web page, or a link opened in a browser. A blank cell means anyone can run it, a person or an agent.
- **Do.** One action. Steps that only prepare the action are part of it. A step that starts "Then:" restores something afterwards and is not a check.
- **Expect.** One expected result, given as one or more of five kinds of observation:
  1. **Returns** or **Throws**: the function's return value, or the error it throws.
  2. **Log**: log lines, by event name, level and fields.
  3. **Properties**: Script Properties, which keys exist and what a value holds.
  4. **Triggers**: the project's triggers, by handler and kind.
  5. **Mailbox**: a thread's labels, or an email that arrived.
- **Record.** A few checks have no fixed result: they observe something nobody has seen yet. They pass when the observation is recorded. Every "record" names its place. The results file always gets it; some checks name a second place.

"SD" below is the Solution Design (`output/solution-design.md`). The three rows of SD §14 that the checks cite:

| Short name | The row that starts |
|------------|---------------------|
| **scope row** | "The real per-scope missing-scope error text, and what `getAuthorizationInfo` reports in a partly granted install, are not observed" |
| **MailApp row** | "What `MailApp.sendEmail` throws without `script.send_mail` and past the daily email quota is not observed" |
| **links row** | "The Gmail links in the `errored` alert […] are not verified live" |

What is recorded where, besides the results file:

| What was seen | Also record it in |
|---------------|-------------------|
| Whether the Gmail links open the thread and the label | SD §14, links row |
| A real `MailApp` missing-scope text | SD §14 (MailApp row), SD §9, `src/adapters/gas/scope-errors.ts` |
| A real `MailApp` quota text | SD §14 (MailApp row), `src/adapters/gas/mail-errors.ts` |
| A real missing-scope text from Gmail, `UrlFetchApp` or `ScriptApp`, or what the authorization check reports in a partly granted install | SD §9, SD §14 (scope row), `src/adapters/gas/scope-errors.ts` |
| Platform behaviour that differs from a fake (`FakeLock`, `nodeDecodeUtf8`) | A bug, filed from the Bug form |

Changing a file in `src/` is always a bug fix with its own PR. It is never part of the smoke run.

## Summary

| Section | Checks | required | not observed | when it happens | Who: person |
|---------|--------|----------|--------------|-----------------|-------------|
| G. Gmail adapter: profile and history | 8 | 7 | 1 | 0 | 1 |
| T. Gmail adapter: thread search and reads | 15 | 14 | 1 | 0 | 2 |
| L. Gmail adapter: labels and moves | 16 | 15 | 1 | 0 | 2 |
| U. UTF-8 decoder | 6 | 6 | 0 | 0 | 0 |
| H. HTTP and secrets adapters | 9 | 8 | 1 | 0 | 1 |
| K. Script lock adapter | 9 | 9 | 0 | 0 | 0 |
| A. Auth adapter | 5 | 2 | 3 | 0 | 3 |
| M. Mail adapter | 9 | 7 | 2 | 0 | 1 |
| S. Setup, as the README describes it | 9 | 9 | 0 | 0 | 2 |
| R. Trigger adapter | 6 | 5 | 1 | 0 | 1 |
| E. Entry points | 8 | 8 | 0 | 0 | 0 |
| C. Clock, random and log adapters | 12 | 11 | 0 | 1 | 0 |
| P. Script Properties adapter | 5 | 5 | 0 | 0 | 0 |
| J. Manual runs | 17 | 17 | 0 | 0 | 0 |
| N. Alerts | 21 | 16 | 3 | 2 | 4 |
| Z. Time zone | 3 | 3 | 0 | 0 | 0 |
| V. Upgrade | 5 | 5 | 0 | 0 | 0 |
| X. Uninstall | 3 | 3 | 0 | 0 | 0 |
| **Total** | **166** | **150** | **13** | **3** | **17** |

The 13 "not observed" checks are the 11 that need a partly granted install and the 2 about the daily email quota (M9, N19). The 3 "when it happens" checks are C12, N20 and N21.

## Coverage

Every adapter and every entry point has at least one **required** check. The IDs below are the required checks only.

| Adapter (`src/adapters/gas/`) | Port | Called directly | Through the entry points |
|-------------------------------|------|-----------------|--------------------------|
| `GasGmailAdapter` (`gas-gmail-adapter.ts`) | `GmailPort` | G1–G7, T1–T13, T15, L1–L15 | S3, S5, E1–E4, J3, J7 |
| `GasStateAdapter` (`gas-state-adapter.ts`) | `StatePort` | P1, P2 | P3–P5, S5, S8, S9, J2, J3, J11, X1 |
| `GasSecretsAdapter` (`gas-secrets-adapter.ts`) | `SecretsPort` | H1–H3 | S4, E7 |
| `GasHttpAdapter` (`gas-http-adapter.ts`) | `HttpPort` | H4–H8 | E1 |
| `GasLockAdapter` (`gas-lock-adapter.ts`) | `LockPort` | K1–K8 | K9, E6, J13 |
| `GasTriggerAdapter` (`gas-trigger-adapter.ts`) | `TriggerPort` | R5 | S5, R1–R4, X1, X2 |
| `GasAuthAdapter` (`gas-auth-adapter.ts`) | `AuthPort` | A1, A2 | S5, E1 |
| `GasMailAdapter` (`gas-mail-adapter.ts`) | `MailPort` | M1–M7 | N2, N4, N7, N9–N11 |
| `GasLogAdapter` (`gas-log-adapter.ts`) | `LogPort` | | C1–C6 |
| `GasClockAdapter` (`gas-clock-adapter.ts`) | `ClockPort` | C7 (`now()`), C9 (`sleep()`), C10 (`timeZone()`), Z1 | C8, Z2, Z3 |
| `GasRandomAdapter` (`gas-random-adapter.ts`) | `RandomPort` | C11 (`next()`) | |
| `gasDecodeUtf8` (`gas-utf8.ts`), a helper function, not a port class | (a `Utf8Decoder`) | U1–U6 | E1 |

`gmail-errors.ts`, `http-results.ts`, `mail-errors.ts` and `scope-errors.ts` in the same folder are not adapters. They are pure error mapping, unit-tested in `test/adapters/gas/`, and have no checks here.

| Entry point (`ENTRY_POINTS`, `src/entry/entry-points.ts`) | Required checks |
|-----------------------------------------------------------|-----------------|
| `onTrigger` | S6, E1–E8, J12, N1–N12, Z2, Z3, V4, V5, X3 |
| `install` | S4, S5, S7–S9, K9, R2, R4 |
| `uninstall` | X1, X2 |
| `startManualRun` | J1–J3, J7–J10 |
| `continueManualRun` | J12–J14, J17 |
| `cancelManualRun` | J15, J16 |

## Setup

This is the only setup. No section below repeats it.

### The account

Use the throwaway test account, `<test-account>`. It also receives real commercial mail, addressed to other people. The smoke config's `excludeQuery` keeps that mail away from Jev, and check S3 proves it before the classifier is installed.

Privacy rules for the whole run:

- Never write the account's address, in plain or URL-encoded form (`%40`). Write `<test-account>`.
- Never print, paste or log the API key or an `Authorization` header.
- The log of a run on this account holds subjects and senders of real mail. The results hold event names, field names, counts, and what synthetic mail showed. Nothing else is copied out of a log.
- If a `thread.classified` line ever shows a `from` that is neither at `example.test` nor the account itself, stop: real mail reached Jev. Uninstall, and file a bug.

### Synthetic mail

All test mail is synthetic: a made-up sender at `example.test`, a subject that starts with `JevSmoke`, and a body that starts with the word `JevSmokeBody`. Put it into the mailbox with `Gmail.Users.Messages.import` (labels `INBOX` and `UNREAD`, `neverMarkSpam: true`), not by sending it. What [spike 19](../spikes/19-message-added.md) found about an import:

- It gets exactly one `messageAdded` history record, so the classifier ingests it like received mail.
- Its `internalDate` comes from the `Date` header. A thread counts as brand new (moves allowed) only when the `Date` header is later than the saved position. **"Deliver" in a check means: import one message whose `Date` header is the current time.**
- `threadId` can't be passed. Gmail threads imported mail by subject, so every thread needs its own subject. Add a short run tag to each subject (for example `JevSmoke live 03 [r2]`), so a second run doesn't join the first run's threads.

There are two kinds of body:

- **label kind:** `JevSmokeBody. This is a synthetic smoke-test message. It is not real mail.`
- **archive kind:** the same, plus `Please archive this email.`

With the smoke config below, the label rule should fire on both kinds and the move rule on the archive kind only. Check that before the run with the local probe (`npm run probe -- --config <your file> <file.eml>`), and change the questions or the body text until it holds. Never change an expected result instead.

The whole run needs about 380 threads:

| Set | Sender | Threads | Subject | Body | `Date` header | Imported |
|-----|--------|---------|---------|------|---------------|----------|
| direct | `smoke-direct@example.test` | 12 | `JevSmoke direct 01` to `12` | label kind; number 12 declares `charset=ISO-8859-1` and holds `café` in that charset | 3 days ago | Before G1 |
| history | `smoke-direct@example.test` | 3 | `JevSmoke history 01` to `03` | label kind | now | In G2 and G3 |
| manual | `smoke-manual@example.test` | 30 | `JevSmoke manual 01` to `30` | archive kind | 3 days ago | Before S3 |
| manual, excluded | `smoke-manual@example.test` | 1 | `JevSmoke manual JevSmokeExcluded` | archive kind | 3 days ago | Before S3 |
| manual, `Jev/Error` | `smoke-manual@example.test` | 1 | `JevSmoke manual error` | label kind | 3 days ago | Before S3, and labelled before J1 |
| bulk | `smoke-bulk@example.test` | 320 | `JevSmoke bulk 001` to `320` | label kind | 3 days ago | Before S3, at most 100 per execution (an import costs 25 Gmail quota units, and the account allows 6,000 a minute) |
| live | `smoke-live@example.test` | about 12 | `JevSmoke live 01`, `02`, … | as the check says | now, unless the check says otherwise | One at a time, when a check says "deliver" |

The manual and bulk sets must be in the mailbox **before** `install` (S5), with an old `Date` header. Then they are behind the saved position, no scheduled run picks them up, and the expired-history check (N11) doesn't find them either.

### The smoke config

Save this as a file outside the repository (or as a git-ignored file), and never commit it. Build with it: `npm run build -- --config <your file>`. The build validates it and makes no live call.

```yaml
defaultThreshold: 0.8
triggerIntervalMinutes: 10
jevModel: jev-latest
dailyTokenBudget: 20000000
excludeQuery: 'subject:JevSmokeExcluded OR (-from:example.test -subject:"Jev Gmail Classifier")'
plainTextMethod: basic

rules:
  - id: smoke_label
    question: Does this email say that it is a synthetic smoke-test message?
    label: JevSmoke/Test
  - id: smoke_archive
    question: Does this email ask the recipient to archive it?
    action: move
    destination: archive
```

The `excludeQuery` does two jobs:

- `subject:JevSmokeExcluded` excludes the one marked synthetic thread, for the exclusion checks (E4, J4).
- `-from:example.test -subject:"Jev Gmail Classifier"` matches every message that is neither synthetic nor one of the classifier's own alert emails. So real mail in the account is never sent to Jev. Check S3 proves this half live. If S3 fails, change the query until it passes, never the check.

**Variations.** Some checks need one field changed. Each variation is a rebuild and a push, and each is undone by rebuilding the config above and pushing again.

| Variation | Change | Used by |
|-----------|--------|---------|
| Interval | `triggerIntervalMinutes: 5` | R2, R3 |
| Budget | `dailyTokenBudget: 1` | N8, N9 |
| Model | `jevModel: no-such-model` | N10 |
| Changed rule | `smoke_label`'s `label` becomes `JevSmoke/Upgraded` | V1–V5 |
| Time zone | `timeZone` in the project's manifest (`appsscript.json`), not in the config | Z1–Z3 |

### The two builds

1. **The product.** `npm run build -- --config <your file>` writes `dist/Code.js` and `dist/appsscript.json`. `Code.js` is one script that defines the global `JevGmailClassifier` and one global function per entry point: `onTrigger`, `install`, `uninstall`, `startManualRun`, `continueManualRun`, `cancelManualRun`. It exposes nothing else, so a scratch function can't reach an adapter through it.
2. **The adapter bundle**, for the checks that call an adapter directly. This command, run from the repository root after `npm ci`, bundles the adapters into a global `JevSmokeAdapters` (about 29 KB). Write the output where you need it, and never commit it.

   ```sh
   printf "%s\n" \
     "export { GasAuthAdapter } from './src/adapters/gas/gas-auth-adapter.ts';" \
     "export { GasClockAdapter } from './src/adapters/gas/gas-clock-adapter.ts';" \
     "export { GasGmailAdapter } from './src/adapters/gas/gas-gmail-adapter.ts';" \
     "export { GasHttpAdapter } from './src/adapters/gas/gas-http-adapter.ts';" \
     "export { GasLockAdapter } from './src/adapters/gas/gas-lock-adapter.ts';" \
     "export { GasLogAdapter } from './src/adapters/gas/gas-log-adapter.ts';" \
     "export { GasMailAdapter } from './src/adapters/gas/gas-mail-adapter.ts';" \
     "export { GasRandomAdapter } from './src/adapters/gas/gas-random-adapter.ts';" \
     "export { GasSecretsAdapter } from './src/adapters/gas/gas-secrets-adapter.ts';" \
     "export { GasStateAdapter } from './src/adapters/gas/gas-state-adapter.ts';" \
     "export { GasTriggerAdapter } from './src/adapters/gas/gas-trigger-adapter.ts';" \
     "export { gasDecodeUtf8 } from './src/adapters/gas/gas-utf8.ts';" \
     "export { INSTALL_REQUIRED_SCOPES } from './src/core/scope-features.ts';" \
     | npx esbuild --bundle --format=iife --global-name=JevSmokeAdapters \
         --target=es2020 --platform=neutral --loader=ts --outfile=<out>.js
   ```

   A direct check is then written as, for example, `new JevSmokeAdapters.GasLockAdapter().tryAcquire()`. Below, the prefix `JevSmokeAdapters.` is left out: `new GasLockAdapter()` means `new JevSmokeAdapters.GasLockAdapter()`.

Both files go into the test project, next to a file of scratch functions. How they get there is the runner's choice: `clasp`, pasting them in the editor, or the spike runner. With `clasp`, build the product first (the build empties `dist/`), write the adapter bundle and the scratch file into `dist/`, then run `npx clasp push`. `npm run push` builds again from `config.yaml` and pushes only the product. Never push from a checkout whose `.clasp.json` points at a real mailbox's project.

### How a check is run, and where its result is seen

A check's action is "run this function": an entry point, or a **scratch function** that makes the call shown and returns its result. For example:

```js
function smokeK1() {
  return new JevSmokeAdapters.GasLockAdapter().tryAcquire();
}
```

**In the editor.** Pick the function and click Run. To see a return value in the execution log, a scratch function also logs it (`console.log(JSON.stringify(result))`); for an entry point, call it from a scratch function that logs what it returns. A throw shows the execution as Failed, with the error. The log lines are in the execution log. Script Properties are under Project Settings. The triggers are on the Triggers page. The mailbox is Gmail.

**Through the spike runner.** Only a function's return value comes back: the log goes to Cloud Logging, which the runner can't read. So a helper function wraps each call and returns everything an agent needs: the result (or the error's name, message and fields, if it threw), the log lines it captured while the call ran, the Script Properties, the triggers from `ScriptApp.getProjectTriggers()`, and the mailbox state read through the Gmail API. The helper replaces the account's address, in both its plain and its URL-encoded form, before it returns. That helper is `spikes/155-smoke.js` (its functions start with `s155_`). The log of a run that the trigger started itself can't be read this way: checks that wait for a trigger run read `state.runs` and the mailbox instead.

A check says `person` only when neither way can do it without someone at the screen.

### The key

Put the Jev API key in the Script Property `JEV_API_KEY` before H1. It is never printed, pasted into a result, or logged. A scratch function that needs it reads it with `new GasSecretsAdapter().getJevApiKey()` and never returns it. Several checks delete the key and restore it: a person pastes it again from `.env`; a helper keeps it in a variable for the length of one execution.

### Trigger runs compete

While the trigger is installed, its own run may take the mail a check was about to use, and it fails on its own while a check has removed the key or corrupted a value. So most of the checklist runs with the trigger **paused**: the classifier is installed and holds state, but has no trigger, and every `onTrigger` run is started by hand.

| Sections | Trigger |
|----------|---------|
| G, T, L, U, H, K, A, M | Not installed yet. |
| S, R | Installed by S5. R5 removes it, which pauses it. |
| E, C, P, J, N, Z | Paused. Run `onTrigger` by hand. |
| V | Installed again by V's first step. |
| X | Removed by `uninstall`. |

To pause the trigger at any other time, run `new GasTriggerAdapter().deleteTriggers('onTrigger')`. To bring it back, run `install`: it keeps the position.

Real mail that arrives during the run is ingested like any other mail and then excluded. So a count such as `ingested` or `excluded` can be higher than a check says. `sent` and `classified` can't: they count synthetic threads and the classifier's own alert emails only.

### Clean-up

Once, at the end, after section X:

1. Run `uninstall` once more, until it returns `keysDeleted: 0`.
2. Delete the Script Properties `JEV_API_KEY`, `RESET_POSITION` and every `MANUAL_*`.
3. Delete every trigger the run created (the second handler's, in R4 and X1).
4. Delete the labels `JevSmoke/…` and `Jev/Error` (and the parents `JevSmoke` and `Jev`).
5. Move the synthetic threads and the classifier's alert emails to Trash.
6. Remove the scratch functions, the adapter bundle and the product from the project, unless the project is thrown away.
7. If the manifest's `timeZone` was changed (section Z), check that it is back.

## G. Gmail adapter: profile and history

`GasGmailAdapter`: `getProfile` and `listHistory`. Direct calls. Keep the IDs and tokens from one check for the next.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| G1 | required | | `new GasGmailAdapter().getProfile()` | **Returns** `{ ok: true, emailAddress, historyId }`: the owner's address (don't record it) and a `historyId` of digits. |
| G2 | required | | Deliver `JevSmoke history 01`. Then `listHistory({ startHistoryId: <G1's historyId>, historyTypes: ['messageAdded'] })`. | **Returns** `ok: true`, a `historyId` of digits, and among `records` one whose `messagesAdded[0].message` is that message. |
| G3 | required | | Deliver `JevSmoke history 02` and `03`. Then the same call with `maxResults: 1`. | **Returns** one record and a `nextPageToken`. |
| G4 | required | | The same call with `pageToken: <G3's token>`, and so on to the end. | **Returns** the next record on each page. The last page has no `nextPageToken`. (Gmail may end with a page that has no records: the page with the last record can still carry a token.) |
| G5 | required | | `listHistory` with `startHistoryId: <the id of G3's record>`. | **Returns** only the records after that one. |
| G6 | required | | `listHistory({ startHistoryId: '1', historyTypes: ['messageAdded'] })`. | **Returns** `{ ok: false, kind: 'history_expired' }`. It doesn't throw. |
| G7 | required | | `getProfile()`, then at once `listHistory` from that `historyId`. | **Returns** `records: []`. |
| G8 | not observed | person | With `gmail.modify` unticked at consent, call either method. | **Returns** `{ ok: false, kind: 'scope' }`, and doesn't throw. SD §14, scope row. Record the real text as the table in "How to read a check" says. |

## T. Gmail adapter: thread search and reads

`GasGmailAdapter`: `searchThreadIds` and `getThread`. Direct calls, on the direct set.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| T1 | required | | `searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, maxResults: 2 })` | **Returns** `{ ok: true, threadIds }` with 2 IDs, and a `nextPageToken`. |
| T2 | required | | The same call with `pageToken: <T1's token>`. | **Returns** the next IDs. None repeats an ID from T1. |
| T3 | required | | Follow the tokens to the end. (If the inbox is large, use `q: 'from:smoke-direct@example.test'` for T1 to T3.) | **Returns** a last page with no `nextPageToken`: the key is absent, not empty. |
| T4 | required | | `searchThreadIds({ q: 'in:inbox', includeSpamTrash: false })`, with no `maxResults`. | **Returns** `ok: true` with `threadIds`. The result has no `resultSizeEstimate`, no snippets and no history IDs. |
| T5 | required | | `searchThreadIds({ q: 'subject:jev-smoke-no-such-subject-91f3', includeSpamTrash: false })` | **Returns** `threadIds: []` and no `nextPageToken`. |
| T6 | required | | Move the thread `JevSmoke direct 04` to Trash. Search for its subject with `includeSpamTrash: false`. | **Returns** a result without that thread. |
| T7 | required | | The same search with `includeSpamTrash: true`. | **Returns** that thread (spike 23, D1). |
| T8 | required | | `getThread(<JevSmoke direct 01's ID>, { format: 'metadata', metadataHeaders: ['Date'] })` | **Returns** every message of the thread with `id`, `labelIds` and `internalDate` (a string), only the `Date` header in `payload.headers`, and no body `data`. |
| T9 | required | | `getThread(<the same ID>, { format: 'full' })` | **Returns** payloads whose `body.data` is an array of numbers (signed bytes), not a string. `internalDate` is still a string. |
| T10 | required | | `getThread(<the same ID>, { format: 'minimal' })` | **Returns** messages with `id`, `threadId`, `labelIds` and `internalDate`, and no `payload`. |
| T11 | required | | `getThread(<the ID of T6's trashed thread>, { format: 'minimal' })` | **Returns** the trashed message too, with `TRASH` in its `labelIds` (SD §14). |
| T12 | required | person | In the Gmail web page, move `JevSmoke direct 06` to Trash and choose "Delete forever" (the API can't: it would need the `https://mail.google.com/` scope). Then `getThread(<its ID>, { format: 'minimal' })`. | **Returns** `{ ok: false, kind: 'not_found' }`. It doesn't throw. |
| T13 | required | | `getThread('not-a-thread-id', { format: 'minimal' })` | **Throws** `UnexpectedResponseError` with `service: 'gmail'` and `status: 400`. The error holds no header text. If the status differs, record it in the results. |
| T14 | not observed | person | With `gmail.modify` unticked at consent, call both methods. | **Returns** `{ ok: false, kind: 'scope' }` from each, with no throw. SD §14, scope row. |
| T15 | required | | `searchThreadIds({ q: 'in:inbox', includeSpamTrash: false, pageToken: 'not-a-token' })` | **Returns** `{ ok: false, kind: 'invalid_page_token', message }`. Gmail's text is "Invalid pageToken" (spike 287). It doesn't throw. |

## L. Gmail adapter: labels and moves

`GasGmailAdapter`: `listLabels`, `createLabel` and `modifyThread`. Direct calls, on the direct set. Before L1, make sure no label is named `JevSmoke` or starts with `JevSmoke/`.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| L1 | required | | `new GasGmailAdapter().listLabels()` | **Returns** `{ ok: true, labels }` in one response, with no paging: system labels (IDs such as `INBOX`, `SPAM`) and user labels (`Label_<n>`), each with an `id` and a `name`. |
| L2 | required | | `createLabel('JevSmoke/A/B')` | **Returns** `{ ok: true, label }` with a `Label_<n>` ID and the name `JevSmoke/A/B`. |
| L3 | required | | `listLabels()` again. | **Returns** that leaf only: no `JevSmoke` and no `JevSmoke/A` was created. |
| L4 | required | | `createLabel('JevSmoke/A/B')` again. | **Returns** `{ ok: false, kind: 'label_exists', message }`. It doesn't throw. |
| L5 | required | | `createLabel('jevsmoke/a-b')` (a `-` for a `/`: Gmail takes them as the same character, #329) | **Returns** `{ ok: false, kind: 'label_exists', message }`. It doesn't throw. |
| L6 | required | | `createLabel('Inbox')` | **Returns** `{ ok: false, kind: 'invalid_label_name', message }`. It doesn't throw. |
| L7 | required | | `modifyThread(<JevSmoke direct 02's ID>, { addLabelIds: [<L2's ID>], removeLabelIds: [] })` | **Returns** `{ ok: true }`. **Mailbox:** every message of the thread has the label. |
| L8 | required | | The same call again. | **Returns** `{ ok: true }`. **Mailbox:** nothing changed. |
| L9 | required | | `modifyThread(<JevSmoke direct 03's ID>, { addLabelIds: ['JevSmoke/A/B'], removeLabelIds: [] })`: a label **name**, not an ID. | **Returns** `{ ok: false, kind: 'invalid_label', message }`. **Mailbox:** the thread is unchanged. |
| L10 | required | | The same with `addLabelIds: ['Label_999999999']`. | **Returns** `{ ok: false, kind: 'invalid_label', message }`. **Mailbox:** the thread is unchanged. |
| L11 | required | | Archive: on `JevSmoke direct 07`, give it L2's label first, then `modifyThread(id, { addLabelIds: [], removeLabelIds: ['INBOX'] })`. | **Returns** `{ ok: true }`. **Mailbox:** the thread has left the inbox and keeps its other labels (SD §6.5). |
| L12 | required | | Label move: on `JevSmoke direct 08`, `modifyThread(id, { addLabelIds: [<L2's ID>], removeLabelIds: ['INBOX'] })`. | **Returns** `{ ok: true }`. **Mailbox:** the thread has the label and has left the inbox. |
| L13 | required | | Spam: on `JevSmoke direct 09`, give it L2's label first, then `modifyThread(id, { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] })`. | **Returns** `{ ok: true }`. **Mailbox:** the thread is in Spam, not in the inbox, and keeps the user label. |
| L14 | required | | Trash: on `JevSmoke direct 10`, give it L2's label first, then `modifyThread(id, { addLabelIds: ['TRASH'], removeLabelIds: [] })`. | **Returns** `{ ok: true }`. **Mailbox:** the thread is in Trash, `INBOX` is gone too, and it keeps the user label. |
| L15 | required | person | `modifyThread(<the ID of the thread deleted forever in T12>, { addLabelIds: [<L2's ID>], removeLabelIds: [] })` | **Returns** `{ ok: false, kind: 'not_found' }`. It doesn't throw. |
| L16 | not observed | person | With `gmail.modify` unticked at consent, call the three methods. | **Returns** `{ ok: false, kind: 'scope' }` from each, with no throw. SD §14, scope row. |

Then: delete the label `JevSmoke/A/B`.

## U. UTF-8 decoder

`gasDecodeUtf8`. Direct calls with chosen bytes.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| U1 | required | | `gasDecodeUtf8([])` | **Returns** `''`. |
| U2 | required | | `gasDecodeUtf8([72, 105])` | **Returns** `'Hi'`. |
| U3 | required | | `gasDecodeUtf8([-61, -87, -26, -105, -91, -16, -97, -103, -126])` | **Returns** `'é日🙂'`: length 4 in UTF-16, because the emoji is a surrogate pair. |
| U4 | required | | `gasDecodeUtf8([-17, -69, -65, 65])` | **Returns** a string of length 2 that starts with U+FEFF. If Apps Script drops the BOM instead, that differs from `nodeDecodeUtf8`: record it in the results and file a bug. |
| U5 | required | | `gasDecodeUtf8([-1])` | **Returns** `'\uFFFD'` (the replacement character). It doesn't throw. |
| U6 | required | | `getThread(<JevSmoke direct 12's ID>, { format: 'full' })`, then decode its text part's `body.data`. That message declares `charset=ISO-8859-1`. | **Returns** readable text: `café`, not `cafÃ©` (Gmail has already converted the part to UTF-8, spike 29). |

## H. HTTP and secrets adapters

`GasSecretsAdapter` and `GasHttpAdapter`. Direct calls. [`spikes/94-fetch-all.md`](../spikes/94-fetch-all.md) recorded what `UrlFetchApp` does underneath. Never put a response body that echoes a request into a result.

The "Jev request" below is `{ url: 'https://api.typesafe.ai/v1/systemone', method: 'post', headers: {}, contentType: 'application/json', payload }`, where `payload` is the JSON text of `{ model: 'jev-latest', state: [{ subject: 'JevSmoke', body: 'JevSmokeBody. A synthetic message.' }], questions: { q1: { type: 'noul', instructions: 'Is this a synthetic message?' } } }`.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| H1 | required | | Delete the property `JEV_API_KEY`. `new GasSecretsAdapter().getJevApiKey()`. | **Returns** `undefined`. |
| H2 | required | | Set `JEV_API_KEY` to three spaces. The same call. | **Returns** `undefined`. |
| H3 | required | | Set `JEV_API_KEY` to ` test-key ` (a space at each end). The same call. Then: restore the real key. | **Returns** `'test-key'`. |
| H4 | required | | `new GasHttpAdapter().sendAll([])` | **Returns** `[]`. |
| H5 | required | | `sendAll([<Jev request>])`, with no `Authorization` header. | **Returns** `[{ ok: true, status: 403, … }]` (Jev's "no key" answer: spike 94, `test/fixtures/jev/`). Every header name is lower-case (`content-type`, `x-typesafe-request-id`, `set-cookie`), and `body` is the JSON text `{"detail":{"error_type":"authentication_error",…}}`. |
| H6 | required | | The same request with `headers: { Authorization: 'Bearer ' + <the key from getJevApiKey()> }`. | **Returns** status 200, an `x-typesafe-request-id` header, and a body with `usage.input_tokens`. |
| H7 | required | | `sendAll([<H6's request>, { url: 'https://jev-smoke.invalid/', method: 'get', headers: {} }, { url: 'https://www.google.com/generate_204', method: 'get', headers: {} }])` | **Returns** three `{ ok: false, kind: 'transport', message: 'DNS error: https://jev-smoke.invalid/' }` results, and doesn't throw. No `message` contains `Bearer`, the key, or the payload. |
| H8 | required | | `sendAll([{ url: 'https://google.com/', method: 'get', headers: {} }])` | **Returns** status 301 with a `location` header, not the redirected page. |
| H9 | not observed | person | With `script.external_request` unticked at consent, any `sendAll` with a request. | **Returns** `{ ok: false, kind: 'scope' }` for every request. Nothing throws. SD §14, scope row. |

## K. Script lock adapter

`GasLockAdapter`. K1 to K8 call it directly. K9 goes through an entry point. K3, K4 and K9 need two executions at the same time: start one from the editor and one with the runner, or two with the runner from two terminals.

The **sleeper** is a scratch function that calls `tryAcquire()`, then `Utilities.sleep(60000)`, then `release()`, and returns what `tryAcquire()` gave.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| K1 | required | | With no other execution running, `new GasLockAdapter().tryAcquire()`. | **Returns** `true`. |
| K2 | required | | In one execution, call `tryAcquire()` twice on the same adapter. | **Returns** `true` both times: the lock is re-entrant for its holder, as `FakeLock` models. If the second call returns `false`, that differs from `FakeLock`: record it in the results and file a bug. |
| K3 | required | | Start the sleeper (execution A). While A sleeps, execution B calls `tryAcquire()` and measures how long the call took. | **Returns** `false` in B, in well under a second: B didn't wait. |
| K4 | required | | While A still sleeps, B calls `release()` on its own adapter. Then a third execution calls `tryAcquire()`. | **Returns** `false` in the third execution: B's `release()` threw nothing, and A still holds the lock. |
| K5 | required | | Execution A calls `tryAcquire()` (it gets `true`) and then throws without releasing. Then a new execution calls `tryAcquire()`. | **Returns** `true` in the new execution: Apps Script freed the lock when A ended. |
| K6 | required | | Start the sleeper and wait until it has finished. Then a new execution calls `tryAcquire()`. | **Returns** `true`. |
| K7 | required | | `new GasLockAdapter().release()`, with no `tryAcquire()` first. | **Returns** normally: nothing is thrown. |
| K8 | required | | `tryAcquire()`, `release()`, then `release()` again, on one adapter. | **Returns** normally: the second `release()` throws nothing. |
| K9 | required | | Start the sleeper. While it sleeps, run `install`. | **Returns** `{ entry: 'install', status: 'skipped', reason: 'busy' }`. **Log:** `run.skipped` with `reason: 'busy'`, and no other line for that execution. **Properties:** nothing was written. |

## A. Auth adapter

`GasAuthAdapter`. Direct calls. `install` and `onTrigger` use it too: S5 and E1 check that neither logs `scope_missing` when every permission is granted.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| A1 | required | | With all four permissions granted, `new GasAuthAdapter().missingScopes()`. | **Returns** `{ ok: true, missing: [] }`. It doesn't throw. |
| A2 | required | | With all four granted, `new GasAuthAdapter().requireScopes(INSTALL_REQUIRED_SCOPES)`. | **Returns** normally: nothing is thrown. |
| A3 | not observed | person | With one permission unticked at consent, `missingScopes()`. | **Returns** `missing` with exactly that scope, and never throws. With `script.scriptapp` unticked, record whether it returns `missing: ['https://www.googleapis.com/auth/script.scriptapp']` or `{ ok: false, kind: 'unknown' }`: in the results, SD §9 and SD §14 (scope row). |
| A4 | not observed | person | Run `install` from the editor with `gmail.modify`, `script.external_request` or `script.scriptapp` unticked. | The consent screen appears again (or an authorization error with a link to it is thrown), and **Properties:** `install` wrote nothing. SD §14, scope row. Record which of the two happened in the results and SD §9. |
| A5 | not observed | person | Run `install` with only `script.send_mail` unticked. | **Returns** a report whose `missingScopes` lists `script.send_mail`: `install` finished. SD §14, scope row. |

## M. Mail adapter

`GasMailAdapter`. Direct calls. The "Alerts" section checks it end to end. Send to the account's own address, read at run time from `getProfile()` and never written down.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| M1 | required | | `new GasMailAdapter().send(<own address>, '[Jev Gmail Classifier] Smoke test', 'Line 1\nLine 2')` | **Returns** `{ ok: true }`. |
| M2 | required | | Read the email M1 sent. | **Mailbox:** it arrived in the account's own mailbox. The sender is `Jev Gmail Classifier` with the account's own address, the subject is exact, and the body is plain text with the line break kept. It has no HTML styling and no attachment (through the API: no `text/html` part, and no part with a file name). |
| M3 | required | | Read the labels of M1's message. | **Mailbox**, to **record** in the results: its labels (`INBOX`, `SENT`, `UNREAD`?) and whether it is a thread of its own. Nobody has observed a `MailApp` self-send before. |
| M4 | required | | Send M1's email a second time. | **Returns** `{ ok: true }`. **Mailbox**, to **record** in the results: whether the second email joined the first one's thread or started a new one. |
| M5 | required | | `send` with the subject `[Jev Gmail Classifier] Smoke test 2` and the body `café … 日本`. | **Mailbox:** the body arrived unchanged, apart from its line ends: `MailApp` sends `format=flowed`, so a line break arrives as `\r\n` and one is added at the end. |
| M6 | required | | `send` with the subject `[Jev Gmail Classifier] Smoke test 3` and a body of 5,000 characters. | **Mailbox:** the body arrived unchanged, all 5,000 characters, apart from its line ends: as M5, and a long line arrives soft-wrapped (a space, then a line break), which a mail client joins again (`format=flowed; delsp=yes`). |
| M7 | required | | `send('not-an-address', 'x', 'y')` | **Throws** `UnexpectedResponseError` with `service: 'mail'`. Its message has `<recipient>` in place of the address. **Record** Apps Script's exact text in the results. |
| M8 | not observed | person | With `script.send_mail` unticked at consent, `send`. | **Returns** `{ ok: false, kind: 'scope' }`. It doesn't throw. SD §14, MailApp row. If this is ever run, record the exact error text in the results, SD §14 (MailApp row), SD §9 and `scope-errors.ts`. |
| M9 | not observed | | Past the daily email quota, `send`. Don't exhaust the quota to see this: `MailApp.getRemainingDailyQuota()` shows what is left (about 100 a day on a consumer account). | **Returns** `{ ok: false, kind: 'quota' }`. SD §14, MailApp row. If the real text is ever seen, record it in the results, SD §14 (MailApp row) and `mail-errors.ts`. |

## S. Setup, as the README describes it

The steps of [README "Setup"](../README.md#setup), as a user follows them, on the test account. From here on the product is used through its entry points. Before S3: the manual and bulk sets are in the mailbox, and the key is set.

S1 and S2 need a fresh Apps Script project: they are the push with `clasp` and the first consent screen. Do them when the code is first pushed into a fresh project, whenever that is. A project that already has the permissions granted, such as the shared spike project, can't show S2. S3 to S9 run in any project.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| S1 | required | person | In a fresh Apps Script project, follow the README: turn on the Apps Script API, run `npx clasp login`, copy `.clasp.json.example` to `.clasp.json` with the project's script ID, put the smoke config at `config.yaml`, and run `npm run push`. Answer yes if `clasp` asks to overwrite the manifest. | The build passes and `clasp` pushes. After a reload, the editor lists exactly two files: `Code.gs` (`clasp` pushes a `.js` file as `.gs`) and `appsscript.json`. |
| S2 | required | person | In that fresh project, run `install` for the first time. | A consent screen appears, after "Google hasn't verified this app". It lists four permissions, all unticked. It never says "Read, compose, send, and permanently delete all your email from Gmail". With all four ticked, `install` goes on. |
| S3 | required | | Before anything is installed: with `new GasGmailAdapter().searchThreadIds`, page four searches to the end, each with `includeSpamTrash: true`: (a) the config's `excludeQuery`; (b) `from:example.test`; (c) `subject:"Jev Gmail Classifier"`; (d) `in:anywhere`. | **Returns** four ID lists for which both hold. The only threads in both (a) and (b) are the ones whose subject holds `JevSmokeExcluded`, and threads that hold a message from `example.test` next to a message from another sender (a search matches a thread when any of its messages matches, so the first half of the `excludeQuery` matches those too; no thread of this run's synthetic sets is one). Every thread of (d) is in (a), (b) or (c): whatever is neither synthetic nor one of the classifier's own emails is excluded, so no real mail can reach Jev. Record counts only. |
| S4 | required | | Delete the property `JEV_API_KEY`. Run `install`. Then: restore the key. | **Throws** `RunAbortError` with the message "JEV_API_KEY is missing: set JEV_API_KEY in Script Properties, then run install again". **Log:** `run.failed` with `error: 'RunAbortError'`, `reason: 'missing_key'` and `alerts: ['auth']`. **Properties:** no `state.position` and no `state.installedAt`. **Triggers:** none for `onTrigger`. (The run also sends the `auth` alert email, which section N checks.) |
| S5 | required | | Run `install`. | **Returns** `{ entry: 'install', status: 'ok', position: 'set', historyId, triggerMinutes: 10, missingScopes: [] }`. **Triggers:** exactly one for the handler `onTrigger`, and it is time-driven. **Properties:** `state.position` (with that `historyId` and a `savedAt`), `state.installedAt` and `state.gmailCalls`. **Log:** `run.start` and `run.end` for `install`; no `run.failed` and no `scope_missing`. |
| S6 | required | | Deliver one label-kind message and one whose subject holds `JevSmokeExcluded`. Run nothing. Wait for a trigger run that starts after the delivery: `state.runs` appears, with a `lastStart` later than the delivery. | **Properties:** `state.runs` has `lastOutcome: 'ok'`, `consecutiveFailures: 0`, and a `lastSummary` with `sent: 1` and `classified: 1`. **Mailbox:** the first thread has the label `JevSmoke/Test`; the excluded one doesn't. (In the editor, the Executions page shows the run as Completed.) |
| S7 | required | | Run `install` again. | **Returns** `position: 'kept'` and the `historyId` that `state.position` held just before the run. **Triggers:** still exactly one for `onTrigger`. |
| S8 | required | | Set the property `RESET_POSITION` to `true`. Run `install`. | **Returns** `position: 'reset'` and the mailbox's current `historyId`. **Properties:** `state.position` has a new `savedAt`, and `RESET_POSITION` is deleted. |
| S9 | required | | Set the property `RESET_POSITION` to `yes`. Run `install`. Then: delete `RESET_POSITION`. | **Returns** `position: 'kept'`. **Log:** `run.end` at `warn`, with `resetPositionIgnored: true` and without the value. **Properties:** `RESET_POSITION` is still there, and `state.position` is unchanged. |

Every README "Setup" step that the test account can show, and its checks:

| README "Setup" step | Checks |
|---------------------|--------|
| Get the code, write a config, build | Local, with no account: "The smoke config" and "The two builds" above |
| Create the project, connect `clasp`, push | S1 |
| Set the time zone | Z1–Z3 |
| Add the Jev key; without it `install` stops and says so | S4 |
| Run `install`: the consent screen | S2 |
| `install` saves the position and creates the trigger | S5 |
| Check that it works: `install`'s `run.end`, one trigger, a completed trigger run, a test mail that gets its label | S5, S6 |
| Changing the config or the interval: push, and run `install` again for the interval | R2, R3 |
| Running `install` again keeps the position | S7 |
| Upgrading: pull, build, push | V1–V5 |
| Starting from now: `RESET_POSITION` | S8, S9 |
| Stopping: `uninstall`, and what it leaves | X1, X2 |

Removing the granted permissions and deleting the project are Google account pages, not the classifier: they have no check.

## R. Trigger adapter

`GasTriggerAdapter`. `install` calls `replaceRecurringTrigger('onTrigger', triggerIntervalMinutes)` and `uninstall` calls `deleteTriggers('onTrigger')`, so R1 to R4 go through `install`. R5 needs both calls in one execution and is direct. The trigger is installed during this section.

A trigger's interval can't be read from code. A person sees it on the Triggers page. Anyone can see it as the gap between the `lastStart` values that two trigger runs in a row leave in `state.runs`, as long as nothing is run by hand in between.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| R1 | required | | Read `lastStart` in `state.runs` after each of two trigger runs in a row. | **Properties:** the two values are about 10 minutes apart. (In the editor: the Triggers page says every 10 minutes.) |
| R2 | required | | Build the interval variation (`triggerIntervalMinutes: 5`), push, and run `install`. | **Returns** `triggerMinutes: 5` and `position: 'kept'`. **Triggers:** still exactly one for `onTrigger`. |
| R3 | required | | As R1. Then: build the smoke config again, push, and run `install`. | **Properties:** the two values are about 5 minutes apart. |
| R4 | required | | By hand, create a second `onTrigger` trigger and one for a second handler: `ScriptApp.newTrigger(<handler>).timeBased().everyHours(1).create()`. The second handler is a function that does nothing (for example `smokeOther`; in a shared project, use a name that follows that project's rules). Run `install`. | **Triggers:** exactly one for `onTrigger`, and the second handler's trigger is untouched. |
| R5 | required | | In **one** scratch execution: `new GasTriggerAdapter()`'s `replaceRecurringTrigger('onTrigger', 10)`, then `deleteTriggers('onTrigger')`. Then: delete the second handler's trigger. | **Returns** `{ ok: true }`, then `{ ok: true, deleted: 1 }`, with no HTTP 500: the pitfall from E1 #163 is avoided. **Triggers:** none for `onTrigger`. The trigger is now paused. |
| R6 | not observed | person | With `script.scriptapp` unticked at consent, call both methods. | **Returns** `{ ok: false, kind: 'scope' }` from each, with no throw. SD §14, scope row. |

## E. Entry points

`onTrigger`, run by hand, with the trigger paused. `install` is checked in S, the manual entry points in J, and `uninstall` in X. What each entry point returns is in [Solution Design §6.1](../output/solution-design.md#61-entry-points).

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| E1 | required | | Deliver one label-kind message. Run `onTrigger`. | **Returns** `{ entry: 'onTrigger', status: 'ok', stopped: 'drained', summary, alerts: [] }`. **Log:** `run.start`; `thread.classified` for the thread, with `probabilities.smoke_label` and `actions: ['label:JevSmoke/Test']`; `run.end` with `ingested` ≥ 1 and `classified: 1`; no `scope_missing`. **Mailbox:** the thread has the label. **Properties:** `state.runs` has `lastOutcome: 'ok'` and `consecutiveFailures: 0`. |
| E2 | required | | Deliver one archive-kind message. Run `onTrigger`. | **Log:** `thread.classified` with both rules in `fired` and `actions: ['label:JevSmoke/Test', 'move:archive']`. **Mailbox:** the thread has the label and has left the inbox: a brand-new thread is moved. |
| E3 | required | | Import one archive-kind message whose `Date` header is 2 days ago. Run `onTrigger`. | **Log:** `thread.classified` with `smoke_archive` in `fired` and no `move:` entry in `actions`, at `info`. **Mailbox:** the thread has the label and is still in the inbox: a thread with a message older than the saved position gets labels only. |
| E4 | required | | Deliver one message whose subject holds `JevSmokeExcluded`. Run `onTrigger`. | **Log:** `thread.excluded` with `reason: 'matched'` for that thread, and no `thread.classified` for it; `run.end` has `excluded` ≥ 1 and `sent: 0`. **Mailbox:** the thread has no `JevSmoke` label. |
| E5 | required | | With no new synthetic mail, run `onTrigger`. | **Returns** `stopped: 'drained'`. **Log:** `run.end` with `sent: 0` and `classified: 0` (and `ingested: 0`, unless real mail arrived in between). |
| E6 | required | | Start the sleeper (section K). While it sleeps, run `onTrigger`. Or start two `onTrigger` executions at the same moment. | **Returns** `{ entry: 'onTrigger', status: 'skipped', reason: 'busy' }` from the execution that didn't get the lock. **Log:** exactly one line for it, `run.skipped`. |
| E7 | required | | Delete the property `JEV_API_KEY`. Run `onTrigger`. | **Throws** `RunAbortError`. **Log:** right after `run.start`, `run.failed` with `error: 'RunAbortError'`, `reason: 'missing_key'` and `alerts: ['auth']`: no Gmail or Jev call came first. **Properties:** `state.runs` has `lastOutcome: 'failed'` and `consecutiveFailures: 1`. **Mailbox:** no thread was labelled. (The `auth` alert email is sent at most once a day: section N checks it.) |
| E8 | required | | Restore the key. Run `onTrigger`. | **Returns** `status: 'ok'`. **Properties:** `state.runs` has `consecutiveFailures: 0`. |

## C. Clock, random and log adapters

`GasLogAdapter`, `GasClockAdapter` and `GasRandomAdapter`. C1 to C6 and C8 read the log and the state of entry-point runs: use the runs of sections S and E. C7 and C9 to C11 are direct calls. The log adapter's line format and `redact` are also unit-tested (`test/adapters/gas/gas-log-adapter.test.ts`, `test/core/redact.test.ts`).

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| C1 | required | | Read every log line of one `onTrigger` run that classified a thread. | **Log:** each line is one JSON object that starts with `event`, `runId`, `entry` and `ts`, and it is written at a level that `LOG_EVENT_LEVELS` (`src/core/log-events.ts`) allows for its event: `info`, `warn` or `error`. |
| C2 | required | | Compare `runId` across the lines of that run. | **Log:** all the lines share one `runId`, and it is a UUID. |
| C3 | required | | Compare the `runId` of two executions. | **Log:** they differ. |
| C4 | required | | Read `entry` in the lines of an `install` run and an `onTrigger` run. Do the same for `startManualRun`, `continueManualRun` and `cancelManualRun` in section J and for `uninstall` in section X, and record C4 after X. | **Log:** `entry` is the name of the entry point that ran, in every line. |
| C5 | required | | Note the time just before and just after one `onTrigger` run. Read `ts` in its lines. | **Log:** every `ts` is an ISO 8601 time in UTC (it ends with `Z`) between those two times. (`GasLogAdapter` writes `ts` itself; the clock adapter is not involved.) |
| C6 | required | | Search every log line captured so far. | **Log:** no line contains a message body (`JevSmokeBody` is the first word of every synthetic body), the API key, an `Authorization` header (the text `Bearer`), or a request's `state`. |
| C7 | required | | In a scratch function: `const before = Date.now(); const now = new GasClockAdapter().now(); const after = Date.now();` | **Returns** an integer `now` (epoch milliseconds) with `before <= now <= after`. |
| C8 | required | | Note the time just before and just after one `onTrigger` run. Read `state.runs`. | **Properties:** `lastStart` and `lastEnd` are epoch milliseconds between those two times, and `lastStart <= lastEnd`. This is `GasClockAdapter.now()` as the product uses it. |
| C9 | required | | `const clock = new GasClockAdapter(); const start = clock.now(); clock.sleep(1500); return clock.now() - start;` | **Returns** a number of at least 1500, and under 3000. |
| C10 | required | | `new GasClockAdapter().timeZone()` | **Returns** the `timeZone` of the project's manifest: `Etc/UTC` as shipped. |
| C11 | required | | Call `new GasRandomAdapter().next()` 1,000 times. | **Returns** numbers that are all at least 0 and under 1, and not all equal. |
| C12 | when it happens | | Jev answers 429 or 503, so a request is retried. Read that run's `jev.batch` line. | **Log:** `jev.batch` with `rounds` > 1 has `sleptMs` > 0, and the execution lasted at least that long (`GasClockAdapter.sleep()`, with `GasRandomAdapter`'s jitter in the delay). Record that it was seen, with `rounds` and `sleptMs`, in the results (or in the pilot report, if it is seen in the pilot). |

## P. Script Properties adapter

`GasStateAdapter`. P1 and P2 are direct calls. P3 to P5 look at a real deployment: every entry point builds a `GasStateAdapter` per execution. A queue of several shards is checked in J11, and the user inputs in S8, S9, J2 and J3.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| P1 | required | | `new GasStateAdapter().set('state.smoke', { v: 1, text: 'é日🙂' })`. Then, with a **new** adapter, `get('state.smoke')` and `keys('state.smoke')`. | **Returns** `{ v: 1, text: 'é日🙂' }` and `['state.smoke']`. **Properties:** the property `state.smoke` is the one-line JSON text `{"v":1,"text":"é日🙂"}`. |
| P2 | required | | `new GasStateAdapter().delete('state.smoke')`. Then, with a new adapter, `get('state.smoke')`. | **Returns** `undefined`. **Properties:** `state.smoke` is gone. |
| P3 | required | | Read every Script Property after the runs of sections S and E. | **Properties:** every key the classifier wrote starts with `state.`, and every such value is one line of JSON that starts with `{"v":`. `JEV_API_KEY` is unchanged. |
| P4 | required | | Note the value of `state.position`. Edit it by hand to text that isn't JSON: `{"v":1,`. Run `onTrigger`. Then: restore the value. | **Throws** `StateError`. **Log:** `run.failed` with `error: 'StateError'`, `reason: 'parse'` and `key: 'state.position'`, and without the stored text. **Properties:** the value is exactly as edited: it was not reset. |
| P5 | required | | Edit `state.position` to `{"v":99}`. Run `onTrigger`. Then: restore the value, and run `onTrigger` once: it succeeds. | **Throws** `StateError`. **Log:** `run.failed` with `reason: 'version'`. **Properties:** the value is as edited. |

## J. Manual runs

`startManualRun`, `continueManualRun`, `cancelManualRun`, and the spare-time hook in `onTrigger`. The trigger is paused. The manual set (32 threads from `smoke-manual@example.test`) and the bulk set (320 threads from `smoke-bulk@example.test`) are in the mailbox since before `install`.

Before J1: create the label `Jev/Error` (and its parent `Jev`), add it to the thread `JevSmoke manual error`, and set the property `state.jevErrorLabel` to `{"v":1,"ids":["<that label's ID>"]}`. The classifier skips a thread by the label IDs it has itself used for `Jev/Error` (Solution Design §7.3), and a valid config can't force a real `Jev/Error`, so the smoke test writes that record by hand.

An editor run works for up to 4.5 minutes and classifies about 140 threads. If Gmail's per-minute limit stops a run early (`stopped: 'rate_limited'`), wait a few minutes and go on: the job is saved.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| J1 | required | | With no `MANUAL_*` property, run `startManualRun`. | **Returns** `{ entry: 'startManualRun', status: 'rejected', reason: 'no_input' }`. It doesn't throw. **Log:** `manual.rejected` at `warn`, and no `run.end`. **Properties:** no `state.manual`. |
| J2 | required | | Set `MANUAL_QUERY` to `from:smoke-manual@example.test` and `MANUAL_TIMESPAN` to `1m`. Run `startManualRun`. | **Returns** `status: 'rejected'`, `reason: 'invalid_timespan'`. **Properties:** both inputs are still there. |
| J3 | required | | Change `MANUAL_TIMESPAN` to `7d`. Run `startManualRun`. | **Returns** `{ entry: 'startManualRun', status: 'ok', query: '(from:smoke-manual@example.test) after:<seconds>', applyMoves: false, job: 'completed', stopped: 'completed', summary }`. **Log:** `manual.started` with that exact query; `manual.progress`; then `manual.completed` with `classified: 30` and `JevSmoke/Test` in `labels`. **Properties:** all four `MANUAL_*` inputs are deleted (set or not), and `state.manual` is gone. **Mailbox:** the 30 threads have the label. |
| J4 | required | | Read J3's log and the excluded thread (`JevSmoke manual JevSmokeExcluded`). | **Log:** `thread.excluded` for that thread and no `thread.classified` for it; `manual.completed` has `excluded: 1`; the `query` in `manual.started` doesn't contain the `excludeQuery`. **Mailbox:** the thread has no `JevSmoke` label. |
| J5 | required | | Read J3's log for the thread `JevSmoke manual error`, which carries `Jev/Error`. | **Log:** `thread.skipped` with `reason: 'jev_error'` for that thread, and no `thread.classified` for it; `manual.completed` has `skipped: 1`. |
| J6 | required | | Read J3's log and the 30 threads. | **Log:** each `thread.classified` has `smoke_archive` in `fired` and no `move:` entry in `actions`. **Mailbox:** the 30 threads are still in the inbox: without `MANUAL_APPLY_MOVES`, a firing move rule moves nothing. |
| J7 | required | | Set `MANUAL_QUERY` to `from:smoke-manual@example.test` and `MANUAL_APPLY_MOVES` to `true`. Run `startManualRun`. | **Returns** `applyMoves: true` and `job: 'completed'`. **Log:** `manual.completed` with `moves.archive: 30`. **Mailbox:** the 30 threads have left the inbox. |
| J8 | required | | Delete the property `JEV_API_KEY`. Set `MANUAL_QUERY` to `from:smoke-manual@example.test`. Run `startManualRun`. Then: restore the key. | **Throws** `RunAbortError`. **Log:** `manual.started`, then `run.failed` with `reason: 'missing_key'`. **Properties:** `state.manual` exists (the job is saved), and the `MANUAL_*` inputs are deleted. |
| J9 | required | | With that job unfinished, set `MANUAL_QUERY` to `from:smoke-bulk@example.test`. Run `startManualRun`. | **Returns** `status: 'rejected'`, `reason: 'job_unfinished'`. **Properties:** `MANUAL_QUERY` is still there, and `state.manual` is unchanged. |
| J10 | required | | Add `MANUAL_REPLACE` with the value `true`. Run `startManualRun`. | **Returns** `status: 'ok'`, `query: 'from:smoke-bulk@example.test'` and `job: 'active'`: 320 threads don't fit in one run. **Log:** `manual.cancelled` with `reason: 'replaced'`, then `manual.started` with `replaced: true`, then `manual.progress` with `stopped` set to `units`, `deadline` or `rate_limited`. **Properties:** `state.manual` holds the new query. |
| J11 | required | | Read the `state.queue.<n>` properties while that job is unfinished. | **Properties:** each value is at most 9 KB (9,216 bytes of UTF-8), and the numbers `<n>` run from 0 with no gaps. |
| J12 | required | | Run `onTrigger`. | **Log:** `manual.progress` for the job, and a `run.end` that has `spare`: a scheduled run works on the job in its spare time. |
| J13 | required | | Start the sleeper (section K). While it sleeps, run `continueManualRun`. | **Returns** `{ entry: 'continueManualRun', status: 'skipped', reason: 'busy' }`. |
| J14 | required | | Run `continueManualRun`. | **Returns** `{ entry: 'continueManualRun', status: 'ok', job: 'active', stopped, summary }`. **Log:** `manual.progress` whose `seen` and `totalClassified` are higher than in J10's line: an execution after J10's read a search page with the page token that J10's execution saved. No execution of this job logged `manual.cursor_reset`. This is the only check of the search cursor across executions. |
| J15 | required | | Run `cancelManualRun`. | **Returns** `{ entry: 'cancelManualRun', status: 'ok', cancelled: true, removed }` with `removed` above 0. **Log:** `manual.cancelled`, and no `run.end`. **Properties:** `state.manual` is gone, no item with `"source":"manual"` is left in `state.queue.*`, and `state.runs` is unchanged. **Mailbox:** the labels already applied are still there. |
| J16 | required | | Run `cancelManualRun` again. | **Returns** `cancelled: false` and `removed: 0`. |
| J17 | required | | With no job, run `continueManualRun`. | **Returns** `job: 'none'` and `stopped: 'no_job'`. **Log:** `run.end` with `stopped: 'no_job'`. |

## N. Alerts

The alert mailer (`createMailAlertSink`, `src/app/alert-mailer.ts`) sends for `onTrigger`, `install`, `startManualRun` and `continueManualRun`. `uninstall` and `cancelManualRun` keep the sink that does nothing. The trigger is paused, so the failed runs below are counted exactly.

The email texts and the subjects are in `src/core/alert-email.ts`. Every subject starts with `[Jev Gmail Classifier]`.

Before N1: delete the property `state.alerts` if it exists. S4 or E7 sent the `auth` alert earlier today, and an absent key means nothing was sent.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| N1 | required | | With nothing wrong, run `onTrigger`. | **Returns** `alerts: []`. **Log:** no `alert.sent` and no `alert.failed`. **Properties:** no `state.alerts`. **Mailbox:** no email arrived. |
| N2 | required | | Delete the property `JEV_API_KEY`. Run `onTrigger`. | **Throws** `RunAbortError`. **Log:** `run.failed` with `alerts: ['auth']`, then `alert.sent` with `condition: 'auth'` and `day`. **Mailbox:** one email arrived in the account's own mailbox: the sender name is `Jev Gmail Classifier`, the subject is `[Jev Gmail Classifier] Jev API key missing or rejected`, and the body is plain text that ends with the footer, which gives the day and the time zone. **Properties:** `state.alerts` is `{"v":1,"sent":{"auth":"<today>"}}`. |
| N3 | required | | Run `onTrigger` again. | **Throws** again. **Log:** `run.failed` with `alerts: ['auth']` and `consecutiveFailures: 2`, and no `alert.sent`. **Mailbox:** no second email. |
| N4 | required | | Run `onTrigger` a third time. | **Log:** `run.failed` with `consecutiveFailures: 3` and `alerts: ['auth', 'run_failures']`; `alert.sent` with `condition: 'run_failures'`. **Mailbox:** a second email, `[Jev Gmail Classifier] Runs are failing repeatedly`, which says 3 runs. (If the trigger is installed, its own runs fail and count too: read `consecutiveFailures` in each `run.failed` rather than counting your own runs.) |
| N5 | required | | Run `onTrigger` a fourth time. | **Log:** `run.failed` with `consecutiveFailures: 4`, and no `alert.sent`. **Mailbox:** no new email. |
| N6 | required | | Restore the key. Run `onTrigger`. | **Returns** `status: 'ok'` and `alerts: []`. **Log:** `thread.classified` for each alert email's own thread: an alert is ordinary mail, ingested and classified like any other (#304). That run raises no new alert because of it. **Properties:** `state.runs` has `consecutiveFailures: 0`. |
| N7 | required | | In `state.alerts`, change `auth`'s day to yesterday. Delete the key. Run `onTrigger`. Then: restore the key, and run `onTrigger` once. | **Log:** `alert.sent` with `condition: 'auth'`. **Mailbox:** the `auth` email arrived again. **Properties:** `auth`'s day in `state.alerts` is today again. |
| N8 | required | | Delete the property `state.budget`. Build the budget variation (`dailyTokenBudget: 1`) and push. Deliver one label-kind message. Run `onTrigger`. | **Log:** `thread.classified` for the message: the first batch is sent, and it crosses the budget. **Properties:** `state.budget` has today's `day` and `inputTokens` of at least 1. |
| N9 | required | | Run `onTrigger` again. Then: build the smoke config again and push. | **Returns** `stopped: 'budget'` and `alerts: ['budget_reached']`. **Log:** `budget.reached` at `warn`, with `day`, `inputTokens` and `dailyTokenBudget: 1`; `alert.sent` with `condition: 'budget_reached'`. **Mailbox:** `[Jev Gmail Classifier] Daily token budget reached`. |
| N10 | required | | Build the model variation (`jevModel: no-such-model`) and push. Deliver one label-kind message. Run `onTrigger`. Then: build the smoke config again, push, and run `onTrigger` once. | **Throws** `RunAbortError`. **Log:** `run.failed` with `reason: 'config_invalid'`; `alert.sent` with `condition: 'config_invalid'`. **Mailbox:** `[Jev Gmail Classifier] Configuration is invalid`. No thread got `Jev/Error`. |
| N11 | required | | In `state.position`, change the `historyId` to `"1"`. Run `onTrigger`. | **Log:** `history.expired`; `alert.sent` with `condition: 'history_expired'`. **Mailbox:** `[Jev Gmail Classifier] Gmail history expired: catching up`. |
| N12 | required | | Run `onTrigger` until the catch-up is done (N11's own run may already finish it). | **Log:** `ingest.done` with `fallbackDone: true`. **Properties:** `state.fallback` is gone, and `state.position` holds a `historyId` of the mailbox again. |
| N13 | required | person | Take a `threadId` from a `thread.classified` line. In a browser signed in to the test account, open `https://mail.google.com/mail/?authuser=<address>#all/<threadId>`, with the address URL-encoded. | The page opens that thread, in that account. **Record** the result in the results and in SD §14 (links row). |
| N14 | required | person | Add the label `Jev/Error` to a synthetic thread by hand. Open `https://mail.google.com/mail/?authuser=<address>#label/Jev%2FError`. Then: remove the label. | The page lists that thread. **Record** the result in the results and in SD §14 (links row). |
| N15 | required | | Read the threads of N2's and N7's `auth` emails. | **Mailbox**, to **record** in the results: whether two alerts of the same condition share one Gmail thread. |
| N16 | required | | Search every `alert.sent` and `alert.failed` line captured in this section. | **Log:** no such line holds the account's address, a subject or a body. (`thread.classified` may show the address as `from` for an alert's own thread: subjects and senders are allowed there. An `alert.failed` line's `errorMessage` is the mail or Gmail service's own text.) |
| N17 | not observed | person | With `script.external_request` unticked at consent, run `onTrigger`. | **Log:** `scope_missing`. **Mailbox:** `[Jev Gmail Classifier] A permission is missing`, which lists that scope and what it disables. SD §14, scope row. |
| N18 | not observed | person | With `script.send_mail` unticked at consent, run `onTrigger`. | **Log:** `scope_missing`, and `alert.failed` with `reason: 'scope'`, on every run. **Mailbox:** no email. The run is otherwise normal, and no execution fails because of `MailApp`. SD §14, MailApp row. |
| N19 | not observed | | The daily email quota runs out while an alert is due. Don't exhaust the quota to see this. | **Log:** `alert.failed` with `reason: 'quota'`. SD §14, MailApp row. If it is ever seen, record its `errorMessage` in the results, SD §14 (MailApp row) and `mail-errors.ts`. |
| N20 | when it happens | | A thread gets `Jev/Error` (a valid config can't force it; the pilot, #157 and #158, may show it). Read the alert email. | **Mailbox:** the subject is `[Jev Gmail Classifier] Threads marked Jev/Error`, and the body lists a link to each thread and a link to the label. **Record** that it was seen, and whether the links open the thread and the label: in the results (or the pilot report), and in SD §14 (links row). Never record a thread ID from a real mailbox. |
| N21 | when it happens | | `uninstall` or `cancelManualRun` fails with an alert condition (an invalid embedded config, or `uninstall` without `script.scriptapp`). Neither is easy to cause live; `test/build/bundle.test.ts` covers it with an invalid embedded config. | **Mailbox:** no email. **Properties:** no `state.alerts` was written. **Record** that it was seen in the results. |

## Z. Time zone

`GasClockAdapter.timeZone()` and the days that follow it: the Gmail call tally, the token budget and the alert limit. These checks need `timeZone` changed in the project's manifest (`appsscript.json`), and changed back afterwards. The manifest belongs to the whole project: in a project shared with other scripts, run this section only when nothing else there depends on the time zone.

Before Z1: choose a zone whose date differs from the UTC date right now. `Pacific/Kiritimati` (UTC+14) is a day ahead from 10:00 UTC on; `Pacific/Pago_Pago` (UTC−11) is a day behind until 11:00 UTC. Set it as `timeZone` in the manifest and push: the build copies the repository's `appsscript.json` into `dist/`, so change it there and build, and never commit that change. Each push overwrites the project's manifest. The trigger is paused.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| Z1 | required | | `new GasClockAdapter().timeZone()` | **Returns** the zone you set. |
| Z2 | required | | Deliver one label-kind message. Run `onTrigger`. | **Properties:** `day` in `state.gmailCalls` and in `state.budget` is that zone's date, not the UTC date. **Log:** `run.end` has `gmailCallsToday` equal to `gmailCalls`: a new day started with this run. |
| Z3 | required | | Delete the property `JEV_API_KEY`. Run `onTrigger`. Then: restore the key, and run `onTrigger` once. | **Log:** `alert.sent` with `condition: 'auth'` and a `day` that is the zone's date. **Properties:** `auth`'s day in `state.alerts` is that date. **Mailbox:** the `auth` email's footer gives that date and names the zone. |

Then: set `timeZone` back to what it was (`Etc/UTC` as shipped) and push.

## V. Upgrade

Pushing a new build over an installed one ([PDD §2](../output/product-design-document.md), "Upgrade"; Solution Design §11, "Upgrades"). The user pulls, builds and pushes, and does **not** run `install`: state, the trigger and the labels carry over.

Before V1: run `install` (it keeps the position and brings the trigger back). The classifier now holds a position, `state.runs`, and the label `JevSmoke/Test` that it created. Note the values of `state.position` and `state.installedAt` and the trigger's unique ID.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| V1 | required | | Build the changed-rule variation (`smoke_label`'s label is `JevSmoke/Upgraded`) and push. Don't run `install`. Read the properties at once. | **Properties:** `state.installedAt` is identical. `state.position` is identical too, unless a trigger run came in between: then only its `historyId` and `savedAt` moved forward. Every other `state.*` key is still there. |
| V2 | required | | Read the project's triggers after V1's push. | **Triggers:** exactly one for `onTrigger`, with the same unique ID as before the push. |
| V3 | required | | Read the labels after V1's push. | **Mailbox:** the label `JevSmoke/Test` exists, and its threads still have it. |
| V4 | required | | Run nothing. Wait for the trigger's own run: `lastStart` in `state.runs` changes. | **Properties:** `state.runs` has `lastOutcome: 'ok'` and `consecutiveFailures: 0`: the first run of the new build succeeded on the old state. |
| V5 | required | | Deliver one label-kind message. Wait for the next trigger run. | **Mailbox:** the thread has the label `JevSmoke/Upgraded`, which the classifier created, and not `JevSmoke/Test`: the changed rule applies to new mail. Threads labelled earlier keep `JevSmoke/Test`. |

## X. Uninstall

`uninstall`, last. Before X1: create a trigger for a second handler, as in R4, and set the properties `RESET_POSITION` to `no` and `MANUAL_QUERY` to `x`.

| ID | Marking | Who | Do | Expect |
|----|---------|-----|----|--------|
| X1 | required | | Run `uninstall`. | **Returns** `{ entry: 'uninstall', status: 'ok', triggersDeleted: 1, keysDeleted }`, where `keysDeleted` is the number of `state.*` keys there were. **Log:** `run.end` with `triggersDeleted` and `keysDeleted`. **Triggers:** none for `onTrigger`; the second handler's is still there. **Properties:** no `state.*` key at all (so no `state.alerts`, and nothing was written after the delete); `JEV_API_KEY`, `RESET_POSITION` and `MANUAL_QUERY` are still there. **Mailbox:** the labels `JevSmoke/Test`, `JevSmoke/Upgraded` and `Jev/Error` are still there. |
| X2 | required | | Run `uninstall` again. | **Returns** `triggersDeleted: 0` and `keysDeleted: 0`. |
| X3 | required | | Run `onTrigger` by hand. | **Throws** `StateError`. **Log:** `run.failed` with `error: 'StateError'`, `reason: 'missing'` and `key: 'state.position'`: `install` writes it. (That run wrote `state.runs` and `state.gmailCalls`: the clean-up removes them.) |

Then: do the clean-up in "Setup".
