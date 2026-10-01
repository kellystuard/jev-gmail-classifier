import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import {
  isLogEventName,
  LOG_EVENT_LEVELS,
  LOG_EVENTS,
  type LogEventLevel,
} from '../../src/core/log-events.ts';

/** The event-name pattern `FakeLog` enforces (`test/fakes/fake-log.ts`). */
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * A log call and its first argument. `console` is banned outside the log
 * adapter, so every `.info(`, `.warn(` and `.error(` call in `src/` is a
 * `LogPort` call, whatever the variable is called (`log`, `deps.log`,
 * `call.deps.log`). `\s*` covers a call that Prettier broke after the bracket.
 * The first branch is a single-quoted string literal; the second is anything
 * else (a variable, a template, a double-quoted string, no argument).
 *
 * It also matches a call written inside a comment. That is fine as long as the
 * comment names a real event at a level the catalog allows.
 */
const LOG_CALL = /\.(info|warn|error)\(\s*(?:'([^'\n]*)'|(\S))/g;

type Scan = {
  /** The levels each literal event name is logged at. */
  readonly levels: Map<string, Set<LogEventLevel>>;
  /** Calls whose first argument isn't a single-quoted string literal, as `file: .level(`. */
  readonly nonLiteral: string[];
  readonly calls: number;
};

function isLevel(value: string | undefined): value is LogEventLevel {
  return value === 'info' || value === 'warn' || value === 'error';
}

/** Scans source texts (`[name, text]`) for log calls. */
function scan(files: readonly (readonly [string, string])[]): Scan {
  const levels = new Map<string, Set<LogEventLevel>>();
  const nonLiteral: string[] = [];
  let calls = 0;
  for (const [file, text] of files) {
    for (const match of text.matchAll(LOG_CALL)) {
      const [, level, name] = match;
      if (!isLevel(level)) throw new Error('the regex matched an unknown level');
      calls++;
      if (name === undefined) {
        nonLiteral.push(`${file}: .${level}(`);
        continue;
      }
      const seen = levels.get(name) ?? new Set<LogEventLevel>();
      seen.add(level);
      levels.set(name, seen);
    }
  }
  return { levels, nonLiteral, calls };
}

/**
 * What a scan has that the catalog doesn't allow, one line per problem. Empty
 * when the code and the catalog agree.
 */
function problems(found: Scan): string[] {
  const out: string[] = [];
  for (const call of found.nonLiteral) {
    out.push(`${call} log a literal event name, so the catalog can check it`);
  }
  for (const name of found.levels.keys()) {
    if (!isLogEventName(name)) {
      out.push(`'${name}' is logged but is not in LOG_EVENT_LEVELS (src/core/log-events.ts)`);
    }
  }
  for (const name of LOG_EVENTS) {
    const seen = [...(found.levels.get(name) ?? [])].sort();
    const allowed = [...LOG_EVENT_LEVELS[name]].sort();
    if (seen.length === 0) {
      out.push(`'${name}' is in LOG_EVENT_LEVELS but nothing logs it`);
    } else if (seen.join() !== allowed.join()) {
      out.push(`'${name}' is logged at [${seen.join()}] but the catalog says [${allowed.join()}]`);
    }
  }
  return out;
}

/**
 * Every `.ts` file under `src/` as `[path relative to the repo, text]`, without
 * the build output in `src/generated/` and without the log adapter, whose
 * `console` calls are the one place that isn't a `LogPort` call.
 */
function sourceFiles(): [string, string][] {
  const srcDir = join(REPO_ROOT, 'src');
  const adapter = join(srcDir, 'adapters', 'gas', 'gas-log-adapter.ts');
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(join(srcDir, 'generated') + sep) && path !== adapter)
    .map((path) => [relative(REPO_ROOT, path), readFileSync(path, 'utf8')]);
}

describe('LOG_EVENTS', () => {
  it('is the keys of LOG_EVENT_LEVELS, in order, with no duplicate', () => {
    expect(LOG_EVENTS).toEqual(Object.keys(LOG_EVENT_LEVELS));
    expect(new Set(LOG_EVENTS).size).toBe(LOG_EVENTS.length);
    expect(LOG_EVENTS).toHaveLength(27);
  });

  it.each(LOG_EVENTS)('%s is a dotted lower-case name with at least one level', (name) => {
    expect(name).toMatch(EVENT_NAME);
    const levels: readonly LogEventLevel[] = LOG_EVENT_LEVELS[name];
    expect(levels.length).toBeGreaterThan(0);
    expect(new Set(levels).size).toBe(levels.length);
  });

  it('isLogEventName accepts only catalog names, and no inherited key', () => {
    expect(isLogEventName('run.end')).toBe(true);
    expect(isLogEventName('scope_missing')).toBe(true);
    expect(isLogEventName('config.invalid')).toBe(false);
    expect(isLogEventName('toString')).toBe(false);
    expect(isLogEventName('__proto__')).toBe(false);
    expect(isLogEventName('')).toBe(false);
  });
});

describe('the source scan', () => {
  const found = scan(sourceFiles());

  it('finds the log calls in src/', () => {
    // 46 at v0.8.0, plus #148's and #302's. A lower number means the regex or the walk broke.
    expect(found.calls).toBeGreaterThanOrEqual(49);
  });

  it('every log call names its event with a single-quoted string literal', () => {
    expect(found.nonLiteral).toEqual([]);
  });

  it('the names logged are exactly LOG_EVENTS', () => {
    const logged = [...found.levels.keys()];
    expect({
      onlyInCode: logged.filter((name) => !isLogEventName(name)),
      onlyInCatalog: LOG_EVENTS.filter((name) => !found.levels.has(name)),
    }).toEqual({ onlyInCode: [], onlyInCatalog: [] });
  });

  it.each(LOG_EVENTS)('%s is logged at exactly the levels the catalog allows', (name) => {
    expect([...(found.levels.get(name) ?? [])].sort()).toEqual([...LOG_EVENT_LEVELS[name]].sort());
  });

  it('agrees with the catalog as a whole', () => {
    expect(problems(found)).toEqual([]);
  });
});

/** A source text with one log call for every catalog event at every allowed level. */
function conformingSource(): string {
  return LOG_EVENTS.flatMap((name) =>
    LOG_EVENT_LEVELS[name].map((level) => `deps.log.${level}('${name}', {});`),
  ).join('\n');
}

describe('the source scan catches a drift (run on made-up sources)', () => {
  it('accepts a source that logs every event at every allowed level', () => {
    expect(problems(scan([['ok.ts', conformingSource()]]))).toEqual([]);
  });

  it('a name outside the catalog', () => {
    const source = `${conformingSource()}\nlog.info('thread.invented', {});`;
    expect(problems(scan([['new.ts', source]]))).toEqual([
      "'thread.invented' is logged but is not in LOG_EVENT_LEVELS (src/core/log-events.ts)",
    ]);
  });

  it('a catalog name nothing logs', () => {
    const source = conformingSource()
      .split('\n')
      .filter((line) => !line.includes("'jev.outage'"))
      .join('\n');
    expect(problems(scan([['gone.ts', source]]))).toEqual([
      "'jev.outage' is in LOG_EVENT_LEVELS but nothing logs it",
    ]);
  });

  it.each([
    ['a variable', 'log.warn(eventName, fields);'],
    ['a template literal', 'log.warn(`thread.${kind}`, fields);'],
    ['a double-quoted string', 'log.warn("thread.failed", fields);'],
    ['a constant on the next line', 'log.warn(\n  EVENT,\n  fields,\n);'],
    ['no argument', 'log.warn();'],
  ])('a non-literal name: %s', (_case, call) => {
    const source = `${conformingSource()}\n${call}`;
    expect(problems(scan([['app/x.ts', source]]))).toEqual([
      'app/x.ts: .warn( log a literal event name, so the catalog can check it',
    ]);
  });

  it('a level the catalog does not allow', () => {
    const source = `${conformingSource()}\nlog.error('thread.failed', {});`;
    expect(problems(scan([['level.ts', source]]))).toEqual([
      "'thread.failed' is logged at [error,warn] but the catalog says [warn]",
    ]);
  });

  it('an allowed level that is no longer used', () => {
    const source = conformingSource().replace("deps.log.warn('thread.classified', {});", '');
    expect(problems(scan([['level.ts', source]]))).toEqual([
      "'thread.classified' is logged at [info] but the catalog says [info,warn]",
    ]);
  });

  it('reads a call that Prettier broke after the bracket, and any receiver', () => {
    const found = scan([
      ['a.ts', "call.deps.log.info(\n    'manual.progress',\n    fields,\n  );"],
      ['b.ts', "log.warn('jev.outage', {});\n// log.error('run.failed') in a comment counts too"],
    ]);
    expect(found.nonLiteral).toEqual([]);
    expect(found.calls).toBe(3);
    expect([...found.levels.entries()].map(([name, levels]) => [name, [...levels]])).toEqual([
      ['manual.progress', ['info']],
      ['jev.outage', ['warn']],
      ['run.failed', ['error']],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Solution Design §10.5, "Main events"
// ---------------------------------------------------------------------------

const MAIN_EVENTS = '- **Main events:**';

/**
 * The names in a document's "Main events" list: every backtick span on the
 * sub-bullets (two spaces, then `- `) right after the line that starts with
 * `- **Main events:**`, up to the first line that isn't one.
 */
function mainEvents(text: string): { headings: number; names: string[] } {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => (line.startsWith(MAIN_EVENTS) ? [i] : []));
  const names: string[] = [];
  const [start] = starts;
  if (start !== undefined) {
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('  - ')) break;
      for (const match of line.matchAll(/`([^`]*)`/g)) {
        names.push(match[1] ?? '');
      }
    }
  }
  return { headings: starts.length, names };
}

/** The two-way difference between a "Main events" list and the catalog. */
function listDiff(names: readonly string[]): { onlyInSd: string[]; onlyInCatalog: string[] } {
  return {
    onlyInSd: names.filter((name) => !isLogEventName(name)),
    onlyInCatalog: LOG_EVENTS.filter((name) => !names.includes(name)),
  };
}

describe('SD §10.5 "Main events"', () => {
  const sd = readFileSync(join(REPO_ROOT, 'output', 'solution-design.md'), 'utf8');
  const list = mainEvents(sd);

  it('is in the Solution Design exactly once', () => {
    expect(list.headings).toBe(1);
  });

  it('has no duplicate', () => {
    expect(list.names.filter((name, i) => list.names.indexOf(name) !== i)).toEqual([]);
  });

  it('names exactly the events in LOG_EVENTS', () => {
    // A name only in the SD is listed but never logged; a name only in the
    // catalog is logged but missing from the SD list (ES §6).
    expect(listDiff(list.names)).toEqual({ onlyInSd: [], onlyInCatalog: [] });
  });

  it('is in the catalog order', () => {
    expect(list.names).toEqual([...LOG_EVENTS]);
  });

  it('has no config.invalid: an invalid config is run.failed', () => {
    expect(list.names).not.toContain('config.invalid');
    expect(list.names).toEqual(expect.arrayContaining(['run.unfinished', 'alert.failed']));
  });

  it('the comparison catches a difference (run on a made-up list)', () => {
    const text = [
      'Before.',
      '- **Main events:**',
      '  - `run.start`, `run.end` (summary), `config.invalid`',
      '  - `thread.classified`',
      '- **`run.start`** (`info`) is not part of the list.',
    ].join('\n');
    const made = mainEvents(text);
    expect(made).toEqual({
      headings: 1,
      names: ['run.start', 'run.end', 'config.invalid', 'thread.classified'],
    });
    const diff = listDiff(made.names);
    expect(diff.onlyInSd).toEqual(['config.invalid']);
    expect(diff.onlyInCatalog).toHaveLength(LOG_EVENTS.length - 3);
    expect(diff.onlyInCatalog).toContain('alert.failed');
  });
});
