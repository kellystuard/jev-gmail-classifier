# 27: Missing-scope errors and a detection approach

- Task: #27
- Date run: (YYYY-MM-DD, filled in from the maintainer's run)
- Account: `<test-account>` (consumer). Account language: (filled in; error text may differ by locale)
- Run by: maintainer in the editor, in a **separate** Apps Script project ("Jev spike 27"). Not the shared `jev-spikes` project, and not the #163 runner.

## Question

When the user leaves one of the four declared scopes unticked on Google's granular consent screen:

1. What exactly fails (exception name and message) for each call that needs that scope, in the editor and in a trigger run?
2. What does `ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL)` (with and without the declared scope list) report in each state, and does it need a scope itself?
3. How should E7's scope preflight (`AuthPort.missingScopes()`, SD §5.2, §9) detect the missing scope, and what error signature should each adapter match (Gmail #112, `MailApp` #146, `ScriptApp` #127, `UrlFetchApp` #94)?
4. How does the user get the consent screen back to grant the missing scope?

Design text under test: SD §9 "Scope preflight" and "Per-action fallback", the SD §5.2 `AuthPort` row, and [ADR-0003](../output/adr/0003-advanced-gmail-service-and-scopes.md) ("missing scopes are handled, not fatal").

## Why the maintainer runs it

The consent screens can't be automated, and the #163 runner can't stand in: `scripts.run` refuses a token that lacks any of the script's scopes, so a partly granted state can only be probed from the editor or a trigger. It uses its own Apps Script project so unticking scopes never touches the shared spike project or the runner's refresh token.

## Functions

| Function | What it does |
|----------|--------------|
| `s27_setup()` | B0 only. Imports one synthetic thread (placeholder From on `example.test`), creates the `S27/Probe` label, stores both IDs in Script Properties. |
| `s27_probeAll()` | Runs probes P1–P9 (below) in the editor and returns one entry per probe. Also derives the consent state (`stateKey`, for example `all` or `missing-gmail.modify`) from P2's authorized scopes. |
| `s27_installProbeTrigger()` / `s27_removeProbeTrigger()` | Create / delete an every-minute time-driven trigger for `s27_probeFromTrigger`. |
| `s27_probeFromTrigger()` | The trigger handler. Same probes, but sends at most one P5 email per consent state, stores its result in Script Properties, and then calls `requireScopes` for the missing scopes (table 5; the result is stored before the call). |
| `s27_readTriggerResults()` | Returns the stored trigger results (the newest 40), oldest first, and logs each on its own line. |
| `s27_tryRequireScopes()` | `ScriptApp.requireScopes(FULL, [missing scopes])` in the editor (tables 5 and 6b). |
| `s27_tryRequireAllScopes()` | `ScriptApp.requireAllScopes(FULL)` (table 6b). |
| `s27_authUrl()` | Logs `getAuthorizationUrl()` on its own line for you to open (table 6c). **Don't paste that line**; the returned JSON only says whether a URL exists. |
| `s27_invalidateAuth()` | `ScriptApp.invalidateAuth()` (table 6e). |
| `s27_cleanup()` | With full consent: removes `S27/Probe` from the thread, deletes the label, clears the `s27.*` properties. |

Probes (each in its own `try/catch`, recording `ok`, `e.name`, `e.message` verbatim, `e.details` if present, and the first line of `e.stack`):

| Probe | Call | Scope it needs (expected) |
|-------|------|---------------------------|
| P1 | `ScriptApp.getAuthorizationInfo(FULL)`: status, authorized scopes, whether a URL is returned | none? (check) |
| P2 | `ScriptApp.getAuthorizationInfo(FULL, DECLARED_SCOPES)`: the same | none? (check) |
| P3 | `Gmail.Users.getProfile('me')`, reduced to `historyId` (never the address) | `gmail.modify` |
| P4 | `Gmail.Users.Threads.modify({addLabelIds: [S27/Probe]}, 'me', testThread)` | `gmail.modify` |
| P5 | `MailApp.sendEmail(S27_TO, 'S27 probe', '<context and state>')` | `script.send_mail` |
| P6 | `ScriptApp.getProjectTriggers()` | `script.scriptapp` |
| P7 | `ScriptApp.newTrigger('s27_noop').timeBased().after(3600000).create()`, then `deleteTrigger` | `script.scriptapp` |
| P8 | `UrlFetchApp.fetch('https://www.google.com/generate_204', {muteHttpExceptions: true})` | `script.external_request` |
| P9 | Script Properties get and set, `LockService.getScriptLock().tryLock(0)`, `Session.getScriptTimeZone()`, `Utilities.sleep(10)` | none |

P7's trigger handler is `s27_noop` (not `noop`), to keep the `s27_` prefix.

Consent states: **B0** all four granted; **S1** `gmail.modify` unticked; **S2** `script.send_mail` unticked; **S3** `script.scriptapp` unticked; **S4** `script.external_request` unticked.

## Runbook

> **Warning: revoke only "Jev spike 27".** Steps 3, 4 and 5 remove this project's access at <https://myaccount.google.com/connections>. On that page, remove **only** the entry named **"Jev spike 27"**. **Never** remove the shared `jev-spikes` project, or the app for the #163 runner's OAuth client (the name you gave the #163 OAuth consent screen). Removing either revokes `SPIKE_REFRESH_TOKEN`, which stops every agent's spike runs until you redo #163's `node spikes/auth.mjs` step and update `.env` and the `spike-account` secrets. If you're unsure which entry is which, stop and ask before deleting anything.

Paste every returned JSON into the PR, labelled with the state (B0, S1, …) and the context (editor / trigger). The results are scrubbed of the `S27_TO` address, but check before pasting, and replace any address with `<test-account>`. For editor runs, copy the Execution log; for trigger runs, run `s27_readTriggerResults()` and copy its log.

1. **Create the project.** Signed in as the test account, create a new standalone project at <https://script.google.com> named **"Jev spike 27"**.
   - Leave it on its **default** Cloud project. Don't switch it to the #163 Cloud project.
   - Project Settings → tick "Show `appsscript.json` manifest file in editor". Paste `spikes/appsscript.json` from `main` over it.
   - Replace `Code.gs` with the contents of `spikes/27-missing-scope.js`.
   - Project Settings → Script Properties → add `S27_TO` = the test account's address.
   - Note the account's display language (Google Account → Personal info → General preferences → Language).
2. **B0 (all granted).**
   1. Run `s27_setup()`. On the consent screen, note for table 1: whether checkboxes appear at all, which are pre-ticked, whether each of the four can be unticked, and the exact wording of each line. Tick **all four** and allow.
   2. Run `s27_probeAll()`.
   3. Run `s27_installProbeTrigger()`.
   4. Wait for two trigger runs (about 2 minutes; the Executions page in the left sidebar lists them). Run `s27_readTriggerResults()`.
   5. Paste the four results, plus your table 1 notes, into the PR.
3. **S1 to S4 (one scope unticked each).** For each state in turn (S1 `gmail.modify`, S2 `script.send_mail`, S3 `script.scriptapp`, S4 `script.external_request`):
   1. At <https://myaccount.google.com/connections>, remove the access of **"Jev spike 27" only** (see the warning above).
   2. In the editor, run `s27_probeAll()`. On the consent screen, untick **only** that state's scope, and continue. If the editor shows the consent screen again on a later run, untick the same scope again, or the state changes.
   3. Note for table 3: did the editor re-prompt before the function ran? Did the function run at all? Paste the result.
   4. Wait for two trigger runs. Open the Executions page and note the status and any error of the trigger runs (table 4). Run `s27_readTriggerResults()` and paste it. If Google emails you a trigger failure notice, note its subject and error line.
   5. Run `s27_tryRequireScopes()`. Note what happened (a prompt, an error dialog, or nothing) and paste the log (table 5).
   - **S3** unticks `script.scriptapp`. The trigger created in B0 still exists: note whether it keeps firing (Executions page).
   - In **S2**, P5 can't send, so the "S27 probe" email for S2 shouldn't arrive. Note which "S27 probe" emails did arrive in each state.
4. **Re-consent (table 6), once, from S4.** Starting in S4, try each method below and note whether the consent screen comes back and whether it offers `script.external_request` again. After each method that brings the screen back, untick `script.external_request` again to return to S4 before the next one.
   - (a) Run `s27_probeAll()` again in the editor.
   - (b) Run `s27_tryRequireScopes()`, then `s27_tryRequireAllScopes()`.
   - (c) Run `s27_authUrl()`, open the logged URL in the browser (don't paste it).
   - (d) Remove "Jev spike 27" (only) at the connections page, then run `s27_probeAll()`.
   - (e) Run `s27_invalidateAuth()`, then run `s27_probeAll()`.
5. **Clean up.** Grant all four scopes (for example, method (d) and tick everything). Run `s27_removeProbeTrigger()`, then `s27_cleanup()`, and paste both. Then delete the "Jev spike 27" project (Drive → trash it), and remove "Jev spike 27" (only) at the connections page.

## Maintainer steps

Everything in the runbook above: this spike is maintainer-run by design. The agent asks for it in one comment on #27 and fills in the tables from the pasted JSON.

## Results

(Filled in from the maintainer's run.)

### Table 1: consent screen

| Question | Observed |
|----------|----------|
| Do checkboxes appear for this project? | |
| Which scopes are pre-ticked? | |
| Can each of the four be unticked? (`gmail.modify`, `script.send_mail`, `script.scriptapp`, `script.external_request`) | |
| Exact wording of each line | |
| Account language | |

### Table 2: probes by state and context

For P1 and P2: status, authorized scopes, and whether a URL is returned. For the others: `ok`, `e.name`, exact `e.message`, `e.details`.

| State | Probe | Editor | Trigger |
|-------|-------|--------|---------|
| B0 | P1 | | |
| B0 | P2 | | |
| B0 | P3–P9 | | |
| S1 `gmail.modify` | P1 | | |
| S1 | P2 | | |
| S1 | P3 | | |
| S1 | P4 | | |
| S1 | P5–P9 | | |
| S2 `script.send_mail` | P1, P2 | | |
| S2 | P5 | | |
| S2 | others | | |
| S3 `script.scriptapp` | P1 | | |
| S3 | P2 | | |
| S3 | P6 | | |
| S3 | P7 | | |
| S3 | others | | |
| S4 `script.external_request` | P1, P2 | | |
| S4 | P8 | | |
| S4 | others | | |

### Table 3: editor behavior with a scope missing

| State | Re-prompted before running? | Did the function run? | Notes |
|-------|-----------------------------|-----------------------|-------|
| S1 | | | |
| S2 | | | |
| S3 | | | |
| S4 | | | |

### Table 4: trigger behavior

| State | Trigger kept firing? | Executions page status / error | Stored probe result | Failure email from Google? |
|-------|----------------------|--------------------------------|---------------------|----------------------------|
| B0 | | | | |
| S1 | | | | |
| S2 | | | | |
| S3 | | | | |
| S4 | | | | |

### Table 5: `requireScopes`

| State | Editor (`s27_tryRequireScopes`) | Trigger (end of `s27_probeFromTrigger`) |
|-------|--------------------------------|------------------------------------------|
| S1 | | |
| S2 | | |
| S3 | | |
| S4 | | |

### Table 6: re-consent (from S4)

| Method | Consent screen came back? | Offered the missing scope again? |
|--------|---------------------------|----------------------------------|
| (a) run a function in the editor again | | |
| (b) `requireScopes` / `requireAllScopes` | | |
| (c) open `getAuthorizationUrl()` | | |
| (d) remove access at the connections page, run again | | |
| (e) `ScriptApp.invalidateAuth()`, run again | | |

## Raw output

<details><summary>Pasted results</summary>

(Filled in from the maintainer's run.)

</details>

## Conclusion

(Filled in from the results.)

- **Detection approach for E7 (#124, #125):** (the call, whether it works in a trigger run, whether it needs a scope itself, and the fallback if it needs `script.scriptapp`.)
- **`install` and `requireScopes` (#128):** (facts and a recommendation; the decision is E7's. Tension: SD §9 lets a partly granted install carry on with what still works.)
- **Error signatures to match** (a stable part of the message, not the whole text):
  - Gmail (#112):
  - `MailApp` (#146):
  - `ScriptApp` (#127):
  - `UrlFetchApp` (#94):

## Notes for README Permissions (#151)

(Filled in: how a user gets a missing scope back, for example whether "run `install` again" re-offers it, as README Permissions currently says.)

## Design changes

(Filled in: SD §9, §5.2 `AuthPort` row, §13 E7 row; a Proposed ADR if ADR-0003 is overturned; issues #94, #112, #124, #125, #127, #128, #146 updated or listed.)
