# Jev Gmail Classifier: Product Vision

> This is the top-level statement of what the product is for. The [Product Design Document](product-design-document.md) turns it into scope, design, and epics, and the [README](../README.md) holds the detailed mechanics. Decided on 2026-09-24.

## Vision Statement

> **Your Gmail sorts itself by what each conversation is actually about: labeled and routed reliably enough that you can automate on top of it, at a cost you never have to think about.**

## Elevator Pitch

**For** technical Gmail users
**who** want their mail organized by content, not by sender and subject filters they maintain by hand,
**Jev Gmail Classifier** is a background Google Apps Script
**that** asks plain-English yes/no questions about every conversation and labels or routes it based on the answers.
**Unlike** hand-written Gmail filters, which match only on words and addresses, it understands what a conversation is about. **Unlike** hosted email assistants, it runs entirely in the user's own Google account, with no server and no subscription beyond pennies of classification cost.

The product is independent. It is built on [Jev](https://docs.typesafe.ai/models) from [TypeSafe AI](https://typesafe.ai/) and on [Google Apps Script](https://developers.google.com/apps-script), and is not affiliated with TypeSafe AI or Google.

## Target Users

- **Primary:** technical Gmail users who are comfortable cloning a repository, editing a YAML file, running `clasp`, and holding their own Jev API key. Both consumer Gmail and Google Workspace accounts are supported.
- **First user:** the project author, whose own inbox is the v1 pilot.
- **Not yet:** non-technical users. Serving them would take a settings UI and a Marketplace listing, which is a possible future direction, not a current goal.

## Problem

Email arrives unlabeled. Gmail's built-in filters can only match addresses and keywords, so they miss anything that depends on meaning: "this needs my approval," "this is a bill," "this is marketing I never asked for." Without labels you can trust, Gmail searches, saved views, and any downstream automation have nothing reliable to build on.

## Core Value

**Labels you can build on.** The product's main job is to be a dependable building block: other Gmail filters, scripts, and workflows should be able to act on its labels without a human double-checking them. Faster human triage is a welcome side effect.

To serve that job, the product both **labels** conversations and **routes** them (archives, moves to Spam or Trash, or files them under a label), because sometimes the right response to "this is spam" is to move it, not tag it.

## Product Principles

1. **Precision over recall.** A wrong label or a wrong move is worse than a missed one. Defaults and design choices lean toward being sure.
2. **Invisible when working, loud when broken.** It runs in the background with no attention needed, and tells the user promptly when something needs fixing.
3. **Cost you never think about.** Every design choice minimizes what is sent for classification, and a hard daily cap makes runaway spend impossible.
4. **Your account, your data.** Everything runs inside the user's Google account. Only the minimum needed to classify leaves it, and the user decides which mail never leaves at all.
5. **Configuration over code.** Users change behavior by editing questions, labels, and thresholds, not by writing code.
6. **Stay inside the platform's limits.** Every run fits Google Apps Script quotas by design, not by luck.

## Success Measures (v1)

| Measure            | Target                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| Precision          | At least 95% of applied labels and moves are correct, by manual spot-check |
| Latency            | A conversation is handled within 2 trigger intervals of arrival (about 20 minutes by default) |
| Coverage           | 100% of eligible conversations end up processed or explicitly marked as errored; none are silently skipped |
| Cost               | Under $5 per month at personal volume                                     |
| Quota safety       | Zero executions fail from Apps Script quota or timeout errors             |
| Effort             | Near-zero maintenance after setup                                         |

## What It Will Never Become

- Something that **permanently deletes**, **replies to**, **forwards**, or **sends** mail. (Moving to Trash is allowed; Gmail keeps trashed mail for 30 days.)
- A multi-provider classifier. It is built on Jev, with no pluggable model backends.
- A multi-account or team deployment tool. One installation serves one Google account.
- An attachment analyzer. Attachments are never read or sent.

## Possible Future Directions

These are not commitments. They are directions the product may grow in, and v1 decisions should not rule them out.

- **Removing labels** when a newer classification no longer matches, so labels track the conversation as it evolves.
- **Real-time processing** through Gmail push notifications instead of polling. This may need hosted infrastructure, so "no hosted server" is a v1 constraint rather than a permanent rule.
- **A Workspace Add-on or Marketplace listing with a settings UI**, opening the product to non-technical users.
- **A question-tuning aid**: a dry run or evaluation harness that shows score distributions before rules go live.
- **A periodic digest** of threads processed, actions taken, and spend.
- **Automated deployment** from the main branch through a GitHub Action.
