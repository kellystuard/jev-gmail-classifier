/**
 * Composition root and global functions (Solution Design §4.2, §6.1; epic #13
 * decision 13).
 *
 * Each entry point builds its adapters **per call** (`buildPorts`), never at
 * module load: the state adapter's snapshot is valid for one execution only,
 * the log adapter's `runId` identifies one execution, and the bundle must load
 * where Apps Script's globals aren't usable. The logic lives in `src/app/`:
 *
 * - `onTrigger`: `runEntry` (`scheduled`, heartbeat and Gmail tally on) around
 *   `runScheduled`.
 * - `install`: `runEntry` (`lifecycle`, heartbeat off, tally on) around
 *   `install`, which creates the trigger for `onTrigger`.
 * - `uninstall`: `runEntry` (`lifecycle`, heartbeat and tally off: it deletes
 *   `state.*`) around `uninstall`.
 * - `startManualRun`: `runEntry` (`manual`, heartbeat and tally on) around
 *   `startManualJob`, then `continueManualJob` if a job started. A refused
 *   start returns `{entry, status: 'rejected', reason}` and is not a failed
 *   run.
 * - `continueManualRun`: `runEntry` (`manual`, heartbeat and tally on) around
 *   `continueManualJob`.
 * - `cancelManualRun`: `runEntry` (`lifecycle`, heartbeat and tally off)
 *   around `cancelManualJob`.
 *
 * `onTrigger` also passes the manual spare-time hook to `runScheduled`.
 *
 * **Alerts (epic #15 decision 11).** `runEntry` hands each run's collected
 * alerts to the entry's `AlertSink`:
 *
 * - `onTrigger`, `install`, `startManualRun` and `continueManualRun` get the
 *   mailer (`createMailAlertSink`, `src/app/alert-mailer.ts`), which emails
 *   the owner through `GasMailAdapter`, at most once per condition per day.
 *   Its Gmail port is the **uncounted** adapter, not `ctx.gmail`: `runEntry`
 *   saves the Gmail tally before it delivers.
 * - `uninstall` and `cancelManualRun` keep `logOnlyAlertSink`. `uninstall` has
 *   just deleted `state.*`, and the mailer would write `state.alerts` back;
 *   `cancelManualRun` makes no Gmail call and isn't a run to record. The user
 *   is in the editor for both and sees a failure there.
 *
 * **The log's secret list.** `GasLogAdapter` gets the Jev key as its one
 * secret value, so `redact` scrubs it from every string. The adapter reads it
 * at most once, at its first event, never when it is built.
 *
 * Each returns plain JSON, which the Apps Script API (`scripts.run`) hands back
 * but the editor does not show (only the log lines show there, SD §6.1):
 * `{entry, status: 'ok', …}`,
 * `{entry, status: 'rejected', reason}` for a refused manual start, or
 * `{entry, status: 'skipped', reason: 'busy'}` when another execution holds
 * the lock. A failure isn't caught here: `runEntry` logs `run.failed`
 * and rethrows, so the execution shows as Failed (SD §10.1).
 *
 * Export exactly the names in `ENTRY_POINTS` and nothing else: the bundle
 * footer is generated from that list.
 */
import { GasAuthAdapter } from '../adapters/gas/gas-auth-adapter.ts';
import { GasClockAdapter } from '../adapters/gas/gas-clock-adapter.ts';
import { GasGmailAdapter } from '../adapters/gas/gas-gmail-adapter.ts';
import { GasHttpAdapter } from '../adapters/gas/gas-http-adapter.ts';
import { GasLockAdapter } from '../adapters/gas/gas-lock-adapter.ts';
import { GasLogAdapter } from '../adapters/gas/gas-log-adapter.ts';
import { GasMailAdapter } from '../adapters/gas/gas-mail-adapter.ts';
import { GasRandomAdapter } from '../adapters/gas/gas-random-adapter.ts';
import { GasSecretsAdapter } from '../adapters/gas/gas-secrets-adapter.ts';
import { GasStateAdapter } from '../adapters/gas/gas-state-adapter.ts';
import { GasTriggerAdapter } from '../adapters/gas/gas-trigger-adapter.ts';
import { gasDecodeUtf8 } from '../adapters/gas/gas-utf8.ts';
import { createMailAlertSink } from '../app/alert-mailer.ts';
import { type AlertSink, logOnlyAlertSink } from '../app/alerts.ts';
import { cancelManualJob, type CancelReport } from '../app/manual-cancel.ts';
import {
  continueManualJob,
  createManualSpareTime,
  type ManualRunReport,
} from '../app/manual-run.ts';
import { startManualJob, type ManualStartRejection } from '../app/manual-start.ts';
import { install as installUseCase, type InstallReport } from '../app/install.ts';
import { type RunReport, runScheduled } from '../app/run-controller.ts';
import { type RunEntryDeps, type RunEntryOptions, runEntry } from '../app/run-entry.ts';
import type { RunSummary } from '../core/run-record.ts';
import { uninstall as uninstallUseCase, type UninstallReport } from '../app/uninstall.ts';
import { loadEmbeddedConfig } from './embedded-config.ts';
import type { EntryPointName } from './entry-points.ts';

/** The function the recurring trigger calls. */
const TRIGGER_HANDLER = 'onTrigger' satisfies EntryPointName;

interface SkippedResult {
  readonly entry: EntryPointName;
  readonly status: 'skipped';
  readonly reason: 'busy';
}

interface RejectedResult {
  readonly entry: EntryPointName;
  readonly status: 'rejected';
  readonly reason: ManualStartRejection;
}

type OkResult<E extends EntryPointName, R> = { readonly entry: E; readonly status: 'ok' } & R;

type OnTriggerReport = Pick<RunReport, 'stopped' | 'summary' | 'alerts'>;
type OnTriggerResult = OkResult<'onTrigger', OnTriggerReport> | SkippedResult;
type InstallResult = OkResult<'install', InstallReport> | SkippedResult;
type UninstallResult = OkResult<'uninstall', UninstallReport> | SkippedResult;
type ContinueManualReport = Pick<ManualRunReport, 'job' | 'stopped'> & {
  readonly summary: RunSummary;
};
type StartManualReport = ContinueManualReport & {
  readonly query: string;
  readonly applyMoves: boolean;
};
type StartManualResult =
  OkResult<'startManualRun', StartManualReport> | RejectedResult | SkippedResult;
type ContinueManualResult = OkResult<'continueManualRun', ContinueManualReport> | SkippedResult;
type CancelManualResult = OkResult<'cancelManualRun', CancelReport> | SkippedResult;

/**
 * One execution's adapters. Built per call, never kept. Building them touches
 * no Script Property and no mailbox: the log adapter asks for the key only at
 * its first event.
 */
function buildPorts(entry: EntryPointName) {
  const secrets = new GasSecretsAdapter();
  return {
    lock: new GasLockAdapter(),
    clock: new GasClockAdapter(),
    random: new GasRandomAdapter(),
    log: new GasLogAdapter({
      entry,
      secretValues: () => {
        const key = secrets.getJevApiKey();
        return key === undefined ? [] : [key];
      },
    }),
    state: new GasStateAdapter(),
    secrets,
    gmail: new GasGmailAdapter(),
    mail: new GasMailAdapter(),
    http: new GasHttpAdapter(),
    trigger: new GasTriggerAdapter(),
    auth: new GasAuthAdapter(),
    decodeUtf8: gasDecodeUtf8,
  };
}

type Ports = ReturnType<typeof buildPorts>;

/** What each body returns to `runEntry`: the report for the editor, and the run's summary for `state.runs`. */
type Body<R> = { readonly summary?: RunSummary; readonly report: R };

/** `startManualRun`'s body: a refused start has a reason and no summary, so `state.runs` records no failure. */
type StartBody =
  | Body<StartManualReport>
  | { readonly summary?: RunSummary; readonly rejected: ManualStartRejection };

/** The sink that emails the owner. Not for `uninstall` or `cancelManualRun` (see the header). */
function mailAlertSink(ports: Ports): AlertSink {
  return createMailAlertSink({
    mail: ports.mail,
    // The uncounted adapter: the Gmail tally is already saved when the sink runs.
    gmail: ports.gmail,
    state: ports.state,
    clock: ports.clock,
    log: ports.log,
  });
}

function entryDeps(ports: Ports, alertSink: AlertSink): RunEntryDeps {
  return {
    lock: ports.lock,
    clock: ports.clock,
    state: ports.state,
    log: ports.log,
    gmail: ports.gmail,
    alertSink,
    loadConfig: loadEmbeddedConfig,
  };
}

/** Turns `runEntry`'s result into the entry point's JSON. */
function finish<E extends EntryPointName, R extends object>(
  entry: E,
  result: Body<R> | { readonly skipped: 'busy' },
): OkResult<E, R> | SkippedResult {
  if ('skipped' in result) return { entry, status: 'skipped', reason: 'busy' };
  return { entry, status: 'ok', ...result.report };
}

export function onTrigger(): OnTriggerResult {
  const entry = 'onTrigger';
  const ports = buildPorts(entry);
  const options: RunEntryOptions = { entry, kind: 'scheduled', heartbeat: true, tallyGmail: true };
  const deps = entryDeps(ports, mailAlertSink(ports));
  const result = runEntry<Body<OnTriggerReport>>(options, deps, (ctx) => {
    const { summary, stopped, alerts } = runScheduled(ctx, {
      http: ports.http,
      state: ports.state,
      log: ports.log,
      clock: ports.clock,
      random: ports.random,
      secrets: ports.secrets,
      auth: ports.auth,
      decodeUtf8: ports.decodeUtf8,
      spareTime: createManualSpareTime({
        http: ports.http,
        state: ports.state,
        log: ports.log,
        clock: ports.clock,
        random: ports.random,
        decodeUtf8: ports.decodeUtf8,
      }),
    });
    return { summary, report: { stopped, summary, alerts } };
  });
  return finish(entry, result);
}

export function install(): InstallResult {
  const entry = 'install';
  const ports = buildPorts(entry);
  const options: RunEntryOptions = { entry, kind: 'lifecycle', heartbeat: false, tallyGmail: true };
  const deps = entryDeps(ports, mailAlertSink(ports));
  const result = runEntry<Body<InstallReport>>(options, deps, (ctx) => ({
    report: installUseCase(
      ctx,
      {
        gmail: ctx.gmail,
        state: ports.state,
        trigger: ports.trigger,
        auth: ports.auth,
        secrets: ports.secrets,
        clock: ports.clock,
        log: ports.log,
      },
      TRIGGER_HANDLER,
    ),
  }));
  return finish(entry, result);
}

export function uninstall(): UninstallResult {
  const entry = 'uninstall';
  const ports = buildPorts(entry);
  const options: RunEntryOptions = {
    entry,
    kind: 'lifecycle',
    heartbeat: false,
    tallyGmail: false,
  };
  const deps = entryDeps(ports, logOnlyAlertSink);
  const result = runEntry<Body<UninstallReport>>(options, deps, () => ({
    report: uninstallUseCase(
      { trigger: ports.trigger, state: ports.state, log: ports.log },
      TRIGGER_HANDLER,
    ),
  }));
  return finish(entry, result);
}

const MANUAL_OPTIONS = { kind: 'manual', heartbeat: true, tallyGmail: true } as const;

function manualDeps(ports: Ports) {
  return {
    http: ports.http,
    state: ports.state,
    log: ports.log,
    clock: ports.clock,
    random: ports.random,
    secrets: ports.secrets,
    auth: ports.auth,
    decodeUtf8: ports.decodeUtf8,
  };
}

export function startManualRun(): StartManualResult {
  const entry = 'startManualRun';
  const ports = buildPorts(entry);
  const deps = entryDeps(ports, mailAlertSink(ports));
  const result = runEntry<StartBody>({ entry, ...MANUAL_OPTIONS }, deps, (ctx) => {
    const started = startManualJob({ state: ports.state, clock: ports.clock, log: ports.log });
    if (!started.started) return { rejected: started.reason };
    const { summary, report } = continueManualJob(ctx, manualDeps(ports));
    return {
      summary,
      report: {
        query: started.job.query,
        applyMoves: started.job.applyMoves,
        job: report.job,
        stopped: report.stopped,
        summary,
      },
    };
  });
  if ('rejected' in result) return { entry, status: 'rejected', reason: result.rejected };
  return finish(entry, result);
}

export function continueManualRun(): ContinueManualResult {
  const entry = 'continueManualRun';
  const ports = buildPorts(entry);
  const deps = entryDeps(ports, mailAlertSink(ports));
  const result = runEntry<Body<ContinueManualReport>>({ entry, ...MANUAL_OPTIONS }, deps, (ctx) => {
    const { summary, report } = continueManualJob(ctx, manualDeps(ports));
    return { summary, report: { job: report.job, stopped: report.stopped, summary } };
  });
  return finish(entry, result);
}

export function cancelManualRun(): CancelManualResult {
  const entry = 'cancelManualRun';
  const ports = buildPorts(entry);
  const options: RunEntryOptions = {
    entry,
    kind: 'lifecycle',
    heartbeat: false,
    tallyGmail: false,
  };
  const deps = entryDeps(ports, logOnlyAlertSink);
  const result = runEntry<Body<CancelReport>>(options, deps, () => ({
    report: cancelManualJob({ state: ports.state, log: ports.log }, 'cancelled'),
  }));
  return finish(entry, result);
}
