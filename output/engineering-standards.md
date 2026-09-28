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
| Running TypeScript scripts | Node's built-in type stripping (`node scripts/build.ts`) | No `tsx` or `ts-node`. See [§4](#4-typescript) for the rules this implies. |
| Bundler | **esbuild** | One IIFE plus a generated footer of global functions ([Solution Design §11](solution-design.md#11-build-and-deployment)). |
| Tests | **Vitest** | With the V8 coverage provider. |
| Lint / format | **ESLint** (flat config in `eslint.config.ts`: `@eslint/js` recommended + typescript-eslint `strictTypeChecked`) + **Prettier** 3 | Prettier owns formatting. ESLint owns correctness and layering, and adds no formatting rules. Prettier uses its defaults except `singleQuote` and `printWidth: 100` (`.prettierrc.json`). It checks `.ts`, `.js`/`.mjs`, `.json`, and `.yaml`/`.yml`. It never checks Markdown (`**/*.md`), so the design documents and README are never reformatted. Both tools skip `spikes/`, `test/fixtures/`, `docs/`, `dist/`, `coverage/`, `src/generated/`, and `.claude/`; Prettier also skips `output/` and `package-lock.json`. ESLint loads its `.ts` config through `jiti`, because it can't yet use Node's type stripping without an unstable flag. |
| Validation | **Zod** | The one schema is shared by the build and the runtime. Also emits `config.schema.json`. |
| YAML | `yaml` | Build time only. |
| Apps Script CLI | **`@google/clasp` 3.x** | Pushes `dist/`. Deployment is manual in v1. |

**npm scripts** (names fixed so docs and agents can rely on them):

| Script | What it does |
|--------|--------------|
| `npm run build` | Validates the config, generates code, and bundles into `dist/`. |
| `npm run lint` | ESLint and a Prettier check. |
| `npm run format` | Prettier, rewriting files in place. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, once. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run probe -- <file.eml>` | The local Jev probe. |
| `npm run push` | `build`, then `clasp push`. |

## 3. Repository Layout and Module Rules

The layout and layering are in [Solution Design §4](solution-design.md#4-architecture-overview). The rules:

- **Layer boundaries are enforced by ESLint**, with the built-in `@typescript-eslint/no-restricted-imports`, `no-restricted-globals`, `no-restricted-properties`, and `no-restricted-syntax` rules. The lists live in `scripts/lint/layers.ts`. The complete import matrix and the globals per layer are in [Solution Design §4.1, "Lint rules"](solution-design.md#lint-rules). In short:
  - `core/` may import `core/` and `config/`. The cycle-guard modules `core/result.ts`, `core/errors.ts`, and `core/log-fields.ts` may import only `core/`.
  - `config/` may import `config/`, plus `core/result.ts` and `core/errors.ts` only.
  - `ports/` may import `ports/`, plus `core/` and `config/` with `import type` only.
  - `app/` may import `core/`, `config/`, `ports/`, and `app/`.
  - `adapters/gas/` may import `core/`, `config/`, `ports/`, and `adapters/gas/`.
  - `entry/` may import anything in `src/`, and is the only layer that imports `adapters/` or `virtual:generated-config`.
  - Nothing imports `src/generated/`, and `test/` can't import `virtual:generated-config`.
  - **Packages in `src/`:** only relative paths and `zod` (plus `virtual:generated-config` in `src/entry/`). Adding a runtime dependency ([§9](#9-dependencies)) adds it to this allowlist in the same PR.
  - Only `adapters/gas/` may use the Apps Script globals, the clock (`Date.now()`, `new Date()`, `Date()`, `performance`), or `Math.random()`. Only the log adapter, `src/adapters/gas/gas-log-adapter.ts`, may use `console`. Apps Script services that v1 doesn't use (`Logger`, `DriveApp`, `CacheService`, and others) are banned in all of `src/`.
  - `GmailApp` is banned everywhere, including `scripts/` and `test/` ([ADR-0003](adr/0003-advanced-gmail-service-and-scopes.md)).
- **One concept per file.** Files and folders use `kebab-case.ts`. Tests sit in `test/`, mirroring `src/`, as `*.test.ts`.
- **Named exports only.** No default exports, no barrel files that re-export everything. Lint bans default exports in `src/`, `scripts/`, and `test/`. Only the root tool configs (`eslint.config.ts`, `vitest.config.ts`) keep the default export their tools need.
- **`src/generated/`** is written only by the build, and is git-ignored. Source code never imports it: only `src/entry/` reads the embedded config, through the `virtual:generated-config` specifier ([Solution Design §11](solution-design.md#11-build-and-deployment)).

## 4. TypeScript

- **`tsconfig` settings:**
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `noImplicitOverride: true`
  - `noFallthroughCasesInSwitch: true`
  - `useDefineForClassFields: false`
  - For Node's type stripping: `module: nodenext`, `moduleResolution: nodenext`, `allowImportingTsExtensions: true`, `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, and `noEmit: true`
  - `target: ES2020` and `lib: ["ES2020"]`, with no `DOM`. This matches the esbuild target. esbuild lowers syntax but doesn't polyfill library methods, so `lib` keeps the source off methods Apps Script's V8 may lack.
  - `types: ["node"]` and `skipLibCheck: true`. Because `types` is explicit, any other `@types/*` package must be added to it.

  One `tsconfig.json` covers `src/`, `scripts/`, and `test/`. It excludes `spikes/`.
- **Relative imports end in `.ts`** (`import { ENTRY_POINTS } from './entry-points.ts'`). Node needs the extension to run `scripts/*.ts`, and `tsc` enforces it.
- **Erasable syntax only.** No `enum`, `namespace`, or constructor parameter properties. Node can't strip them, and `tsc` rejects them. Use `as const` objects or string-literal unions instead of `enum`.
- **Banned:** `any`, `as` casts to silence errors, and non-null `!`, unless there is a one-line justification comment. Parse unknown data with Zod or a type guard instead of casting.
  - The justification is the `-- <why>` part of an `eslint-disable-next-line` comment: `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- <why>`. Lint rejects a disable comment without a justification, a blanket `eslint-disable` that names no rule, and one that suppresses nothing. `as const` is not a cast and is allowed.
- **V8 runtime limits.** Lint bans these in all of `src/`, `src/adapters/gas/` included. The list lives in `SRC_RUNTIME_BANS` in `scripts/lint/v8-bans.ts`, and `test/lint/v8-bans.test.ts` proves each ban. `tsconfig.json` has `types: ["node"]` for every file, so `tsc` accepts Node globals in `src/`, and these bans are the only guard. `scripts/` and `test/` run in Node and aren't affected. Never use:
  - **Class syntax Apps Script's V8 lacks:** `#private` fields and methods (use `private`), static class fields and `static {}` blocks (use module constants). Instance fields are fine: esbuild lowers them.
  - **Anything asynchronous:** `async` functions and arrows, `await`, `for await`, and `Promise` (see "Synchronous by design" below).
  - **Module features:** dynamic `import()` and `import.meta`. The bundle is one IIFE with no module system.
  - **Timers:** `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `queueMicrotask`. Use `ClockPort.sleep`.
  - **Missing web APIs:** `fetch` (use `HttpPort`); `atob`, `btoa`, `TextDecoder`, `TextEncoder`, and `crypto` (use `Utilities`, through an adapter).
  - **Node globals:** `process`, `Buffer`, `global`, `require`, `module`, `__dirname`, `__filename`.
  - **DOM globals:** `window`, `self`, `document`, `navigator`.
  - **`globalThis`:** it would bypass every global ban. The bundle footer reaches the code through its global name.
  - **`URL` and `URLSearchParams`:** a precaution, not a verified platform fact. They're widely reported as missing in Apps Script. A spike that shows they work can lift the ban.

  The global bans cover value references only; a type such as `Promise<T>` erases from the bundle. Elsewhere: ES module syntax in the output is checked by the bundle test (`test/build/bundle.test.ts`), imports of Node built-ins by the `src/` package allowlist ([§3](#3-repository-layout-and-module-rules)), and `enum`, `namespace`, and parameter properties by `tsc`.
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
- **CI makes no live calls**: no Gmail, no Jev, no secrets. The one exception is the spike workflow (`spikes.yml`), which is only ever dispatched by hand and runs `spikes/` functions against the throwaway test account ([ADR-0016](adr/0016-run-spikes-from-agents-and-a-manual-workflow.md), proposed). It never runs on `pull_request` or `push`, and never touches a real mailbox.
- **The local probe** is how you check question wording and body-conversion quality against Jev by hand, using your own `.env`.

## 9. Dependencies

- **Runtime dependencies** are bundled into Apps Script, so keep them few. Zod is expected to be the only one. Any new one must be pure JavaScript, work without Node or DOM globals (or with a documented shim), and have a license compatible with Apache-2.0 (MIT, BSD, ISC, and Apache-2.0 are fine).
- **Dev dependencies** are fine when they earn their place, for example a MIME parser for the probe.
- **Dependabot** runs weekly for npm and GitHub Actions, with dev dependencies grouped into one PR. CI must pass. No auto-merge.

## 10. Git, CI, and Releases

- **Trunk-based.** Short-lived branches off `main`, merged through PRs.
- **Squash merge only.** The PR title becomes the commit.
- **PR titles follow [Conventional Commits](https://www.conventionalcommits.org/):** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`, optionally with a scope (`feat(jev-client): …`), and `!` for a breaking change. Breaking changes include config changes that make an existing `config.yaml` invalid.
- **Signed commits are required.** The "Protect main" ruleset requires a PR, signed commits, the `ci` check, and squash merges. It requires no approving review ([ADR-0018](adr/0018-protect-main-with-automatic-gates-and-no-required-review.md)). The maintainer's token can bypass these rules, so nobody merges with the bypass (`gh pr merge --admin`).
- **CI** (GitHub Actions) runs `npm ci`, `lint`, `typecheck`, `test`, and `build` against `config.example.yaml`, on Node 24 and 26, in `.github/workflows/ci.yml`. Its aggregate job `ci` passes only when every Node leg passes, and it is the one required check. There is no deploy job in v1.
- **Releases.** release-please maintains `CHANGELOG.md`, the `package.json` version, and SemVer tags (`vX.Y.Z`) from the squashed commit titles. It keeps one release PR open and updates it on every push to `main`. Deployment is manual: `npm run push` from the maintainer's machine.
  - **Before 1.0**, the first release is `0.1.0`. After that, a `feat:` bumps the minor version, a `fix:` the patch version, and a breaking change (`!`) also only the minor version. `v1.0.0` is cut on purpose in E10, with a `Release-As: 1.0.0` footer in the squash commit's body.
  - **CI on a release PR.** release-please runs with the default `GITHUB_TOKEN`, so the release PR's CI run is held with status `action_required` and the PR shows no checks. Before merging a release PR, find the held run with `gh run list --workflow=ci.yml --branch release-please--branches--main--components--jev-gmail-classifier --status action_required`, approve it with `gh api -X POST repos/kellystuard/jev-gmail-classifier/actions/runs/<run-id>/approve`, wait for the `ci` check to pass, then squash-merge. (Check the branch name with `gh pr view <N> --json headRefName`.) Running CI with `gh workflow run` doesn't work: its checks land on the commit but don't count for the PR. release-please force-pushes the branch after every merge to `main`, which starts a new held run, so approve the run right before merging.

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
- **The Project** holds every issue. Its `Status` field (Todo, Ready, In progress, Done) is the one place to see what's in flight. **Ready** means the issue has been refined: it names the files to read, its checks can be verified by an agent, and it has no open questions. An issue with an open question carries the `needs: maintainer` label instead. Its `Level` field (🟣 Epic, 🔷 Story, ✅ Task) mirrors the type label so views can color, filter, and group by level; set it when adding an issue to the Project.
- **Asking the maintainer.** Add the `needs: maintainer` label to the issue or PR, with one comment that lists everything needed. When the maintainer only has to do something (a Gmail UI step, a setting, a secret), the label is the whole handshake: they remove it when finished, and don't reply "done". Treat the removal as the go-ahead and check the result yourself. Ask for a reply only when you need something back, such as an answer, notes, or a screenshot.
- **Changing the plan.** When an epic settles a detail that changes later work, update the affected stories and tasks in the same PR or right after it merges.
