# ADR-0012: Toolchain: Node 24, npm, TypeScript, esbuild, Vitest, ESLint + Prettier, Zod, clasp 3

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** Kelly Stuard, Solution Architect
- **Related:** [Engineering Standards §2](../engineering-standards.md#2-toolchain), [Solution Design §11](../solution-design.md#11-build-and-deployment)

## Context

- **Node.** On 2026-09-25, Node 24 is Active LTS; it moves to Maintenance on 2026-10-20. Node 26 becomes LTS on 2026-10-28.
- **clasp 3** no longer transpiles TypeScript.
- **Apps Script V8 limits:** no ES modules, `#private`, static class fields, or timers. Triggers only see top-level `function` declarations.

## Decision

- **Node 24** (`.nvmrc`, `engines`). CI also tests on Node 26, and the default switches after 2026-10-28.
- **npm**, with the lockfile committed.
- **TypeScript, strict** (see the Standards).
- **esbuild**, producing an IIFE bundle with a V8-safe target and a generated footer of global `function` declarations.
- **Vitest** for tests.
- **ESLint** (typescript-eslint) and **Prettier**.
- **Zod** for config (build and runtime), which also emits a JSON Schema.
- **`@google/clasp` 3.x** to push `dist/`.

## Consequences

- Fast builds and tests.
- One schema serves the build, the runtime, and editor validation.
- The Node version matters only for tooling, because the output runs in Apps Script's V8.

## Alternatives Considered

- **Rollup (Google's ASIDE template):** slower, and more configuration.
- **Jest:** slower TypeScript setup.
- **Biome:** fewer rules for type-aware linting and layer boundaries.
- **Ajv plus a hand-written JSON Schema:** two sources of truth.
- **pnpm:** an extra install step for contributors.
