#!/usr/bin/env node
// One-time OAuth for the spike runner (#163, ADR-0016).
//
//   node spikes/auth.mjs [--env <file>] [--port <n>]
//
// Runs a loopback OAuth flow (Desktop client, PKCE) for the test account and
// saves SPIKE_REFRESH_TOKEN to .env (or --env <file>) without printing it.
// It requests exactly the spike manifest's oauthScopes plus script.projects
// (push, create) and script.deployments (deploy), refuses a token missing any
// of them or carrying https://mail.google.com/, and refuses any account other
// than GMAIL_EMAIL. Zero dependencies; runs on Node 22 and 24.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { accountGuard, authScopes, checkScopes, Fail, http, loadEnv, note, requireEnv, runMain, saveEnv } from './run.mjs';

const b64url = (buf) => buf.toString('base64url');

async function main(argv) {
  const envPath = loadEnv(argv);
  let port = 0;
  const p = argv.indexOf('--port');
  if (p >= 0) port = Number(argv[p + 1]);
  requireEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GMAIL_EMAIL');

  const scopes = authScopes();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const server = createServer();
  await new Promise((ok, fail) => server.once('error', fail).listen(port, '127.0.0.1', ok));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
  }).toString();

  note('Scopes requested:');
  for (const s of scopes) note(`  ${s}`);
  note('\n1. Open this URL in a browser, and sign in as the test account:\n');
  process.stderr.write(`${url}\n\n`);
  note('2. "Google hasn\'t verified this app" -> Advanced -> Go to <app> (unsafe).');
  note('3. Tick EVERY box, then Continue. Check that no line says "Read, compose, send, and permanently delete all your email".');
  note('\nWaiting for the browser to return here. If the page fails to load (for example under WSL),');
  note('copy the full address from the browser\'s address bar and paste it here, then press Enter.\n');

  const rl = createInterface({ input: process.stdin });
  let code;
  try {
    code = await new Promise((ok, fail) => {
      const handle = (u) => {
        if (u.searchParams.get('state') !== state) return fail(new Fail('OAuth state mismatch; start again.'));
        if (u.searchParams.get('error')) return fail(new Fail(`Consent failed: ${u.searchParams.get('error')}`));
        ok(u.searchParams.get('code'));
      };
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (!u.searchParams.has('code') && !u.searchParams.has('error')) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Received. Close this tab and check the terminal.');
        handle(u);
      });
      rl.on('line', (line) => {
        try {
          const u = new URL(line.trim());
          if (u.searchParams.has('code') || u.searchParams.has('error')) handle(u);
        } catch {
          note('That is not the redirect address; paste the whole URL starting with http://127.0.0.1');
        }
      });
    });
  } finally {
    rl.close();
    server.close();
  }

  const r = await http('POST', 'https://oauth2.googleapis.com/token', {
    form: {
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    },
  });
  if (r.status !== 200) throw new Fail(`Token exchange failed: HTTP ${r.status} ${r.data?.error ?? ''} ${r.data?.error_description ?? ''}`.trim());
  if (!r.data.refresh_token) throw new Fail('Google returned no refresh token. Revoke the app at https://myaccount.google.com/connections and run again.');

  const granted = String(r.data.scope ?? '').split(' ').filter(Boolean).sort();
  note('\nScopes granted:');
  for (const s of granted) note(`  ${s}`);
  checkScopes(granted, scopes);
  await accountGuard(r.data.access_token);

  saveEnv(envPath, 'SPIKE_REFRESH_TOKEN', r.data.refresh_token);
  note(`\nAccount matches GMAIL_EMAIL. Saved SPIKE_REFRESH_TOKEN to ${envPath}.`);
}

runMain(main);
