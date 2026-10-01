# Smoke test: results

This file records each run of the release checklist, [`docs/smoke-test.md`](smoke-test.md). The checklist is run before each release and after any change to an adapter ([Engineering Standards §8](../output/engineering-standards.md#8-testing)). Each run adds a dated section at the top of this file, with one row per check ID.

- **Result** is `pass`, `fail (#<bug>)`, or `not run (<reason>)`.
- A run **passes** when every **required** check is `pass` in its latest row. A check that failed is run again after its bug is fixed, in a new dated section that holds only the rows that were run again, with the bug's number.
- The account is written `<test-account>`. The results hold event names, field names, counts, and what synthetic mail showed. They never hold an address, a subject or sender of real mail, the API key, or an `Authorization` header.

## 2026-10-01

- **Commit tested:** `ee3da4a` (`main`), both builds made from it: the product from the checklist's smoke config, and the adapter bundle.
- **Version:** 0.9.0.
- **Account:** consumer, `<test-account>`.
- **Run by:** an agent, through the spike runner (`node spikes/run.mjs`), in the shared spike project, with the helper `spikes/155-smoke.js` ([#155](https://github.com/kellystuard/jev-gmail-classifier/issues/155), Option A). The checks marked `person` are the maintainer's.
- **Checklist:** `docs/smoke-test.md` at `ee3da4a`, with the corrections made in the same pull request as this file.
- **How a result was read:** a return value or a throw through `s155_call` or `s155_check`; log lines captured by `s155_call`, which redefines `console.info`, `console.warn` and `console.error` for the length of one call; Script Properties and triggers through `s155_props` and `s155_triggers`; the mailbox through the Gmail API. The log of a run that the trigger started itself can't be read this way: those checks read `state.runs` and the mailbox.

**Summary:** 166 checks, 150 required. Of the required checks: 0 pass, 0 fail, 150 not run. Of the other 16: 16 not run.

**This run is in progress.** A row that says `not run (not yet run)` has not been reached.

| ID | Marking | Result | Run by | Note |
|----|---------|--------|--------|------|
| G1 | required | not run (not yet run) |  |  |
| G2 | required | not run (not yet run) |  |  |
| G3 | required | not run (not yet run) |  |  |
| G4 | required | not run (not yet run) |  |  |
| G5 | required | not run (not yet run) |  |  |
| G6 | required | not run (not yet run) |  |  |
| G7 | required | not run (not yet run) |  |  |
| G8 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| T1 | required | not run (not yet run) |  |  |
| T2 | required | not run (not yet run) |  |  |
| T3 | required | not run (not yet run) |  |  |
| T4 | required | not run (not yet run) |  |  |
| T5 | required | not run (not yet run) |  |  |
| T6 | required | not run (not yet run) |  |  |
| T7 | required | not run (not yet run) |  |  |
| T8 | required | not run (not yet run) |  |  |
| T9 | required | not run (not yet run) |  |  |
| T10 | required | not run (not yet run) |  |  |
| T11 | required | not run (not yet run) |  |  |
| T12 | required, person | not run (not yet run) |  |  |
| T13 | required | not run (not yet run) |  |  |
| T14 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| T15 | required | not run (not yet run) |  |  |
| L1 | required | not run (not yet run) |  |  |
| L2 | required | not run (not yet run) |  |  |
| L3 | required | not run (not yet run) |  |  |
| L4 | required | not run (not yet run) |  |  |
| L5 | required | not run (not yet run) |  |  |
| L6 | required | not run (not yet run) |  |  |
| L7 | required | not run (not yet run) |  |  |
| L8 | required | not run (not yet run) |  |  |
| L9 | required | not run (not yet run) |  |  |
| L10 | required | not run (not yet run) |  |  |
| L11 | required | not run (not yet run) |  |  |
| L12 | required | not run (not yet run) |  |  |
| L13 | required | not run (not yet run) |  |  |
| L14 | required | not run (not yet run) |  |  |
| L15 | required, person | not run (not yet run) |  |  |
| L16 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| U1 | required | not run (not yet run) |  |  |
| U2 | required | not run (not yet run) |  |  |
| U3 | required | not run (not yet run) |  |  |
| U4 | required | not run (not yet run) |  |  |
| U5 | required | not run (not yet run) |  |  |
| U6 | required | not run (not yet run) |  |  |
| H1 | required | not run (not yet run) |  |  |
| H2 | required | not run (not yet run) |  |  |
| H3 | required | not run (not yet run) |  |  |
| H4 | required | not run (not yet run) |  |  |
| H5 | required | not run (not yet run) |  |  |
| H6 | required | not run (not yet run) |  |  |
| H7 | required | not run (not yet run) |  |  |
| H8 | required | not run (not yet run) |  |  |
| H9 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| K1 | required | not run (not yet run) |  |  |
| K2 | required | not run (not yet run) |  |  |
| K3 | required | not run (not yet run) |  |  |
| K4 | required | not run (not yet run) |  |  |
| K5 | required | not run (not yet run) |  |  |
| K6 | required | not run (not yet run) |  |  |
| K7 | required | not run (not yet run) |  |  |
| K8 | required | not run (not yet run) |  |  |
| K9 | required | not run (not yet run) |  |  |
| A1 | required | not run (not yet run) |  |  |
| A2 | required | not run (not yet run) |  |  |
| A3 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| A4 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| A5 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| M1 | required | not run (not yet run) |  |  |
| M2 | required | not run (not yet run) |  |  |
| M3 | required | not run (not yet run) |  |  |
| M4 | required | not run (not yet run) |  |  |
| M5 | required | not run (not yet run) |  |  |
| M6 | required | not run (not yet run) |  |  |
| M7 | required | not run (not yet run) |  |  |
| M8 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| M9 | not observed | not run (accepted v1 risk, SD §14) |  |  |
| S1 | required, person | not run (not yet run) |  |  |
| S2 | required, person | not run (not yet run) |  |  |
| S3 | required | not run (not yet run) |  |  |
| S4 | required | not run (not yet run) |  |  |
| S5 | required | not run (not yet run) |  |  |
| S6 | required | not run (not yet run) |  |  |
| S7 | required | not run (not yet run) |  |  |
| S8 | required | not run (not yet run) |  |  |
| S9 | required | not run (not yet run) |  |  |
| R1 | required | not run (not yet run) |  |  |
| R2 | required | not run (not yet run) |  |  |
| R3 | required | not run (not yet run) |  |  |
| R4 | required | not run (not yet run) |  |  |
| R5 | required | not run (not yet run) |  |  |
| R6 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| E1 | required | not run (not yet run) |  |  |
| E2 | required | not run (not yet run) |  |  |
| E3 | required | not run (not yet run) |  |  |
| E4 | required | not run (not yet run) |  |  |
| E5 | required | not run (not yet run) |  |  |
| E6 | required | not run (not yet run) |  |  |
| E7 | required | not run (not yet run) |  |  |
| E8 | required | not run (not yet run) |  |  |
| C1 | required | not run (not yet run) |  |  |
| C2 | required | not run (not yet run) |  |  |
| C3 | required | not run (not yet run) |  |  |
| C4 | required | not run (not yet run) |  |  |
| C5 | required | not run (not yet run) |  |  |
| C6 | required | not run (not yet run) |  |  |
| C7 | required | not run (not yet run) |  |  |
| C8 | required | not run (not yet run) |  |  |
| C9 | required | not run (not yet run) |  |  |
| C10 | required | not run (not yet run) |  |  |
| C11 | required | not run (not yet run) |  |  |
| C12 | when it happens | not run (did not happen) |  |  |
| P1 | required | not run (not yet run) |  |  |
| P2 | required | not run (not yet run) |  |  |
| P3 | required | not run (not yet run) |  |  |
| P4 | required | not run (not yet run) |  |  |
| P5 | required | not run (not yet run) |  |  |
| J1 | required | not run (not yet run) |  |  |
| J2 | required | not run (not yet run) |  |  |
| J3 | required | not run (not yet run) |  |  |
| J4 | required | not run (not yet run) |  |  |
| J5 | required | not run (not yet run) |  |  |
| J6 | required | not run (not yet run) |  |  |
| J7 | required | not run (not yet run) |  |  |
| J8 | required | not run (not yet run) |  |  |
| J9 | required | not run (not yet run) |  |  |
| J10 | required | not run (not yet run) |  |  |
| J11 | required | not run (not yet run) |  |  |
| J12 | required | not run (not yet run) |  |  |
| J13 | required | not run (not yet run) |  |  |
| J14 | required | not run (not yet run) |  |  |
| J15 | required | not run (not yet run) |  |  |
| J16 | required | not run (not yet run) |  |  |
| J17 | required | not run (not yet run) |  |  |
| N1 | required | not run (not yet run) |  |  |
| N2 | required | not run (not yet run) |  |  |
| N3 | required | not run (not yet run) |  |  |
| N4 | required | not run (not yet run) |  |  |
| N5 | required | not run (not yet run) |  |  |
| N6 | required | not run (not yet run) |  |  |
| N7 | required | not run (not yet run) |  |  |
| N8 | required | not run (not yet run) |  |  |
| N9 | required | not run (not yet run) |  |  |
| N10 | required | not run (not yet run) |  |  |
| N11 | required | not run (not yet run) |  |  |
| N12 | required | not run (not yet run) |  |  |
| N13 | required, person | not run (not yet run) |  |  |
| N14 | required, person | not run (not yet run) |  |  |
| N15 | required | not run (not yet run) |  |  |
| N16 | required | not run (not yet run) |  |  |
| N17 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| N18 | not observed, person | not run (accepted v1 risk, SD §14) |  |  |
| N19 | not observed | not run (accepted v1 risk, SD §14) |  |  |
| N20 | when it happens | not run (did not happen) |  |  |
| N21 | when it happens | not run (did not happen) |  |  |
| Z1 | required | not run (not yet run) |  |  |
| Z2 | required | not run (not yet run) |  |  |
| Z3 | required | not run (not yet run) |  |  |
| V1 | required | not run (not yet run) |  |  |
| V2 | required | not run (not yet run) |  |  |
| V3 | required | not run (not yet run) |  |  |
| V4 | required | not run (not yet run) |  |  |
| V5 | required | not run (not yet run) |  |  |
| X1 | required | not run (not yet run) |  |  |
| X2 | required | not run (not yet run) |  |  |
| X3 | required | not run (not yet run) |  |  |

### First observations

What this run saw live for the first time, and where else it is recorded.

- **`console` can be intercepted on Apps Script, but not by assignment** (2026-10-01). `console.info`, `console.warn` and `console.error` are own properties of `console` that are not writable but are configurable. `console.info = fn` does nothing and throws nothing. `Object.defineProperty(console, 'info', { value: fn, … })` works, and the original descriptor can be put back. Also recorded in `spikes/155-smoke.js` (`s155_call`, `s155_consoleProbe`).
