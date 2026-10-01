/**
 * Layer boundaries and module rules (Engineering Standards §3, Solution
 * Design §4.1, "Lint rules").
 *
 * `LAYERS` holds one target per layer folder in `src/`, plus `scripts/` and
 * `test/`. Every linted file in those folders matches exactly one target
 * (carve-outs use `ignores`). `EVERYWHERE` holds what no file in `src/`,
 * `scripts/` or `test/` may do. `buildRestrictionConfig()` in
 * `restrictions.ts` turns these lists into lint blocks, and applies the
 * strictest target (`src/core`) to `src/` files outside every layer folder.
 *
 * The import matrix in SD §4.1 is the complete rule; change it there and here
 * in the same PR.
 */
import type {
  GlobalRestriction,
  ImportRestriction,
  LintTarget,
  PathImportRestriction,
  PropertyRestriction,
  RegexImportRestriction,
  Restrictions,
  SyntaxRestriction,
} from './restrictions.ts';

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** The folder names of the layers, as they appear in a relative specifier. */
type Layer = 'core' | 'config' | 'ports' | 'app' | 'adapters' | 'entry' | 'generated';

/** Matches a specifier that goes through the folder `layer` (`./x`, `../x`, `../../x`, ...). */
function layerRegex(layer: Layer): string {
  return `(^|/)${layer}(/|$)`;
}

function layerImport(layer: Layer, message: string): RegexImportRestriction {
  return { regex: layerRegex(layer), message };
}

/** A layer this target may import only with `import type`. */
function layerTypeImport(layer: Layer, message: string): RegexImportRestriction {
  return { regex: layerRegex(layer), allowTypeImports: true, message };
}

const SD = 'SD §4.1';

const NO_PORTS = layerImport('ports', `this layer may not import ports/ (${SD})`);
const NO_APP = layerImport(
  'app',
  `only entry/ may import app/: pass what you need in as a value or a port (${SD})`,
);
const NO_ADAPTERS = layerImport(
  'adapters',
  `only entry/ may import adapters/: depend on the port interface in ports/ instead (${SD})`,
);
const NO_ENTRY = layerImport('entry', `nothing imports entry/: it is the composition root (${SD})`);
const NO_GENERATED = layerImport(
  'generated',
  `src/generated/ is a debug copy the build writes: src/entry/ reads the config from 'virtual:generated-config', and tests build a Config from fixtures (${SD}, SD §11)`,
);

/** The specifier the build serves the embedded config under (SD §11). */
const GENERATED_CONFIG_SPECIFIER = 'virtual:generated-config';

const NO_VIRTUAL_CONFIG: PathImportRestriction = {
  name: GENERATED_CONFIG_SPECIFIER,
  message: `only src/entry/ imports the embedded config: take a Config as a parameter instead (${SD}, epic #8 decision 3)`,
};

/**
 * `src/` imports only relative paths, `zod` and (in `src/entry/`)
 * `virtual:generated-config`. The virtual specifier is excluded here and
 * banned separately outside `src/entry/`, so each bad import reports once.
 * Adding a runtime dependency (ES §9) adds it here in the same PR.
 */
const SRC_PACKAGES: RegexImportRestriction = {
  regex: `^(?!\\.\\.?/|zod$|${GENERATED_CONFIG_SPECIFIER}$)`,
  message: `src/ runs in Apps Script: import only relative paths and zod, never Node built-ins or build-time packages (ES §9, ${SD})`,
};

/** What no `src/` layer except `entry/` may import. */
const SRC_NOT_ENTRY: readonly ImportRestriction[] = [
  NO_APP,
  NO_ADAPTERS,
  NO_ENTRY,
  NO_GENERATED,
  NO_VIRTUAL_CONFIG,
  SRC_PACKAGES,
];

const CORE_IMPORTS: readonly ImportRestriction[] = [
  layerImport('ports', `core/ is pure: take a value, or let app/ call the port (ADR-0002, ${SD})`),
  ...SRC_NOT_ENTRY,
];

/** `result.ts`, `errors.ts` and `log-fields.ts`, which `config/` imports. */
const CYCLE_GUARD_FILES: readonly string[] = [
  'src/core/result.ts',
  'src/core/errors.ts',
  'src/core/log-fields.ts',
];

const CYCLE_GUARD_IMPORTS: readonly ImportRestriction[] = [
  layerImport(
    'config',
    `config/ imports this module, so it may import only core/: importing config/ would form a cycle (${SD})`,
  ),
  ...CORE_IMPORTS,
];

const CONFIG_IMPORTS: readonly ImportRestriction[] = [
  {
    regex: '(^|/)core(/(?!(result|errors)\\.ts$)|$)',
    message: `config/ may import only core/result.ts and core/errors.ts, so core/ and config/ can't form a cycle (${SD})`,
  },
  NO_PORTS,
  ...SRC_NOT_ENTRY,
];

const PORTS_IMPORTS: readonly ImportRestriction[] = [
  layerTypeImport('core', `ports/ are interfaces: use import type for core/ types (${SD})`),
  layerTypeImport('config', `ports/ are interfaces: use import type for config/ types (${SD})`),
  ...SRC_NOT_ENTRY,
];

const APP_IMPORTS: readonly ImportRestriction[] = [
  NO_ADAPTERS,
  NO_ENTRY,
  NO_GENERATED,
  NO_VIRTUAL_CONFIG,
  SRC_PACKAGES,
];

const ADAPTER_IMPORTS: readonly ImportRestriction[] = [
  layerImport(
    'app',
    `adapters implement ports and don't call use cases: entry/ wires them into app/ (${SD})`,
  ),
  NO_ENTRY,
  NO_GENERATED,
  NO_VIRTUAL_CONFIG,
  SRC_PACKAGES,
];

const ENTRY_IMPORTS: readonly ImportRestriction[] = [NO_GENERATED, SRC_PACKAGES];

const TOOLING_IMPORTS: readonly ImportRestriction[] = [
  NO_GENERATED,
  {
    name: GENERATED_CONFIG_SPECIFIER,
    message: `only src/entry/ imports the embedded config: tests build a Config from fixtures, and scripts read the YAML (${SD}, epic #8 decision 3)`,
  },
];

// ---------------------------------------------------------------------------
// Globals, clock and randomness
// ---------------------------------------------------------------------------

/** List A: the Apps Script services v1 uses, allowed only in `src/adapters/gas/`. */
export const ADAPTER_ONLY_GLOBALS: readonly string[] = [
  'Gmail',
  'UrlFetchApp',
  'PropertiesService',
  'LockService',
  'MailApp',
  'ScriptApp',
  'Utilities',
  'Session',
];

/**
 * Apps Script services v1 doesn't use, banned in all of `src/`: most need a
 * scope the manifest doesn't declare. Using one updates this list and SD §4.1,
 * plus an ADR if it adds a scope (ES §11).
 */
export const UNUSED_SERVICE_GLOBALS: readonly string[] = [
  'Logger',
  'CacheService',
  'DriveApp',
  'SpreadsheetApp',
  'DocumentApp',
  'SlidesApp',
  'FormApp',
  'CalendarApp',
  'ContactsApp',
  'GroupsApp',
  'HtmlService',
  'ContentService',
  'XmlService',
  'CardService',
  'Browser',
];

/** The only file in `src/` that may use `console` (SD §4.1). */
export const LOG_ADAPTER_FILE = 'src/adapters/gas/gas-log-adapter.ts';

const ADAPTER_ONLY: readonly GlobalRestriction[] = ADAPTER_ONLY_GLOBALS.map((name) => ({
  name,
  message: `${name} is an Apps Script global: only src/adapters/gas/ may use it, behind a port (ADR-0002, ${SD})`,
}));

const UNUSED_SERVICES: readonly GlobalRestriction[] = UNUSED_SERVICE_GLOBALS.map((name) => ({
  name,
  message: `v1 uses no ${name}: adding it updates SD §4.1, and needs an ADR if it adds a scope (ES §11)`,
}));

const NO_CONSOLE: GlobalRestriction = {
  name: 'console',
  message: `log through LogPort: only ${LOG_ADAPTER_FILE} may use console (ES §6, ${SD})`,
};

const CLOCK_MESSAGE = `take the time from ClockPort (or as a value): only src/adapters/gas/ may read the clock (${SD}, epic #8 decision 5)`;
const RANDOM_MESSAGE = `take randomness from RandomPort: only src/adapters/gas/ may call Math.random (${SD}, epic #8 decision 5)`;

const CLOCK_GLOBALS: readonly GlobalRestriction[] = [
  { name: 'performance', message: CLOCK_MESSAGE },
];

const CLOCK_PROPERTIES: readonly PropertyRestriction[] = [
  { object: 'Date', property: 'now', message: CLOCK_MESSAGE },
  { object: 'Math', property: 'random', message: RANDOM_MESSAGE },
];

const CLOCK_SYNTAX: readonly SyntaxRestriction[] = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: `new Date() reads the clock: ${CLOCK_MESSAGE}`,
  },
  {
    // Date() as a function returns the current time as a string, whatever its arguments.
    selector: "CallExpression[callee.name='Date']",
    message: `Date() reads the clock: ${CLOCK_MESSAGE}`,
  },
];

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** A `src/` layer with no Apps Script globals, no console, and no clock or randomness. */
function pureLayer(
  name: string,
  files: readonly string[],
  imports: readonly ImportRestriction[],
  ignores?: readonly string[],
): LintTarget {
  return {
    name,
    files,
    ...(ignores === undefined ? {} : { ignores }),
    inSrc: true,
    restrictions: {
      globals: [...ADAPTER_ONLY, ...UNUSED_SERVICES, NO_CONSOLE, ...CLOCK_GLOBALS],
      properties: CLOCK_PROPERTIES,
      syntax: CLOCK_SYNTAX,
      imports,
    },
  };
}

export const LAYERS: readonly LintTarget[] = [
  {
    ...pureLayer('src/core', ['src/core/**/*.ts'], CORE_IMPORTS, CYCLE_GUARD_FILES),
    strictest: true,
  },
  pureLayer('src/core (cycle guard)', CYCLE_GUARD_FILES, CYCLE_GUARD_IMPORTS),
  pureLayer('src/config', ['src/config/**/*.ts'], CONFIG_IMPORTS),
  pureLayer('src/ports', ['src/ports/**/*.ts'], PORTS_IMPORTS),
  pureLayer('src/app', ['src/app/**/*.ts'], APP_IMPORTS),
  pureLayer('src/entry', ['src/entry/**/*.ts'], ENTRY_IMPORTS),
  {
    name: 'src/adapters/gas',
    files: ['src/adapters/gas/**/*.ts'],
    ignores: [LOG_ADAPTER_FILE],
    inSrc: true,
    restrictions: {
      globals: [...UNUSED_SERVICES, NO_CONSOLE],
      properties: [],
      syntax: [],
      imports: ADAPTER_IMPORTS,
    },
  },
  {
    name: 'src/adapters/gas (log adapter)',
    files: [LOG_ADAPTER_FILE],
    inSrc: true,
    restrictions: {
      globals: UNUSED_SERVICES,
      properties: [],
      syntax: [],
      imports: ADAPTER_IMPORTS,
    },
  },
  {
    name: 'scripts',
    files: ['scripts/**'],
    inSrc: false,
    restrictions: { globals: [], properties: [], syntax: [], imports: TOOLING_IMPORTS },
  },
  {
    name: 'test',
    files: ['test/**'],
    inSrc: false,
    restrictions: { globals: [], properties: [], syntax: [], imports: TOOLING_IMPORTS },
  },
];

/**
 * What no file in `src/`, `scripts/` or `test/` may do. The root config
 * files (`eslint.config.ts`, `vitest.config.ts`) are outside every target and
 * keep the default export their tools need.
 */
export const EVERYWHERE: Restrictions = {
  globals: [
    {
      name: 'GmailApp',
      message:
        'GmailApp is banned: use the Advanced Gmail Service (Gmail.Users.*) through GmailPort (ADR-0003)',
    },
  ],
  properties: [],
  syntax: [
    {
      selector: 'ExportDefaultDeclaration',
      message: 'use named exports only (ES §3)',
    },
    {
      selector: "ExportNamedDeclaration > ExportSpecifier[exported.name='default']",
      message: 'use named exports only (ES §3)',
    },
  ],
  imports: [],
};
