/**
 * Reads the pilot's exported Cloud Logging file into typed log lines (task
 * #315, story #156; epic #16 decision 8).
 *
 * What an export looks like is NOT confirmed by the repository. This file
 * assumes what `gcloud logging read --format=json` prints for an Apps Script
 * project: a JSON array of `LogEntry` objects (or one object per line), each
 * with `insertId`, `severity` (`INFO`, `WARNING`, `ERROR`), `timestamp`, and
 * the text of the `console` call in `jsonPayload.message` (else
 * `textPayload`). Our own line is one JSON object `{event, runId, entry, ts,
 * ...fields}` (SD §10.5). As a fallback, a `jsonPayload` that already is that
 * object is accepted. The trial export in #157 confirms the shape; if it
 * differs, the fix is a small change here.
 *
 * Nothing here prints. The reader returns typed values and counts; the
 * strings in a line's fields are mail content and stay inside this process.
 */

/** One of our log lines. `fields` holds everything but the four leading keys. */
export interface PilotLine {
  readonly event: string;
  readonly runId: string;
  readonly entry: string;
  /** The line's own `ts`, in epoch milliseconds. */
  readonly ts: number;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Input order, to keep sorts stable. */
  readonly seq: number;
}

export interface PilotRead {
  /** Our lines, sorted by `ts` (ties by input order). */
  readonly lines: readonly PilotLine[];
  /** Distinct entries read (after de-duplication by `insertId`). */
  readonly entries: number;
  /** Entries that are not one of our lines. */
  readonly unparsed: number;
  /** `ERROR` entries that are not one of our lines, with the epoch ms of their `timestamp` when they have one. */
  readonly platformErrors: readonly {
    readonly at: number | undefined;
    readonly quotaLike: boolean;
  }[];
}

/** Text that marks a platform error as a quota or rate problem (ignoring case). Never printed. */
const QUOTA_PATTERNS: readonly string[] = [
  'exceeded maximum execution time',
  'service invoked too many times',
  'service using too much computer time',
  'quota',
  'ratelimitexceeded',
  'user-rate limit exceeded',
];

/** True when `text` holds one of the quota phrases, ignoring case. */
export function isQuotaLike(text: string): boolean {
  const lower = text.toLowerCase();
  return QUOTA_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Field accessors: a field of the wrong type is absent.
// ---------------------------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>;

export function numberField(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stringField(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(fields: Fields, key: string): boolean | undefined {
  const value = fields[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function stringArrayField(fields: Fields, key: string): readonly string[] | undefined {
  const value = fields[key];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

export function recordField(fields: Fields, key: string): Fields | undefined {
  const value = fields[key];
  return isRecord(value) ? value : undefined;
}

/** True when the field is present and is not `false`, `null` or `0`. */
export function presentField(fields: Fields, key: string): boolean {
  const value = fields[key];
  return value !== undefined && value !== null && value !== false && value !== 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The entries of one export file: a JSON array, one object, or one object per line. */
function entriesOf(text: string): readonly unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const whole: unknown = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // Not one JSON value: try one per line.
  }
  const out: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      out.push(parsed);
    } catch {
      out.push(undefined);
    }
  }
  return out;
}

/** The text of the `console` call in an entry: `jsonPayload.message`, else `textPayload`. */
function messageText(entry: Fields): string | undefined {
  const payload = recordField(entry, 'jsonPayload');
  const message = payload === undefined ? undefined : stringField(payload, 'message');
  return message ?? stringField(entry, 'textPayload');
}

function toLine(candidate: unknown, seq: number): PilotLine | undefined {
  if (!isRecord(candidate)) return undefined;
  const event = stringField(candidate, 'event');
  const runId = stringField(candidate, 'runId');
  const entry = stringField(candidate, 'entry');
  const tsText = stringField(candidate, 'ts');
  if (event === undefined || runId === undefined || entry === undefined || tsText === undefined) {
    return undefined;
  }
  const ts = Date.parse(tsText);
  if (Number.isNaN(ts)) return undefined;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key !== 'event' && key !== 'runId' && key !== 'entry' && key !== 'ts') {
      fields[key] = value;
    }
  }
  return { event, runId, entry, ts, fields, seq };
}

function ourLine(entry: Fields, seq: number): PilotLine | undefined {
  const text = messageText(entry);
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text.trim());
      const line = toLine(parsed, seq);
      if (line !== undefined) return line;
    } catch {
      // Not JSON: not one of our lines.
    }
  }
  return toLine(entry['jsonPayload'], seq);
}

/** Everything in an entry that could hold a quota phrase, for matching only. */
function entryText(entry: Fields): string {
  const text = messageText(entry);
  if (text !== undefined) return text;
  const payload = entry['jsonPayload'];
  try {
    return payload === undefined ? '' : JSON.stringify(payload);
  } catch {
    return '';
  }
}

/**
 * Reads the export files' text. Never throws: a bad entry is `unparsed`.
 * Entries with the same `insertId` count once, across files.
 */
export function readExports(texts: readonly string[]): PilotRead {
  const seen = new Set<string>();
  const lines: PilotLine[] = [];
  const platformErrors: { at: number | undefined; quotaLike: boolean }[] = [];
  let entries = 0;
  let unparsed = 0;
  let seq = 0;
  for (const text of texts) {
    for (const raw of entriesOf(text)) {
      if (isRecord(raw)) {
        const insertId = stringField(raw, 'insertId');
        if (insertId !== undefined) {
          if (seen.has(insertId)) continue;
          seen.add(insertId);
        }
      }
      entries += 1;
      seq += 1;
      const line = isRecord(raw) ? ourLine(raw, seq) : undefined;
      if (line !== undefined) {
        lines.push(line);
        continue;
      }
      unparsed += 1;
      if (isRecord(raw) && stringField(raw, 'severity')?.toUpperCase() === 'ERROR') {
        const stamp = stringField(raw, 'timestamp');
        const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
        platformErrors.push({
          at: Number.isNaN(at) ? undefined : at,
          quotaLike: isQuotaLike(entryText(raw)),
        });
      }
    }
  }
  lines.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return { lines, entries, unparsed, platformErrors };
}
