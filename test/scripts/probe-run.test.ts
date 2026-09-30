import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REPO_ROOT } from '../../scripts/bundle.ts';
import { emlToThread, nodeDecodeUtf8 } from '../../scripts/eml-thread.ts';
import { PROBE_USAGE, runProbe } from '../../scripts/probe-run.ts';
import type { ProbeDeps } from '../../scripts/probe-run.ts';
import { buildRequest, JEV_ENDPOINT } from '../../src/core/jev-request.ts';
import { threadToState } from '../../src/core/thread-state.ts';

/** A key that must never appear in any output. */
const SENTINEL_KEY = 'sk-SENTINEL-do-not-print-7f3a9c';

const FIXTURES = join(REPO_ROOT, 'test', 'fixtures');
/** A repo root with no config.yaml and no .env. */
const EMPTY_ROOT = join(FIXTURES, 'probe-empty-root');
const EXAMPLE_CONFIG = join(REPO_ROOT, 'config.example.yaml');
const PLAIN = 'test/fixtures/eml/01-plain-utf8-7bit.eml';
const ALTERNATIVE = 'test/fixtures/eml/03-alternative-utf8-base64.eml';
const NOT_MIME = 'test/fixtures/eml/not-mime.eml';

const jevFixtureSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
type JevFixture = z.infer<typeof jevFixtureSchema>;

function jevFixture(name: string): JevFixture {
  return jevFixtureSchema.parse(
    JSON.parse(readFileSync(join(FIXTURES, 'jev', `${name}.json`), 'utf8')),
  );
}

/** A 200 in the recorded shape, with the given probabilities for config.example.yaml's rules. */
function answers(probabilities: Record<string, number>): JevFixture {
  const recorded = jevFixture('200-four-rules');
  return {
    ...recorded,
    body: JSON.stringify({
      model: 'jev-1.13.0',
      answers: Object.fromEntries(
        Object.entries(probabilities).map(([id, noul]) => [id, { type: 'noul', noul }]),
      ),
      usage: { input_tokens: 500, output_tokens: 60 },
    }),
  };
}

const ALL_LOW = { approval: 0.01, bill: 0.02, newsletter: 0.03, shipping: 0.04 };

type Reply = JevFixture | Error;

interface Harness {
  readonly deps: ProbeDeps;
  readonly out: string[];
  readonly err: string[];
  readonly calls: { url: string; init: RequestInit }[];
}

function harness(
  replies: readonly Reply[],
  overrides: {
    env?: Record<string, string | undefined>;
    files?: Record<string, string>;
    repoRoot?: string;
    gitCommonDir?: string;
  } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...replies];
  const files = new Map(Object.entries(overrides.files ?? {}));
  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} });
    const reply = queue.shift();
    if (reply === undefined) return Promise.reject(new Error('unexpected fetch'));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(reply.body, { status: reply.status, headers: reply.headers }),
    );
  };
  const deps: ProbeDeps = {
    fetch: fakeFetch,
    env: overrides.env ?? { JEV_API_KEY: SENTINEL_KEY },
    readFile: (path) => {
      const text = files.get(path);
      if (text !== undefined) return new TextEncoder().encode(text);
      if (path.startsWith(join(FIXTURES, 'eml'))) return readFileSync(path);
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: REPO_ROOT,
    repoRoot: overrides.repoRoot ?? EMPTY_ROOT,
    gitCommonDir: () => overrides.gitCommonDir,
  };
  return { deps, out, err, calls };
}

function probe(h: Harness, ...argv: string[]): Promise<number> {
  return runProbe(['--config', EXAMPLE_CONFIG, ...argv], h.deps);
}

function everything(h: Harness): string {
  return [...h.out, ...h.err].join('\n');
}

function jsonLines(h: Harness): Record<string, unknown>[] {
  return h.out.map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

describe('runProbe: arguments', () => {
  it('prints the usage for --help', async () => {
    const h = harness([]);
    await expect(runProbe(['--help'], h.deps)).resolves.toBe(0);
    expect(h.out).toEqual([`Usage: ${PROBE_USAGE}`]);
  });

  it.each([[[]], [['--config', EXAMPLE_CONFIG]], [['--nope', PLAIN]]])(
    'prints the usage and returns 1 for %j',
    async (argv) => {
      const h = harness([]);
      await expect(runProbe(argv, h.deps)).resolves.toBe(1);
      expect(h.err).toEqual([`Usage: ${PROBE_USAGE}`]);
      expect(h.calls).toHaveLength(0);
    },
  );
});

describe('runProbe: config', () => {
  it('prints readConfig lines for an invalid config and returns 1', async () => {
    const h = harness([]);
    const code = await runProbe(
      ['--config', join(FIXTURES, 'config', 'three-errors.yaml'), PLAIN],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.err[0]).toMatch(/three-errors\.yaml is invalid:/);
    expect(h.err.length).toBeGreaterThan(1);
    expect(h.calls).toHaveLength(0);
  });

  it('adds the --config hint when the default config.yaml is missing', async () => {
    const h = harness([]);
    await expect(runProbe([PLAIN], h.deps)).resolves.toBe(1);
    expect(h.err[0]).toMatch(/^config\.yaml not found/);
    expect(h.err).toContain('Or run: npm run probe -- --config config.example.yaml <file.eml>');
  });

  it('reads config.yaml from the repo root by default', async () => {
    const h = harness([answers(ALL_LOW)], { repoRoot: join(FIXTURES, 'probe-root') });
    await expect(runProbe([PLAIN], h.deps)).resolves.toBe(0);
    expect(h.out[0]).toBe(PLAIN);
  });
});

describe('runProbe: the key', () => {
  const envFile = join(REPO_ROOT, 'custom.env');

  it('prefers JEV_API_KEY from the environment over .env files', async () => {
    const h = harness([answers(ALL_LOW)], {
      files: { [join(EMPTY_ROOT, '.env')]: 'JEV_API_KEY=from-dotenv\n' },
    });
    await probe(h, PLAIN);
    expect(new Headers(h.calls[0]?.init.headers).get('authorization')).toBe(
      `Bearer ${SENTINEL_KEY}`,
    );
  });

  it('reads the --env file', async () => {
    const h = harness([answers(ALL_LOW)], {
      env: {},
      files: { [envFile]: `# comment\nJEV_API_KEY="  ${SENTINEL_KEY}  "\n` },
    });
    await expect(probe(h, '--env', 'custom.env', PLAIN)).resolves.toBe(0);
    expect(new Headers(h.calls[0]?.init.headers).get('authorization')).toBe(
      `Bearer ${SENTINEL_KEY}`,
    );
  });

  it("falls back to the repo root's .env, then the main checkout's", async () => {
    const main = join(FIXTURES, 'main-checkout');
    const h = harness([answers(ALL_LOW)], {
      env: { JEV_API_KEY: '   ' },
      files: { [join(main, '.env')]: `JEV_API_KEY=${SENTINEL_KEY}\n` },
      gitCommonDir: join(main, '.git'),
    });
    await expect(probe(h, PLAIN)).resolves.toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('returns 1 with no key, lists the places checked, and never fetches', async () => {
    const h = harness([answers(ALL_LOW)], {
      env: { JEV_API_KEY: '' },
      files: { [envFile]: 'JEV_API_KEY=\nOTHER=x\n' },
      gitCommonDir: join(FIXTURES, 'main-checkout', '.git'),
    });
    await expect(probe(h, '--env', 'custom.env', PLAIN)).resolves.toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.err).toEqual([
      'No Jev API key found (JEV_API_KEY). Checked:',
      '  JEV_API_KEY in the environment',
      `  ${envFile}`,
      `  ${join(EMPTY_ROOT, '.env')}`,
      `  ${join(FIXTURES, 'main-checkout', '.env')}`,
    ]);
    expect(h.out).toEqual([]);
  });
});

describe('runProbe: the request', () => {
  it("POSTs buildRequest's body for the file's state, with the key and JSON headers", async () => {
    const h = harness([answers(ALL_LOW)]);
    await probe(h, ALTERNATIVE);
    const config = {
      model: 'jev-latest',
      rules: [
        { id: 'approval', question: 'Does this email ask the recipient to approve something?' },
        { id: 'bill', question: 'Is this email a bill or invoice?' },
        { id: 'newsletter', question: 'Is this email a newsletter the recipient subscribed to?' },
        { id: 'shipping', question: 'Is this email only a shipping or delivery notification?' },
      ],
    };
    const thread = emlToThread(readFileSync(join(REPO_ROOT, ALTERNATIVE)), 'x');
    const { state } = threadToState(
      thread,
      { plainTextMethod: 'basic', questions: config.rules.map((r) => r.question) },
      nodeDecodeUtf8,
    );
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.url).toBe(JEV_ENDPOINT);
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SENTINEL_KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(call?.init.body).toBe(JSON.stringify(buildRequest(config, state)));
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('runProbe: a 200', () => {
  it('reports each rule with its threshold, source, and whether it fires', async () => {
    const h = harness([
      // approval: default 0.8, exactly at it; bill: own 0.9, just below it.
      answers({ approval: 0.8, bill: 0.8999, newsletter: 0.95, shipping: 0.12 }),
    ]);
    await expect(probe(h, '--json', PLAIN)).resolves.toBe(0);
    expect(jsonLines(h)).toEqual([
      {
        file: PLAIN,
        ok: true,
        model: 'jev-1.13.0',
        requestId: jevFixture('200-four-rules').headers['x-typesafe-request-id'],
        inputTokens: 500,
        outputTokens: 60,
        truncated: null,
        rules: [
          {
            id: 'approval',
            probability: 0.8,
            threshold: 0.8,
            thresholdSource: 'default',
            fires: true,
          },
          {
            id: 'bill',
            probability: 0.8999,
            threshold: 0.9,
            thresholdSource: 'rule',
            fires: false,
          },
          {
            id: 'newsletter',
            probability: 0.95,
            threshold: 0.95,
            thresholdSource: 'rule',
            fires: true,
          },
          {
            id: 'shipping',
            probability: 0.12,
            threshold: 0.95,
            thresholdSource: 'rule',
            fires: false,
          },
        ],
      },
    ]);
  });

  it('prints a table in human mode', async () => {
    const h = harness([answers({ approval: 0.8, bill: 0.8999, newsletter: 0.95, shipping: 0.12 })]);
    await probe(h, PLAIN);
    const requestId = jevFixture('200-four-rules').headers['x-typesafe-request-id'] ?? '';
    expect(h.out).toEqual([
      PLAIN,
      `  model jev-1.13.0   request ${requestId}   input tokens 500   truncated: none`,
      '  rule         probability   threshold   fires',
      '  approval     0.8           0.80        yes',
      '  bill         0.8999        0.90        no',
      '  newsletter   0.95          0.95        yes',
      '  shipping     0.12          0.95        no',
      '',
      'Probed 1 file(s): 1 succeeded, 0 failed, 500 input tokens.',
    ]);
    expect(h.err).toEqual([]);
  });

  it('adds state only with --show-state', async () => {
    const without = harness([answers(ALL_LOW)]);
    await probe(without, '--json', PLAIN);
    expect(jsonLines(without)[0]).not.toHaveProperty('state');

    const withState = harness([answers(ALL_LOW)]);
    await probe(withState, '--json', '--show-state', PLAIN);
    const state = jsonLines(withState)[0]?.['state'];
    expect(state).toMatchObject([{ subject: 's29-01 plain utf8 7bit' }]);

    const human = harness([answers(ALL_LOW)]);
    await probe(human, '--show-state', PLAIN);
    expect(human.out).toContain('  state:');
    expect(human.out.join('\n')).toContain('"subject": "s29-01 plain utf8 7bit"');
  });
});

describe('runProbe: failures', () => {
  const tooLong = jevFixture('400-max-tokens-exceeded');
  const invalid = jevFixture('422-missing-state');
  const auth = jevFixture('401-wrong-key');
  const rateLimited: JevFixture = { status: 429, headers: {}, body: '{"detail":"slow down"}' };
  const serverError: JevFixture = { status: 500, headers: {}, body: 'Internal Server Error body' };
  const malformed: JevFixture = { status: 200, headers: {}, body: '{"model":"jev-1.13.0"}' };

  it.each([
    [
      'a 422',
      invalid,
      { class: 'invalid', status: 422, requestId: invalid.headers['x-typesafe-request-id'] },
    ],
    [
      'the 400 max_tokens_exceeded',
      tooLong,
      { class: 'invalid', status: 400, errorType: 'max_tokens_exceeded' },
    ],
    ['a 401', auth, { class: 'auth', status: 401 }],
    ['a 429', rateLimited, { class: 'retryable', status: 429 }],
    ['a 500', serverError, { class: 'exceptional', status: 500, reason: 'unexpected_status' }],
    ['a malformed 200', malformed, { class: 'exceptional', status: 200, reason: 'malformed_body' }],
  ])('reports %s by class and status, never its body', async (_name, reply, expected) => {
    const h = harness([reply]);
    await expect(probe(h, '--json', PLAIN)).resolves.toBe(1);
    expect(jsonLines(h)).toEqual([
      expect.objectContaining({ file: PLAIN, ok: false, stage: 'response', ...expected }),
    ]);
    const output = everything(h);
    expect(output).not.toContain(reply.body);
    for (const fragment of ['Field required', 'Cannot authenticate', 'slow down', 'Internal']) {
      expect(output).not.toContain(fragment);
    }
  });

  it('reports a rejected fetch as transport', async () => {
    const h = harness([new TypeError('fetch failed')]);
    await expect(probe(h, '--json', PLAIN)).resolves.toBe(1);
    expect(jsonLines(h)).toEqual([
      { file: PLAIN, ok: false, stage: 'request', class: 'transport', reason: 'fetch failed' },
    ]);
  });

  it('reports a timeout as transport', async () => {
    const h = harness([new DOMException('timed out', 'TimeoutError')]);
    await probe(h, '--json', PLAIN);
    expect(jsonLines(h)[0]).toMatchObject({ class: 'transport', reason: 'timeout' });
  });

  it('stops after a 401: later files are not_sent and never fetched', async () => {
    const h = harness([auth, answers(ALL_LOW)]);
    await expect(probe(h, '--json', PLAIN, ALTERNATIVE)).resolves.toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(jsonLines(h)[1]).toEqual({
      file: ALTERNATIVE,
      ok: false,
      stage: 'not_sent',
      reason: 'auth',
    });
  });

  it('prints a failure line in human mode', async () => {
    const h = harness([tooLong]);
    await probe(h, PLAIN);
    expect(h.out[1]).toBe(
      `  FAILED response: invalid 400 max_tokens_exceeded request ${tooLong.headers['x-typesafe-request-id'] ?? ''}`,
    );
  });

  it('goes on after a file that is not MIME or cannot be read', async () => {
    const h = harness([answers(ALL_LOW)]);
    await expect(probe(h, '--json', NOT_MIME, 'missing.eml', PLAIN)).resolves.toBe(1);
    expect(jsonLines(h)).toEqual([
      expect.objectContaining({ file: NOT_MIME, ok: false, stage: 'parse' }),
      { file: 'missing.eml', ok: false, stage: 'read', reason: 'ENOENT' },
      expect.objectContaining({ file: PLAIN, ok: true }),
    ]);
    expect(h.calls).toHaveLength(1);
  });
});

describe('runProbe: --json and the exit code', () => {
  it('prints only JSON lines on stdout, one per file, and the summary on stderr', async () => {
    const h = harness([answers(ALL_LOW), jevFixture('422-empty-questions')]);
    await expect(probe(h, '--json', PLAIN, ALTERNATIVE)).resolves.toBe(1);
    expect(h.out).toHaveLength(2);
    expect(jsonLines(h).map((line) => line['ok'])).toEqual([true, false]);
    expect(h.err[h.err.length - 1]).toBe(
      'Probed 2 file(s): 1 succeeded, 1 failed, 500 input tokens.',
    );
  });

  it('returns 0 only when every file succeeded', async () => {
    const h = harness([answers(ALL_LOW), answers(ALL_LOW)]);
    await expect(probe(h, PLAIN, ALTERNATIVE)).resolves.toBe(0);
  });

  it('never prints the key', async () => {
    const h = harness([answers(ALL_LOW), jevFixture('401-wrong-key')]);
    await probe(h, '--show-state', PLAIN, ALTERNATIVE, PLAIN);
    expect(everything(h)).not.toContain(SENTINEL_KEY);
  });
});
