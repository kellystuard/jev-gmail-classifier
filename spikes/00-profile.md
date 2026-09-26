# 00: Profile spike

- Task: #18
- Date run:
- Account: `<test-account>` (consumer)
- Run by: agent via #163 / maintainer in editor

## Question

Does the shared spike Apps Script project work end to end: manifest, enabled Gmail advanced service, and declared scopes, confirmed by a trivial `Gmail.Users.getProfile('me')` call that returns a `historyId`?

## Runbook

1. Create the spike project (Setup option A or B in `spikes/README.md`), and paste or push `spikes/appsscript.json` and `spikes/00-profile.js`.
2. Select `s00_profile` in the editor's function dropdown and run it. Grant every scope at the consent screen.
3. Confirm the consent screen listed exactly the four scopes from `spikes/appsscript.json` (`gmail.modify`, `script.external_request`, `script.scriptapp`, `script.send_mail`) and not "Read, compose, send, and permanently delete all your email" (which would mean `https://mail.google.com/` was requested).
4. Copy the Execution log line (the `console.log(JSON.stringify(result))` output) and paste it into the PR, with the test account's address replaced by `<test-account>` if it appears anywhere in the log.

## Maintainer steps

None for this task. No manual run is needed to complete #18: the manual path above is documented for reference, but the first real run of `s00_profile` and the consent-screen scope check are recorded by #163, once the Apps Script API runner and the `spikes.yml` workflow exist.

## Results

(Recorded by #163.)

| # | Scenario | What was done | Observed | Matches design? |
|---|----------|---------------|----------|-----------------|

## Raw output

(Recorded by #163.)

<details><summary>Log</summary>

</details>

## Conclusion

(Recorded by #163.)

## Design changes

(Recorded by #163, if any.)

## Automated run

`node spikes/run.mjs` and the manual `spikes.yml` workflow-dispatch run are recorded here by #163, once that task lands.
