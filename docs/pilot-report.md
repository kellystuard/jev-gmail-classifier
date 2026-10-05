# Pilot report

The record of the v1 pilot. Task #158, story #156, epic #16. The plan is `docs/pilot.md`. All times are in UTC. Dates are `YYYY-MM-DD`.

**Status: the pilot is running.** This file is filled in as the checkpoints pass. A section that says "not yet" has no result. Every number here comes from a comment on #158, and that comment is linked.

The pilot's log holds mail content, so this report holds only counts, event names, rule IDs, `stopped` values, error class names, `reason` codes, alert conditions, model names and dates.

## 1. Summary

Not yet: written at the end of the window that counts.

| Item | Value |
|------|-------|
| The window that counted | Not yet (window `w1` runs from 2026-10-03T22:23Z to 2026-10-17T22:23Z) |
| Version and commit | Not yet |
| Trigger interval | Not yet |
| Account kind | Not yet |

| Measure | Target | Number | Result |
|---------|--------|--------|--------|
| Precision | At least 95% of applied labels and moves are correct, by manual spot-check | Not yet | Not yet |
| Latency | A conversation is handled within 2 trigger intervals of arrival | Not yet | Not yet |
| Coverage | 100% of eligible conversations end up processed or explicitly marked as errored | Not yet | Not yet |
| Cost | Under $5 per month at personal volume | Not yet | Not yet |
| Quota safety | Zero executions fail from Apps Script quota or timeout errors | Not yet | Not yet |
| Effort | Near-zero maintenance after setup | Not yet | Not yet |

## 2. Windows

One row per start of the clock. The first row repeats the start record in `docs/pilot.md` section 4.

| Window | T0 | Commit | Version | Trigger interval | Plan used | How it ended |
|--------|----|--------|---------|------------------|-----------|--------------|
| `w1` | 2026-10-03T22:23Z | `6c7153c845be548bc2364f3fbe214dfab3ccfd26` | 0.9.1 | 10 minutes | `docs/pilot.md` at `bae307f` | Running. It ends at 2026-10-17T22:23Z. |

The rest of `w1`'s start record: the account is a consumer account; `timeZone` is `Etc/UTC`; `jevModel` is `jev-latest`; 12 label rules and 4 move rules (`archive` 1, `spam` 0, `trash` 0, `label` 3); `excludeQuery` is set.

## 3. Checkpoints

One row per checkpoint of each window.

| Window | Checkpoint | Due | Done on | What was posted | What was found |
|--------|------------|-----|---------|-----------------|----------------|
| `w1` | C1 | 2026-10-04T22:23Z | Not yet | Not yet | Not yet |
| `w1` | C2 | 2026-10-10T22:23Z | Not yet | Not yet | Not yet |
| `w1` | C3 | 2026-10-17T22:23Z | Not yet | Not yet | Not yet |

The log is kept 30 days, so the last export of `w1` must be made before 2026-11-02T22:23Z.

## 4. The measures

Not yet: the final numbers come from the C3 run. Each subsection will hold the formula from the plan, the reducer's keys and values, the supporting figures, and the result.

### 4.1 Precision

Not yet.

### 4.2 Latency

Not yet.

### 4.3 Coverage

Not yet.

### 4.4 Cost

Not yet.

### 4.5 Quota safety

Not yet.

### 4.6 Effort

Not yet.

## 5. Changes during the window

Every push to the pilot account after T0, and every change of model seen in `rules.models`.

None recorded yet.

## 6. Bugs

Each bug the pilot found: its number, one line, whether it restarted the clock, and its state.

None recorded yet.

## 7. Observed for the first time

What the smoke test left for the pilot, each with the check's ID.

Not yet.

## 8. Limits of this report

Not yet: written at the end. It will cover one mailbox, one account kind, what stayed unobserved, and how each fact that `docs/pilot.md` section 10 lists as not confirmed turned out.
