/**
 * The local Jev probe (Epic E5 decision 13, task #102; Solution Design §12):
 * send saved `.eml` files to Jev through the same code path the deployed
 * script uses, and print each rule's probability and whether it fires.
 *
 *     npm run probe -- [--config <file>] [--show-state] [--json] [--env <file>] <file.eml>...
 *
 * Per file: `.eml` → `GmailThread` (`eml-thread.ts`) → `threadToState` →
 * `buildRequest` → one `fetch`, with no retries → `interpretResponse`. All
 * I/O is injected, so tests run it in-process with a fake `fetch`.
 *
 * Never printed: the API key, the request, or a response body (a 422 echoes
 * the request, which is email content: test/fixtures/jev/README.md).
 */
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

import type { Config } from '../src/config/schema.ts';
import { loadConfig } from '../src/config/loader.ts';
import { UnexpectedResponseError } from '../src/core/errors.ts';
import { buildRequest, JEV_ENDPOINT } from '../src/core/jev-request.ts';
import { interpretResponse } from '../src/core/jev-response.ts';
import type { JevStateMessage } from '../src/core/jev-state.ts';
import type { JevHttpResponse } from '../src/core/jev-status.ts';
import { threadToState } from '../src/core/thread-state.ts';
import type { TruncationStats } from '../src/core/truncation.ts';
import { readConfig } from './config-source.ts';
import { emlToThread, nodeDecodeUtf8 } from './eml-thread.ts';

export const PROBE_USAGE =
  'npm run probe -- [--config <file>] [--show-state] [--json] [--env <file>] <file.eml>...';

/** One request's time limit. The probe never retries. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface ProbeDeps {
  readonly fetch: typeof globalThis.fetch;
  /** `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads a file, throwing like `fs.readFileSync`. */
  readonly readFile: (path: string) => Uint8Array;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Relative paths in the arguments resolve against this. */
  readonly cwd: string;
  /** Where the default `config.yaml` and `.env` live (`REPO_ROOT`). */
  readonly repoRoot: string;
  /**
   * `git rev-parse --path-format=absolute --git-common-dir`, or undefined
   * outside git. In a worktree, its parent is the main checkout, the one place
   * `.env` exists (CLAUDE.md).
   */
  readonly gitCommonDir: () => string | undefined;
}

export type ProbeStage = 'read' | 'parse' | 'no_messages' | 'request' | 'response';

/** `interpretResponse`'s failure kinds, plus `exceptional` (it threw) and `transport` (fetch rejected). */
export type ProbeFailureClass =
  'invalid' | 'auth' | 'config' | 'retryable' | 'scope' | 'exceptional' | 'transport';

export interface ProbeRuleResult {
  readonly id: string;
  readonly probability: number;
  readonly threshold: number;
  readonly thresholdSource: 'rule' | 'default';
  readonly fires: boolean;
}

/** One `--json` line. The field names are relied on by #86: don't rename them. */
export type ProbeFileResult =
  | {
      readonly file: string;
      readonly ok: true;
      readonly model: string;
      readonly requestId?: string;
      readonly inputTokens: number;
      readonly outputTokens?: number;
      readonly truncated: TruncationStats | null;
      readonly rules: readonly ProbeRuleResult[];
      readonly state?: readonly JevStateMessage[];
    }
  | {
      readonly file: string;
      readonly ok: false;
      readonly stage: ProbeStage;
      readonly class?: ProbeFailureClass;
      readonly status?: number;
      readonly errorType?: string;
      readonly requestId?: string;
      readonly reason?: string;
      readonly state?: readonly JevStateMessage[];
    }
  | {
      readonly file: string;
      readonly ok: false;
      readonly stage: 'not_sent';
      readonly reason: 'auth';
    };

interface ProbeOptions {
  readonly configFile: string | undefined;
  readonly envFile: string | undefined;
  readonly showState: boolean;
  readonly json: boolean;
  readonly help: boolean;
  readonly files: readonly string[];
}

function parseOptions(argv: readonly string[]): ProbeOptions | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string' },
        env: { type: 'string' },
        'show-state': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    return {
      configFile: values.config,
      envFile: values.env,
      showState: values['show-state'],
      json: values.json,
      help: values.help,
      files: positionals,
    };
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.message : String(error);
}

function loadProbeConfig(
  options: ProbeOptions,
  deps: ProbeDeps,
): { ok: true; config: Config } | { ok: false; lines: string[] } {
  const isDefault = options.configFile === undefined;
  const file =
    options.configFile === undefined
      ? join(deps.repoRoot, 'config.yaml')
      : resolve(deps.cwd, options.configFile);
  const displayName = options.configFile ?? 'config.yaml';
  const result = readConfig(file, { isDefault, displayName });
  if (!result.ok) {
    const lines = [...result.lines];
    if (isDefault && result.kind === 'not_found') {
      lines.push('Or run: npm run probe -- --config config.example.yaml <file.eml>');
    }
    return { ok: false, lines };
  }
  try {
    return { ok: true, config: loadConfig(result.raw) };
  } catch (error) {
    return { ok: false, lines: [`${displayName} is invalid: ${errorCode(error)}`] };
  }
}

/** The key from one `.env` file, or undefined. Never throws; never prints the value. */
function keyFromEnvFile(path: string, deps: ProbeDeps): string | undefined {
  let text: string;
  try {
    text = new TextDecoder().decode(deps.readFile(path));
  } catch {
    return undefined;
  }
  const value = parseEnv(text)['JEV_API_KEY']?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The key, or the places checked (names and paths only). */
function findKey(
  options: ProbeOptions,
  deps: ProbeDeps,
): { ok: true; key: string } | { ok: false; checked: string[] } {
  const checked = ['JEV_API_KEY in the environment'];
  const fromEnv = deps.env['JEV_API_KEY']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return { ok: true, key: fromEnv };

  const files: string[] = [];
  if (options.envFile !== undefined) files.push(resolve(deps.cwd, options.envFile));
  files.push(join(deps.repoRoot, '.env'));
  const commonDir = deps.gitCommonDir();
  if (commonDir !== undefined) {
    const mainEnv = join(dirname(commonDir), '.env');
    if (!files.includes(mainEnv)) files.push(mainEnv);
  }
  for (const file of files) {
    checked.push(file);
    const key = keyFromEnvFile(file, deps);
    if (key !== undefined) return { ok: true, key };
  }
  return { ok: false, checked };
}

function ruleResults(config: Config, answers: Readonly<Record<string, number>>): ProbeRuleResult[] {
  return config.rules.map((rule) => {
    const probability = answers[rule.id] ?? Number.NaN;
    const own = rule.threshold;
    const threshold = own ?? config.defaultThreshold;
    return {
      id: rule.id,
      probability,
      threshold,
      thresholdSource: own === undefined ? 'default' : 'rule',
      // PDD §4, "Threshold": a rule fires at or above its threshold.
      fires: probability >= threshold,
    };
  });
}

async function toJevResponse(response: Response): Promise<JevHttpResponse> {
  const headers: Record<string, string> = {};
  // `Headers` iterates with lower-case names, as HttpPort promises.
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

function withState(
  showState: boolean,
  state: readonly JevStateMessage[] | undefined,
): { state?: readonly JevStateMessage[] } {
  return showState && state !== undefined ? { state } : {};
}

async function probeFile(
  file: string,
  config: Config,
  key: string,
  options: ProbeOptions,
  deps: ProbeDeps,
): Promise<ProbeFileResult> {
  const path = resolve(deps.cwd, file);
  let raw: Uint8Array;
  try {
    raw = deps.readFile(path);
  } catch (error) {
    return { file, ok: false, stage: 'read', reason: errorCode(error) };
  }

  let state: JevStateMessage[];
  let truncated: TruncationStats | undefined;
  try {
    const thread = emlToThread(raw, basename(file, extname(file)));
    ({ state, truncated } = threadToState(
      thread,
      { plainTextMethod: config.plainTextMethod, questions: config.rules.map((r) => r.question) },
      nodeDecodeUtf8,
    ));
  } catch (error) {
    return { file, ok: false, stage: 'parse', reason: errorCode(error) };
  }
  const shown = withState(options.showState, state);
  if (state.length === 0) {
    return { file, ok: false, stage: 'no_messages', ...shown };
  }

  const body = buildRequest(
    { model: config.jevModel, rules: config.rules.map(({ id, question }) => ({ id, question })) },
    state,
  );
  let response: JevHttpResponse;
  try {
    const fetched = await deps.fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    response = await toJevResponse(fetched);
  } catch (error) {
    // Node's fetch errors name the failure, never the request's headers or body.
    const reason =
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : errorCode(error);
    return { file, ok: false, stage: 'request', class: 'transport', reason, ...shown };
  }

  let result: ReturnType<typeof interpretResponse>;
  try {
    result = interpretResponse(
      response,
      config.rules.map((r) => r.id),
    );
  } catch (error) {
    if (!(error instanceof UnexpectedResponseError)) throw error;
    return {
      file,
      ok: false,
      stage: 'response',
      class: 'exceptional',
      status: response.status,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      reason: error.reason,
      ...shown,
    };
  }
  if (!result.ok) {
    return {
      file,
      ok: false,
      stage: 'response',
      class: result.kind,
      ...('status' in result ? { status: result.status } : {}),
      ...('errorType' in result ? { errorType: result.errorType } : {}),
      ...('requestId' in result ? { requestId: result.requestId } : {}),
      ...shown,
    };
  }
  return {
    file,
    ok: true,
    model: result.model,
    ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
    inputTokens: result.inputTokens,
    ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    truncated: truncated ?? null,
    rules: ruleResults(config, result.answers),
    ...shown,
  };
}

const NUMBER = new Intl.NumberFormat('en-US');

function padTable(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 3)))
      .join(''),
  );
}

/** At least two decimals (`0.80`), and every decimal the config gave (`0.925`). */
function formatThreshold(threshold: number): string {
  const exact = String(threshold);
  const fixed = threshold.toFixed(2);
  return fixed.length > exact.length ? fixed : exact;
}

function describeTruncation(truncated: TruncationStats | null): string {
  if (truncated === null) return 'none';
  return [
    `messagesDropped ${NUMBER.format(truncated.messagesDropped)}`,
    `bodiesDropped ${NUMBER.format(truncated.bodiesDropped)}`,
    `charsDropped ${NUMBER.format(truncated.charsDropped)}`,
  ].join(', ');
}

/** The human-readable lines for one file. */
export function formatFileResult(result: ProbeFileResult): string[] {
  const lines = [result.file];
  if (result.ok) {
    lines.push(
      '  ' +
        [
          `model ${result.model}`,
          `request ${result.requestId ?? '(none)'}`,
          `input tokens ${NUMBER.format(result.inputTokens)}`,
          `truncated: ${describeTruncation(result.truncated)}`,
        ].join('   '),
    );
    const table = padTable([
      ['rule', 'probability', 'threshold', 'fires'],
      ...result.rules.map((rule) => [
        rule.id,
        String(rule.probability),
        formatThreshold(rule.threshold),
        rule.fires ? 'yes' : 'no',
      ]),
    ]);
    lines.push(...table.map((line) => `  ${line}`));
  } else if (result.stage === 'not_sent') {
    lines.push('  NOT SENT: an earlier file failed with auth');
  } else {
    const parts = [
      result.class,
      result.status === undefined ? undefined : String(result.status),
      result.errorType,
      result.requestId === undefined ? undefined : `request ${result.requestId}`,
      result.reason,
    ].filter((part) => part !== undefined);
    lines.push(`  FAILED ${result.stage}: ${parts.join(' ')}`);
  }
  if ('state' in result) {
    lines.push('  state:');
    lines.push(
      ...JSON.stringify(result.state, null, 2)
        .split('\n')
        .map((line) => `  ${line}`),
    );
  }
  return lines;
}

/** Returns the exit code. Never throws for a bad file, config, key or response. */
export async function runProbe(argv: readonly string[], deps: ProbeDeps): Promise<number> {
  const options = parseOptions(argv);
  if (options?.help === true) {
    deps.stdout(`Usage: ${PROBE_USAGE}`);
    return 0;
  }
  if (options === undefined || options.files.length === 0) {
    deps.stderr(`Usage: ${PROBE_USAGE}`);
    return 1;
  }

  const loaded = loadProbeConfig(options, deps);
  if (!loaded.ok) {
    loaded.lines.forEach((line) => {
      deps.stderr(line);
    });
    return 1;
  }
  const { config } = loaded;

  const found = findKey(options, deps);
  if (!found.ok) {
    deps.stderr('No Jev API key found (JEV_API_KEY). Checked:');
    found.checked.forEach((place) => {
      deps.stderr(`  ${place}`);
    });
    return 1;
  }
  // The one place the key lives. It goes into the Authorization header only.
  const key = found.key;

  const results: ProbeFileResult[] = [];
  let authStopped = false;
  for (const file of options.files) {
    let result: ProbeFileResult;
    if (authStopped) {
      result = { file, ok: false, stage: 'not_sent', reason: 'auth' };
    } else {
      if (options.json) deps.stderr(`probe: ${file}`);
      result = await probeFile(file, config, key, options, deps);
      if (!result.ok && result.stage === 'response' && result.class === 'auth') {
        authStopped = true;
        deps.stderr('Jev rejected the key (auth): the remaining files are not sent.');
      }
    }
    results.push(result);
    if (options.json) {
      deps.stdout(JSON.stringify(result));
    } else {
      formatFileResult(result).forEach((line) => {
        deps.stdout(line);
      });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  const inputTokens = results.reduce((sum, r) => sum + (r.ok ? r.inputTokens : 0), 0);
  const summary =
    `Probed ${String(results.length)} file(s): ${String(results.length - failed)} succeeded, ` +
    `${String(failed)} failed, ${NUMBER.format(inputTokens)} input tokens.`;
  if (options.json) {
    deps.stderr(summary);
  } else {
    deps.stdout('');
    deps.stdout(summary);
  }
  return failed === 0 ? 0 : 1;
}
