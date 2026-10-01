# Pilot plan

The plan for the v1 pilot, and the record of its start. Task #157, story #156, epic #16. All times are in UTC. Dates are `YYYY-MM-DD`.

## 1. Purpose

- **What it proves.** Release criterion 3 of PDD §11: v1 runs on the maintainer's own inbox for 2 consecutive weeks while meeting the Vision's six success measures (precision, latency, coverage, cost, quota safety, effort).
- **Where.** The maintainer's own mailbox, a consumer Gmail account. Nothing in v1 was run on a Workspace account (epic #16 decision 5).
- **What this file is.** It says exactly how each measure is read, so that the 14 days (#158) only have to follow it. It also holds the first start record (section 4).
- **Where it ends.** In `docs/pilot-report.md` (#158): each measure with its number and pass or fail. Everything that happens after the start is recorded there, not here (story #156, S12).

## 2. Who does what, and what is never written down

| Who | Does |
|-----|------|
| The maintainer | Deploys to the pilot account. Does the one-time logging setup. Declares the start. Does the spot-check and picks the cross-check threads, which need the mail. Notes every push and every action after the start on #158. Makes the judgments this plan leaves to them. |
| An agent, in a session on the maintainer's machine | Exports the pilot's log with `gcloud logging read`, runs the reducer (`scripts/pilot-measures.ts`, #315) on it, and posts what the reducer prints. It may read raw log lines to find the cause of a problem. It writes this plan and the report. |
| No agent, ever | Runs anything on the maintainer's mailbox, opens its mail, runs `clasp` or `npm run push`, or runs any `gcloud` command other than `gcloud logging read` on the pilot's project. The `gcloud` login can reach more than the log. |

Nothing waits or polls. The PM starts an agent session when a checkpoint's date comes, and when the maintainer has removed the `needs: maintainer` label after a step of their own.

**This repository and its issues are public.** The pilot's log holds subjects, senders, thread IDs, label names and a manual run's query.

- **Never** in this file, the report, an issue, a PR or a commit: a subject, a sender, an address, a body, a query, a label name, a thread ID, a `runId`, a rule's question, the API key, the Cloud project's ID or number, the script ID, a value from `.env`, or a raw log line. Never paste `gcloud`'s own output: its messages can name the project.
- **Allowed:** counts, event names, rule IDs, `stopped` values, error class names, `reason` codes, alert conditions, model names and dates. The reducer prints only these, so its output is posted as it is.
- **Local files** (exports, worksheets, cross-check files, copies of the pilot's config) live in `~/.local/share/jev-pilot/` on the maintainer's machine. That folder is outside every checkout and worktree. Never copy one of these files, or a line of one, into the repository or into a session's scratch folder. The folder is deleted when #158's report is merged.

## 3. Before the start

The steps are in order. The maintainer does 3.1 to 3.4, an agent does 3.5, and 3.6 is free time.

### 3.1 The README walk-through (maintainer)

It starts when #150, #151, #152, #155 and #315 are closed.

1. Take a fresh clone of `main`.
2. Follow README "Setup" exactly, steps 1 to 10, and nothing else. Stay on the default Cloud project: don't open the Cloud console. Note every step that was wrong, unclear or missing.
3. Post the notes on #157, or "no corrections". They are about the README only: no mail content, no script ID.
4. An agent files the corrections as bugs under #156 and fixes them in `docs(readme): …` PRs. Wait until they are merged, and read the corrected steps.

This fresh clone is the **deploy checkout** for the whole pilot (section 5).

### 3.2 The pilot-only logging setup (maintainer, once)

This step is not in the README, because a normal user doesn't need it. Without it the log exists only on the Apps Script Executions page, and nothing can export it. The Cloud project is only the pipe that lets the log be exported: the classifier's code, config and behaviour don't change.

Know two things first (Google's [Cloud projects for Apps Script](https://developers.google.com/apps-script/guides/cloud-platform-projects), checked 2026-10-01): "You can't switch a script back to a default project", and "All users who have previously authorized the script must re-authorize."

1. **Create a standard Cloud project.** In the Cloud console, signed in as the pilot account, open the **Manage resources** page and click **Create project**. Give it a name, choose **No organization**, and click **Create** ([Creating and managing projects](https://cloud.google.com/resource-manager/docs/creating-managing-projects), checked 2026-10-01). Note its **project ID** and its **project number** for the steps below. Both stay private.
2. **Configure the OAuth consent screen.** With the new project selected, open **Menu → Google Auth platform → Branding** and click through the setup: an app name, your own address as the support email, the audience **External**, your own address as the contact, agree to the policy, **Create** ([Configure OAuth consent](https://developers.google.com/workspace/guides/configure-oauth-consent), checked 2026-10-01).
3. **Set it to "In production".** Open **Google Auth platform → Audience** and click **Publish app**. The publishing status must read **In production**, not **Testing**. Don't submit the app for verification: an unverified app is fine for your own account, and Google shows the "Google hasn't verified this app" screen that README "Setup" step 9 already covers. Why this matters: Google documents that a project with an external user type and the status "Testing" "is issued a refresh token expiring in 7 days" ([OAuth 2.0](https://developers.google.com/identity/protocols/oauth2), checked 2026-10-01). Section 10 says what is not known about that.
4. **Turn on the Gmail API in that project.** Open **Menu → APIs & Services → Library**, find **Gmail API** and click **Enable** ([Enable Google Workspace APIs](https://developers.google.com/workspace/guides/enable-apis), checked 2026-10-01). The classifier uses the Advanced Gmail Service, and Google says "you must turn on the corresponding APIs in the new Cloud project".
5. **Attach the project to the script.** In the Apps Script editor of the pilot's project, click **Project Settings**. Under **Google Cloud Project**, click **Change project**, enter the project number, and click **Set project**.
6. **Run `install` again.** In the editor, choose `install` and click **Run**. Google asks for permission again: tick all four boxes, as in README "Setup" step 9. Don't set `RESET_POSITION`. You should see a `run.end` line with `position: "kept"` and `triggerMinutes`, and the **Triggers** page should list one trigger for `onTrigger`.
7. **Check that the log arrives.** After one trigger interval, open the [Logs Explorer](https://console.cloud.google.com/logs/query) with the pilot's project selected. You should see the lines of the last run, such as `run.start` and `run.end`. If nothing shows after two intervals, check that the Executions page still shows new `onTrigger` runs, and say what you see on #157.

The console's labels above come from Google's pages, not from a walk-through. If one differs, note it on #157 (the label only).

### 3.3 `gcloud` on the maintainer's machine (maintainer, once)

1. Install the Google Cloud CLI ([Install the gcloud CLI](https://cloud.google.com/sdk/docs/install)).
2. Run `gcloud auth login` and sign in with the pilot account in the browser it opens.

The login is used for one thing: `gcloud logging read` on the pilot's project, run by an agent at the trial export and at each checkpoint. An agent runs no other `gcloud` command. If the export fails for a login or permission reason, the agent says so on the issue and adds the label. It doesn't try another command.

### 3.4 Two keys in `.env` (maintainer, once)

In the `.env` of the **main checkout** (git-ignored; `.env.example` lists the keys), without quotes:

- `PILOT_GCP_PROJECT`: the Cloud project's ID (not its number).
- `PILOT_CONFIG`: the absolute path of the `config.yaml` that is pushed to the pilot account (the one in the deploy checkout).

These two keys are how the project ID and the path reach an agent without being written on an issue. Then remove the `needs: maintainer` label from #157.

### 3.5 The trial export (agent)

It proves that the export works and that the reducer can read it, before the clock starts. It needs the logging setup and at least two scheduled runs after it.

1. Export the last 2 hours to `~/.local/share/jev-pilot/export-trial.json`, with the commands of section 6.
2. Run the reducer on it with `--from` and `--to` set to those 2 hours.
3. It parses when `window.events` is above 0, `runs.onTrigger.ended` is above 0, and `window.unparsed` is small against `window.entries`.
4. Look at one entry. Record in section 10 which field held the line (`jsonPayload.message` or `textPayload`) and what `resource.type` is. Those two names are all that is written down.
5. Post the reducer's printed output on #157 and add `needs: maintainer` for the start declaration.
6. If the reducer can't read the shape, file a bug under #156 for `scripts/`, with a synthetic entry of the same shape (the field names, with made-up values). The fix doesn't restart the clock, and the start waits for it.
7. Delete `export-trial.json` when the start record is written.

### 3.6 Tuning (maintainer)

Tune the config for as long as you want (README "Tuning"). Nothing before the start counts. The pilot's config has `triggerIntervalMinutes: 10` and at least one move rule (story #156, S6). When you are ready, declare the start: post the values of section 4 on #157 and remove the label.

## 4. Start record

Filled in by an agent from the values the maintainer posts on #157. It is empty until the start.

| Item | Value |
|------|-------|
| Deploy date | |
| T0 (`YYYY-MM-DDTHH:MMZ`) | |
| Commit (full SHA) | |
| Version (`package.json` at that commit) | |
| `triggerIntervalMinutes` | |
| `timeZone` as deployed | |
| `jevModel` | |
| Account kind (consumer or Workspace) | |
| Label rules (count) | |
| Move rules (count) | |
| Move destinations by kind (`archive`, `spam`, `trash`, `label`) | |
| `excludeQuery` set (yes or no) | |
| Logging: standard Cloud project attached (yes or no) | |
| Logging: consent screen's publishing status | |
| Logging: date of the trial export | |
| Logging: payload field that held the line | |
| README walk-through: date | |
| README walk-through: commit of the README that was followed | |
| README walk-through: corrections, each with its bug and PR number (or "none") | |
| README walk-through: all merged before T0 (yes or no) | |

Never in this record: a rule's question, a label name, the exclusion query, the Cloud project's ID or number, the script ID, an address, or a path on the maintainer's machine other than `~/.local/share/jev-pilot/`.

**How the agent checks it** before it marks the PR ready:

- The commit is on `main`: `git merge-base --is-ancestor <commit> origin/main`.
- `git diff <commit>..origin/main -- src appsscript.json package.json package-lock.json` shows no change to the bundle's behaviour (epic #16 decision 14). If it does, the agent says so on #157: the maintainer deploys the newer commit before T0, or the PM holds those changes. A change to what builds the bundle is for the PM to judge (decision 12).
- The version matches `package.json` at that commit.
- The rule counts match `PILOT_CONFIG`.
- Every correction listed is a closed issue with a merged PR, merged before T0.
- T0 is not before the deploy date, and one more export of the last hour shows a scheduled run after the last `install`.

## 5. The window and the clock

- **The window** is 14 × 24 hours from T0. The maintainer declares T0, at or after the last `install` (story #156, S7).
- **The clock restarts** when changed code is deployed to the pilot account: a `fix:` or `feat:` in `src/`, a change to the manifest, or a change of `zod` (epic #16 decision 12). It also restarts when `triggerIntervalMinutes` changes, because latency and the quota figures are defined by it (S4).
- **The clock does not restart** for a config-only push (a threshold, a question, a rule), or for changes to docs, tests, CI, dev dependencies or the reducer. Those are not part of what runs.
- **The deploy checkout stays at the pilot commit** for the whole window, so `npm run push` for a config change never carries new code. Before each push, run `git rev-parse HEAD` in the deploy checkout: it must print the start record's commit.
- **Every push after T0 is noted** by the maintainer on #158: the time (UTC), the kind of change, and the rule IDs it touched. Never the question or the label.
- **Precision after a config change.** Precision for a changed rule counts only the actions after the change. A change of `defaultThreshold`, `jevModel`, `plainTextMethod` or `excludeQuery` counts as a change to every rule. If a late change leaves a rule with too few checked actions, the maintainer chooses: run a few days longer, or judge it.
- **A model change needs no push.** A new `jev-latest` can change probabilities by itself (PDD §9). `rules.models` in the reducer's output shows which models answered, and the report records a change.
- **A restart is not a failure.** The same report carries on with a new window (`w2`, then `w3`), each with its own start record in `docs/pilot-report.md`.

## 6. The measures

### 6.1 How an agent exports the log and runs the reducer

Run these from a checkout or worktree of the current `main`, after `fnm use` and `npm ci`. The reducer is not part of the bundle, so a newer reducer never restarts the clock. A shell's variables don't carry over between an agent's commands: repeat the first block in each command that needs it.

The values, read without printing them. `.env` is read from the main checkout, because a worktree's copy can be old:

```sh
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
PILOT_GCP_PROJECT="$(grep -E '^PILOT_GCP_PROJECT=' "$MAIN/.env" | cut -d= -f2-)"
PILOT_CONFIG="$(grep -E '^PILOT_CONFIG=' "$MAIN/.env" | cut -d= -f2-)"
```

The folder:

```sh
mkdir -p ~/.local/share/jev-pilot && chmod 700 ~/.local/share/jev-pilot
```

The export. `gcloud`'s own messages go to a file in the same folder, so they are never pasted:

```sh
gcloud logging read 'timestamp>="<from>" AND timestamp<"<to>"' \
  --project "$PILOT_GCP_PROJECT" --order=asc --format=json \
  > ~/.local/share/jev-pilot/export-<window>-<checkpoint>.json \
  2> ~/.local/share/jev-pilot/gcloud-messages.txt
```

- `<from>` and `<to>` are UTC times such as `2026-10-05T14:00:00Z`. `<to>` is the time of the export, not the checkpoint's time: lines after the checkpoint let the reducer see a failed thread that was resolved later.
- The first export of a window starts at T0. Each later one starts one hour before the previous export's `<to>`. The reducer drops entries with the same `insertId`, so the overlap is safe.
- Add `AND resource.type="app_script_function"` to the filter only if the trial export showed that value (section 10).
- From Google's [`gcloud logging read`](https://cloud.google.com/sdk/gcloud/reference/logging/read) page (checked 2026-10-01): the default `--limit` is unlimited, the default order is `desc`, and `--freshness` "works only with DESC ordering and filters without a timestamp", so it is not used here.

A copy of the config as it is at the checkpoint. `config.yaml` has no history, so this copy is how a later config change can still be counted against the rules as they were:

```sh
cp "$PILOT_CONFIG" ~/.local/share/jev-pilot/config-<window>-<checkpoint>.yaml
```

The reducer. `<T0>` is the window's start and `<checkpoint>` the checkpoint's own time (T0 + 1, 7 or 14 days):

```sh
node scripts/pilot-measures.ts --from <T0> --to <checkpoint> --interval 10 \
  --config "$PILOT_CONFIG" --usd-per-million 0.042 \
  ~/.local/share/jev-pilot/export-<window>-*.json
```

- `--interval` is `triggerIntervalMinutes` from the start record.
- At C2 and C3, `--worksheet <file>`, `--checked <file>` (once per worksheet) and `--crosscheck <file>` are added (section 8). `--worksheet` and `--checked` need `--config`.
- It prints one JSON object with the sections `window`, `events`, `runs`, `latency`, `coverage`, `cost`, `jev`, `quota`, `alerts` and `rules`, plus `worksheet`, `precision` and `crosscheck` when asked. That output is what is posted.
- A wrong argument or an unreadable file prints one line and exits 1.

File names in `~/.local/share/jev-pilot/`, each with `<window>-<checkpoint>` (for example `w1-c2`): `export-w1-c2.json`, `config-w1-c2.yaml`, `worksheet-w1-c2.csv`, `crosscheck-w1-c2.txt`.

Every event and field below is in SD §10.5 and `src/core/log-events.ts`. Every output key is the reducer's (#315).

### 6.2 Precision

- **Target** (Vision): "At least 95% of applied labels and moves are correct, by manual spot-check".
- **Data.** `thread.classified` lines with a non-empty `actions`. An applied action is one (thread, rule) pair: the rule is in `fired` and its label or move is in `actions`. A move rule that fired while moves weren't allowed is in `fired` and not in `actions`, so it is not an applied action. The maintainer checks every applied move and a sample of the applied labels in Gmail (section 8).
- **Formula.** `precision.estimate` = (correct moves + applied labels × correct labels ÷ checked labels) ÷ (applied moves + applied labels). Moves are counted, because all are checked. Labels are estimated from the sample.
- **Passes when** `precision.estimate` is at least 0.95, with at least 60 actions checked in the window (`precision.moves.checked` + `precision.labels.checked`) and every applied move checked (`precision.moves.checked` equals `precision.moves.applied`). Below 60 the number is reported as "low volume" and the maintainer judges. A wrong `spam` or `trash` move is always listed by rule ID.
- **The reducer prints** `rules` (per rule `id`, `kind`, `fired`, `applied`; `appliedLabels`, `appliedMoves`, `models`) and `precision` (per rule `checked` and `correct`; `moves` and `labels`, each with `applied`, `checked` and `correct`; `estimate`).
- **Also reported:** the counts per rule ID, the counts for moves alone, `rules.models`, and `coverage.moveSkipped` and `coverage.labelsSkipped`.

### 6.3 Latency

- **Target** (Vision): "A conversation is handled within 2 trigger intervals of arrival (about 20 minutes by default)".
- **Data.** `onTrigger` runs: `run.start` and `run.end` (`stopped`, `queueSize`, `ts`), `ingest.done` (`stopped`, `fallback`, `fallbackDone`), and `manual.progress` (`manualQueued`).
- **Formula** (story #156, S8). A **clean run** is an `onTrigger` run whose `run.end` has `stopped: "drained"` and no scheduled item left (`queueSize` minus `manualQueued`), and whose `ingest.done` has no `stopped` and no unfinished fallback. A clean run handled everything that had arrived. A **late episode** is two clean runs in a row where the second ended more than 2 intervals + 120 s after the first started. At 10 minutes that is 1,320 s.
- **Passes when** `latency.lateEpisodes` is 0, with `latency.cleanRuns` above 0.
- **A guard for the window's edges.** The time before the first clean run and after the last one is not inside any pair of clean runs. So when `latency.longestNotCleanStreak` is 2 or more while `lateEpisodes` is 0, the agent reads the raw lines of that streak and reports what it was. Mail that waited there counts as a late episode.
- **The reducer prints** `latency`: `cleanRuns`, `otherRuns`, `lateEpisodes`, `maxCleanSpanMs`, `longestNotCleanStreak`, `startGapMs` (`p50`, `p95`, `max`) and `startGapsOverTwoIntervals`.
- **Also reported:** `maxCleanSpanMs`, `startGapMs.max`, and `runs.onTrigger.stopped` (the count per `stopped` value).

### 6.4 Coverage

- **Target** (Vision): "100% of eligible conversations end up processed or explicitly marked as errored; none are silently skipped".
- **Data.** The sums over `run.end` (`ingested`, `excluded`, `skipped`, `classified`, `errored`, `gone`, `struck`, `untouched`, `queueSize`); `history.fallback_missed` (`missed`); `thread.failed` and a later `thread.classified`, `thread.errored` or `thread.skipped` for the same thread; and the cross-check (section 8), which is the only check of mail that Gmail's history never reported.
- **Formula.** In a scheduled run an item leaves the queue only as excluded, skipped, classified, errored or gone. So a run's `queueSize` must equal the previous run's `queueSize` + `ingested` − (`excluded` + `skipped` + `classified` + `errored` + `gone`). A run where it doesn't is a balance break. A failed thread is unresolved when no later line classifies, errors or skips it.
- **Passes when** four counts are all 0: `coverage.balanceBreaks`, `coverage.failedUnresolved`, `coverage.fallbackMissed`, and the cross-check lines that are neither found nor explained (C2's and C3's together). Threads still queued at the end are reported (`coverage.scheduled.queueLast`). They are not skipped.
- **The reducer prints** `coverage`: `scheduled` (the sums, `queueFirst`, `queueLast`), `manual` (the same sums for manual work), `balanceBreaks`, `balanceNotChecked`, `fallbackMissedEvents`, `fallbackMissed`, `historyExpired`, `excludedSearchCapped`, `ingestStopped`, `failedThreads`, `failedUnresolved`, `truncated`, `moveSkipped`, `labelsSkipped`. And `crosscheck`: `listed`, `found`, `missingLines`.
- **Also reported:** the sums; `balanceNotChecked` with the reason (the balance is not checked for a run with manual work, or one that follows a run with no `run.end`); `historyExpired`; `excludedSearchCapped`; `truncated`; and from `jev` the sums `retryable`, `transport`, `invalid`, `exceptional`, `outage` and `outageEvents`, which epic #16 decision 16 watches.

### 6.5 Cost

- **Target** (Vision): "Under $5 per month at personal volume".
- **Data.** `jev.batch`'s `inputTokens`, summed (story #156, S9). It covers scheduled and manual work and every billed request.
- **Formula.** `cost.usdPer30Days` = `cost.inputTokens` ÷ `window.days` × 30 ÷ 1,000,000 × the price. The price is $0.042 per million input tokens (README "Limits and Cost", retrieved 2026-10-01). Re-read the price at C3.
- **Passes when** `cost.usdPer30Days` is under 5. At that price it is about 55.5 million tokens in 14 days.
- **The check against TypeSafe.** At C3 the maintainer reads TypeSafe's own usage figure for the window, if its account page shows one, and posts the number. A difference of more than 10% from `cost.inputTokens` is reported and explained. Other use of the same key (the probe, a spike) is one explanation.
- **The reducer prints** `cost`: `inputTokens`, `classifiedTokens` (`scheduled`, `manual`), `tokensPer30Days`, `usdPer30Days`.
- **Also reported:** `tokensPer30Days`, the split in `classifiedTokens`, and the count of `budget.reached` in `events`.

### 6.6 Quota safety

- **Target** (Vision): "Zero executions fail from Apps Script quota or timeout errors".
- **Data.** From the export: `run.unfinished` (the next run's record of a run that Apps Script killed, or that was stopped by hand); `run.failed` (`error`, `reason`, `phase`, `step`) and platform errors whose text is quota-like; and gaps between `run.start` lines. Plus one look by the maintainer at the Executions page, filtered to "Failed" and "Timed out", at C3 (S15).
- **Number.** The executions that failed from an Apps Script quota or the time limit.
- **Passes when** it is 0, which means all of:
  - `quota.runUnfinished` is 0, unless the maintainer stopped a run by hand, which is noted;
  - no entry of `quota.runFailed` has `quotaLike` above 0, and `quota.platformErrors.quotaLike` is 0;
  - no start gap (`latency.startGapsOverTwoIntervals`) was caused by Apps Script stopping the trigger;
  - nothing on the Executions page at C3 is "Timed out" or failed for a quota.
- **Not a failure:** `quota.rateLimitedStops`. A run that ends with `stopped: "rate_limited"` or `"ingest_rate_limited"` handled Gmail's rate limit and stopped cleanly. The count is reported.
- **The reducer prints** `quota`: `runUnfinished`, `runFailed` (a list of `entry`, `error`, `reason`, `phase`, `step`, `count`, `quotaLike`), `platformErrors` (`count`, `quotaLike`), `rateLimitedStops`. And in `runs.onTrigger`: `durationMs` (`p50`, `p95`, `max`), `maxDurationPerUtcDayMs`, `maxGmailCallsToday`.
- **Also reported:** `runs.onTrigger.durationMs.max` against the 6-minute limit (360,000 ms); `maxDurationPerUtcDayMs` against 90 minutes (5,400,000 ms); `maxGmailCallsToday` against 20,000; and every `run.failed` group. The per-day sum is by UTC day, and Google says quotas "reset 24 hours after the first request" ([quotas](https://developers.google.com/apps-script/guides/services/quotas), checked 2026-10-01), so it is a guide, not Google's own count.
- **A gap or an error the agent can't explain** is looked at in the raw lines first. The agent asks the maintainer to look at the Executions page at another time only if that doesn't settle it.

### 6.7 Effort

- **Target** (Vision): "Near-zero maintenance after setup".
- **Data.** The maintainer's list of every action taken after T0, posted on #158 at C3. As evidence: `alerts.sent` (the count per condition), `alerts.failed`, and the runs per entry point (`runs.<entry>.started`).
- **Number** (S10). The required interventions: actions without which the classifier would not have kept working. Examples: running `install` again because the trigger had stopped, replacing a rejected key, granting a permission again, fixing a config that made runs fail.
- **Passes when** it is 0. With 1 or more, the maintainer judges each one and the report records the judgment.
- **Listed, not counted:** the spot-check and the cross-check, the other steps of this plan, and optional tuning.
- **Also reported:** for a real alert, its condition, the count and the date; for a real `Jev/Error` email, whether its links opened the right thread and the label.

## 7. Checkpoints

Three checkpoints (S11). At each one the agent posts the reducer's printed output on #158, as it is.

| Checkpoint | The agent | The maintainer |
|------------|-----------|----------------|
| **C1**, T0 + 1 day | Exports, copies the config, runs the reducer, posts its output, and checks that every measure can be read (below). | Nothing. |
| **C2**, T0 + 7 days | Exports, copies the config, runs the reducer over the window so far, and writes the worksheet for the first 7 days. Posts the output and the two file names, and adds the label. After the maintainer's part: runs the reducer with `--checked` and `--crosscheck` and posts the output. | Fills in the worksheet's `correct` column. Writes the cross-check file. Removes the label. |
| **C3**, T0 + 14 days | The same over the whole window, with the worksheet for days 8 to 14 and both worksheets in `--checked`. | The same, plus: one look at the Executions page ("Failed" and "Timed out"), TypeSafe's usage figure, and the list of actions taken after T0. |

**"Can every measure be read?" at C1:**

- `window.unparsed` is small against `window.entries`, and `events.other` is 0.
- `window.firstTs` and `window.lastTs` are within one interval of the window's ends.
- `runs.onTrigger.started` is close to the expected number (144 a day at 10 minutes), and `latency.cleanRuns` is above 0.
- `coverage.balanceNotChecked` is small against `runs.onTrigger.ended`.
- `rules.rules` lists every rule of the config, and `cost.inputTokens` is above 0 when `coverage.scheduled.classified` is.
- `rules.appliedLabels` + `rules.appliedMoves` after one day shows whether 60 checked actions can be reached in 14 days. If not, the agent says so on #158 at once.

A measure that can't be read is fixed then (a bug for `scripts/` under #156), not at the end.

**At every checkpoint** the agent also compares the new copy of the config with the previous one (`cmp -s`, which prints nothing). If they differ and no push is noted on #158, it asks the maintainer.

**Two dates to keep.** Cloud Logging keeps the `_Default` bucket 30 days ([quotas and limits](https://cloud.google.com/logging/quotas), checked 2026-10-01), so the last export must be made before T0 + 30 days. And the folder `~/.local/share/jev-pilot/` is deleted when #158's report is merged.

## 8. The spot-check and the cross-check

### The worksheet (agent)

At C2 and at C3 the agent runs the reducer over the days since the last checkpoint (`--from` is T0 at C2 and C2's time at C3; `--to` is the checkpoint's time), with one more flag:

```sh
--worksheet ~/.local/share/jev-pilot/worksheet-<window>-<checkpoint>.csv
```

- The worksheet lists every applied move and a random sample of applied labels: 40, with at least 5 per rule or all the rule has (the reducer's `--sample` and `--min-per-rule` defaults). The sample is the same each time for the same `--from` and input.
- Its columns are `id`, `ts`, `threadId`, `ruleId`, `kind`, `action`, `subject`, `from`, `correct`. It holds mail content, so the reducer refuses to write it inside a git work tree.
- The agent posts only the file's name and the row counts (`worksheet.rows`, `worksheet.moves`, `worksheet.labels`).

### The maintainer's part

Do it within 2 days of the checkpoint: Gmail deletes mail in Spam and Trash after 30 days, and memory fades.

1. Open the worksheet in a spreadsheet or an editor. Keep it in `~/.local/share/jev-pilot/`, as CSV, with the same columns.
2. For each row, open the thread in Gmail. Search for its subject and sender. The address `https://mail.google.com/mail/#all/<threadId>` should also open it (the same form as the alert email's link, which SD §14 lists as not yet verified live).
3. Answer one question: reading this thread as it is now, is the answer to the rule's question yes? Write `y` or `n` in the `correct` column. Unsure is `n`.
4. A thread that no longer exists can't be judged: leave its cell empty and tell the agent how many there were (a count only). An unchecked move means "every applied move checked" is not met, so the maintainer judges it on #158.
5. **The cross-check file.** In the same sitting, pick 10 threads that arrived since the last checkpoint and are older than 20 minutes. Pick them by eye from the mailbox, not from the log (a sample from the log would check nothing), spread over the days. Write each one's subject, or a distinctive part of it, on its own line in `~/.local/share/jev-pilot/crosscheck-<window>-<checkpoint>.txt`.
6. Remove the `needs: maintainer` label.

There is no second opinion: it is the maintainer's mail, and the rules ask what the maintainer means by them (S5).

### The agent's part

1. Run the reducer over the window so far with `--checked` for every worksheet of the window and `--crosscheck` for the new file. Post what it prints.
2. A cross-check line is found when a `thread.classified` line's subject contains it, ignoring case. For each number in `crosscheck.missingLines`, ask the maintainer on #158, by line number only, whether the thread is explained: it matches `excludeQuery`; it is a draft or in Spam or Trash; it arrived before T0; or it carries `Jev/Error`, which is the Vision's "explicitly marked as errored".
3. A line that is neither found nor explained is a coverage miss.

No subject, sender or thread ID is ever written on an issue: line numbers, counts and rule IDs only.

### After a config change

Precision for a changed rule counts only the actions after the change (section 5). The reducer must then count that rule's applied actions and its checked rows from the time of the push only. **This is open on #315:** the reducer has no flag for it yet. Nothing is lost meanwhile: the push is noted on #158 with its time and rule IDs (section 5), each worksheet row has its own `ts`, and the config copies keep the rules as they were. The counting waits for the flag. This paragraph is replaced by the exact command before the start.

## 9. When a measure is missed

- **A code cause** is a bug (epic #16 decision 9): filed under #156, fixed by its own PR. Deploying the fix restarts the clock.
- **A config cause** is tuned under section 5. Precision for the changed rule counts from the change.
- **Any other cause** (a Jev outage, a Google incident) is recorded in the report and judged by the maintainer on #158. It never passes silently.
- **A measure that can't be read is not a pass.** Fix the tooling: the log is kept 30 days, so the export can be made again.

## 10. Not confirmed

Google's pages don't settle these. Each says how the pilot settles it or works around it.

| Not confirmed | How the pilot deals with it |
|---------------|-----------------------------|
| How long the Executions page keeps an execution and its log. Google's [logging guide](https://developers.google.com/apps-script/guides/logging) only says the execution log "persists only for a short time". | The measures are read from Cloud Logging, not from that page. The maintainer's one look at C3 notes how far back the page goes. |
| Whether the 7-day expiry of a "Testing" project stops an Apps Script trigger. | Avoided: the consent screen is "In production" before the start (section 3.2). |
| Whether the four scopes must also be listed under **Data Access** in the Cloud project. | Skip it. If the consent screen in step 6 of section 3.2 fails, add the four scopes of README "Permissions" there and note it on #157. |
| The shape of an exported entry. The line is reported to be in `jsonPayload.message`, with `resource.type` `app_script_function`. Google's [`console` reference](https://developers.google.com/apps-script/reference/base/console) says only that the methods log at `INFO`, `WARNING` and `ERROR` and serialize objects to strings. | The reducer reads `jsonPayload.message`, else `textPayload`. The trial export settles it, and the two lines below record what was seen. |
| The exact text of Apps Script's time-limit and quota errors, and whether a timed-out execution writes an entry of its own to Cloud Logging. | `run.unfinished` is the evidence the classifier itself gives. The reducer also matches known quota phrases in `ERROR` entries, and the maintainer looks at the Executions page at C3. A first real text is recorded by #158 in SD §14. |
| Whether Cloud Logging charges anything for this volume (a few megabytes), and whether the Cloud project needs a billing account. | The maintainer checks Google's pricing page when creating the project. A charge is reported in the report's cost section, apart from the Jev cost. |
| Whether TypeSafe's account page shows token usage for a date range. | If it doesn't, the report says the cost was read from the log alone. |
| When Apps Script's daily quotas start and end for this account. | `maxDurationPerUtcDayMs` and `maxGmailCallsToday` are supporting figures only. The pass rule doesn't use them. |
| The console labels in section 3.2. They come from Google's pages, not from a walk-through. | The maintainer notes a wrong label on #157 and the plan is corrected. |

**What the trial export showed** (filled in by agent step 4; the names only):

- The payload field that held the line:
- `resource.type`:
