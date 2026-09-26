# Jev Gmail Classifier: Engineering Standards

> **Status:** Accepted for v1. Decided on 2026-09-25.
>
> **Where this fits:** the [Solution Design](solution-design.md) says how the system is built. This document says how we work on it: tooling, code conventions, testing, git, and the Definition of Done. It ranks alongside the Solution Design, below the [Vision](product-vision.md) and the [PDD](product-design-document.md). The reasons behind these rules are in the [ADRs](adr/README.md).

## 1. Which Documents to Load

| Task | Load |
|------|------|
| Any story or task | This document, plus the Solution Design section for the component you're touching. |
| A change to what is sent to Jev, logged, or stored | [Solution Design §8](solution-design.md#8-jev-integration), [§10.5](solution-design.md#105-logging-and-alerts), [§10.6](solution-design.md#106-security-and-privacy) |
| A user-visible behavior change | The PDD and README, too. Both must be updated in the same PR. |
| Revisiting a decision | The matching ADR. Write a new ADR that supersedes it; don't edit the old decision. |

## 2. Toolchain

| Tool | Version / choice | Notes |
|------|------------------|-------|
| Node.js | **24 LTS**, pinned in `.nvmrc` and `engines` | CI also runs Node 26. Switch the default to 26 after it becomes LTS on 2026-10-28. |
| Package manager | **npm**, with `package-lock.json` committed | Use `npm ci` in CI. |
| Language | **TypeScript**, strict | See [§4](#4-typescript). |
| Bundler | **esbuild** | One IIFE plus a generated footer of global functions ([Solution Design §11](solution-design.md#11-build-and-deployment)). |
| Tests | **Vitest** | With the V8 coverage provider. |
| Lint / format | **ESLint** (typescript-eslint, strict and type-checked) + **Prettier** | Prettier owns formatting. ESLint owns correctness and layering. |
| Validation | **Zod** | The one schema is shared by the build and the runtime. Also emits `config.schema.json`. |
| YAML | `yaml` | Build time only. |
| Apps Script CLI | **`@google/clasp` 3.x** | Pushes `dist/`. Deployment is manual in v1. |

**npm scripts** (names fixed so docs and agents can rely on them):

| Script | What it does |
|--------|--------------|
| `npm run build` | Validates the config, generates code, and bundles into `dist/`. |
| `npm run lint` | ESLint and a Prettier check. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run probe -- <file.eml>` | The local Jev probe. |
| `npm run push` | `build`, then `clasp push`. |

## 3. Repository Layout and Module Rules

The layout and layering are in [Solution Design §4](solution-design.md#4-architecture-overview). The rules:

- **Layer boundaries are enforced by ESLint** (`no-restricted-imports`, `no-restricted-globals`, or an equivalent boundary plugin):
  - `core/` may import only `core/` and `config/`. No Apps Script or DOM globals, no `Date.now()`, no `Math.random()`.
  - `app/` may import `core/`, `ports/`, and `config/`.
  - Only `adapters/gas/` may use Apps Script globals, including `console`.
  - Only `entry/` may import `adapters/`.
  - `GmailApp` is banned everywhere ([ADR-0003](adr/0003-advanced-gmail-service-and-scopes.md)).
- **One concept per file.** Files and folders use `kebab-case.ts`. Tests sit in `test/`, mirroring `src/`, as `*.test.ts`.
- **Named exports only.** No default exports, no barrel files that re-export everything.
- **`src/generated/`** is written only by the build, and is git-ignored.

## 4. TypeScript

- **`tsconfig` settings:**
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `noImplicitOverride: true`
  - `noFallthroughCasesInSwitch: true`
  - `useDefineForClassFields: false`
- **Banned:** `any`, `as` casts to silence errors, and non-null `!`, unless there is a one-line justification comment. Parse unknown data with Zod or a type guard instead of casting.
- **V8 runtime limits.** Never use:
  - `#private` fields or static class field declarations: use `private` and module constants.
  - `setTimeout`: use `ClockPort.sleep`.
  - `fetch`, `atob`, `TextDecoder`, or `crypto`.
  - ES module syntax in the output.

  The esbuild target lowers syntax, but lint also bans these so the source stays honest.
- **Synchronous by design.** All ports and the core are synchronous. No `async`/`await` or Promises in `src/`. The local probe in `scripts/` may use them.
- **Prefer data and pure functions** to classes with state. Classes are fine for adapters and port implementations.
- **Discriminated unions** for results and state variants. Use exhaustive `switch` statements with a `never` check.
- **Naming:**
  - Types and interfaces: `PascalCase`.
  - Functions and variables: `camelCase`.
  - Constants: `SCREAMING_SNAKE_CASE` only for true module-level constants.
  - Ports end in `Port`, and adapters are named for what they wrap (`GasGmailAdapter`).

## 5. Error Handling

The model is in [Solution Design §10.1](solution-design.md#101-error-model) and [ADR-0006](adr/0006-results-and-error-boundaries.md). The rules:

- **Throw only on invalid input or invalid state.** An expected failure is a result: `{ ok: false, kind, … }`. Code that receives an `ok:false` handles it as ordinary control flow.
- **Throwing to reach a shared handler is allowed** when two paths need the same handling. For example, throw a `ThreadProcessingError` carrying a failed result, so it reaches the per-thread boundary that also handles unexpected exceptions.
- **Use typed exceptions** that extend one `JevClassifierError` base. They carry structured fields for the log, not just a message.
- **Never swallow an exception.** Every `catch` either handles it completely (and logs) or rethrows. There are exactly three boundaries: per request, per thread, and per run.
- **Classify each failure explicitly.** For every external response or failure mode you handle, decide and document in code whether it is *retryable*, a *normal failure*, or *exceptional*, and test that classification. For example, 429 and 529 are retryable, 422 and 401 are normal failures, and a generic 500 is exceptional.

## 6. Logging

- Only use `LogPort`. `console.*` is banned outside the log adapter.
- One event is one JSON object:
  - `event` is a dotted lower-case name (`thread.classified`).
  - Every event carries `runId`, `entry`, and `ts`.
  - The fields are flat and machine-filterable.
- **Levels:**
  - `info`: normal events.
  - `warn`: handled failures, such as a strike, `scope_missing`, a truncation, or a skipped move.
  - `error`: failures at a boundary and aborted runs.
- **Never log** message bodies, the API key, the `Authorization` header, or any raw request `state`. Subject and sender are allowed ([PDD §4.9](product-design-document.md#49-observability)).
- **Adding a new event or field** means updating the event list in [Solution Design §10.5](solution-design.md#105-logging-and-alerts).

## 7. Configuration and State

- **A new config field** goes into the Zod schema (with a default and a validation message), `config.example.yaml`, the README configuration table, and the PDD §5 table, all in the same PR.
- **The config is validated at build time and at runtime load**, by the same schema.
- **A new Script Properties key** goes through `StatePort` under the `state.` namespace. It holds versioned JSON (`{"v": 1, …}`) with an explicit size bound, and it is added to [Solution Design §7.3](solution-design.md#73-script-properties-state).
- **Secrets** live only in Script Properties (deployed) or `.env` (local, git-ignored). Never commit a real key, `config.yaml`, or `.clasp.json`.

## 8. Testing

> **Test what is testable in the ways it can be tested. Don't test what is not testable in the ways it cannot be tested.**

- **The core is unit-tested thoroughly.** Use table-driven tests for decision logic: thresholds, the move winner, first-classification, truncation, converters, retry classification, budget rollover, queue caps, and query building.
- **The app layer is tested against in-memory fakes** of every port (`test/fakes/`), with a controllable `ClockPort` and `RandomPort`. Fakes model the behavior that matters, such as history paging, 404 expiry, `scope` failures, and `fetchAll` partial failures. They are not just stubs.
- **Jev fixtures.** Store real response shapes in `test/fixtures/jev/`: answers, `usage`, headers, and error bodies. Never store email content. Any new response shape seen in the wild gets a fixture.
- **Adapters are not unit-tested with mocked Apps Script globals.** That would test the mock, not the platform. Instead:
  - `spikes/` scripts confirm platform behavior once, and record what they find in the Solution Design or an ADR.
  - `docs/smoke-test.md` is the manual checklist, run in a real account before each release and after any adapter change.
- **Coverage** is a guide, not a gate: about **90% of lines in `src/core/`**. A lower number for code that can't be tested meaningfully is fine. Don't write tests that assert nothing just to reach the number.
- **CI makes no live calls**: no Gmail, no Jev, no secrets.
- **The local probe** is how you check question wording and body-conversion quality against Jev by hand, using your own `.env`.

## 9. Dependencies

- **Runtime dependencies** are bundled into Apps Script, so keep them few. Zod is expected to be the only one. Any new one must be pure JavaScript, work without Node or DOM globals (or with a documented shim), and have a license compatible with Apache-2.0 (MIT, BSD, ISC, and Apache-2.0 are fine).
- **Dev dependencies** are fine when they earn their place, for example a MIME parser for the probe.
- **Dependabot** runs weekly for npm and GitHub Actions, with dev dependencies grouped into one PR. CI must pass. No auto-merge.

## 10. Git, CI, and Releases

- **Trunk-based.** Short-lived branches off `main`, merged through PRs.
- **Squash merge only.** The PR title becomes the commit.
- **PR titles follow [Conventional Commits](https://www.conventionalcommits.org/):** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`, optionally with a scope (`feat(jev-client): …`), and `!` for a breaking change. Breaking changes include config changes that make an existing `config.yaml` invalid.
- **Signed commits are required.** Branch protection on `main` requires signed commits, passing CI, and a CODEOWNERS review.
- **CI** (GitHub Actions) runs `npm ci`, `lint`, `typecheck`, `test`, and `build` against `config.example.yaml`, on Node 24 and 26. There is no deploy job in v1.
- **Releases.** release-please maintains `CHANGELOG.md` and SemVer tags from the squashed commit titles. Deployment is manual: `npm run push` from the maintainer's machine.

## 11. Documentation

- **Precedence:** Vision > PDD > Solution Design, ADRs, and Engineering Standards > README. If a change contradicts a higher document, update the higher document in the same PR, or stop and ask.
- **ADRs.** Write one (`output/adr/NNNN-title.md`, from the [template](adr/template.md)) for any decision that is hard to reverse, changes a layer boundary, a port, the stored state, or the OAuth scopes, or that overrides something in these documents. Accepted ADRs are not rewritten. A new ADR supersedes the old one, and both are linked.
- **Settling a "starting value"** or a detail listed in [Solution Design §13](solution-design.md#13-epic-guidance) means updating that section in the same PR.
- **Diagrams** are Mermaid, in Markdown.
- **Writing style.** Plain language, short sentences, and dates as `YYYY-MM-DD`. Don't edit `docs/archive/`.

## 12. Definition of Done

A story is done when:

1. **Tests pass, lint is clean, and the typecheck passes** locally and in CI. Tests follow [§8](#8-testing).
2. **The documentation is updated in the same PR:** README, PDD, Solution Design, or an ADR, whichever the change affects. That includes new events, state keys, and settled starting values.
3. **New config fields** are in the Zod schema, `config.example.yaml`, the README table, and the PDD §5 table.

## 13. Work Tracking

Work is tracked in GitHub Issues on this repository, in the **Jev v1** Project, under the **v1.0** milestone.

- **Three levels**, marked by one label each and linked as **sub-issues**:

  | Level | Label | Is | Closes when |
  |-------|-------|----|-------------|
  | Epic | `type: epic` | One of E1–E10 from [PDD §14](product-design-document.md#14-epics), with the same name and dependencies. | All its stories are closed. |
  | Story | `type: story` | An outcome that can be shown or tested, with acceptance criteria traced to the design documents. The [Definition of Done](#12-definition-of-done) applies to it. | All its tasks are closed and its acceptance criteria are checked. |
  | Task | `type: task` | One PR's worth of work. | Its PR merges (`Closes #N` in the PR description). |

  Bugs use the `bug` label and may sit under a story or stand alone.
- **Every issue** is opened from its form in `.github/ISSUE_TEMPLATE/`, has exactly one type label, and (except epics and standalone bugs) has one parent.
- **Dependencies** between epics are written in the epic's "Depends on" field. A task that can't start until another closes says so in its Notes.
- **The Project** holds every issue. Its `Status` field (Todo, In progress, Done) is the one place to see what's in flight. Its `Level` field (🟣 Epic, 🔷 Story, ✅ Task) mirrors the type label so views can color, filter, and group by level; set it when adding an issue to the Project.
- **Changing the plan.** When an epic settles a detail that changes later work, update the affected stories and tasks in the same PR or right after it merges.
