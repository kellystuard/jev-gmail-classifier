#!/usr/bin/env node
// Task #90 (E5): record real Jev response shapes as test fixtures, and measure latency.
//
// Plain Node 24 ES module, zero dependencies. NOT Apps Script: `spikes/run.mjs push` uploads
// only `*.js`. It makes live, billed Jev requests, so it only ever runs by hand (never in CI).
// Synthetic text only: no real mail, names or addresses.
//
//   node spikes/90-jev-fixtures.mjs [--env <file>] [--max <n>] [--latency] [--force <name>]
//                                   [--dry-run]
//
// --env      a .env file holding JEV_API_KEY (used only if JEV_API_KEY isn't set). Default: the
//            repo root's .env. From a git worktree, pass the main checkout's .env.
// --max      the cap on live requests in this run (default 60).
// --latency  also run the latency phase (5 single requests, a burst of 20 small ones, a burst
//            of 5 large ones). Off by default, so a plain rerun sends nothing.
// --force    send this fixture again and overwrite its file (the name is the part after the
//            status, e.g. `four-rules`). May be repeated.
// --dry-run  list what would be sent, and send nothing.
//
// A fixture whose file already exists (`test/fixtures/jev/<status>-<name>.json`, whatever the
// status) is never re-sent. Fixture file: {"status", "headers", "body"}, with only the headers
// that are safe to keep and `body` as the exact text received.
//
// The key and request headers are never printed, logged or written. Output: one JSON summary
// on stdout; one progress line per request on stderr.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'test', 'fixtures', 'jev');
const URL_ = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const PRICE_PER_MTOK = 0.042;

// ---------------------------------------------------------------------------------------------
// Arguments and key
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { env: resolve(HERE, '..', '.env'), max: 60, latency: false, force: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = resolve(argv[++i]);
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--force') out.force.push(argv[++i]);
    else if (a === '--latency') out.latency = true;
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Deterministic synthetic text
// ---------------------------------------------------------------------------------------------

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

// Common CJK: one token per character (#84).
const CJK = [...'東京駅で待ち合わせしましょう今週末は雨が降るかもしれません新しい図書館の本を読んで感想を書きます'];
function cjk(r, targetUnits) {
  let out = '';
  while (out.length < targetUnits) out += pick(r, CJK);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const message = (over) => ({
  from: 'Example Sender <news@example.com>',
  to: 'Reader <reader@example.org>',
  subject: 'Synthetic test message',
  date: 'Tue, 29 Sep 2026 10:00:00 +0000',
  body: 'Hello, this is a synthetic message.',
  ...over,
});
const noul = (instructions) => ({ type: 'noul', instructions });
const Q = 'Is this email a newsletter or marketing message?';

const FOUR_RULES = {
  approval: noul('Does this email ask the recipient to approve something?'),
  bill: noul('Is this email a bill or invoice?'),
  newsletter: noul('Is this email a newsletter the recipient subscribed to?'),
  shipping: noul('Is this email only a shipping or delivery notification?'),
};

const LONG_ID = 'a' + '-_'.repeat(15) + 'z'; // 32 characters, the schema's maximum
if (LONG_ID.length !== 32) throw new Error('bad long id');

const newsletter = [
  message({
    from: 'Example Weekly <weekly@example.com>',
    subject: 'Re: Your weekly garden digest',
    date: 'Tue, 29 Sep 2026 12:00:00 +0000',
    body: 'Thanks for subscribing. This week: five tips for autumn planting, and our new seed catalogue. To stop receiving this digest, follow the unsubscribe link below.',
  }),
  message({
    from: 'Example Weekly <weekly@example.com>',
    subject: 'Your weekly garden digest',
    listId: '<digest.weekly.example.com>',
    listUnsubscribe: '<https://weekly.example.com/unsubscribe>',
    precedence: 'bulk',
    body: 'Welcome to the digest. Seasonal planting advice and offers from Example Weekly.',
  }),
];

const oneMsg = [message({ body: 'Please confirm the meeting schedule for tomorrow morning.' })];
const oneQ = { q1: noul(Q) };

// Each fixture: name (the file is <status>-<name>.json), the body to send, and the key mode
// (undefined: the real key; a string: that fake key; null: no Authorization header).
// `group: 'invalid'`: candidates for a 422, tried in order; the rest are skipped once one got it.
const FIXTURES = [
  { name: 'four-rules', body: { model: MODEL, state: newsletter, questions: FOUR_RULES } },
  {
    name: 'edge-rule-ids',
    body: { model: MODEL, state: oneMsg, questions: { a: noul(Q), constructor: noul(Q), [LONG_ID]: noul(Q) } },
  },
  { name: 'wrong-key', key: 'jev-not-a-real-key-0000000000', body: { model: MODEL, state: oneMsg, questions: oneQ } },
  { name: 'no-key', key: null, body: { model: MODEL, state: oneMsg, questions: oneQ } },
  { name: 'question-type-yesno', group: 'invalid', body: { model: MODEL, state: oneMsg, questions: { q1: { type: 'yesno', instructions: Q } } } },
  { name: 'empty-questions', group: 'invalid', body: { model: MODEL, state: oneMsg, questions: {} } },
  { name: 'missing-state', group: 'invalid', body: { model: MODEL, questions: oneQ } },
  { name: 'state-wrong-type', group: 'invalid', body: { model: MODEL, state: 42, questions: oneQ } },
  { name: 'unknown-model', body: { model: 'jev-does-not-exist', state: oneMsg, questions: oneQ } },
  { name: 'unknown-model-typo', body: { model: 'jev-1.99.0', state: oneMsg, questions: oneQ } },
  {
    name: 'max-tokens-exceeded',
    body: { model: MODEL, state: [message({ body: cjk(rng(4), 34000) })], questions: oneQ },
  },
];

// ---------------------------------------------------------------------------------------------
// Sending and recording
// ---------------------------------------------------------------------------------------------

const KEEP = (n) =>
  n === 'content-type' ||
  n === 'x-typesafe-request-id' ||
  n === 'retry-after' ||
  n === 'retry-after-ms' ||
  n.startsWith('x-ratelimit-') ||
  n.startsWith('ratelimit-');

const args = parseArgs(process.argv.slice(2));
const key = readKey(args.env);
const seenHeaders = {}; // status -> Set of header names
let live = 0;
let totalInput = 0;
let unexpected401 = false;

function log(msg) {
  process.stderr.write(msg + '\n');
}

async function send(body, mode) {
  const headers = { 'Content-Type': 'application/json' };
  const token = mode === undefined ? key : mode;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const started = Date.now();
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const ms = Date.now() - started;
  live++;
  const names = [...res.headers.keys()].map((n) => n.toLowerCase());
  (seenHeaders[res.status] ??= new Set());
  names.forEach((n) => seenHeaders[res.status].add(n));
  const kept = {};
  for (const n of names.filter(KEEP).sort()) kept[n] = res.headers.get(n);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const inputTokens = parsed?.usage?.input_tokens;
  if (typeof inputTokens === 'number') totalInput += inputTokens;
  if (res.status === 401 && mode === undefined) unexpected401 = true;
  return { status: res.status, ms, headers: kept, body: text, model: parsed?.model, inputTokens };
}

const existing = (name) => readdirSync(OUT_DIR).filter((f) => f.endsWith(`-${name}.json`));
const write = (name, r) => {
  const file = resolve(OUT_DIR, `${r.status}-${name}.json`);
  writeFileSync(file, JSON.stringify({ status: r.status, headers: r.headers, body: r.body }, null, 2) + '\n');
};
const row = (name, r) => ({ name, status: r.status, ms: r.ms, inputTokens: r.inputTokens, model: r.model });

function stats(msList) {
  const s = [...msList].sort((a, b) => a - b);
  return { fastestMs: s[0], medianMs: s[Math.floor(s.length / 2)], slowestMs: s[s.length - 1] };
}

async function burst(label, bodies) {
  const t0 = Date.now();
  const rs = await Promise.all(bodies.map((b) => send(b)));
  const wallMs = Date.now() - t0;
  log(`${label}: wall ${wallMs} ms`);
  const statuses = {};
  for (const r of rs) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  // Only a response not already recorded (say a 429) becomes a fixture.
  for (const r of rs) {
    if (r.status !== 200 && !readdirSync(OUT_DIR).some((f) => f.startsWith(`${r.status}-`))) write(label, r);
  }
  return {
    requests: rs.length,
    wallMs,
    ...stats(rs.map((r) => r.ms)),
    statuses,
    inputTokens: rs.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary = { fixtures: [], skipped: [], latency: {} };
  const plan = [];
  for (const f of FIXTURES) {
    if (existing(f.name).length && !args.force.includes(f.name)) summary.skipped.push(f.name);
    else plan.push(f);
  }
  if (args.dryRun) {
    summary.wouldSend = plan.map((f) => f.name);
    if (args.latency) summary.wouldSend.push('latency: 5 single, burst of 20 small, burst of 5 large');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const needsKey = plan.some((f) => f.key === undefined) || args.latency;
  if (needsKey && !key) {
    console.error('JEV_API_KEY is not set (environment or --env file). Nothing sent.');
    process.exit(1);
  }

  let invalidFound = readdirSync(OUT_DIR).some((f) => /^422-/.test(f));
  for (const f of plan) {
    if (live >= args.max || unexpected401) break;
    if (f.group === 'invalid' && invalidFound && !args.force.includes(f.name)) {
      summary.skipped.push(`${f.name} (a 422 was already found)`);
      continue;
    }
    const r = await send(f.body, f.key);
    write(f.name, r);
    if (f.group === 'invalid' && r.status === 422) invalidFound = true;
    summary.fixtures.push(row(f.name, r));
    log(`${f.name}: ${r.status} ${r.ms} ms`);
  }

  if (args.latency && !unexpected401 && live + 30 <= args.max) {
    const singles = [];
    for (let i = 0; i < 5; i++) {
      const b = { model: MODEL, state: [message({ body: `Synthetic note number ${i}: lunch is at noon.` })], questions: oneQ };
      const r = await send(b);
      singles.push(r);
      log(`single ${i}: ${r.status} ${r.ms} ms`);
    }
    summary.latency.singles = singles.map((r) => row('single', r));
    summary.latency.singleStats = stats(singles.map((r) => r.ms));
    const small = Array.from({ length: 20 }, (_, i) => ({
      model: MODEL,
      state: [message({ body: `Synthetic burst note ${i}: please confirm the schedule.` })],
      questions: oneQ,
    }));
    summary.latency.burst20Small = await burst('burst-small', small);
    const large = Array.from({ length: 5 }, (_, i) => ({
      model: MODEL,
      state: [message({ body: prose(rng(100 + i), 176000) })],
      questions: oneQ,
    }));
    summary.latency.burst5Large = await burst('burst-large', large);
  }

  summary.liveRequests = live;
  summary.totalInputTokens = totalInput;
  summary.costUsd = Number(((totalInput / 1e6) * PRICE_PER_MTOK).toFixed(5));
  summary.headerNamesByStatus = Object.fromEntries(
    Object.entries(seenHeaders).map(([s, set]) => [s, [...set].sort()]),
  );
  if (unexpected401) summary.stopped = 'unexpected 401 with the real key';
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`failed: ${String(e && e.message)}`);
  process.exit(1);
});
