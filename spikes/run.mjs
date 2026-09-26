#!/usr/bin/env node
// Spike runner (#163, ADR-0016): pushes spikes to the shared spike Apps Script
// project and runs spike functions through the Apps Script API.
//
//   node spikes/run.mjs [--env <file>] <command> [...]
//
//   check                     Account guard, granted scopes, remote files and deployments.
//   setup [title]             Create the spike project if SPIKE_SCRIPT_ID is unset, save its ID, then push.
//   push                      Merge spikes/*.js and spikes/appsscript.json into the project.
//   run <function> [json]     Run a function (devMode) and print its return value as JSON.
//   deploy                    Create an API-executable deployment if none exists.
//
// Zero dependencies; runs on Node 22 and 24. Credentials come from the
// environment, falling back to the repo's .env (or --env <file>). It never
// prints tokens, secrets, or the test account's address. See spikes/README.md,
// "Running spikes automatically".

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const SPIKES_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SPIKES_DIR, '..');
const MANIFEST_PATH = join(SPIKES_DIR, 'appsscript.json');
const SCRIPT_API = 'https://script.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const RUN_TIMEOUT_MS = 7 * 60 * 1000; // Apps Script stops at 6 minutes.

export const FULL_GMAIL_SCOPE = 'https://mail.google.com/';
const MANIFEST_SCOPES_FALLBACK = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.send_mail',
];
const PROJECTS_SCOPE = 'https://www.googleapis.com/auth/script.projects';
const DEPLOYMENTS_SCOPE = 'https://www.googleapis.com/auth/script.deployments';

/** An expected failure: printed as a message (no stack), with an exit code. */
export class Fail extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------- env and output

/**
 * Loads `--env <file>` (removed from argv) or the repo's `.env`. Variables
 * already set to a non-empty value in the environment win. Returns the path.
 */
export function loadEnv(argv) {
  let envPath = join(REPO_ROOT, '.env');
  const i = argv.indexOf('--env');
  if (i >= 0) {
    if (!argv[i + 1]) throw new Fail('--env needs a file path.');
    envPath = resolve(argv[i + 1]);
    argv.splice(i, 2);
    if (!existsSync(envPath)) throw new Fail(`--env file not found: ${envPath}`);
  }
  if (existsSync(envPath)) {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, 'utf8')))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  return envPath;
}

/** Sets KEY=value in an env file, replacing an existing line or appending one. */
export function saveEnv(envPath, key, value) {
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(envPath, next, { mode: 0o600 });
  process.env[key] = value;
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Fail(`Missing ${missing.join(', ')}. Set them in the environment or in .env (see .env.example and spikes/README.md).`);
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes the test account's address (and plus-addresses) and any secret from text. */
export function scrub(text) {
  let out = String(text);
  for (const key of ['SPIKE_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_SECRET', 'JEV_API_KEY']) {
    const v = process.env[key];
    if (v && v.length >= 8) out = out.split(v).join('<redacted>');
  }
  const email = (process.env.GMAIL_EMAIL ?? '').trim();
  const at = email.lastIndexOf('@');
  if (at > 0) {
    const re = new RegExp(`${escapeRegExp(email.slice(0, at))}(\\+[\\w.-]*)?@${escapeRegExp(email.slice(at + 1))}`, 'gi');
    out = out.replace(re, (_, plus) => `<test-account>${plus ?? ''}`);
  }
  return out;
}

const print = (value) => process.stdout.write(`${scrub(JSON.stringify(value, null, 2))}\n`);
export const note = (text) => process.stderr.write(`${scrub(text)}\n`);

// ---------------------------------------------------------------- HTTP

/**
 * Minimal HTTPS client. `node:https` rather than `fetch`, because fetch's
 * default 300 s headers timeout would cut off a spike that runs close to
 * Apps Script's 6-minute limit.
 */
export function http(method, url, { token, form, json, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = { Accept: 'application/json' };
    let body;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = request(new URL(url), { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        resolvePromise({ status: res.statusCode, data, bytes: buf.length });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${new URL(url).pathname} timed out after ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function hintFor(status, message) {
  if (/Apps Script API/i.test(message) && /not enabled|has not been used|disabled/i.test(message)) {
    return ' Hint: turn on "Google Apps Script API" at https://script.google.com/home/usersettings (signed in as the test account), and enable the Apps Script API in the Cloud project.';
  }
  if (/insufficient.*scope/i.test(message)) {
    return ' Hint: the token lacks a scope. Re-run `node spikes/auth.mjs` and tick every box.';
  }
  if (status === 404) return ' Hint: check SPIKE_SCRIPT_ID, and that the test account owns the project.';
  return '';
}

/** Calls a Google API and returns its JSON body, or throws Fail on an HTTP error. */
export async function google(method, url, opts) {
  const r = await http(method, url, opts);
  if (r.status >= 200 && r.status < 300) return r.data ?? {};
  const e = r.data && typeof r.data === 'object' ? r.data.error : undefined;
  const message = (typeof e === 'object' ? e.message : r.data?.error_description ?? e) ?? String(r.data).slice(0, 300);
  const status = typeof e === 'object' && e.status ? ` ${e.status}` : '';
  throw new Fail(`${method} ${new URL(url).pathname} failed: HTTP ${r.status}${status}: ${message}.${hintFor(r.status, String(message))}`);
}

// ---------------------------------------------------------------- auth and guard

function manifestScopes() {
  if (!existsSync(MANIFEST_PATH)) return MANIFEST_SCOPES_FALLBACK;
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).oauthScopes ?? MANIFEST_SCOPES_FALLBACK;
}

/** Scopes minted by auth.mjs: the manifest's, plus what the runner itself calls. */
export function authScopes() {
  return [...new Set([...manifestScopes(), PROJECTS_SCOPE, DEPLOYMENTS_SCOPE])];
}

/** Throws unless every needed scope was granted and the full Gmail scope was not. */
export function checkScopes(granted, needed = authScopes()) {
  if (granted.includes(FULL_GMAIL_SCOPE)) {
    throw new Fail(`The token carries ${FULL_GMAIL_SCOPE} (permanent deletion). Revoke it and mint a new one with \`node spikes/auth.mjs\`.`);
  }
  const missing = needed.filter((s) => !granted.includes(s));
  if (missing.length) {
    throw new Fail(`The token lacks ${missing.join(', ')}. Re-run \`node spikes/auth.mjs\` and tick every box on the consent screen.`);
  }
}

/** Refuses unless the token's Gmail account is GMAIL_EMAIL. Never prints either address. */
export async function accountGuard(token) {
  requireEnv('GMAIL_EMAIL');
  const profile = await google('GET', PROFILE_URL, { token });
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  if (!profile.emailAddress || norm(profile.emailAddress) !== norm(process.env.GMAIL_EMAIL)) {
    throw new Fail('Refusing: the token belongs to a different Google account than GMAIL_EMAIL. Nothing was pushed or run.');
  }
}

/** Refreshes an access token, checks its scopes, and applies the account guard. */
async function session({ needScript = true } = {}) {
  requireEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SPIKE_REFRESH_TOKEN', 'GMAIL_EMAIL');
  if (needScript) requireEnv('SPIKE_SCRIPT_ID');
  const r = await http('POST', TOKEN_URL, {
    form: {
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.SPIKE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    },
  });
  if (r.status !== 200) {
    if (r.data?.error === 'invalid_grant') {
      throw new Fail('SPIKE_REFRESH_TOKEN was rejected (invalid_grant): it was revoked or has expired. Mint a new one with `node spikes/auth.mjs` (spikes/README.md).');
    }
    throw new Fail(`Token refresh failed: HTTP ${r.status} ${r.data?.error ?? ''} ${r.data?.error_description ?? ''}`.trim());
  }
  const token = r.data.access_token;
  const scopes = String(r.data.scope ?? '').split(' ').filter(Boolean);
  checkScopes(scopes, [...manifestScopes(), PROJECTS_SCOPE]);
  await accountGuard(token);
  return { token, scopes, scriptId: process.env.SPIKE_SCRIPT_ID };
}

// ---------------------------------------------------------------- project content

async function getContent(s) {
  const d = await google('GET', `${SCRIPT_API}/projects/${s.scriptId}/content`, { token: s.token });
  return (d.files ?? []).map(({ name, type, source }) => ({ name, type, source }));
}

async function putContent(s, files) {
  await google('PUT', `${SCRIPT_API}/projects/${s.scriptId}/content`, { token: s.token, json: { scriptId: s.scriptId, files } });
}

export function localFiles() {
  if (!existsSync(MANIFEST_PATH)) throw new Fail('spikes/appsscript.json is missing.');
  const files = [{ name: 'appsscript', type: 'JSON', source: readFileSync(MANIFEST_PATH, 'utf8') }];
  for (const f of readdirSync(SPIKES_DIR).sort()) {
    if (f.endsWith('.js')) files.push({ name: f.slice(0, -3), type: 'SERVER_JS', source: readFileSync(join(SPIKES_DIR, f), 'utf8') });
  }
  return files;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameFile(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'JSON') {
    try {
      return canonicalJson(JSON.parse(a.source)) === canonicalJson(JSON.parse(b.source));
    } catch {
      return false;
    }
  }
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trimEnd();
  return norm(a.source) === norm(b.source);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Merges this checkout's spike files into the shared project: files with the
 * same name are replaced, remote files this checkout lacks are kept (other
 * branches' spikes). `projects.updateContent` replaces the whole project, so
 * the read-merge-write window is kept short, and the result is re-read to
 * confirm this checkout's files survived a concurrent push. On a loss, retry.
 */
export async function push(s, io = { getContent, putContent, sleep, mine: localFiles() }) {
  const { mine } = io;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remote = await io.getContent(s);
    const remoteByName = new Map(remote.map((f) => [f.name, f]));
    const mineByName = new Map(mine.map((f) => [f.name, f]));
    const added = mine.filter((f) => !remoteByName.has(f.name)).map((f) => f.name);
    const updated = mine.filter((f) => remoteByName.has(f.name) && !sameFile(remoteByName.get(f.name), f)).map((f) => f.name);
    const kept = remote.filter((f) => !mineByName.has(f.name)).map((f) => f.name);
    if (added.length || updated.length) {
      const merged = [...remote.map((f) => mineByName.get(f.name) ?? f), ...mine.filter((f) => !remoteByName.has(f.name))];
      await io.putContent(s, merged);
    }
    const after = new Map((await io.getContent(s)).map((f) => [f.name, f]));
    const lost = mine.filter((f) => f.type !== 'JSON' && !(after.has(f.name) && sameFile(after.get(f.name), f))).map((f) => f.name);
    if (!lost.length) {
      const manifest = mine.find((f) => f.type === 'JSON');
      if (!after.has('appsscript') || !sameFile(after.get('appsscript'), manifest)) {
        note('Warning: the project manifest differs from spikes/appsscript.json (another branch may have pushed a different one).');
      }
      return { added, updated, unchanged: mine.length - added.length - updated.length, kept, attempts: attempt };
    }
    if (attempt === maxAttempts) {
      throw new Fail(`Push could not keep ${lost.join(', ')} in the project after ${maxAttempts} attempts (concurrent pushes?). Try again.`);
    }
    note(`Concurrent push detected (${lost.join(', ')} missing); retrying.`);
    await io.sleep(1000 + Math.random() * 3000);
  }
}

// ---------------------------------------------------------------- commands

function parseArgs(json) {
  if (json === undefined || json.trim() === '') return [];
  let value;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new Fail(`Arguments are not valid JSON: ${e.message}`);
  }
  // An array is the parameter list; anything else is a single parameter.
  return Array.isArray(value) ? value : [value];
}

async function run(s, fn, argsJson) {
  if (!fn || !/^[A-Za-z_$][\w$]*$/.test(fn)) throw new Fail(`Not a function name: ${JSON.stringify(fn ?? '')}`);
  const parameters = parseArgs(argsJson);
  const defined = new RegExp(`(^|[^\\w$.])function\\s+${escapeRegExp(fn)}\\s*\\(`, 'm');
  const files = await getContent(s);
  if (!files.some((f) => f.type === 'SERVER_JS' && defined.test(f.source))) {
    throw new Fail(`Function ${fn} is not in the spike project (${files.length} files). Push a checkout that defines it first: node spikes/run.mjs push`);
  }
  const started = Date.now();
  const r = await http('POST', `${SCRIPT_API}/scripts/${s.scriptId}:run`, {
    token: s.token,
    json: { function: fn, parameters, devMode: true },
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 200) {
    const e = r.data?.error ?? {};
    const hint = r.status === 404 ? ' Hint: if the project has no API-executable deployment, run `node spikes/run.mjs deploy` once.' : hintFor(r.status, String(e.message ?? ''));
    throw new Fail(`scripts.run failed: HTTP ${r.status} ${e.status ?? ''}: ${e.message ?? JSON.stringify(r.data)}.${hint}`);
  }
  // Script errors come back inside an HTTP 200 response.
  if (r.data?.error) {
    const detail = (r.data.error.details ?? []).find((d) => d.errorMessage) ?? {};
    note(JSON.stringify({
      function: fn,
      errorType: detail.errorType ?? r.data.error.message,
      errorMessage: detail.errorMessage ?? r.data.error.message,
      stack: (detail.scriptStackTraceElements ?? []).map((el) => `${el.function}:${el.lineNumber}`),
      seconds: Number(seconds),
    }, null, 2));
    throw new Fail(`${fn} threw a script error.`, 1);
  }
  print(r.data?.response?.result ?? null);
  note(`(${fn} ran in ${seconds} s; response ${r.bytes} bytes)`);
}

async function deploy(s) {
  checkScopes(s.scopes, [DEPLOYMENTS_SCOPE]);
  const base = `${SCRIPT_API}/projects/${s.scriptId}`;
  const list = await google('GET', `${base}/deployments`, { token: s.token });
  const existing = (list.deployments ?? []).find(
    (d) => d.deploymentConfig?.versionNumber && (d.entryPoints ?? []).some((e) => e.entryPointType === 'EXECUTION_API'),
  );
  if (existing) return { deploymentId: existing.deploymentId, versionNumber: existing.deploymentConfig.versionNumber, created: false };
  const version = await google('POST', `${base}/versions`, { token: s.token, json: { description: 'spike runner (#163)' } });
  const dep = await google('POST', `${base}/deployments`, {
    token: s.token,
    json: { versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: 'API executable for spikes/run.mjs (#163)' },
  });
  return { deploymentId: dep.deploymentId, versionNumber: version.versionNumber, created: true };
}

async function check(s) {
  const files = await getContent(s);
  const result = {
    account: 'matches GMAIL_EMAIL',
    scopes: s.scopes,
    files: files.map((f) => `${f.name} (${f.type})`),
  };
  if (s.scopes.includes(DEPLOYMENTS_SCOPE)) {
    const list = await google('GET', `${SCRIPT_API}/projects/${s.scriptId}/deployments`, { token: s.token });
    result.deployments = (list.deployments ?? []).map((d) => ({
      version: d.deploymentConfig?.versionNumber ?? 'HEAD',
      entryPoints: (d.entryPoints ?? []).map((e) => e.entryPointType),
    }));
  }
  return result;
}

async function setup(envPath, title = 'jev-spikes') {
  const s = await session({ needScript: false });
  if (!s.scriptId) {
    const created = await google('POST', `${SCRIPT_API}/projects`, { token: s.token, json: { title } });
    s.scriptId = created.scriptId;
    saveEnv(envPath, 'SPIKE_SCRIPT_ID', s.scriptId);
    note(`Created Apps Script project "${title}" and saved SPIKE_SCRIPT_ID to ${envPath}.`);
  } else {
    note('SPIKE_SCRIPT_ID is already set; using that project.');
  }
  const pushed = await push(s);
  note(`Next: open https://script.google.com/home/projects/${s.scriptId}/settings as the test account, and under "Google Cloud Platform (GCP) Project" change it to your Cloud project's number.`);
  return pushed;
}

const USAGE = `Usage: node spikes/run.mjs [--env <file>] <command>
  check                  account guard, granted scopes, remote files, deployments
  setup [title]          create the spike project if SPIKE_SCRIPT_ID is unset, then push
  push                   merge spikes/*.js and spikes/appsscript.json into the project
  run <function> [json]  run a function; json is the parameter array (or one value)
  deploy                 create an API-executable deployment if none exists`;

async function main(argv) {
  const envPath = loadEnv(argv);
  const [command, ...rest] = argv;
  switch (command) {
    case 'check':
      return print(await check(await session()));
    case 'setup':
      return print(await setup(envPath, rest[0]));
    case 'push':
      return print(await push(await session()));
    case 'run':
      return run(await session(), rest[0], rest[1]);
    case 'deploy':
      return print(await deploy(await session()));
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

export function runMain(fn) {
  fn(process.argv.slice(2)).catch((e) => {
    note(e instanceof Fail ? e.message : e?.stack ?? String(e));
    process.exitCode = e instanceof Fail ? e.exitCode : 2;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runMain(main);
