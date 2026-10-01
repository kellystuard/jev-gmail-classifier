/**
 * Reduces the pilot's log lines to the numbers the success measures need
 * (task #315, story #156). The output is built from typed counters, never by
 * copying a log object: every string in it is a name from a closed set in
 * this file (events, entry points, `stopped` values, error classes, alert
 * conditions, reasons), a rule ID or a model name. Nothing a log line holds as
 * free text (subject, sender, thread ID, `runId`, label name, query, error
 * text) is ever returned.
 */
import type { Config } from '../src/config/schema.ts';
import { LOG_EVENTS } from '../src/core/log-events.ts';
import {
  isQuotaLike,
  numberField,
  type PilotLine,
  type PilotRead,
  presentField,
  recordField,
  stringArrayField,
  stringField,
} from './pilot-log.ts';
import {
  balanceOf,
  groupRuns,
  latencyOf,
  MANUAL_ENTRIES,
  type RunRecord,
  spread,
} from './pilot-runs.ts';
import { appliedActions, modelName, ruleInfos, type RuleInfo, sourceOf } from './pilot-rules.ts';

const DAY_MS = 86_400_000;
const KNOWN_EVENTS: ReadonlySet<string> = new Set<string>(LOG_EVENTS);

/** The entry points, as named by `entry` in a log line. */
export const ENTRY_NAMES = [
  'onTrigger',
  'install',
  'uninstall',
  'startManualRun',
  'continueManualRun',
  'cancelManualRun',
] as const;

const RUN_STOPS: ReadonlySet<string> = new Set([
  'gmail_scope_missing',
  'ingest_rate_limited',
  'ingest_scope',
  'classify_scope_missing',
  'budget',
  'drained',
  'deadline',
  'units',
  'rate_limited',
  'scope',
  'send_deadline',
  'send_scope',
  'outage',
  'abort',
]);
const INGEST_STOPS: ReadonlySet<string> = new Set(['cap', 'deadline', 'rate_limited', 'scope']);
const ALERT_CONDITIONS: ReadonlySet<string> = new Set([
  'auth',
  'errored',
  'run_failures',
  'budget_reached',
  'scope_missing',
  'history_expired',
  'config_invalid',
]);
const ALERT_FAILURES: ReadonlySet<string> = new Set(['scope', 'quota', 'no_owner']);
const ERROR_NAMES: ReadonlySet<string> = new Set([
  'JevClassifierError',
  'ConfigError',
  'StateError',
  'UnexpectedResponseError',
  'ThreadProcessingError',
  'RunAbortError',
  'InvalidArgumentError',
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'Exception',
  'unknown',
]);
const FAILED_STEPS: ReadonlySet<string> = new Set(['heartbeat', 'gmail_calls', 'alerts', 'unlock']);
/** A `reason` is a snake_case code from the source. Anything else is `other`. */
const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;

type Counts = Record<string, number>;

function bump(counts: Counts, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function closed(value: string | undefined, allowed: ReadonlySet<string>): string {
  return value !== undefined && allowed.has(value) ? value : 'other';
}

function sum(lines: readonly PilotLine[], key: string): number {
  return lines.reduce((total, line) => total + (numberField(line.fields, key) ?? 0), 0);
}

export interface ReduceOptions {
  readonly from: number;
  readonly to: number;
  readonly intervalMinutes: number;
  readonly usdPerMillion: number | undefined;
  readonly config: Config | undefined;
}

export interface RunFailedGroup {
  readonly entry: string;
  readonly error: string;
  readonly reason?: string;
  readonly phase?: string;
  readonly step?: string;
  readonly count: number;
  readonly quotaLike: number;
}

export interface Measures {
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly days: number;
    readonly intervalMinutes: number;
    readonly entries: number;
    readonly events: number;
    readonly firstTs: string | null;
    readonly lastTs: string | null;
    readonly outsideWindow: number;
    readonly unparsed: number;
  };
  readonly events: Counts;
  readonly runs: Record<string, Record<string, unknown>>;
  readonly latency: ReturnType<typeof latencyOf>;
  readonly coverage: Record<string, unknown>;
  readonly cost: Record<string, unknown>;
  readonly jev: Record<string, number>;
  readonly quota: Record<string, unknown>;
  readonly alerts: { readonly sent: Counts; readonly failed: Counts };
  readonly rules?: Record<string, unknown>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const SCHEDULED_SUM_KEYS = [
  'ingested',
  'merged',
  'excluded',
  'skipped',
  'classified',
  'errored',
  'gone',
  'struck',
  'untouched',
] as const;

/** `queued` is a manual job's name for what ingest calls `ingested`. */
const MANUAL_SUM_KEYS: readonly (readonly [string, string])[] = [
  ['ingested', 'queued'],
  ['merged', 'merged'],
  ['excluded', 'excluded'],
  ['skipped', 'skipped'],
  ['classified', 'classified'],
  ['errored', 'errored'],
  ['gone', 'gone'],
  ['struck', 'struck'],
  ['untouched', 'untouched'],
];

function runsSection(inWindow: readonly PilotLine[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const entry of ENTRY_NAMES) {
    const own = inWindow.filter((line) => line.entry === entry);
    const section: Record<string, unknown> = {
      started: own.filter((line) => line.event === 'run.start').length,
      ended: own.filter((line) => line.event === 'run.end').length,
      failed: own.filter(
        (line) => line.event === 'run.failed' && !presentField(line.fields, 'phase'),
      ).length,
      skippedBusy: own.filter((line) => line.event === 'run.skipped').length,
    };
    if (entry === 'onTrigger') {
      const ends = own.filter((line) => line.event === 'run.end');
      const stopped: Counts = {};
      for (const line of ends)
        bump(stopped, closed(stringField(line.fields, 'stopped'), RUN_STOPS));
      const durations = ends.flatMap((line) => numberField(line.fields, 'durationMs') ?? []);
      const perDay: Counts = {};
      for (const line of ends) {
        bump(perDay, iso(line.ts).slice(0, 10), numberField(line.fields, 'durationMs') ?? 0);
      }
      const calls = ends.flatMap((line) => numberField(line.fields, 'gmailCallsToday') ?? []);
      section['stopped'] = stopped;
      section['durationMs'] = spread(durations);
      section['maxDurationPerUtcDayMs'] = Math.max(0, ...Object.values(perDay));
      section['maxGmailCallsToday'] = Math.max(0, ...calls);
    }
    out[entry] = section;
  }
  return out;
}

function coverageSection(
  all: readonly PilotLine[],
  inWindow: readonly PilotLine[],
  runs: readonly RunRecord[],
  options: ReduceOptions,
): Record<string, unknown> {
  const scheduledEnds = inWindow.filter((l) => l.entry === 'onTrigger' && l.event === 'run.end');
  const scheduled: Record<string, number | null> = {};
  for (const key of SCHEDULED_SUM_KEYS) scheduled[key] = sum(scheduledEnds, key);
  scheduled['queueFirst'] = numberField(scheduledEnds[0]?.fields ?? {}, 'queueSize') ?? null;
  scheduled['queueLast'] =
    numberField(scheduledEnds[scheduledEnds.length - 1]?.fields ?? {}, 'queueSize') ?? null;

  const spareRecords: Readonly<Record<string, unknown>>[] = [];
  for (const line of scheduledEnds) {
    const spare = recordField(line.fields, 'spare');
    if (spare !== undefined) spareRecords.push(spare);
  }
  const editorEnds = inWindow.filter(
    (l) => MANUAL_ENTRIES.includes(l.entry) && l.event === 'run.end',
  );
  const manual: Record<string, number> = {};
  for (const [outKey, inKey] of MANUAL_SUM_KEYS) {
    manual[outKey] =
      spareRecords.reduce((total, rec) => total + (numberField(rec, inKey) ?? 0), 0) +
      sum(editorEnds, inKey);
  }

  const manualLines = all.filter(
    (l) => MANUAL_ENTRIES.includes(l.entry) && (l.event === 'run.start' || l.event === 'run.end'),
  );
  const balance = balanceOf(runs, manualLines, options.from, options.to);

  const ofEvent = (event: string): PilotLine[] => inWindow.filter((l) => l.event === event);
  const ingestStopped: Counts = {};
  for (const line of ofEvent('ingest.done')) {
    const stopped = stringField(line.fields, 'stopped');
    if (stopped !== undefined) bump(ingestStopped, closed(stopped, INGEST_STOPS));
  }

  // A failed thread is resolved by a later classification, error or skip of
  // the same thread anywhere in the input, also after the window. Thread IDs
  // stay in memory.
  const resolvedAt = new Map<string, number>();
  const order = new Map<PilotLine, number>();
  all.forEach((line, index) => order.set(line, index));
  for (const line of all) {
    if (
      line.event !== 'thread.classified' &&
      line.event !== 'thread.errored' &&
      line.event !== 'thread.skipped'
    ) {
      continue;
    }
    const id = stringField(line.fields, 'threadId');
    if (id !== undefined)
      resolvedAt.set(id, Math.max(resolvedAt.get(id) ?? -1, order.get(line) ?? 0));
  }
  const failedAt = new Map<string, number>();
  for (const line of ofEvent('thread.failed')) {
    const id = stringField(line.fields, 'threadId');
    if (id !== undefined) failedAt.set(id, Math.max(failedAt.get(id) ?? -1, order.get(line) ?? 0));
  }
  let failedUnresolved = 0;
  for (const [id, at] of failedAt) {
    if ((resolvedAt.get(id) ?? -1) < at) failedUnresolved += 1;
  }

  const classified = ofEvent('thread.classified');
  return {
    scheduled,
    manual,
    balanceBreaks: balance.balanceBreaks,
    balanceNotChecked: balance.balanceNotChecked,
    fallbackMissedEvents: ofEvent('history.fallback_missed').length,
    fallbackMissed: sum(ofEvent('history.fallback_missed'), 'missed'),
    historyExpired: ofEvent('history.expired').length,
    excludedSearchCapped: ofEvent('thread.excluded').filter(
      (l) => stringField(l.fields, 'reason') === 'search_capped',
    ).length,
    ingestStopped,
    failedThreads: failedAt.size,
    failedUnresolved,
    truncated: classified.filter((l) => presentField(l.fields, 'truncated')).length,
    moveSkipped: classified.filter((l) => presentField(l.fields, 'moveSkipped')).length,
    labelsSkipped: classified.filter((l) => presentField(l.fields, 'labelsSkipped')).length,
  };
}

function costSection(
  inWindow: readonly PilotLine[],
  days: number,
  usdPerMillion: number | undefined,
): Record<string, unknown> {
  const batches = inWindow.filter((l) => l.event === 'jev.batch');
  const inputTokens = sum(batches, 'inputTokens');
  const classified = inWindow.filter((l) => l.event === 'thread.classified');
  const bySource = (source: string): number =>
    sum(
      classified.filter((l) => sourceOf(l) === source),
      'inputTokens',
    );
  const tokensPer30Days = Math.round((inputTokens / days) * 30);
  return {
    inputTokens,
    classifiedTokens: { scheduled: bySource('scheduled'), manual: bySource('manual') },
    tokensPer30Days,
    ...(usdPerMillion === undefined
      ? {}
      : { usdPer30Days: Math.round((tokensPer30Days / 1_000_000) * usdPerMillion * 100) / 100 }),
  };
}

function jevSection(inWindow: readonly PilotLine[]): Record<string, number> {
  const batches = inWindow.filter((l) => l.event === 'jev.batch');
  const out: Record<string, number> = { batches: batches.length };
  for (const key of [
    'requests',
    'attempts',
    'success',
    'invalid',
    'exceptional',
    'retryable',
    'transport',
    'outage',
  ]) {
    out[key] = sum(batches, key);
  }
  out['outageEvents'] = inWindow.filter((l) => l.event === 'jev.outage').length;
  return out;
}

function quotaSection(
  read: PilotRead,
  inWindow: readonly PilotLine[],
  options: ReduceOptions,
): Record<string, unknown> {
  const groups = new Map<
    string,
    { group: Omit<RunFailedGroup, 'count' | 'quotaLike'>; count: number; quotaLike: number }
  >();
  for (const line of inWindow.filter((l) => l.event === 'run.failed')) {
    const entry = closed(line.entry, new Set(ENTRY_NAMES));
    const error = closed(stringField(line.fields, 'error'), ERROR_NAMES);
    const reasonText = stringField(line.fields, 'reason');
    const reason =
      reasonText === undefined ? undefined : REASON_CODE.test(reasonText) ? reasonText : 'other';
    const phase = presentField(line.fields, 'phase') ? 'finally' : undefined;
    const stepText = stringField(line.fields, 'step');
    const step = stepText === undefined ? undefined : closed(stepText, FAILED_STEPS);
    const group = {
      entry,
      error,
      ...(reason === undefined ? {} : { reason }),
      ...(phase === undefined ? {} : { phase }),
      ...(step === undefined ? {} : { step }),
    };
    const key = [entry, error, reason, phase, step].join('|');
    const text = stringField(line.fields, 'errorMessage');
    const found = groups.get(key) ?? { group, count: 0, quotaLike: 0 };
    found.count += 1;
    if (text !== undefined && isQuotaLike(text)) found.quotaLike += 1;
    groups.set(key, found);
  }
  const platform = read.platformErrors.filter(
    (e) => e.at === undefined || (e.at >= options.from && e.at < options.to),
  );
  return {
    runUnfinished: inWindow.filter((l) => l.event === 'run.unfinished').length,
    runFailed: [...groups.values()]
      .sort((a, b) => a.group.entry.localeCompare(b.group.entry) || b.count - a.count)
      .map((g) => ({ ...g.group, count: g.count, quotaLike: g.quotaLike })),
    platformErrors: {
      count: platform.length,
      quotaLike: platform.filter((e) => e.quotaLike).length,
    },
    rateLimitedStops: inWindow.filter((l) => {
      if (l.event !== 'run.end') return false;
      const stopped = stringField(l.fields, 'stopped');
      return stopped === 'rate_limited' || stopped === 'ingest_rate_limited';
    }).length,
  };
}

function alertsSection(inWindow: readonly PilotLine[]): { sent: Counts; failed: Counts } {
  const sent: Counts = {};
  const failed: Counts = {};
  for (const line of inWindow) {
    if (line.event === 'alert.sent') {
      bump(sent, closed(stringField(line.fields, 'condition'), ALERT_CONDITIONS));
    } else if (line.event === 'alert.failed') {
      bump(failed, closed(stringField(line.fields, 'reason'), ALERT_FAILURES));
    }
  }
  return { sent, failed };
}

/** Counts per rule, as the `rules` section prints them and as `precision` needs them. */
export interface RuleCounts {
  readonly rules: readonly (RuleInfo & {
    fired: number;
    applied: number;
    appliedSince: number;
  })[];
  readonly appliedLabels: number;
  readonly appliedMoves: number;
  readonly models: Counts;
}

/**
 * `applied` counts every action in the window. `appliedSince` counts only the
 * actions at or after the rule's `--rule-from` instant (all of them without
 * one): it is what `precision` compares with the checked rows.
 */
export function ruleCounts(
  inWindow: readonly PilotLine[],
  config: Config,
  ruleFrom: ReadonlyMap<string, number> = new Map(),
): RuleCounts {
  const infos = ruleInfos(config);
  const rules = infos.map((info) => ({ ...info, fired: 0, applied: 0, appliedSince: 0 }));
  const models: Counts = {};
  let appliedLabels = 0;
  let appliedMoves = 0;
  for (const line of inWindow.filter((l) => l.event === 'thread.classified')) {
    const fired = new Set(stringArrayField(line.fields, 'fired') ?? []);
    for (const rule of rules) {
      if (fired.has(rule.id)) rule.fired += 1;
    }
    for (const applied of appliedActions(line, infos)) {
      const rule = rules.find((r) => r.id === applied.ruleId);
      if (rule !== undefined) {
        rule.applied += 1;
        if (line.ts >= (ruleFrom.get(rule.id) ?? Number.NEGATIVE_INFINITY)) rule.appliedSince += 1;
      }
      if (applied.kind === 'label') appliedLabels += 1;
      else appliedMoves += 1;
    }
    bump(models, modelName(line));
  }
  return { rules, appliedLabels, appliedMoves, models };
}

/** The whole report, in the order it prints. */
export function reduce(read: PilotRead, options: ReduceOptions): Measures {
  const all = read.lines;
  const inWindow = all.filter((l) => l.ts >= options.from && l.ts < options.to);
  const days = (options.to - options.from) / DAY_MS;
  const runs = groupRuns(all, 'onTrigger');

  const events: Counts = {};
  for (const name of LOG_EVENTS) events[name] = 0;
  events['other'] = 0;
  for (const line of inWindow) {
    const known = KNOWN_EVENTS.has(line.event);
    bump(events, known ? line.event : 'other');
  }

  const counts = options.config === undefined ? undefined : ruleCounts(inWindow, options.config);
  return {
    window: {
      from: iso(options.from),
      to: iso(options.to),
      days,
      intervalMinutes: options.intervalMinutes,
      entries: read.entries,
      events: inWindow.length,
      firstTs: inWindow.length === 0 ? null : iso(inWindow[0]?.ts ?? 0),
      lastTs: inWindow.length === 0 ? null : iso(inWindow[inWindow.length - 1]?.ts ?? 0),
      outsideWindow: all.length - inWindow.length,
      unparsed: read.unparsed,
    },
    events,
    runs: runsSection(inWindow),
    latency: latencyOf(runs, options.from, options.to, options.intervalMinutes),
    coverage: coverageSection(all, inWindow, runs, options),
    cost: costSection(inWindow, days, options.usdPerMillion),
    jev: jevSection(inWindow),
    quota: quotaSection(read, inWindow, options),
    alerts: alertsSection(inWindow),
    ...(counts === undefined
      ? {}
      : {
          rules: {
            rules: counts.rules.map((r) => ({
              id: r.id,
              kind: r.kind,
              fired: r.fired,
              applied: r.applied,
            })),
            appliedLabels: counts.appliedLabels,
            appliedMoves: counts.appliedMoves,
            models: counts.models,
          },
        }),
  };
}
