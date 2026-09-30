# 27: Missing-scope errors and a detection approach

- Task: #27
- Date run: 2026-09-26 (B0 only; see [Status](#status))
- Account: `<test-account>` (consumer). Account language: `en` (`Session.getActiveUserLocale()`)
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

P7's trigger handler is `s27_noop` (not `noop`), to keep the `s27_` prefix. P7 deletes the trigger through its `getProjectTriggers()` copy, because deleting the object `create()` returned fails with a bare HTTP 500 in the same execution (`spikes/README.md`, Limits).

Consent states: **B0** all four granted; **S1** `gmail.modify` unticked; **S2** `script.send_mail` unticked; **S3** `script.scriptapp` unticked; **S4** `script.external_request` unticked.

## Runbook

> **Warning: revoke only "Jev spike 27".** Steps 3, 4 and 5 remove this project's access at <https://myaccount.google.com/connections>. On that page, remove **only** the entry named **"Jev spike 27"**. **Never** remove **jev-spike-runner** (the #163 runner's OAuth app): that revokes `SPIKE_REFRESH_TOKEN` and stops every agent's spike runs until you redo `node spikes/auth.mjs` and update `.env` and the `spike-account` secrets. Leave any `jev-spikes` entry alone too. If you're unsure which entry is which, stop and ask before deleting anything.

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

## Status

**Only B0 (all four scopes granted) was run.** The maintainer ran runbook step 2 on 2026-09-26 and declined steps 3–5 (the partial-consent states S1–S4, re-consent, and cleanup). So tables 3–6 and the S1–S4 rows of table 2 are **not observed**. The per-scope error signatures below are Google's documented behavior, not measurements. See the conclusion for what E7 can rely on, and the PR for how the Done-when is affected.

**#268 was skipped too (maintainer, 2026-09-30).** The planned re-run in the product was declined as well, so the per-scope error text and the partial-consent behavior of `getAuthorizationInfo` stay unobserved. This is an accepted v1 risk (SD §14). The first real text, from E10's pilot or a user report, gets recorded here.

- `s27_setup` failed in B0 with `Exception: Invalid argument: value` (`s27_setup @ Code.gs:51`). `Messages.import` returns only `{id}`, and the spike stored the undefined `threadId` (the bug #25 found; fixed since). So nothing was imported, and P4 returned the spike's own guard error (`s27_setup has not stored s27.labelId / s27.threadId`), not a Gmail result. P3 covers the same scope (`gmail.modify`) and passed.
- The every-minute trigger from step 2.iii was left running; removing it has been requested on #27.

## Results

(Filled in from the maintainer's run.)

### Table 1: consent screen

| Question | Observed |
|----------|----------|
| Do checkboxes appear for this project? | Yes: "4 in list" |
| Which scopes are pre-ticked? | **None** ("0 ticked"). The user has to tick each one. |
| Can each of the four be unticked? (`gmail.modify`, `script.send_mail`, `script.scriptapp`, `script.external_request`) | Implied yes: all four are unticked by default. Continuing with some unticked wasn't tried. |
| Exact wording of each line | Not recorded |
| Account language | `en` |

### Table 2: probes by state and context

For P1 and P2: status, authorized scopes, and whether a URL is returned. For the others: `ok`, `e.name`, exact `e.message`, `e.details`.

| State | Probe | Editor | Trigger |
|-------|-------|--------|---------|
| B0 | P1 | ok: status `NOT_REQUIRED`; authorized scopes = all four declared scopes (a JS array); no authorization URL | not observed (no `s27_readTriggerResults` output) |
| B0 | P2 | ok: identical to P1 | not observed |
| B0 | P3–P9 | P3 ok (`historyId`). P4 **not tested** (setup bug, see Status). P5 ok (`sent`). P6 ok (`[]`). P7 ok (created and deleted `s27_noop` through the `getProjectTriggers()` copy). P8 ok (204). P9: properties get and set, `tryLock(0)` (acquired), `getScriptTimeZone` (`Etc/UTC`), `sleep` all ok | not observed |
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
| B0 | Installed at 18:11Z (`s27_installProbeTrigger` ok) | not reported | not read | not reported |
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

<details><summary>Pasted results (B0, editor, 2026-09-26)</summary>

`s27_setup` (execution log, from a screenshot):

```
1:08:16 PM  Notice  Execution started
1:08:17 PM  Error   Exception: Invalid argument: value
                    s27_setup @ Code.gs:51
```

`s27_probeAll`:

```json
{"fn":"s27_probeAll","context":"editor","at":"2026-09-26T18:10:00.422Z","env":{"timeZone":{"ok":true,"value":"Etc/UTC"},"locale":{"ok":true,"value":"en"}},"stateKey":"all","missingForRequire":[],"probes":{"P1":{"ok":true,"value":{"status":"NOT_REQUIRED","authorizedScopes":["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/script.external_request","https://www.googleapis.com/auth/script.scriptapp","https://www.googleapis.com/auth/script.send_mail"],"authorizedScopesType":"[object Array]","hasAuthorizationUrl":false}},"P2":{"ok":true,"value":{"status":"NOT_REQUIRED","authorizedScopes":["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/script.external_request","https://www.googleapis.com/auth/script.scriptapp","https://www.googleapis.com/auth/script.send_mail"],"authorizedScopesType":"[object Array]","hasAuthorizationUrl":false}},"P3":{"ok":true,"value":{"historyId":"36575982"}},"P4":{"ok":false,"error":{"name":"Error","message":"s27_setup has not stored s27.labelId / s27.threadId","stackFirstLine":"Error: s27_setup has not stored s27.labelId / s27.threadId"}},"P5":{"ok":true,"value":"sent"},"P6":{"ok":true,"value":[]},"P7":{"ok":true,"value":{"created":true,"handler":"s27_noop","deleted":true}},"P8":{"ok":true,"value":{"status":204}},"P9":{"propertiesGet":{"ok":true,"value":"null"},"propertiesSet":{"ok":true,"value":"ok"},"lock":{"ok":true,"value":{"acquired":true}},"timeZone":{"ok":true,"value":"Etc/UTC"},"sleep":{"ok":true,"value":"ok"}}}}
```

`s27_installProbeTrigger`:

```json
{"fn":"s27_installProbeTrigger","at":"2026-09-26T18:11:15.746Z","removed":{"ok":true,"value":{"deleted":0}},"create":{"ok":true,"value":{"uniqueId":"4463478620945383424","handler":"s27_probeFromTrigger"}}}
```

</details>

## Conclusion

**B0 plus Google's docs, the reduced scope the PM accepted. S1–S4 weren't observed** ([Status](#status), [Design changes](#design-changes)).

**Settled by B0:**

- **Consent screen:** it lists all four scopes as checkboxes, and **none is pre-ticked**. The user has to tick each one, so a partly granted install is easy to end up with, not an edge case.
- **Detection call:** `ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL).getAuthorizedScopes()` returns a plain JS array of the granted scope URLs, with status `NOT_REQUIRED` and no authorization URL when everything is granted. Passing the declared list (P2) changes nothing.
- **Other services:** Script Properties, `LockService`, `Session.getScriptTimeZone`, and `Utilities.sleep` need no scope beyond the four (P9).
- **Trigger deletion:** P7 confirms the #163 limit workaround: delete a trigger through its `getProjectTriggers()` copy.

**From Google's docs, not observed** ([Authorization scopes and granular consent](https://developers.google.com/apps-script/concepts/scopes), checked 2026-09-26):

- A trigger execution "cannot prompt the user for missing permissions mid-execution". If it uses a service the user didn't authorize, "the trigger execution fails immediately with an 'Authorization is required to perform that action.' error".
- The docs recommend `ScriptApp.requireScopes()` "during trigger setup", and `getAuthorizationInfo()` to "skip features where users haven't granted the required scopes".

**Recommendations for E7 and E6** (the verification moved to #125):

- **Detection approach (#124, #125):** missing = declared scopes minus `getAuthorizationInfo(FULL).getAuthorizedScopes()`.
  - Call it in `try`/`catch`. If it throws (it might need `script.scriptapp`, which isn't verified), report the state as "unknown", alert, and rely on the per-action fallback.
  - If the docs are right that a trigger run fails *immediately* at an unauthorized call, the preflight is the **primary** defense in scheduled runs, not the per-action fallback. The run should skip every feature whose scope is missing before calling it, rather than catching the error.
- **`install` (#128):** the user is present in the editor, so `install` can call `ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)`. That brings the consent screen back until all four are granted, as the docs recommend for trigger setup. This conflicts with SD §9, which lets a partly granted install carry on with what still works. Given that nothing is pre-ticked, requiring all four at install looks safer. The decision is E7's.
- **Error signatures** (#112, #146, #127, #94), not observed. Adapters should match any of these stable fragments, case-insensitively:
  - `Authorization is required to perform that action`, documented for trigger runs;
  - `insufficient authentication scopes`, the Gmail REST 403 wording SD §9 assumes;
  - `Specified permissions are not sufficient`, the wording often reported for Apps Script services.

  An unmatched error follows the normal error rules. Record the real text when E10's pilot or a user report first shows one.

## Notes for README Permissions (#151)

Not observed (the re-consent methods in table 6 weren't run). Facts for #151:

- The consent screen shows the four permissions as checkboxes, **none ticked**. Setup instructions should say to tick all four.
- Whether "run `install` again" offers a missing permission again is unverified. If E7 makes `install` call `requireAllScopes`, the README can say so. Until then, the reliable way is to remove the script's access at <https://myaccount.google.com/connections> and run `install` again.

## Design changes

**Scope decision (PM, 2026-09-26):** accept B0 plus Google's docs. The maintainer declined the partial-consent runs ([comment on #27](https://github.com/kellystuard/jev-gmail-classifier/issues/27#issuecomment-5848642753)). Observing the real per-scope errors moved to E7 (#268), which the maintainer then skipped too (2026-09-30): an accepted v1 risk, SD §14.

- **SD §5.2, `AuthPort` row:** `getAuthorizationInfo(FULL).getAuthorizedScopes()`; `missingScopes()` is declared minus authorized, or "unknown" if the call throws.
- **SD §9:**
  - The preflight call.
  - No scope is pre-ticked on the consent screen.
  - The preflight is the primary defense in scheduled runs (documented trigger behavior).
  - A new `install` and missing-scopes bullet (`requireAllScopes`, decided by #128).
  - The per-action fallback now covers all four scopes and matches three message fragments, marked not observed. A `rateLimitExceeded` 403 isn't a scope error.
- **SD §13 E7 row:** "API settled, error text not observed", with the follow-ups in #125 and #128.
- **No ADR:** nothing observed overturns ADR-0003. If #125 confirms that a trigger run fails uncatchably at an unauthorized call, the per-action part of ADR-0003 should be revisited then.
- **Issues updated:**
  - #94, #112, #124, #125, #127, #128, #146: E1 notes added.
  - #125: a new Done-when checkbox, "observe the real per-scope errors … and confirm the adapters' message fragments".
  - #112: a checkbox to confirm its fragments.
  - #127: the trigger-deletion pitfall.
  - #128: the `requireAllScopes` decision.
- **#151:** linked from a comment with the notes above.
