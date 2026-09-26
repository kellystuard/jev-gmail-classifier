# 00: Profile spike

- Task: #18 (spike and manual runbook), #163 (first run and runner checks)
- Date run: 2026-09-26
- Account: `<test-account>` (consumer)
- Run by: agent via #163 (`node spikes/run.mjs`, Node 22); the workflow-dispatch run is pending (see [Automated run](#automated-run))

## Question

Does the shared spike Apps Script project work end to end: manifest, enabled Gmail advanced service, and declared scopes, confirmed by a trivial `Gmail.Users.getProfile('me')` call that returns a `historyId`?

#163 adds: can agents and GitHub Actions push and run spike functions through the Apps Script API, safely, on the test account only?

## Runbook

### Automated (the normal path, #163)

1. One-time setup: `spikes/README.md` → "Running spikes automatically" → "One-time setup (maintainer)".
2. `node spikes/run.mjs check`
3. `node spikes/run.mjs push`, then `node spikes/run.mjs run s00_profile`.
4. Account guard: `GMAIL_EMAIL=not-the-test-account@example.com node spikes/run.mjs run s00_profile` must refuse.
5. Runner checks: `run s163_echo '{"a":[1,"b",true,null],"n":3.5}'`, `run s163_echo '{"bytes":N}'` for N up to 100,000,000, `run s163_echo '{"bytes":-1}'` (a script error), `run s163_trigger`, `run s99_missing`, and two `run`s at once.
6. After #163 merges: `gh workflow run spikes.yml --ref main -f function=s00_profile`.

### Manual (editor)

1. Create the spike project (Setup option A or B in `spikes/README.md`), and paste or push `spikes/appsscript.json` and `spikes/00-profile.js`.
2. Select `s00_profile` in the editor's function dropdown and run it. Grant every scope at the consent screen.
3. Confirm the consent screen listed exactly the four scopes from `spikes/appsscript.json` (`gmail.modify`, `script.external_request`, `script.scriptapp`, `script.send_mail`) and not "Read, compose, send, and permanently delete all your email" (which would mean `https://mail.google.com/` was requested).
4. Copy the Execution log line (the `console.log(JSON.stringify(result))` output) and paste it into the PR, with the test account's address replaced by `<test-account>` if it appears anywhere in the log.

## Maintainer steps

The one-time setup in #163 (Cloud project, consent screen, OAuth client, `auth.mjs`, linking the spike project, GitHub secrets). Done on 2026-09-26. Nothing else.

## Results

| # | Scenario | What was done | Observed | Matches design? |
|---|----------|---------------|----------|-----------------|
| 1 | Consent-screen scopes | Maintainer ran `auth.mjs` and ticked every box; `run.mjs check` lists the token's granted scopes | Exactly six: `gmail.modify`, `script.external_request`, `script.scriptapp`, `script.send_mail`, `script.projects`, `script.deployments`. **No `https://mail.google.com/`** (so no "Read, compose, send, and permanently delete all your email" grant). Evidence is the granted-scope list; the maintainer didn't separately confirm the wording on screen. | Yes (SD §9, ADR-0003) |
| 2 | `check` | `node spikes/run.mjs check` | Account matches `GMAIL_EMAIL`; files `appsscript`, `00-profile`, `163-runner`; one deployment: HEAD, entry point `EXECUTION_API` | Yes |
| 3 | `push` | Pushed twice | First push updated `appsscript` (remote differed after setup); second push changed nothing (`unchanged: 3`) | Yes |
| 4 | **`s00_profile` (local)** | `node spikes/run.mjs run s00_profile` | `historyId` `36553749`, `messagesTotal` 41735, `threadsTotal` 40176, in 0.6 s. No address returned. | Yes |
| 5 | Account guard | `GMAIL_EMAIL` set to a different address, for `run` and `push` | Both refused, exit 2: "Refusing: the token belongs to a different Google account than GMAIL_EMAIL. Nothing was pushed or run." | Yes |
| 6 | Missing function | `run s99_missing` | Clear error before calling the API: "Function s99_missing is not in the spike project (3 files). Push a checkout that defines it first", exit 2 | Yes |
| 7 | Parameters | `run s163_echo '{"a":[1,"b",true,null],"n":3.5}'` and `'[{"x":1},2]'` | Object and array round-tripped exactly; a JSON array is the parameter list | Yes |
| 8 | Script error | `run s163_echo '{"bytes":-1}'` | HTTP 200 with an error: `errorType` `USER_ERROR`, `errorMessage` "RangeError: Invalid count value: -1", stack `s163_echo:14`; runner exit 1 | Yes |
| 9 | Triggers through the API | `run s163_trigger` | First version: **HTTP 500 INTERNAL**, no details. Diagnosis (`s163_triggerSteps`): `newTrigger(...).timeBased().everyHours(1).create()` works, but `ScriptApp.deleteTrigger()` on the object returned by `create()` in the same execution throws "Unexpected error while getting the method or property deleteTrigger on object ScriptApp.", which `scripts.run` reports as a bare 500. Deleting the copy from `getProjectTriggers()` works: `{created: true, found: true, deleted: true}`. No `s163_` triggers were left behind. | Yes, with a pitfall for #21 and #23 (README "Limits") |
| 10 | Response size | `run s163_echo '{"bytes":N}'` for 1, 5, 10, 30, 60, 100 MB | All returned; 100 MB in 4.3 s. No `scripts.run` limit was hit. | Nothing to confirm (Google documents no limit) |
| 11 | Parallel runs | Two `run s163_echo` processes at once | Both returned their own result | Yes (#30) |
| 12 | Network error | A connection timeout happened once during testing | Runner now prints "Network error (ETIMEDOUT); try again." instead of a stack | n/a |
| 13 | **`s00_profile` (workflow dispatch)** | `gh workflow run spikes.yml --ref main -f function=s00_profile` | Pending: the workflow can only be dispatched once it's on `main` | — |

## Raw output

<details><summary>Log (local, 2026-09-26)</summary>

```
$ node spikes/run.mjs run s00_profile
{
  "messagesTotal": 41735,
  "historyId": "36553749",
  "threadsTotal": 40176
}
(s00_profile ran in 0.6 s; response 227 bytes)

$ GMAIL_EMAIL=not-the-test-account@example.com node spikes/run.mjs run s00_profile
Refusing: the token belongs to a different Google account than GMAIL_EMAIL. Nothing was pushed or run.

$ node spikes/run.mjs run s163_trigger        # first version
scripts.run failed: HTTP 500 INTERNAL: Internal error encountered..

$ node spikes/run.mjs run s163_triggerSteps '"roundtrip"'
{
  "found": true,
  "at": "delete",
  "step": "roundtrip",
  "error": "Unexpected error while getting the method or property deleteTrigger on object ScriptApp."
}

$ node spikes/run.mjs run s163_trigger        # deleting the getProjectTriggers() copy
{
  "deleted": true,
  "found": true,
  "created": true
}
(s163_trigger ran in 1.5 s; response 204 bytes)

$ node spikes/run.mjs run s163_echo '{"bytes":100000000}'
(s163_echo ran in 4.3 s; response 100000247 bytes)

$ node spikes/run.mjs run s163_echo '{"bytes":-1}'
{
  "function": "s163_echo",
  "errorType": "USER_ERROR",
  "errorMessage": "RangeError: Invalid count value: -1",
  "stack": [
    "s163_echo:14"
  ],
  "seconds": 0.7
}
s163_echo threw a script error.
```

</details>

## Conclusion

The spike project works end to end. The manifest, the Gmail advanced service, and the four declared scopes are enough for `getProfile`, and no full-Gmail scope was granted. Agents can push and run spike functions through the Apps Script API with `devMode: true` on the script ID. The HEAD deployment created by the manifest's `executionApi` key is enough, so no versioned deployment is needed. The account guard refuses any other account. Spikes that manage triggers must delete the copy returned by `getProjectTriggers()`, never the object returned by `create()` in the same execution.

## Design changes

- [ADR-0016](../output/adr/0016-run-spikes-from-agents-and-a-manual-workflow.md) (Proposed): spikes run from agents and a manual workflow. It amends Engineering Standards §8 and Solution Design §12 (no live calls in CI, except `spikes.yml`) and §10.6 (`.env` holds the spike credentials).
- No change to SD §9: the manifest and scopes are confirmed as written.

## Automated run

| Path | Date | Result |
|------|------|--------|
| `node spikes/run.mjs run s00_profile` (Node 22, agent) | 2026-09-26 | `historyId` returned (row 4) |
| `spikes.yml` workflow dispatch (Node 24) | pending | Recorded after #163 merges and the workflow is on `main` |
