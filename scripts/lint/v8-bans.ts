/**
 * Apps Script V8 runtime bans (Engineering Standards §4, Solution Design §3).
 *
 * `SRC_RUNTIME_BANS` applies to every file in `src/`, `src/adapters/gas/`
 * included: features the Apps Script runtime lacks, and the synchronous-only
 * rule. `tsconfig.json` has `types: ["node"]` for every file, so `tsc` accepts
 * Node globals in `src/`; these bans are the only guard. `scripts/` and
 * `test/` run in Node and aren't affected.
 *
 * Not here: ES module syntax in the output (the bundle test in
 * `test/build/bundle.test.ts` checks it), imports of Node built-ins (the
 * `src/` package allowlist in `layers.ts`), and `enum`, `namespace` and
 * parameter properties (`tsc`, through `erasableSyntaxOnly`).
 */
import type { GlobalRestriction, Restrictions, SyntaxRestriction } from './restrictions.ts';

const ES = 'ES §4';

function globals(names: readonly string[], message: string): GlobalRestriction[] {
  return names.map((name) => ({ name, message: `${name}: ${message}` }));
}

const SYNTAX: readonly SyntaxRestriction[] = [
  {
    selector: 'PrivateIdentifier',
    message: `#private members aren't supported by Apps Script's V8: use the private modifier (${ES})`,
  },
  {
    selector: 'PropertyDefinition[static=true]',
    message: `static class fields aren't supported by Apps Script's V8: use a module constant (${ES})`,
  },
  {
    selector: 'StaticBlock',
    message: `static blocks aren't supported by Apps Script's V8: use module-level code (${ES})`,
  },
  {
    selector: ':function[async=true]',
    message: `src/ is synchronous: Apps Script services are, so no async functions (${ES}, SD §4.1)`,
  },
  {
    selector: 'AwaitExpression',
    message: `src/ is synchronous: Apps Script services are, so no await (${ES}, SD §4.1)`,
  },
  {
    selector: 'ForOfStatement[await=true]',
    message: `src/ is synchronous: Apps Script services are, so no for await (${ES}, SD §4.1)`,
  },
  {
    selector: 'ImportExpression',
    message: `the bundle is one IIFE with no module system: use a static import (${ES})`,
  },
  {
    selector: "MetaProperty[meta.name='import']",
    message: `the bundle is one IIFE with no module system, so import.meta means nothing (${ES})`,
  },
];

const GLOBALS: readonly GlobalRestriction[] = [
  ...globals(
    [
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
    ],
    `Apps Script has no timers: use ClockPort.sleep (${ES})`,
  ),
  ...globals(['fetch'], `Apps Script has no fetch: use HttpPort (${ES})`),
  ...globals(
    ['atob', 'btoa'],
    `Apps Script lacks it: decode and encode with Utilities, through an adapter (${ES})`,
  ),
  ...globals(
    ['TextDecoder', 'TextEncoder', 'crypto'],
    `Apps Script lacks it: use Utilities, through an adapter (${ES})`,
  ),
  ...globals(['Promise'], `src/ is synchronous: no Promises (${ES}, SD §4.1)`),
  ...globals(
    ['process', 'Buffer', 'global', 'require', 'module', '__dirname', '__filename'],
    `a Node global, which Apps Script doesn't have: take the value through a port (${ES})`,
  ),
  ...globals(
    ['window', 'self', 'document', 'navigator'],
    `a browser global, which Apps Script doesn't have (${ES})`,
  ),
  ...globals(
    ['globalThis'],
    `it would bypass every global ban; the bundle footer reaches the code through its global name, so src/ never needs it (${ES})`,
  ),
  ...globals(
    ['URL', 'URLSearchParams'],
    `reported missing in Apps Script, so banned as a precaution until a spike shows it works; build query strings by hand (${ES})`,
  ),
];

export const SRC_RUNTIME_BANS: Restrictions = {
  globals: GLOBALS,
  properties: [],
  syntax: SYNTAX,
  imports: [],
};
