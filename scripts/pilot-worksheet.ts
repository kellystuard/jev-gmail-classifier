/**
 * The pilot's spot-check worksheet and the `precision` section (task #315,
 * story #156 S5).
 *
 * The worksheet holds mail content (subjects and senders) and stays on the
 * maintainer's machine; `runPilotMeasures` refuses to write it anywhere that
 * could be committed. Reading it back (`--checked`) yields counts only.
 */
import { createHash } from 'node:crypto';

import { type PilotLine, stringField } from './pilot-log.ts';
import { appliedActions, type RuleInfo } from './pilot-rules.ts';

export const WORKSHEET_COLUMNS = [
  'id',
  'ts',
  'threadId',
  'ruleId',
  'kind',
  'action',
  'subject',
  'from',
  'correct',
] as const;

export interface WorksheetRow {
  readonly id: string;
  readonly ts: string;
  readonly threadId: string;
  readonly ruleId: string;
  readonly kind: string;
  readonly action: string;
  readonly subject: string;
  readonly from: string;
  readonly correct: '';
}

export interface SampleOptions {
  readonly sample: number;
  readonly minPerRule: number;
  readonly seed: string;
}

/** A stable ID for one applied action, the same in every export that holds it. */
export function rowId(threadId: string, ruleId: string, ts: string): string {
  return createHash('sha256').update(`${threadId}\n${ruleId}\n${ts}`).digest('hex').slice(0, 12);
}

/** A seeded generator (mulberry32) returning numbers in [0, 1). */
function seeded(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/** Every applied action in `lines` as a row, sorted by ID. */
export function applicationRows(
  lines: readonly PilotLine[],
  rules: readonly RuleInfo[],
): WorksheetRow[] {
  const rows: WorksheetRow[] = [];
  for (const line of lines) {
    if (line.event !== 'thread.classified') continue;
    const threadId = stringField(line.fields, 'threadId') ?? '';
    const ts = new Date(line.ts).toISOString();
    for (const applied of appliedActions(line, rules)) {
      rows.push({
        id: rowId(threadId, applied.ruleId, ts),
        ts,
        threadId,
        ruleId: applied.ruleId,
        kind: applied.kind,
        action: applied.action,
        subject: stringField(line.fields, 'subject') ?? '',
        from: stringField(line.fields, 'from') ?? '',
        correct: '',
      });
    }
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Every applied move, and a sample of the applied labels: `minPerRule` per
 * rule (or all it has), then at random up to `sample` labels in all. The same
 * seed over the same input gives the same rows.
 */
export function sampleRows(
  rows: readonly WorksheetRow[],
  rules: readonly RuleInfo[],
  options: SampleOptions,
): WorksheetRow[] {
  const random = seeded(options.seed);
  const moves = rows.filter((row) => row.kind !== 'label');
  const labels = rows.filter((row) => row.kind === 'label');
  const chosen = new Set<string>();
  for (const rule of rules) {
    const own = labels.filter((row) => row.ruleId === rule.id);
    for (const row of shuffled(own, random).slice(0, options.minPerRule)) chosen.add(row.id);
  }
  for (const row of shuffled(labels, random)) {
    if (chosen.size >= options.sample) break;
    chosen.add(row.id);
  }
  return [...moves, ...labels.filter((row) => chosen.has(row.id))].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1,
  );
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** The worksheet as CSV text: a header row, then one row per line, quoted as RFC 4180 says. */
export function toCsv(rows: readonly WorksheetRow[]): string {
  const lines = [WORKSHEET_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(WORKSHEET_COLUMNS.map((column) => quote(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Parses CSV text into rows of fields: quoted fields may hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (source.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface CheckedRow {
  readonly ruleId: string;
  readonly kind: string;
  /** `undefined`: the cell was empty, so the row was not checked. */
  readonly correct: boolean | undefined;
}

/**
 * Reads filled-in worksheets. Rows are added up across files; a row with the
 * same `id` counts once (the later file wins). Returns undefined when a file
 * has no header with the `id`, `ruleId`, `kind` and `correct` columns.
 */
export function readChecked(texts: readonly string[]): CheckedRow[] | undefined {
  const byId = new Map<string, CheckedRow>();
  for (const text of texts) {
    const [header, ...body] = parseCsv(text);
    if (header === undefined) return undefined;
    const idCol = header.indexOf('id');
    const ruleCol = header.indexOf('ruleId');
    const kindCol = header.indexOf('kind');
    const correctCol = header.indexOf('correct');
    if (idCol < 0 || ruleCol < 0 || kindCol < 0 || correctCol < 0) return undefined;
    for (const row of body) {
      const id = row[idCol]?.trim() ?? '';
      if (id === '') continue;
      const cell = (row[correctCol] ?? '').trim();
      byId.set(id, {
        ruleId: row[ruleCol] ?? '',
        kind: row[kindCol] ?? '',
        correct: cell === '' ? undefined : cell.toLowerCase() === 'y',
      });
    }
  }
  return [...byId.values()];
}

export interface Precision {
  readonly rules: readonly { id: string; checked: number; correct: number }[];
  readonly moves: { applied: number; checked: number; correct: number };
  readonly labels: { applied: number; checked: number; correct: number };
  /**
   * (correct moves + applied labels x correct labels / checked labels) /
   * (applied moves + applied labels). Left out when nothing was checked, and
   * when labels were applied but none was checked.
   */
  readonly estimate?: number;
}

export function precisionOf(
  checked: readonly CheckedRow[],
  rules: readonly RuleInfo[],
  applied: { readonly labels: number; readonly moves: number },
): Precision {
  const perRule = rules.map((rule) => {
    const own = checked.filter((row) => row.ruleId === rule.id && row.correct !== undefined);
    return {
      id: rule.id,
      checked: own.length,
      correct: own.filter((r) => r.correct === true).length,
    };
  });
  const tally = (move: boolean, appliedCount: number) => {
    const own = checked.filter(
      (row) => row.kind.startsWith('move') === move && row.correct !== undefined,
    );
    return {
      applied: appliedCount,
      checked: own.length,
      correct: own.filter((r) => r.correct === true).length,
    };
  };
  const moves = tally(true, applied.moves);
  const labels = tally(false, applied.labels);
  const total = applied.moves + applied.labels;
  const nothing = moves.checked + labels.checked === 0;
  const labelsUnknown = labels.checked === 0 && applied.labels > 0;
  const estimate =
    nothing || labelsUnknown || total === 0
      ? undefined
      : (moves.correct +
          (labels.checked === 0 ? 0 : (applied.labels * labels.correct) / labels.checked)) /
        total;
  return {
    rules: perRule,
    moves,
    labels,
    ...(estimate === undefined ? {} : { estimate: Math.round(estimate * 10_000) / 10_000 }),
  };
}
