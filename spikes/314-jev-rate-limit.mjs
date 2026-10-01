#!/usr/bin/env node
// Task #314 (E10): does a batch of 20 large Jev requests exceed Jev's token rate limit?
//
// Plain Node 24 ES module, zero dependencies. NOT Apps Script. It makes live, billed Jev
// requests, so it only ever runs by hand (never in CI). Synthetic text only: no real mail,
// names or addresses.
//
//   node spikes/314-jev-rate-limit.mjs [--env <file>] [--max <n>] [--out <file>] [--dry-run]
//
// --env      a .env file holding JEV_API_KEY (used only if JEV_API_KEY isn't set). Default: the
//            repo root's .env. From a git worktree, pass the main checkout's .env.
// --max      the cap on live requests in this run (default 200, the issue's cap).
// --out      write the raw per-request records (no key, no text) to this JSON file.
// --dry-run  print the plan and send nothing.
//
// Bursts (each is `Promise.all` of 20 fetches, as `UrlFetchApp.fetchAll` would send them), with a
// pause of at least 5 s after each: about 2,000 tokens each, about 8,000, about 30,000. A burst
// that got any 429 is sent again and followed through up to 3 attempts, re-sending only the 429s
// after `retryDelay`'s wait (`src/core/retry-delay.ts`: 500 ms x 2^(attempt-1) shortened by up to
// 25 % jitter; a longer `retry-after` header wins; over 60 s means "stop"), as the sender does.
// One calibration request first sizes the text (tokens per character of this prose).
//
// The key and request headers are never printed, logged or written.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const PRICE_PER_MTOK = 0.042;
const BURST = 20;
const PAUSE_MS = 6000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const SIZES = [2000, 8000, 30000];

function parseArgs(argv) {
  const out = { env: resolve(HERE, '..', '.env'), max: 200, out: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = resolve(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function readKey(envFile) {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?JEV_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return undefined;
}

// Deterministic synthetic prose (same generator as spikes/90-jev-fixtures.mjs).
function rng(seed) {
  let a = seed >>> 0; // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const WORDS = (
  'the of and to in is that for it as was with be by on not he this are or his from at which ' +
  'but have an they you were her she there been one all we their has would when if so no will ' +
  'more about can said them some could into only time new other then my also any these may ' +
  'meeting schedule invoice project garden weather morning letter customer delivery order ' +
  'account report question answer family holiday travel office library kitchen window river ' +
  'mountain village station bicycle coffee dinner friend neighbour summer autumn winter spring'
).split(' ');
function prose(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) {
    const n = 8 + Math.floor(r() * 14);
    const w = [];
    for (let i = 0; i < n; i++) w.push(pick(r, WORDS));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    out += w.join(' ') + pick(r, ['.', '.', '.', '?', '!']) + (r() < 0.2 ? '\n\n' : ' ');
  }
  return out.slice(0, targetUnits);
}

const noul = (instructions) => ({ type: 'noul', instructions });
const questions = {
  newsletter: noul('Is this email a newsletter the recipient subscribed to?'),
  bill: noul('Is this email a bill or invoice?'),
};
const body = (seed, chars) => ({
  model: MODEL,
  state: [
    {
      from: 'Example Sender <news@example.com>',
      to: 'Reader <reader@example.org>',
      subject: 'Synthetic rate limit test',
      date: 'Tue, 29 Sep 2026 10:00:00 +0000',
      body: prose(rng(seed), chars),
    },
  ],
  questions,
});

const args = parseArgs(process.argv.slice(2));
const key = readKey(args.env);
let live = 0;
let totalInput = 0;
const log = (m) => process.stderr.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const records = [];

async function send(payload, ctx) {
  live++;
  const started = Date.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const rec = {
    ...ctx,
    status: res.status,
    ms: Date.now() - started,
    inputTokens: parsed?.usage?.input_tokens,
    retryAfter: res.headers.get('retry-after') ?? undefined,
    retryAfterMs: res.headers.get('retry-after-ms') ?? undefined,
    rateHeaders: Object.fromEntries(
      [...res.headers.entries()].filter(([n]) => n.startsWith('x-ratelimit-') || n.startsWith('ratelimit-')),
    ),
    errorType: parsed?.error?.error_type ?? parsed?.error_type ?? parsed?.error?.type,
    errorBody: res.status === 200 ? undefined : text.slice(0, 600),
  };
  if (typeof rec.inputTokens === 'number') totalInput += rec.inputTokens;
  records.push(rec);
  return rec;
}

// retryDelay (src/core/retry-delay.ts), without a RandomPort.
function retryDelay(attempt, retryAfterMs) {
  if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) return undefined;
  const backoff = Math.min(5000, 500 * 2 ** (attempt - 1)) * (1 - 0.25 * Math.random());
  return Math.ceil(Math.max(retryAfterMs ?? 0, backoff));
}
const headerMs = (r) =>
  r.retryAfterMs !== undefined && !Number.isNaN(Number(r.retryAfterMs))
    ? Number(r.retryAfterMs)
    : r.retryAfter !== undefined && !Number.isNaN(Number(r.retryAfter))
      ? Number(r.retryAfter) * 1000
      : undefined;

// One burst: all at once; with `rounds`, re-send the 429s after the wait, up to 3 attempts.
async function burst(label, size, bodies, rounds) {
  const result = { label, size, rounds, attempts: [] };
  let pending = bodies.map((b, i) => ({ b, i }));
  for (let attempt = 1; attempt <= (rounds ? MAX_ATTEMPTS : 1) && pending.length; attempt++) {
    if (live + pending.length > args.max) {
      result.stoppedByCap = true;
      break;
    }
    const t0 = Date.now();
    const rs = await Promise.all(pending.map((p) => send(p.b, { label, rounds, attempt, i: p.i })));
    const statuses = {};
    for (const r of rs) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    const ra = rs.filter((r) => r.status === 429).map(headerMs);
    result.attempts.push({
      attempt,
      sent: rs.length,
      wallMs: Date.now() - t0,
      statuses,
      inputTokens: rs.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
      retryAfterMs: [...new Set(ra)],
    });
    log(`${label} (${rounds ? 'rounds' : 'single'}) attempt ${attempt}: ${JSON.stringify(statuses)}`);
    const failed = rs.map((r, k) => ({ r, p: pending[k] })).filter((x) => x.r.status === 429);
    if (!failed.length) {
      pending = [];
      break;
    }
    pending = failed.map((x) => x.p);
    if (!rounds || attempt === MAX_ATTEMPTS) break;
    const waits = failed.map((x) => retryDelay(attempt, headerMs(x.r)));
    if (waits.some((w) => w === undefined)) break;
    const wait = Math.max(...waits);
    result.attempts.at(-1).waitedMsBeforeNext = wait;
    await sleep(wait);
  }
  result.stillFailing = pending.length;
  result.recovered = rounds ? pending.length === 0 : undefined;
  return result;
}

async function main() {
  const plan = {
    calibration: '1 request of 20,000 characters of prose, to get tokens per character',
    bursts: SIZES.map((s) => `${BURST} requests of about ${s} tokens, then (if any 429) the same burst with up to 3 attempts`),
    pauseMs: PAUSE_MS,
    maxLiveRequests: args.max,
  };
  if (args.dryRun) {
    console.log(JSON.stringify({ plan }, null, 2));
    return;
  }
  if (!key) {
    console.error('JEV_API_KEY is not set (environment or --env file). Nothing sent.');
    process.exit(1);
  }
  const cal = await send(body(1, 20000), { label: 'calibration' });
  log(`calibration: ${cal.status} ${cal.inputTokens ?? '-'} tokens`);
  if (!cal.inputTokens) {
    console.error('calibration failed; stopping');
    console.log(JSON.stringify({ calibration: { status: cal.status, errorBody: cal.errorBody } }, null, 2));
    process.exit(1);
  }
  const perChar = cal.inputTokens / 20000; // includes a fixed overhead, small next to 20,000 chars
  const results = [];
  for (const size of SIZES) {
    const chars = Math.floor(size / perChar);
    const bodies = () => Array.from({ length: BURST }, (_, i) => body(1000 * size + i, chars));
    await sleep(PAUSE_MS);
    const first = await burst(`${size}-tokens`, size, bodies(), false);
    first.chars = chars;
    results.push(first);
    if (first.attempts[0]?.statuses[429]) {
      await sleep(PAUSE_MS);
      const again = await burst(`${size}-tokens`, size, bodies(), true);
      again.chars = chars;
      results.push(again);
    }
  }
  const summary = {
    calibration: { status: cal.status, inputTokens: cal.inputTokens, charsPerToken: Number((1 / perChar).toFixed(2)) },
    bursts: results,
    liveRequests: live,
    totalInputTokens: totalInput,
    costUsd: Number(((totalInput / 1e6) * PRICE_PER_MTOK).toFixed(4)),
    headerNames: [...new Set(records.flatMap((r) => Object.keys(r.rateHeaders)))],
    sample429: records.find((r) => r.status === 429)?.errorBody,
  };
  if (args.out) writeFileSync(args.out, JSON.stringify({ summary, records }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`failed: ${String(e && e.message)}`);
  process.exit(1);
});
