#!/usr/bin/env node
// Spike #86: find real HTML-only mail in the test account and export it as .eml files for the
// local probe (`npm run probe`), to check the `basic` HTML-to-text converter.
//
// Plain Node ES module, zero dependencies. NOT Apps Script: `spikes/run.mjs push` uploads only
// `*.js`. It reads the test account only, through `session` from `spikes/run.mjs` (which
// refreshes an access token from SPIKE_REFRESH_TOKEN, checks its scopes, and refuses any account
// other than GMAIL_EMAIL). Read-only: it calls only `users.messages.list` and `users.messages.get`
// (plus `users.getProfile` in the account guard). No modify, send, insert, import or trash.
//
//   node spikes/86-sample-mail.mjs [--env <file>] --out <dir> [--query <q>] [--max <n>]
//
// --env    the .env holding the runner's credentials (default: the repo root's .env).
// --out    where to write, OUTSIDE the repo (or in a git-ignored folder): one `c-NNN.eml` per
//          HTML-only candidate, and `index.json` (Gmail IDs, category labels and a few header
//          flags) for choosing samples by hand. Never commit anything from it.
// --query  the Gmail search (default: the category query below, minus spam, trash and drafts).
// --max    how many messages to inspect at most (default 300).
//
// It never prints a token, an address, a subject or any content. Output: counts only, as one JSON
// object on stdout (through `scrub`); progress goes to stderr through `note`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Fail, google, loadEnv, note, runMain, scrub, session } from './run.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DEFAULT_QUERY =
  '(category:promotions OR category:updates OR category:purchases OR category:forums OR category:social) -in:spam -in:trash -in:drafts';
const CONCURRENCY = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A read-only GET, retried after a pause when Gmail's per-minute quota is exceeded. */
async function get(url, token) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await google('GET', url, { token });
    } catch (e) {
      if (!(e instanceof Fail) || !/HTTP (403|429)\b.*(Quota exceeded|rate limit)/i.test(e.message) || attempt >= 6) throw e;
      note(`Quota hit; waiting 30 s (attempt ${attempt}).`);
      await sleep(30_000);
    }
  }
}

function parseArgs(argv) {
  const out = { out: undefined, query: DEFAULT_QUERY, max: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--out') (out.out = resolve(v)), i++;
    else if (a === '--query') (out.query = v), i++;
    else if (a === '--max') (out.max = Number(v)), i++;
    else throw new Fail(`Unknown argument ${a}.`);
  }
  if (!out.out) throw new Fail('--out <dir> is required (outside the repo, or git-ignored).');
  if (!Number.isInteger(out.max) || out.max < 1) throw new Fail('--max must be a positive integer.');
  return out;
}

/**
 * Whether a part is excluded with its whole subtree (epic #10, decision 6): a non-empty
 * `filename`, a `body.attachmentId`, or a `message/rfc822` type.
 */
function excluded(part) {
  return Boolean(part.filename) || Boolean(part.body?.attachmentId) || String(part.mimeType).toLowerCase() === 'message/rfc822';
}

/** The MIME types of the body parts outside excluded parts. */
function bodyTypes(payload) {
  const types = new Set();
  const walk = (part) => {
    if (!part || excluded(part)) return;
    if (part.parts?.length) {
      for (const p of part.parts) walk(p);
      return;
    }
    types.add(String(part.mimeType).toLowerCase());
  };
  walk(payload);
  return types;
}

/** HTML-only: a `text/html` part and no `text/plain` part outside excluded parts. */
function isHtmlOnly(payload) {
  const types = bodyTypes(payload);
  return types.has('text/html') && !types.has('text/plain');
}

const header = (payload, name) =>
  (payload.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

async function listIds(token, query, max) {
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(500, max - ids.length)) });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await get(`${GMAIL}/messages?${params}`, token);
    for (const m of r.messages ?? []) ids.push(m.id);
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

async function inParallel(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

async function main(argv) {
  loadEnv(argv);
  const args = parseArgs(argv);
  const { token } = await session({ needScript: false });
  mkdirSync(args.out, { recursive: true });

  const ids = await listIds(token, args.query, args.max);
  note(`Inspecting ${ids.length} messages.`);

  const inspected = await inParallel(ids, CONCURRENCY, async (id) => {
    const m = await get(`${GMAIL}/messages/${id}?format=full`, token);
    return {
      id,
      threadId: m.threadId,
      htmlOnly: isHtmlOnly(m.payload ?? {}),
      categories: (m.labelIds ?? []).filter((l) => l.startsWith('CATEGORY_')),
      listUnsubscribe: header(m.payload ?? {}, 'List-Unsubscribe') !== undefined,
      listId: header(m.payload ?? {}, 'List-Id') !== undefined,
      sizeEstimate: m.sizeEstimate,
    };
  });

  const candidates = inspected.filter((c) => c.htmlOnly);
  await inParallel(candidates, CONCURRENCY, async (c, i) => {
    const m = await get(`${GMAIL}/messages/${c.id}?format=raw`, token);
    c.file = `c-${String(i + 1).padStart(3, '0')}.eml`;
    writeFileSync(join(args.out, c.file), Buffer.from(m.raw, 'base64url'), { mode: 0o600 });
  });
  writeFileSync(join(args.out, 'index.json'), `${JSON.stringify(candidates, null, 2)}\n`, { mode: 0o600 });

  const byCategory = {};
  for (const c of candidates) {
    const key = c.categories.join('+') || 'none';
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }
  const summary = {
    inspected: inspected.length,
    htmlOnly: candidates.length,
    htmlOnlyByCategory: byCategory,
    htmlOnlyWithListUnsubscribe: candidates.filter((c) => c.listUnsubscribe).length,
  };
  process.stdout.write(`${scrub(JSON.stringify(summary, null, 2))}\n`);
}

runMain(main);
