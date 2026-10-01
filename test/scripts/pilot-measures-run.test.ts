import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import { isRecord } from '../../scripts/pilot-log.ts';
import { type PilotDeps, runPilotMeasures } from '../../scripts/pilot-measures-run.ts';
import { parseCsv, toCsv } from '../../scripts/pilot-worksheet.ts';

// ---------------------------------------------------------------------------
// Synthetic log builders. Nothing here comes from a real log.
// ---------------------------------------------------------------------------

const FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'pilot');
const CONFIG = readFileSync(join(FIXTURES, 'config.yaml'), 'utf8');
const FROM = '2026-10-02T00:00:00Z';
const TO = '2026-10-16T00:00:00Z';
const T0 = Date.parse(FROM);
const MIN = 60_000;
const BASE_ARGS = ['--from', FROM, '--to', TO, '--interval', '10'];

type Fields = Record<string, unknown>;

let serial = 0;

interface EntryOptions {
  readonly runId?: string;
  readonly entry?: string;
  readonly at: number;
  readonly severity?: string;
  readonly insertId?: string;
  /** Put the line in `textPayload` instead of `jsonPayload.message`. */
  readonly text?: boolean;
}

/** One exported Cloud Logging entry holding one of our lines. */
function logEntry(event: string, fields: Fields, o: EntryOptions): unknown {
  serial += 1;
  const line = JSON.stringify({
    event,
    runId: o.runId ?? 'run-0',
    entry: o.entry ?? 'onTrigger',
    ts: new Date(o.at).toISOString(),
    ...fields,
  });
  return {
    insertId: o.insertId ?? `id-${String(serial)}`,
    severity: o.severity ?? 'INFO',
    timestamp: new Date(o.at).toISOString(),
    resource: { type: 'app_script_function' },
    ...(o.text === true ? { textPayload: line } : { jsonPayload: { message: line } }),
  };
}

interface RunSpec {
  /** Minutes after the window start. */
  readonly startMin: number;
  readonly durationS?: number;
  readonly end?: Fields;
  readonly ingest?: Fields | false;
  readonly entry?: string;
  readonly noEnd?: boolean;
}

/** One run: `run.start`, `ingest.done`, `run.end`. The defaults make a clean, empty run. */
function runEntries(id: string, spec: RunSpec): unknown[] {
  const startAt = T0 + spec.startMin * MIN;
  const durationMs = (spec.durationS ?? 20) * 1000;
  const entry = spec.entry ?? 'onTrigger';
  const out: unknown[] = [
    logEntry('run.start', { kind: 'scheduled' }, { runId: id, entry, at: startAt }),
  ];
  if (spec.ingest !== false) {
    out.push(
      logEntry(
        'ingest.done',
        { queued: 0, queueSize: 0, ...spec.ingest },
        { runId: id, entry, at: startAt + 1000 },
      ),
    );
  }
  if (spec.noEnd !== true) {
    out.push(
      logEntry(
        'run.end',
        {
          ingested: 0,
          merged: 0,
          excluded: 0,
          skipped: 0,
          sent: 0,
          classified: 0,
          struck: 0,
          errored: 0,
          untouched: 0,
          gone: 0,
          inputTokens: 0,
          queueSize: 0,
          stopped: 'drained',
          durationMs,
          ...spec.end,
        },
        { runId: id, entry, at: startAt + durationMs },
      ),
    );
  }
  return out;
}

/** Normal scheduled runs every 10 minutes: `count` of them from minute 0. */
function steadyRuns(count: number, skip: readonly number[] = []): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    if (!skip.includes(i)) out.push(...runEntries(`run-${String(i)}`, { startMin: i * 10 }));
  }
  return out;
}

interface Harness {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly written: Record<string, string>;
  readonly json: unknown;
}

interface Setup {
  readonly files?: Record<string, string>;
  readonly inGitWorkTree?: boolean;
  readonly repoRoot?: string;
}

/** Runs the reducer with in-memory files. `exports` become `/data/export-<i>.json`. */
function run(args: readonly string[], exports: readonly unknown[][], setup: Setup = {}): Harness {
  const files: Record<string, string> = { ...setup.files };
  exports.forEach((entries, i) => {
    files[`/data/export-${String(i)}.json`] = JSON.stringify(entries);
  });
  const written: Record<string, string> = {};
  let stdout = '';
  const stderr: string[] = [];
  const deps: PilotDeps = {
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    writeFile: (path, text) => {
      written[path] = text;
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => stderr.push(line),
    cwd: '/data',
    repoRoot: setup.repoRoot ?? '/repo',
    isInGitWorkTree: () => setup.inGitWorkTree === true,
  };
  const exportArgs = exports.map((_e, i) => `export-${String(i)}.json`);
  const code = runPilotMeasures([...args, ...exportArgs], deps);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, stdout, stderr: stderr.join('\n'), written, json };
}

function dig(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') current = current[key];
    else if (isRecord(current) && typeof key === 'string') current = current[key];
    else return undefined;
  }
  return current;
}

function classified(at: number, fields: Fields, runId = 'run-0'): unknown {
  return logEntry(
    'thread.classified',
    {
      threadId: `thread-${String(serial)}`,
      source: 'scheduled',
      subject: 'Synthetic subject',
      from: 'sender@example.test',
      probabilities: {},
      fired: [],
      actions: [],
      model: 'jev-1.13.0',
      inputTokens: 100,
      ...fields,
    },
    { runId, at },
  );
}

const CFG = { files: { '/data/config.yaml': CONFIG } };
const WITH_CONFIG = ['--config', 'config.yaml'];

// ---------------------------------------------------------------------------

describe('parsing', () => {
  it('reads jsonPayload.message and textPayload, an array file and a line-per-object file', () => {
    const array = readFileSync(join(FIXTURES, 'export-array.json'), 'utf8');
    const lines = readFileSync(join(FIXTURES, 'export-lines.jsonl'), 'utf8');
    const out = runFiles(BASE_ARGS, ['a.json', 'b.jsonl'], {
      '/data/a.json': array,
      '/data/b.jsonl': lines,
    });
    expect(dig(out, 'window', 'entries')).toBe(5);
    // run-a start and end (a2 is in both files), run-b start; the ERROR entry and the plain text are not ours.
    expect(dig(out, 'window', 'events')).toBe(3);
    expect(dig(out, 'window', 'unparsed')).toBe(2);
    expect(dig(out, 'runs', 'onTrigger', 'started')).toBe(2);
    expect(dig(out, 'runs', 'onTrigger', 'ended')).toBe(1);
    expect(dig(out, 'quota', 'platformErrors')).toEqual({ count: 1, quotaLike: 1 });
    expect(dig(out, 'window', 'firstTs')).toBe('2026-10-02T00:00:00.000Z');
    expect(dig(out, 'window', 'lastTs')).toBe('2026-10-02T00:10:00.000Z');
  });

  it('counts an entry outside the window as outsideWindow, and bad entries as unparsed', () => {
    const entries = [
      ...runEntries('run-in', { startMin: 0 }),
      logEntry('run.start', {}, { runId: 'old', at: T0 - 60 * MIN }),
      logEntry('run.start', {}, { runId: 'late', at: Date.parse(TO) }),
      { insertId: 'x1', severity: 'INFO', textPayload: '{"event":"run.start"}' },
      {
        insertId: 'x2',
        jsonPayload: { message: '{"event":"run.start","runId":"r","entry":"e","ts":"nope"}' },
      },
      { insertId: 'x3', jsonPayload: { message: 5 } },
      'a string',
      null,
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'window', 'events')).toBe(3);
    expect(dig(out, 'window', 'outsideWindow')).toBe(2);
    expect(dig(out, 'window', 'unparsed')).toBe(5);
    expect(dig(out, 'window', 'entries')).toBe(10);
  });

  it('de-duplicates by insertId across files', () => {
    const one = runEntries('run-1', { startMin: 0 });
    const out = run(BASE_ARGS, [one, one]).json;
    expect(dig(out, 'window', 'entries')).toBe(3);
    expect(dig(out, 'runs', 'onTrigger', 'started')).toBe(1);
  });

  it('counts an event outside the catalog under other, and a field of the wrong type as absent', () => {
    const entries = [
      logEntry('not.an.event', {}, { at: T0 + MIN }),
      logEntry('run.end', { queueSize: 'many', durationMs: '5', stopped: 7 }, { at: T0 + 2 * MIN }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'events', 'other')).toBe(1);
    expect(dig(out, 'events', 'run.end')).toBe(1);
    expect(dig(out, 'runs', 'onTrigger', 'stopped')).toEqual({ other: 1 });
    expect(dig(out, 'coverage', 'scheduled', 'queueFirst')).toBeNull();
  });

  it('prints the sections in order', () => {
    const out = run(BASE_ARGS, [steadyRuns(2)]).json;
    expect(isRecord(out) ? Object.keys(out) : []).toEqual([
      'window',
      'events',
      'runs',
      'latency',
      'coverage',
      'cost',
      'jev',
      'quota',
      'alerts',
    ]);
    expect(dig(out, 'window', 'days')).toBe(14);
  });
});

/** Like `run`, but with named files. */
function runFiles(
  args: readonly string[],
  names: readonly string[],
  files: Record<string, string>,
): unknown {
  let stdout = '';
  const code = runPilotMeasures([...args, ...names], {
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    writeFile: () => undefined,
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
    cwd: '/data',
    repoRoot: '/repo',
    isInGitWorkTree: () => false,
  });
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

describe('latency', () => {
  it('a normal sequence has no late episode', () => {
    const out = run(BASE_ARGS, [steadyRuns(6)]).json;
    expect(dig(out, 'latency')).toMatchObject({
      cleanRuns: 6,
      otherRuns: 0,
      lateEpisodes: 0,
      longestNotCleanStreak: 0,
      startGapsOverTwoIntervals: 0,
      maxCleanSpanMs: 10 * MIN + 20_000,
    });
    expect(dig(out, 'latency', 'startGapMs')).toEqual({
      p50: 10 * MIN,
      p95: 10 * MIN,
      max: 10 * MIN,
    });
  });

  it('one not-clean run between two clean ones is not a late episode at a normal spacing', () => {
    const entries = [
      ...runEntries('r0', { startMin: 0 }),
      ...runEntries('r1', { startMin: 10, end: { stopped: 'deadline', queueSize: 5 } }),
      ...runEntries('r2', { startMin: 20 }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'latency')).toMatchObject({
      cleanRuns: 2,
      otherRuns: 1,
      lateEpisodes: 0,
      longestNotCleanStreak: 1,
      maxCleanSpanMs: 20 * MIN + 20_000,
    });
  });

  it('two not-clean runs in a row make one late episode', () => {
    const entries = [
      ...runEntries('r0', { startMin: 0 }),
      ...runEntries('r1', { startMin: 10, end: { stopped: 'deadline' } }),
      ...runEntries('r2', { startMin: 20, end: { stopped: 'units' } }),
      ...runEntries('r3', { startMin: 30 }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'latency', 'lateEpisodes')).toBe(1);
    expect(dig(out, 'latency', 'longestNotCleanStreak')).toBe(2);
  });

  it('a missing run is a start gap over two intervals', () => {
    const out = run(BASE_ARGS, [steadyRuns(5, [2, 3])]).json;
    expect(dig(out, 'latency', 'startGapsOverTwoIntervals')).toBe(1);
    expect(dig(out, 'latency', 'startGapMs', 'max')).toBe(30 * MIN);
    expect(dig(out, 'latency', 'lateEpisodes')).toBe(1);
  });

  it('a drained run whose ingest.done stopped at the cap is not clean', () => {
    const entries = [
      ...runEntries('r0', { startMin: 0, ingest: { stopped: 'cap' } }),
      ...runEntries('r1', { startMin: 10, ingest: { fallback: true } }),
      ...runEntries('r2', { startMin: 20, ingest: { fallback: true, fallbackDone: true } }),
      ...runEntries('r3', { startMin: 30, ingest: false }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'latency', 'cleanRuns')).toBe(1);
    expect(dig(out, 'latency', 'otherRuns')).toBe(3);
  });

  it('subtracts the manual items from queueSize', () => {
    const manualProgress = (runId: string, queued: number): unknown =>
      logEntry('manual.progress', { manualQueued: queued }, { runId, at: T0 + 5000 });
    const entries = [
      ...runEntries('r0', { startMin: 0, end: { queueSize: 7 } }),
      manualProgress('r0', 7),
      ...runEntries('r1', { startMin: 10, end: { queueSize: 7 } }),
      manualProgress('r1', 5),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'latency', 'cleanRuns')).toBe(1);
  });
});

describe('coverage', () => {
  it('sums the scheduled and manual counts and the queue ends', () => {
    const entries = [
      ...runEntries('r0', {
        startMin: 0,
        end: { ingested: 5, classified: 3, excluded: 1, struck: 1, queueSize: 1 },
      }),
      ...runEntries('r1', {
        startMin: 10,
        end: {
          classified: 1,
          queueSize: 0,
          spare: { queued: 4, classified: 2, errored: 1, gone: 1 },
        },
      }),
      ...runEntries('m0', {
        startMin: 12,
        entry: 'continueManualRun',
        end: { classified: 6, skipped: 2, queued: 3 },
      }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'coverage', 'scheduled')).toMatchObject({
      ingested: 5,
      classified: 4,
      excluded: 1,
      struck: 1,
      queueFirst: 1,
      queueLast: 0,
    });
    expect(dig(out, 'coverage', 'manual')).toMatchObject({
      ingested: 7,
      classified: 8,
      errored: 1,
      gone: 1,
      skipped: 2,
    });
  });

  it('counts a made-up break, and does not count the identity that holds', () => {
    const entries = [
      ...runEntries('r0', { startMin: 0, end: { ingested: 4, classified: 3, queueSize: 1 } }),
      // Holds: 1 + 2 - (1 + 1) = 1.
      ...runEntries('r1', {
        startMin: 10,
        end: { ingested: 2, skipped: 1, excluded: 1, queueSize: 1 },
      }),
      // Breaks: 1 + 0 - 0 = 1, but the queue is 3.
      ...runEntries('r2', { startMin: 20, end: { queueSize: 3 } }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'coverage', 'balanceBreaks')).toBe(1);
    // The first run has no predecessor.
    expect(dig(out, 'coverage', 'balanceNotChecked')).toBe(1);
  });

  it('does not check a run with spare work, after a manual entry, or after a run that never ended', () => {
    const entries = [
      ...runEntries('r0', { startMin: 0, end: { queueSize: 0 } }),
      ...runEntries('r1', { startMin: 10, end: { queueSize: 9, spare: { queued: 9 } } }),
      ...runEntries('m1', { startMin: 15, entry: 'startManualRun' }),
      ...runEntries('r2', { startMin: 20, end: { queueSize: 3 } }),
      ...runEntries('r3', { startMin: 30, noEnd: true }),
      ...runEntries('r4', { startMin: 40, end: { queueSize: 8 } }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'coverage', 'balanceBreaks')).toBe(0);
    // r0 has no predecessor, r1 has spare work, r2 follows a manual entry, r4 follows a run that never ended; r3 has no end to check.
    expect(dig(out, 'coverage', 'balanceNotChecked')).toBe(4);
  });

  it('resolves a failed thread by a later outcome, also after the window', () => {
    const failed = (id: string, at: number): unknown =>
      logEntry('thread.failed', { threadId: id, source: 'scheduled', reason: 'retryable' }, { at });
    const outcome = (event: string, id: string, at: number): unknown =>
      logEntry(event, { threadId: id, source: 'scheduled' }, { at });
    const entries = [
      failed('t-resolved', T0 + MIN),
      outcome('thread.classified', 't-resolved', T0 + 11 * MIN),
      failed('t-after', T0 + 2 * MIN),
      outcome('thread.errored', 't-after', Date.parse(TO) + MIN),
      failed('t-never', T0 + 3 * MIN),
      failed('t-never', T0 + 13 * MIN),
      failed('t-skipped', T0 + 4 * MIN),
      outcome('thread.skipped', 't-skipped', T0 + 5 * MIN),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'coverage', 'failedThreads')).toBe(4);
    expect(dig(out, 'coverage', 'failedUnresolved')).toBe(1);
  });

  it('sums history.fallback_missed and counts the other coverage events', () => {
    const entries = [
      logEntry('history.fallback_missed', { missed: 3 }, { at: T0 + MIN }),
      logEntry('history.fallback_missed', { missed: 4 }, { at: T0 + 2 * MIN }),
      logEntry('history.expired', {}, { at: T0 + 3 * MIN }),
      logEntry('thread.excluded', { reason: 'search_capped' }, { at: T0 + 4 * MIN }),
      logEntry('thread.excluded', { reason: 'matched' }, { at: T0 + 5 * MIN }),
      logEntry('ingest.done', { stopped: 'cap' }, { at: T0 + 6 * MIN }),
      logEntry('ingest.done', { stopped: 'cap' }, { at: T0 + 7 * MIN }),
      logEntry('ingest.done', { stopped: 'scope' }, { at: T0 + 8 * MIN }),
      classified(T0 + 9 * MIN, { truncated: { messagesDropped: 1 }, moveSkipped: 'scope' }),
      classified(T0 + 9 * MIN, { labelsSkipped: 'scope' }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'coverage')).toMatchObject({
      fallbackMissedEvents: 2,
      fallbackMissed: 7,
      historyExpired: 1,
      excludedSearchCapped: 1,
      ingestStopped: { cap: 2, scope: 1 },
      truncated: 1,
      moveSkipped: 1,
      labelsSkipped: 1,
    });
  });
});

describe('cost, jev and alerts', () => {
  const batch = (at: number, fields: Fields): unknown => logEntry('jev.batch', fields, { at });

  it('sums jev.batch and projects 30 days', () => {
    const entries = [
      batch(T0 + MIN, {
        requests: 20,
        attempts: 22,
        success: 18,
        invalid: 1,
        retryable: 1,
        inputTokens: 1_000_000,
      }),
      batch(T0 + 2 * MIN, { requests: 5, attempts: 5, success: 5, inputTokens: 400_000 }),
      logEntry('jev.outage', { batch: 1 }, { at: T0 + 3 * MIN }),
      classified(T0 + 4 * MIN, { inputTokens: 600 }),
      classified(T0 + 5 * MIN, { inputTokens: 300, source: 'manual' }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'cost', 'inputTokens')).toBe(1_400_000);
    expect(dig(out, 'cost', 'classifiedTokens')).toEqual({ scheduled: 600, manual: 300 });
    expect(dig(out, 'cost', 'tokensPer30Days')).toBe(3_000_000);
    expect(dig(out, 'cost', 'usdPer30Days')).toBeUndefined();
    expect(dig(out, 'jev')).toMatchObject({
      batches: 2,
      requests: 25,
      attempts: 27,
      success: 23,
      invalid: 1,
      retryable: 1,
      outageEvents: 1,
    });
  });

  it('prints the dollar figure for 14 days at 0.042', () => {
    const entries = [batch(T0 + MIN, { inputTokens: 14_000_000 })];
    const out = run([...BASE_ARGS, '--usd-per-million', '0.042'], [entries]).json;
    // 14,000,000 over 14 days is 1,000,000 a day: 30,000,000 per 30 days, 1.26 dollars.
    expect(dig(out, 'cost', 'tokensPer30Days')).toBe(30_000_000);
    expect(dig(out, 'cost', 'usdPer30Days')).toBe(1.26);
  });

  it('counts alerts sent by condition and failed by reason', () => {
    const entries = [
      logEntry('alert.sent', { condition: 'errored' }, { at: T0 + MIN }),
      logEntry('alert.sent', { condition: 'errored' }, { at: T0 + 2 * MIN }),
      logEntry('alert.sent', { condition: 'budget_reached' }, { at: T0 + 3 * MIN }),
      logEntry('alert.failed', { reason: 'scope', conditions: ['auth'] }, { at: T0 + 4 * MIN }),
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'alerts')).toEqual({
      sent: { errored: 2, budget_reached: 1 },
      failed: { scope: 1 },
    });
  });
});

describe('quota', () => {
  it('reads run.unfinished, run.failed (quota-like or not, and a finally one) and rate limits', () => {
    const failed = (fields: Fields, at: number): unknown =>
      logEntry('run.failed', { kind: 'scheduled', ...fields }, { at });
    const entries = [
      logEntry('run.unfinished', { consecutiveFailures: 1 }, { at: T0 + MIN }),
      failed(
        { error: 'UnexpectedResponseError', errorMessage: 'Service invoked too many times' },
        T0 + 2 * MIN,
      ),
      failed({ error: 'UnexpectedResponseError', errorMessage: 'Something else' }, T0 + 3 * MIN),
      failed(
        { error: 'StateError', reason: 'corrupt', phase: 'finally', step: 'alerts' },
        T0 + 4 * MIN,
      ),
      logEntry('run.end', { stopped: 'rate_limited' }, { at: T0 + 5 * MIN, runId: 'a' }),
      logEntry('run.end', { stopped: 'ingest_rate_limited' }, { at: T0 + 6 * MIN, runId: 'b' }),
      {
        insertId: 'p1',
        severity: 'ERROR',
        textPayload: 'Exceeded maximum execution time',
        timestamp: new Date(T0 + 7 * MIN).toISOString(),
      },
      { insertId: 'p2', severity: 'ERROR', jsonPayload: { message: 'a plain failure' } },
    ];
    const out = run(BASE_ARGS, [entries]).json;
    expect(dig(out, 'quota', 'runUnfinished')).toBe(1);
    expect(dig(out, 'quota', 'runFailed')).toEqual([
      { entry: 'onTrigger', error: 'UnexpectedResponseError', count: 2, quotaLike: 1 },
      {
        entry: 'onTrigger',
        error: 'StateError',
        reason: 'corrupt',
        phase: 'finally',
        step: 'alerts',
        count: 1,
        quotaLike: 0,
      },
    ]);
    expect(dig(out, 'quota', 'rateLimitedStops')).toBe(2);
    expect(dig(out, 'quota', 'platformErrors')).toEqual({ count: 2, quotaLike: 1 });
    expect(dig(out, 'runs', 'onTrigger', 'failed')).toBe(2);
  });
});

describe('rules', () => {
  it('applies two label rules that share a label, and only the first move that fired', () => {
    const entries = [
      // Both labels share one label name, so both rules are applied.
      classified(T0 + MIN, {
        fired: ['newsletter', 'promo'],
        actions: ['label:Synthetic/News'],
      }),
      // Two move rules fired: only the first (shipping) is applied.
      classified(T0 + 2 * MIN, {
        fired: ['shipping', 'junk'],
        actions: ['label:Synthetic/Bill', 'move:archive'],
      }),
      // A move rule fired with moves not allowed: not applied.
      classified(T0 + 3 * MIN, { fired: ['junk', 'bill'], actions: ['label:Synthetic/Bill'] }),
      // A label skipped for scope: fired, not applied.
      classified(T0 + 4 * MIN, { fired: ['newsletter'], actions: [], labelsSkipped: 'scope' }),
      classified(T0 + 5 * MIN, { model: 'jev-latest' }),
    ];
    const out = run([...BASE_ARGS, ...WITH_CONFIG], [entries], CFG).json;
    expect(dig(out, 'rules', 'rules')).toEqual([
      { id: 'newsletter', kind: 'label', fired: 2, applied: 1 },
      { id: 'promo', kind: 'label', fired: 1, applied: 1 },
      { id: 'bill', kind: 'label', fired: 1, applied: 1 },
      { id: 'shipping', kind: 'move:archive', fired: 1, applied: 1 },
      { id: 'junk', kind: 'move:spam', fired: 2, applied: 0 },
    ]);
    expect(dig(out, 'rules', 'appliedLabels')).toBe(3);
    expect(dig(out, 'rules', 'appliedMoves')).toBe(1);
    expect(dig(out, 'rules', 'models')).toEqual({ 'jev-1.13.0': 4, 'jev-latest': 1 });
    expect(dig(out, 'coverage', 'labelsSkipped')).toBe(1);
  });
});

describe('worksheet and --checked', () => {
  /** Every move, plus labels for two rules; one subject is awkward CSV. */
  function pilotEntries(): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      out.push(
        classified(T0 + (i + 1) * MIN, {
          threadId: `move-${String(i)}`,
          fired: ['shipping'],
          actions: ['move:archive'],
          subject: i === 0 ? 'Comma, "quote"\nand a line break' : 'Synthetic move',
        }),
      );
    }
    for (let i = 0; i < 4; i++) {
      out.push(
        classified(T0 + (10 + i) * MIN, {
          threadId: `news-${String(i)}`,
          fired: ['newsletter'],
          actions: ['label:Synthetic/News'],
        }),
      );
    }
    for (let i = 0; i < 2; i++) {
      out.push(
        classified(T0 + (20 + i) * MIN, {
          threadId: `bill-${String(i)}`,
          fired: ['bill'],
          actions: ['label:Synthetic/Bill'],
        }),
      );
    }
    return out;
  }

  const SHEET = '/out/sheet.csv';
  const args = (...more: string[]): string[] => [...BASE_ARGS, ...WITH_CONFIG, ...more];

  it('includes every applied move and holds the per-rule minimum', () => {
    const result = run(
      args('--worksheet', SHEET, '--sample', '3', '--min-per-rule', '1'),
      [pilotEntries()],
      CFG,
    );
    expect(result.code).toBe(0);
    const rows = parseCsv(result.written[SHEET] ?? '').slice(1);
    const kinds = rows.map((r) => r[4]);
    expect(kinds.filter((k) => k === 'move:archive')).toHaveLength(2);
    // sample 3 labels in all, at least one per rule.
    expect(kinds.filter((k) => k === 'label')).toHaveLength(3);
    const rules = rows.map((r) => r[3]);
    expect(rules).toContain('newsletter');
    expect(rules).toContain('bill');
    expect(dig(result.json, 'worksheet')).toEqual({ rows: 5, moves: 2, labels: 3 });
    expect(rows.every((r) => r[8] === '')).toBe(true);
  });

  it('gives the same rows for the same seed, and may differ for another', () => {
    const sheet = (seed: string): string | undefined =>
      run(
        args('--worksheet', SHEET, '--sample', '2', '--min-per-rule', '0', '--seed', seed),
        [pilotEntries()],
        CFG,
      ).written[SHEET];
    expect(sheet('one')).toBe(sheet('one'));
    const distinct = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(sheet));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('keeps a subject with a comma, a quote and a line break through a round trip', () => {
    const result = run(args('--worksheet', SHEET, '--sample', '100'), [pilotEntries()], CFG);
    const rows = parseCsv(result.written[SHEET] ?? '').slice(1);
    expect(rows.map((r) => r[6])).toContain('Comma, "quote"\nand a line break');
    expect(rows).toHaveLength(8);
    expect(toCsv([])).toBe('id,ts,threadId,ruleId,kind,action,subject,from,correct\n');
  });

  it('refuses a path inside the repository or inside another git work tree, and writes nothing', () => {
    const inRepo = run(args('--worksheet', '/repo/out/sheet.csv'), [pilotEntries()], CFG);
    expect(inRepo.code).toBe(1);
    expect(inRepo.written).toEqual({});
    expect(inRepo.stdout).toBe('');
    const nested = run(
      args('--worksheet', '/repo/.claude/worktrees/x/sheet.csv'),
      [pilotEntries()],
      CFG,
    );
    expect(nested.code).toBe(1);
    const inTree = run(args('--worksheet', SHEET), [pilotEntries()], {
      ...CFG,
      inGitWorkTree: true,
    });
    expect(inTree.code).toBe(1);
    expect(inTree.stderr).toContain('git work tree');
    expect(inTree.written).toEqual({});
  });

  /** Fills the `correct` column of a worksheet by `decide(rule, indexWithinRule)`. */
  function fill(csv: string, decide: (rule: string, i: number) => string): string {
    const [header, ...body] = parseCsv(csv);
    const seen: Record<string, number> = {};
    const rows = body.map((row) => {
      const rule = row[3] ?? '';
      const i = seen[rule] ?? 0;
      seen[rule] = i + 1;
      return row.map((cell, col) => (col === 8 ? decide(rule, i) : cell));
    });
    return [header ?? [], ...rows]
      .map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
      .join('\n');
  }

  it('adds the precision section and estimates it by hand', () => {
    const sheet =
      run(args('--worksheet', SHEET, '--sample', '100'), [pilotEntries()], CFG).written[SHEET] ??
      '';
    // Moves: both correct. newsletter: 3 of 4 correct. bill: not checked.
    const filled = fill(sheet, (rule, i) =>
      rule === 'shipping' ? 'Y' : rule === 'newsletter' ? (i < 3 ? 'y' : 'n') : '',
    );
    const result = run(args('--checked', 'filled.csv'), [pilotEntries()], {
      files: { ...CFG.files, '/data/filled.csv': filled },
    });
    expect(dig(result.json, 'precision', 'moves')).toEqual({ applied: 2, checked: 2, correct: 2 });
    expect(dig(result.json, 'precision', 'labels')).toEqual({ applied: 6, checked: 4, correct: 3 });
    expect(dig(result.json, 'precision', 'rules')).toEqual([
      { id: 'newsletter', checked: 4, correct: 3 },
      { id: 'promo', checked: 0, correct: 0 },
      { id: 'bill', checked: 0, correct: 0 },
      { id: 'shipping', checked: 2, correct: 2 },
      { id: 'junk', checked: 0, correct: 0 },
    ]);
    // (2 + 6 * 3 / 4) / (2 + 6) = 0.8125
    expect(dig(result.json, 'precision', 'estimate')).toBe(0.8125);
  });

  it('adds up two --checked files and counts a repeated id once, the later file winning', () => {
    const sheet =
      run(args('--worksheet', SHEET, '--sample', '100'), [pilotEntries()], CFG).written[SHEET] ??
      '';
    const first = fill(sheet, (rule, i) => (rule === 'bill' ? (i === 0 ? 'n' : '') : ''));
    const second = fill(sheet, (rule, i) => (rule === 'bill' ? (i === 0 ? 'y' : 'y') : ''));
    const result = run(args('--checked', 'one.csv', '--checked', 'two.csv'), [pilotEntries()], {
      files: { ...CFG.files, '/data/one.csv': first, '/data/two.csv': second },
    });
    // Two bill rows in the log, both repeated across the files: counted once each.
    expect(dig(result.json, 'precision', 'labels')).toEqual({ applied: 6, checked: 2, correct: 2 });
  });

  it('leaves the estimate out when nothing was checked', () => {
    const sheet = run(args('--worksheet', SHEET), [pilotEntries()], CFG).written[SHEET] ?? '';
    const result = run(args('--checked', 'blank.csv'), [pilotEntries()], {
      files: { ...CFG.files, '/data/blank.csv': sheet },
    });
    expect(dig(result.json, 'precision', 'estimate')).toBeUndefined();
    expect(dig(result.json, 'precision', 'labels', 'checked')).toBe(0);
  });
});

describe('--crosscheck', () => {
  it('finds a line in another case, reports one that matches nothing, skips an empty line', () => {
    const entries = [
      classified(T0 + MIN, { subject: 'Synthetic Invoice for May' }),
      classified(T0 + 2 * MIN, { subject: 'Another synthetic thing' }),
      // After the window: still counts, the cross-check reads the whole input.
      classified(Date.parse(TO) + MIN, { subject: 'Late synthetic arrival' }),
    ];
    const list = '  synthetic invoice  \n\nNo such subject\nlate SYNTHETIC\n';
    const result = run([...BASE_ARGS, '--crosscheck', 'list.txt'], [entries], {
      files: { '/data/list.txt': list },
    });
    expect(dig(result.json, 'crosscheck')).toEqual({ listed: 3, found: 2, missingLines: [3] });
    expect(result.stdout).not.toContain('No such subject');
  });
});

describe('errors', () => {
  it('exits 1 with one line on stderr for a bad command line', () => {
    const cases: string[][] = [
      [],
      ['--from', FROM, '--to', TO],
      ['--from', 'nope', '--to', TO, '--interval', '10'],
      ['--from', TO, '--to', FROM, '--interval', '10'],
      [...BASE_ARGS.slice(0, 4), '--interval', '7'],
      [...BASE_ARGS, '--unknown'],
      [...BASE_ARGS, '--usd-per-million', 'x'],
      [...BASE_ARGS, '--worksheet', '/out/s.csv'],
      [...BASE_ARGS, '--checked', 'x.csv'],
    ];
    for (const args of cases) {
      const result = run(args, [steadyRuns(1)]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.split('\n')).toHaveLength(1);
    }
  });

  it('exits 1 for no export, an unreadable file, an invalid config and a non-worksheet', () => {
    expect(run(BASE_ARGS, []).code).toBe(1);
    expect(runPilotMeasures([...BASE_ARGS, 'missing.json'], noFiles())).toBe(1);
    expect(
      run([...BASE_ARGS, ...WITH_CONFIG], [steadyRuns(1)], {
        files: { '/data/config.yaml': 'rules: nope' },
      }).code,
    ).toBe(1);
    expect(
      run([...BASE_ARGS, ...WITH_CONFIG, '--checked', 'w.csv'], [steadyRuns(1)], {
        files: { ...CFG.files, '/data/w.csv': 'a,b\n1,2\n' },
      }).code,
    ).toBe(1);
  });

  it('prints the usage for --help', () => {
    const result = run(['--help'], []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--interval');
  });
});

function noFiles(): PilotDeps {
  return {
    readFile: () => {
      throw new Error('ENOENT');
    },
    writeFile: () => undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    cwd: '/data',
    repoRoot: '/repo',
    isInGitWorkTree: () => false,
  };
}

// ---------------------------------------------------------------------------
// The privacy test: nothing from a free-text value reaches stdout or stderr.
// ---------------------------------------------------------------------------

describe('privacy', () => {
  const S = 'SECRET';

  /** A log in which every free-text value holds the marker. */
  function secretEntries(): unknown[] {
    const at = (i: number): number => T0 + i * MIN;
    const own = { runId: `${S}-run`, at: at(1) };
    return [
      ...runEntries(`${S}-run-1`, {
        startMin: 0,
        end: { stopped: S, ingested: 1, queueSize: 1, spare: { queued: 1 } },
      }),
      logEntry('run.start', { kind: S }, { ...own, entry: `${S}Entry` }),
      logEntry('not.an.event.SECRET', { subject: `${S} subject` }, own),
      logEntry('ingest.done', { stopped: S, historyId: `${S}-history`, startHistoryId: S }, own),
      logEntry('history.expired', { historyId: S, savedAt: S }, { ...own, at: at(2) }),
      logEntry('label.created', { name: `${S}/label` }, { ...own, at: at(2) }),
      logEntry(
        'manual.started',
        { query: `${S} query`, timespan: S },
        { ...own, entry: 'startManualRun', at: at(3) },
      ),
      logEntry(
        'scope_missing',
        { scope: `https://${S}.example.test/auth`, feature: S },
        { ...own, at: at(3) },
      ),
      logEntry('alert.sent', { condition: S }, { ...own, at: at(4) }),
      logEntry('alert.failed', { reason: S, errorMessage: `${S} quota` }, { ...own, at: at(4) }),
      logEntry(
        'run.failed',
        {
          error: `${S}Error`,
          reason: S,
          errorMessage: `${S} quota error`,
          cause: S,
          step: S,
          issues: [S],
        },
        { ...own, at: at(5) },
      ),
      logEntry(
        'thread.failed',
        { threadId: `${S}-thread`, source: S, reason: S },
        { ...own, at: at(5) },
      ),
      classified(at(6), {
        threadId: `${S}-thread-2`,
        subject: `${S} subject`,
        from: `${S}@example.test`,
        model: S,
        labels: { [`${S}/label`]: 1 },
        moves: { [`label:${S}`]: 1 },
        fired: ['newsletter', 'shipping'],
        actions: [`label:${S}/Label`, `move:label:${S}`],
        probabilities: { newsletter: 0.9 },
      }),
      { insertId: 'p', severity: 'ERROR', textPayload: `${S} Exceeded maximum execution time` },
      { insertId: 'q', severity: 'WARNING', textPayload: `${S} plain` },
    ];
  }

  const secretConfig = CONFIG.replace('Synthetic/News', `${S}/Label`);
  const files = {
    '/data/config.yaml': secretConfig,
    '/data/list.txt': `${S} subject\n${S} missing line\n`,
  };

  it('never prints a marker with every flag, and the worksheet (local) does hold it', () => {
    const sheet = '/out/sheet.csv';
    const result = run(
      [
        ...BASE_ARGS,
        ...WITH_CONFIG,
        '--usd-per-million',
        '1',
        '--worksheet',
        sheet,
        '--crosscheck',
        'list.txt',
        '--seed',
        S,
      ],
      [secretEntries()],
      { files },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(S);
    expect(result.stderr).not.toContain(S);
    expect(result.written[sheet]).toContain(S);
    expect(dig(result.json, 'crosscheck')).toEqual({ listed: 2, found: 1, missingLines: [2] });

    const filled = (result.written[sheet] ?? '').replace(/,\n/g, ',y\n');
    const checked = run(
      [...BASE_ARGS, ...WITH_CONFIG, '--checked', 'filled.csv'],
      [secretEntries()],
      {
        files: { ...files, '/data/filled.csv': filled },
      },
    );
    expect(checked.code).toBe(0);
    expect(checked.stdout).not.toContain(S);
  });

  it('never quotes a file or a value on an error path', () => {
    const paths: Harness[] = [
      run([...BASE_ARGS, '--unknown-SECRET'], [secretEntries()]),
      run([...BASE_ARGS, '--interval', S], [secretEntries()]),
      run([...BASE_ARGS, '--usd-per-million', S], [secretEntries()]),
      run([...BASE_ARGS, `--from=${S}`], [secretEntries()]),
      run([...BASE_ARGS, ...WITH_CONFIG], [secretEntries()], {
        files: { '/data/config.yaml': `${S}: [` },
      }),
      run([...BASE_ARGS, ...WITH_CONFIG, '--checked', 'bad.csv'], [secretEntries()], {
        files: { ...files, '/data/bad.csv': `${S},x\n${S},y\n` },
      }),
      run([...BASE_ARGS, '--crosscheck', `${S}-missing.txt`], [secretEntries()]),
      run(
        [...BASE_ARGS, ...WITH_CONFIG, '--worksheet', `/repo/${S}/sheet.csv`],
        [secretEntries()],
        { files },
      ),
      run(
        [...BASE_ARGS, ...WITH_CONFIG, '--worksheet', `/elsewhere/${S}/sheet.csv`],
        [secretEntries()],
        { files, inGitWorkTree: true },
      ),
    ];
    const missing = runPilotMeasures([...BASE_ARGS, `${S}-missing.json`], noFiles());
    expect(missing).toBe(1);
    for (const result of paths) {
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain(S);
      expect(result.stderr).not.toContain(S);
    }
  });
});
