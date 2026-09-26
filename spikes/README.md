# Spikes

## Purpose and rules

These are spikes for [epic #7](https://github.com/kellystuard/jev-gmail-classifier/issues/7): hand-run scripts that confirm or correct assumptions about Gmail (History API, exclusion queries, labels, and moves) before E3 and E6 are built. They are **plain Apps Script JavaScript**, not TypeScript, and are not part of the E2 build: no `src/`, no build/lint/test tooling, and E2's tooling excludes `spikes/`.

`GmailApp` is never used, even here ([ADR-0003](../output/adr/0003-advanced-gmail-service-and-scopes.md)): the product can't use it, so its behavior would prove nothing. Only the Advanced Gmail Service (`Gmail.Users.*`) is used.

Spikes run against a throwaway **consumer** Gmail test account with only synthetic mail, referred to everywhere as `<test-account>`. **Its address is never written** in files, issues, PRs, commits, logs, or findings — not even as a fragment. Never commit real mail, OAuth secrets, refresh tokens, `.clasp.json`, `.clasprc.json`, or API keys.

## One project, many files

All spikes live in **one** Apps Script project, so every file shares one global namespace.

- `NN` in `spikes/NN-slug.js` is the task's issue number (for example `spikes/19-message-added.js`; this task's trivial spike is `00-profile`), so parallel PRs never collide.
- Every top-level function is prefixed `sNN_` (`s19_start`, `s21_report`). Helpers stay inside a spike's own functions, or use the same prefix if they must be top-level.
- A spike creates and deletes only its own triggers (handler names starting `sNN_`) and Script Properties (keys starting `sNN.`), never "all triggers" — other spikes' triggers may be running.

## Functions return their results

Every runnable top-level function returns a JSON-serializable result object and also calls `console.log(JSON.stringify(result))`. The Apps Script API (`scripts.run`, used by #163) returns only the return value; console output goes to Cloud Logging, not the API response. Functions may take JSON arguments for automated runs, but should have defaults so they also run unmodified from the editor.

Returned results are scrubbed of the test account's address before they're logged or committed anywhere.

## Setup, option A (editor)

1. Sign in as the test account.
2. Create a standalone project at [script.google.com](https://script.google.com).
3. Project Settings → tick "Show `appsscript.json` manifest file in editor", then paste `spikes/appsscript.json` over it (this enables the Gmail advanced service v1; alternatively add it under Services → Gmail API).
4. Add one script file per spike and paste its contents.

## Setup, option B (clasp 3)

1. `npm i -g @google/clasp`
2. `clasp login` as the test account.
3. From `spikes/`: `clasp create --type standalone --title "jev-spikes"` (or `clasp clone <scriptId>` if the project already exists), then `clasp push`.

The generated `spikes/.clasp.json` is git-ignored. Check that `clasp push` uploads only `.js` files and `appsscript.json`; if it also tries to push `.md` files, add a `spikes/.claspignore` with `**/*.md`.

## Running a function

Select the function in the editor's function dropdown → Run.

First run: the consent screen shows "Google hasn't verified this app" → Advanced → Go to jev-spikes (unsafe) → tick **every** scope (granular consent lets you leave some unticked, which breaks the spike being tested) → Allow. Copy the Execution log.

## Re-authorizing

Needed after the manifest's scopes change. Revoke access (below), then run any function again to get a fresh consent screen with the new scope list.

## Revoking access

Google Account → Security → [Your connections to third-party apps & services](https://myaccount.google.com/connections) → jev-spikes → Delete all connections. Also delete any triggers a spike created (editor → Triggers).

## Recording findings

The protocol from epic #7:

1. The agent writes `spikes/NN-slug.js` and `spikes/NN-slug.md` in a draft PR.
2. The agent runs the functions (via #163 once it lands; until then the maintainer runs them in the editor and pastes the log).
3. The agent records the returned JSON, fills in the results table, and updates the design docs.

Maintainer-only steps (Gmail UI actions, consent screens) are listed in each findings file under **Maintainer steps**, and the agent asks for all of them in one PR comment. Replace any real address with `<test-account>` before committing output.

## Running spikes automatically

(Placeholder — filled in by #163.)

## Findings-file template

Copy this for each spike's `spikes/NN-slug.md`:

```
# NN: <title>
- Task: #N
- Date run: YYYY-MM-DD
- Account: `<test-account>` (consumer)
- Run by: agent via #163 / maintainer in editor
## Question
## Runbook
1. ...
## Maintainer steps
(only what needs the Gmail UI or a consent screen; "None" if nothing)
## Results
| # | Scenario | What was done | Observed | Matches design? |
|---|----------|---------------|----------|-----------------|
## Raw output
<details><summary>Log</summary> ... </details>
## Conclusion
## Design changes
(SD sections, ADRs, and issues updated)
```

## Index

| Spike | Task | Result |
|-------|------|--------|
| [00-profile](00-profile.md) | #18 | Manual runbook documented; first run recorded by #163. |
