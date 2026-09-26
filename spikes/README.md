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

Agents and GitHub Actions push and run spike functions through the Apps Script API, with no editor and no maintainer in the loop ([ADR-0016](../output/adr/0016-run-spikes-from-agents-and-a-manual-workflow.md)). Two zero-dependency Node scripts do it; they run on Node 22 and 24:

- `spikes/auth.mjs`: the one-time OAuth flow that mints `SPIKE_REFRESH_TOKEN`.
- `spikes/run.mjs`: the runner.

Both read `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SPIKE_REFRESH_TOKEN`, `SPIKE_SCRIPT_ID`, and `GMAIL_EMAIL` from the environment, falling back to the repo's `.env` (or `--env <file>`). See `.env.example`. They never print tokens, secrets, or the test account's address, and they scrub the address (and plus-addresses) from anything they print.

### Commands

| Command | What it does |
|---------|--------------|
| `node spikes/run.mjs push` | Merges this checkout's `spikes/*.js` and `spikes/appsscript.json` into the shared spike project (see below). Prints what it added, updated, and kept. |
| `node spikes/run.mjs run <function> [json]` | Runs the function on the most recently pushed code (`devMode`) and prints its return value as JSON on stdout. `json` is the parameter array (`'[1, "a"]'`) or one value (`'{"n":3}'`); to pass a single array, wrap it (`'[[1,2]]'`). On a script error it prints `errorType`, `errorMessage`, and the stack to stderr and exits 1. |
| `node spikes/run.mjs check` | Account guard, granted scopes, the project's files, and its deployments. Changes nothing. |
| `node spikes/run.mjs setup [title]` | One-time: creates the spike project (`jev-spikes`) if `SPIKE_SCRIPT_ID` is unset, saves its ID to `.env`, and pushes. |
| `node spikes/run.mjs deploy` | Creates an API-executable deployment if the project has none. Only needed if `run` fails with a 404 (see the setup notes). |

Other exit codes: 2 for a usage, configuration, guard, or HTTP error. A typical agent session:

```sh
node spikes/run.mjs push
node spikes/run.mjs run s19_start '{"tag":"a"}'
```

**Account guard.** Before anything else, every command calls Gmail `users.getProfile` with the token and refuses unless the address equals `GMAIL_EMAIL`. It also refuses a token that lacks a manifest scope or carries `https://mail.google.com/`.

### `push` merges; it never wipes other spikes

`projects.updateContent` replaces the whole project, and many branches push to the one shared project. So `push`:

1. reads the project (`projects.getContent`);
2. re-reads it right before writing (only if something needs to change), and builds the merge from that: this checkout's files replace same-named ones, every remote file it doesn't have (other branches' spikes, and the handlers of their running triggers) is kept, and its new files are added; the second read narrows, but doesn't close, the window in which a concurrent push could land (#176; see "Limits");
3. writes that merge, then reads the project again and checks that both its own `.js` files and every foreign file the pre-write read saw are still there, unchanged;
4. if anything is missing or changed, a concurrent push landed: retries after a short random wait (up to 4 attempts), then fails with a clear message naming the affected files.

Consequences to know:

- **Files are never deleted by `push`.** To remove a renamed or abandoned spike, delete it in the editor. Two files defining the same top-level function would silently shadow each other, which the `sNN_` prefix prevents.
- **The manifest is shared and last-writer-wins.** Change `spikes/appsscript.json` only through a PR to `main`, and rebase before pushing, or you may push an older manifest over a newer one. `push` warns if the remote manifest differs from yours afterwards.
- **`run` executes whatever was pushed last**, from any branch. Since every spike has its own file and prefix, that's only a problem for the manifest.
- `run` checks that the function is defined in the project before calling it, and says to push if it isn't.

### Limits

- **6 minutes per execution**, as in the editor. The runner waits up to 7 minutes. Design long spikes as several calls, or as triggers that store results in `sNN.` Script Properties.
- **Only return values come back.** `console.log` output goes to Cloud Logging, not the API response. Parameters and return values must be plain JSON types (strings, numbers, booleans, arrays, objects).
- **Response size.** Google documents no limit for `scripts.run`, and none was hit: `s163_echo` returned 100 MB in 4.3 s (2026-09-26, [00-profile.md](00-profile.md#automated-run)). The practical limits are elsewhere: the Actions **job summary holds at most 1 MiB** (the workflow puts larger results in the log only), and big results are hard to read. Return summaries and counts, not raw lists. The runner prints each response's size to stderr.
- **Parallel runs are fine.** The runner keeps no temp files or locks; each process refreshes its own access token. Two concurrent `run`s were tested.
- **Parallel `push`es are handled, but a window remains.** `push` re-reads right before writing and retries when a concurrent push is detected (#176; tested offline in `spikes/run.test.mjs`, `node --test spikes/run.test.mjs`), but a race landing in the instant between that last read and the write itself can't be closed this way — one push's write can still silently revert the other's. Run `push` right before a run whose result you record, rather than relying on an earlier push.
- **Script errors.** A thrown JavaScript error comes back as `USER_ERROR` with the message and stack, and `run` exits 1. An *internal* Apps Script error (for example "Unexpected error while getting the method or property …") comes back as a bare **HTTP 500 INTERNAL** with no details. If a spike gets one, wrap its steps in `try`/`catch` and return the message.
- **Triggers.** A function run through the API can create and delete time-driven triggers (`s163_trigger` checks this). Triggers then run as the test account on the project's current code. **Pitfall:** deleting the `Trigger` object returned by `create()` in the same execution fails with an internal error (HTTP 500). Delete the copy returned by `ScriptApp.getProjectTriggers()` instead, matched by `getUniqueId()` or handler name.

### GitHub Actions

`.github/workflows/spikes.yml` is dispatched by hand only (never on `pull_request` or `push`). It uses the `spike-account` environment's secrets, runs `push` (unless `push=false`) and then `run` on Node 24, and writes the result JSON to the log and the job summary. It must be on `main` before it can be dispatched; after that, any branch can be targeted:

```sh
gh workflow run spikes.yml --ref <branch> -f function=s19_start -f args='{"tag":"a"}'
gh run list --workflow spikes.yml --limit 1   # find the run ID
gh run watch <run-id>
gh run view <run-id> --log
```

Anyone with write access can dispatch it against any branch, and that branch's code gets the secrets. That's acceptable only because the account is a throwaway (ADR-0016).

### One-time setup (maintainer)

Do these once, **signed in as the test account** throughout, so that it owns the Cloud project, the OAuth client, and the spike project.

1. **Cloud project.** At https://console.cloud.google.com, create a standard project (for example `jev-spikes`). Note its **project number** (Dashboard → Project info). Under APIs & Services → Library, enable the **Apps Script API** and the **Gmail API**.
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type **External**. App name `jev-spike-runner` (not `jev-spikes`, so it can't be confused with the Apps Script project on the connections page); support and developer email: the test account.
   - Audience → add the test account as a test user, then **Publish app** so the publishing status is **In production**. It stays unverified, which is fine for one user: the consent screen shows "Google hasn't verified this app", and the account can still grant it. Don't submit it for verification. Why: in **Testing** status, Google expires refresh tokens after **7 days**, which would break unattended runs weekly (and #21's 7-day watch). In production, the token lasts until it's revoked, unused for 6 months, or the test account's password changes (it carries Gmail scopes).
   - Data access: you don't need to add scopes here; `auth.mjs` requests them.
3. **OAuth client.** Clients → Create client → **Desktop app** (`jev-spikes-runner`). Copy the client ID and secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Make sure `GMAIL_EMAIL` is already there.
4. **Apps Script API user setting.** At https://script.google.com/home/usersettings, turn on **Google Apps Script API**.
5. **Refresh token.** Run `node spikes/auth.mjs`. Open the printed URL, sign in as the test account, click Advanced → Go to jev-spike-runner (unsafe), and **tick every box**. The screen should list six permissions: Gmail (`gmail.modify`), connecting to an external service, running when you're not present, sending email as you, and managing Apps Script projects and deployments. It must **not** say "Read, compose, send, and permanently delete all your email". `auth.mjs` checks the granted scopes and the account, prints the granted scopes, and saves `SPIKE_REFRESH_TOKEN` to `.env` without printing it. If the browser can't reach the `127.0.0.1` page (possible under WSL), paste the browser's full address into the terminal.
6. **Spike project.** Run `node spikes/run.mjs setup`. It creates the `jev-spikes` Apps Script project in the test account's Drive (unless `SPIKE_SCRIPT_ID` is already set to one you made by hand), saves `SPIKE_SCRIPT_ID` to `.env`, and pushes the spikes. It prints the project's settings URL.
7. **Link the spike project to the Cloud project.** Open that settings URL (Project Settings) → Google Cloud Platform (GCP) Project → **Change project** → enter the project number from step 1. `scripts.run` only works when the script and the OAuth client share a standard Cloud project.
8. **GitHub secrets.** Copy the five runner values from `.env` into the `spike-account` environment (Settings → Environments; the environment already exists), without echoing them:

   ```sh
   for k in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET SPIKE_REFRESH_TOKEN SPIKE_SCRIPT_ID GMAIL_EMAIL; do
     printf %s "$(grep "^$k=" .env | cut -d= -f2-)" | gh secret set "$k" --env spike-account --repo kellystuard/jev-gmail-classifier
   done
   ```

   (The values in `.env` must be unquoted.) `JEV_API_KEY` stays local; the spike workflow doesn't use it.

After that, `node spikes/run.mjs check` should report the account match, six scopes, and the project's files, and `node spikes/run.mjs run s00_profile` should return a `historyId`.

**No versioned deployment is needed.** With `"executionApi": { "access": "MYSELF" }` in the manifest, the project's HEAD deployment has an `EXECUTION_API` entry point, and `scripts.run` with `devMode: true` on the script ID works (verified 2026-09-26). `node spikes/run.mjs deploy` is a fallback only, in case `run` ever returns HTTP 404 while `check` works.

### Revoking and re-minting the token

`SPIKE_REFRESH_TOKEN` is a grant to the **jev-spike-runner** OAuth app, listed at [Your connections to third-party apps & services](https://myaccount.google.com/connections). **Removing that entry (or deleting the OAuth client) revokes the token**, and every automated run then fails with `invalid_grant`. #27 removes a project's access on that page: remove only #27's own project, never jev-spike-runner. An Apps Script entry named jev-spikes (from an editor run) is a separate grant and doesn't affect the runner.

To mint a new token: run `node spikes/auth.mjs` again (it overwrites `SPIKE_REFRESH_TOKEN` in `.env`), then update the secret: `printf %s "$(grep '^SPIKE_REFRESH_TOKEN=' .env | cut -d= -f2-)" | gh secret set SPIKE_REFRESH_TOKEN --env spike-account --repo kellystuard/jev-gmail-classifier`. The same applies after the manifest's scopes change: the runner refuses a token that lacks one.

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
| [00-profile](00-profile.md) | #18, #163 | Works: `s00_profile` returned a `historyId` through `node spikes/run.mjs` and the `spikes.yml` workflow (2026-09-26). The runner checks (`163-runner.js`) are recorded there too. |
| [23-exclusion-query](23-exclusion-query.md) | #23 | Run 2026-09-26. Scheduled search works with `includeSpamTrash: true`, a window from the oldest message to at least now + 1 d, and paging; the ADR-0005 manual form leaks (ADR-0017). Indexing lag under 1 s. |
| [30-gmail-quota](30-gmail-quota.md) | #30 | Docs checked 2026-09-25; counter and latency not run yet (waits for #163). |
