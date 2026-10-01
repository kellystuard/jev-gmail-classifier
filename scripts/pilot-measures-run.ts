/**
 * The pilot log reducer (task #315, story #156; epic #16 decisions 1, 8, 11,
 * 13). It reads Cloud Logging exports of the pilot's script and prints the
 * numbers the six success measures need, as one JSON object, and nothing else.
 *
 *     node scripts/pilot-measures.ts --from <ISO> --to <ISO> --interval <minutes>
 *       [--config <config.yaml>] [--usd-per-million <number>]
 *       [--worksheet <file> [--sample <n>] [--min-per-rule <n>] [--seed <text>]]
 *       [--checked <file>]... [--rule-from <ruleId>=<ISO>]... [--crosscheck <file>]
 *       <export.json>...
 *
 * `--rule-from` (story #156 S4): a rule whose config changed at that instant
 * counts, in `precision` and in the worksheet, only actions at or after it
 * (a checked row by its own `ts`). Every other measure, `rules` included,
 * counts the whole window. The instants used are printed as `ruleFrom`.
 *
 * The pilot's log holds subjects and senders and this repository is public,
 * so the output holds only numbers, booleans, ISO times, names from closed
 * sets (events, entry points, `stopped` values, error classes, alert
 * conditions) and rule IDs and model names (`pilot-reduce.ts`). It never
 * holds a subject, sender, thread ID, `runId`, `historyId`, label name,
 * query, error text, scope URL, rule question or a line of the cross-check
 * file, and no error message quotes file content. The worksheet, which does
 * hold mail content, is refused anywhere inside a git work tree.
 *
 * All I/O is injected (`PilotDeps`), so tests run it in process. The format of
 * the export is assumed in `pilot-log.ts`; the trial export in #157 confirms it.
 */
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config/loader.ts';
import type { Config } from '../src/config/schema.ts';
import { parseConfigText } from './config-source.ts';
import { readExports } from './pilot-log.ts';
import { reduce, ruleCounts } from './pilot-reduce.ts';
import { ruleInfos } from './pilot-rules.ts';
import { applicationRows, precisionOf, readChecked, sampleRows, toCsv } from './pilot-worksheet.ts';

export const PILOT_USAGE =
  'node scripts/pilot-measures.ts --from <ISO> --to <ISO> --interval <minutes> ' +
  '[--config <config.yaml>] [--usd-per-million <number>] ' +
  '[--worksheet <file> [--sample <n>] [--min-per-rule <n>] [--seed <text>]] ' +
  '[--checked <file>]... [--rule-from <ruleId>=<ISO>]... [--crosscheck <file>] <export.json>...';

export interface PilotDeps {
  /** Reads a UTF-8 file, throwing like `fs.readFileSync`. */
  readonly readFile: (path: string) => string;
  /** Writes a file (private, creating its folder), throwing like `fs.writeFileSync`. */
  readonly writeFile: (path: string, text: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (line: string) => void;
  /** Relative paths in the arguments resolve against this. */
  readonly cwd: string;
  /** The repository's root: a worksheet is never written inside it. */
  readonly repoRoot: string;
  /** True when `dir`, or its nearest existing parent, is inside any git work tree. */
  readonly isInGitWorkTree: (dir: string) => boolean;
}

const INTERVALS: readonly number[] = [1, 5, 10, 15, 30];
const DEFAULT_SAMPLE = 40;
const DEFAULT_MIN_PER_RULE = 5;

interface Options {
  readonly from: number;
  readonly to: number;
  readonly interval: number;
  readonly config: string | undefined;
  readonly usd: number | undefined;
  readonly worksheet: string | undefined;
  readonly sample: number;
  readonly minPerRule: number;
  readonly seed: string;
  readonly checked: readonly string[];
  readonly ruleFrom: readonly { readonly ruleId: string; readonly at: number }[];
  readonly crosscheck: string | undefined;
  readonly exports: readonly string[];
}

type Parsed = { ok: true; options: Options } | { ok: false; message: string };

function wholeNumber(text: string | undefined, fallback: number): number | undefined {
  if (text === undefined) return fallback;
  return /^\d{1,9}$/.test(text) ? Number(text) : undefined;
}

function parseOptions(argv: readonly string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        interval: { type: 'string' },
        config: { type: 'string' },
        'usd-per-million': { type: 'string' },
        worksheet: { type: 'string' },
        sample: { type: 'string' },
        'min-per-rule': { type: 'string' },
        seed: { type: 'string' },
        checked: { type: 'string', multiple: true },
        'rule-from': { type: 'string', multiple: true },
        crosscheck: { type: 'string' },
      },
    });
  } catch {
    return { ok: false, message: 'Unknown or incomplete option.' };
  }
  const { values, positionals } = parsed;
  if (values.from === undefined || values.to === undefined || values.interval === undefined) {
    return { ok: false, message: 'Required: --from, --to and --interval.' };
  }
  const from = Date.parse(values.from);
  const to = Date.parse(values.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
    return {
      ok: false,
      message: 'Invalid window: --from and --to must be ISO times, --from first.',
    };
  }
  const interval = Number(values.interval);
  if (!INTERVALS.includes(interval)) {
    return { ok: false, message: '--interval must be 1, 5, 10, 15 or 30.' };
  }
  let usd: number | undefined;
  if (values['usd-per-million'] !== undefined) {
    usd = Number(values['usd-per-million']);
    if (values['usd-per-million'].trim() === '' || !Number.isFinite(usd) || usd < 0) {
      return { ok: false, message: '--usd-per-million must be a number, 0 or more.' };
    }
  }
  const sample = wholeNumber(values.sample, DEFAULT_SAMPLE);
  const minPerRule = wholeNumber(values['min-per-rule'], DEFAULT_MIN_PER_RULE);
  if (sample === undefined || minPerRule === undefined) {
    return { ok: false, message: '--sample and --min-per-rule must be whole numbers.' };
  }
  const checked = values.checked ?? [];
  if ((values.worksheet !== undefined || checked.length > 0) && values.config === undefined) {
    return { ok: false, message: '--worksheet and --checked need --config.' };
  }
  const ruleFrom: { ruleId: string; at: number }[] = [];
  for (const text of values['rule-from'] ?? []) {
    const cut = text.indexOf('=');
    const at = cut < 0 ? Number.NaN : Date.parse(text.slice(cut + 1));
    if (cut <= 0 || Number.isNaN(at)) {
      return { ok: false, message: '--rule-from must look like <ruleId>=<ISO instant>.' };
    }
    if (at < from || at >= to) {
      return { ok: false, message: 'A --rule-from instant must be inside [--from, --to).' };
    }
    const ruleId = text.slice(0, cut);
    if (ruleFrom.some((entry) => entry.ruleId === ruleId)) {
      return { ok: false, message: '--rule-from is given twice for one rule.' };
    }
    ruleFrom.push({ ruleId, at });
  }
  if (ruleFrom.length > 0 && values.config === undefined) {
    return { ok: false, message: '--rule-from needs --config.' };
  }
  if (positionals.length === 0) {
    return { ok: false, message: 'Give at least one export file.' };
  }
  return {
    ok: true,
    options: {
      from,
      to,
      interval,
      config: values.config,
      usd,
      worksheet: values.worksheet,
      sample,
      minPerRule,
      seed: values.seed ?? values.from,
      checked,
      ruleFrom,
      crosscheck: values.crosscheck,
      exports: positionals,
    },
  };
}

function insideRepo(repoRoot: string, path: string): boolean {
  const rel = relative(resolve(repoRoot), path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function loadPilotConfig(text: string): Config | undefined {
  const result = parseConfigText(text, 'config');
  if (!result.ok) return undefined;
  try {
    return loadConfig(result.raw);
  } catch {
    return undefined;
  }
}

/** Runs the reducer. Returns the exit code. Never throws for bad input. */
export function runPilotMeasures(argv: readonly string[], deps: PilotDeps): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.stdout(`${PILOT_USAGE}\n`);
    return 0;
  }
  const parsed = parseOptions(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.message} Usage: ${PILOT_USAGE}`);
    return 1;
  }
  const { options } = parsed;
  const read = (path: string): string | undefined => {
    try {
      return deps.readFile(resolve(deps.cwd, path));
    } catch {
      return undefined;
    }
  };

  // Everything is read and checked before anything is written.
  const exportTexts: string[] = [];
  for (const file of options.exports) {
    const text = read(file);
    if (text === undefined) {
      deps.stderr('Cannot read an export file.');
      return 1;
    }
    exportTexts.push(text);
  }
  let config: Config | undefined;
  if (options.config !== undefined) {
    const text = read(options.config);
    if (text === undefined) {
      deps.stderr('Cannot read the config file.');
      return 1;
    }
    config = loadPilotConfig(text);
    if (config === undefined) {
      deps.stderr(
        'The config file is not valid. Run: npm run build -- --config <file> to see why.',
      );
      return 1;
    }
  }
  const ruleFrom = new Map<string, number>();
  for (const entry of options.ruleFrom) {
    const known = config?.rules.some((rule) => rule.id === entry.ruleId) === true;
    if (!known) {
      deps.stderr('--rule-from names a rule that is not in the config.');
      return 1;
    }
    ruleFrom.set(entry.ruleId, entry.at);
  }
  const checkedTexts: string[] = [];
  for (const file of options.checked) {
    const text = read(file);
    if (text === undefined) {
      deps.stderr('Cannot read a --checked file.');
      return 1;
    }
    checkedTexts.push(text);
  }
  const checkedRows = checkedTexts.length === 0 ? undefined : readChecked(checkedTexts);
  if (checkedTexts.length > 0 && checkedRows === undefined) {
    deps.stderr('A --checked file is not a worksheet (no id, ruleId, kind and correct columns).');
    return 1;
  }
  let crosscheckText: string | undefined;
  if (options.crosscheck !== undefined) {
    crosscheckText = read(options.crosscheck);
    if (crosscheckText === undefined) {
      deps.stderr('Cannot read the --crosscheck file.');
      return 1;
    }
  }
  let worksheetPath: string | undefined;
  if (options.worksheet !== undefined) {
    worksheetPath = resolve(deps.cwd, options.worksheet);
    const folder = dirname(worksheetPath);
    if (insideRepo(deps.repoRoot, worksheetPath) || deps.isInGitWorkTree(folder)) {
      deps.stderr(
        'Refusing to write the worksheet inside a git work tree: it holds mail content. ' +
          'Choose a folder outside every checkout.',
      );
      return 1;
    }
  }

  const log = readExports(exportTexts);
  const measures = reduce(log, {
    from: options.from,
    to: options.to,
    intervalMinutes: options.interval,
    usdPerMillion: options.usd,
    config,
  });
  const out: Record<string, unknown> = { ...measures };

  const inWindow = log.lines.filter((l) => l.ts >= options.from && l.ts < options.to);
  if (config !== undefined) {
    const rules = ruleInfos(config);
    const counts = ruleCounts(inWindow, config, ruleFrom);
    if (ruleFrom.size > 0) {
      out['ruleFrom'] = rules.flatMap((rule) => {
        const at = ruleFrom.get(rule.id);
        return at === undefined ? [] : [{ id: rule.id, from: new Date(at).toISOString() }];
      });
    }
    if (worksheetPath !== undefined) {
      const all = applicationRows(inWindow, rules, ruleFrom);
      const rows = sampleRows(all, rules, {
        sample: options.sample,
        minPerRule: options.minPerRule,
        seed: options.seed,
      });
      try {
        deps.writeFile(worksheetPath, toCsv(rows));
      } catch {
        deps.stderr('Cannot write the worksheet.');
        return 1;
      }
      out['worksheet'] = {
        rows: rows.length,
        moves: rows.filter((r) => r.kind !== 'label').length,
        labels: rows.filter((r) => r.kind === 'label').length,
      };
    }
    if (checkedRows !== undefined) {
      out['precision'] = precisionOf(
        checkedRows,
        rules,
        new Map(counts.rules.map((rule) => [rule.id, rule.appliedSince])),
        ruleFrom,
      );
    }
  }

  if (crosscheckText !== undefined) {
    const subjects = log.lines.flatMap((line) => {
      if (line.event !== 'thread.classified') return [];
      const subject = line.fields['subject'];
      return typeof subject === 'string' ? [subject.toLowerCase()] : [];
    });
    let listed = 0;
    const missingLines: number[] = [];
    crosscheckText.split(/\r?\n/).forEach((text, index) => {
      const needle = text.trim().toLowerCase();
      if (needle === '') return;
      listed += 1;
      if (!subjects.some((subject) => subject.includes(needle))) missingLines.push(index + 1);
    });
    out['crosscheck'] = { listed, found: listed - missingLines.length, missingLines };
  }

  deps.stdout(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}
