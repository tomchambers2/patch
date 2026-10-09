#!/usr/bin/env node
// One-time helper: complete Google Calendar OAuth via the loopback flow using a
// Desktop ("installed") OAuth client, and write the tokens to
// <dataDir>/google-oauth.json in the exact shape patch's
// defaultCalendarClientFactory expects (access_token / refresh_token / scope /
// token_type / expiry_date).
//
// Why this exists: patch's configured GOOGLE_OAUTH_CLIENT_ID is a *Web* client
// whose redirect URI is not registered in the Cloud Console, so its consent
// flow returns redirect_uri_mismatch and cannot complete unattended. A Desktop
// client supports the loopback redirect (http://localhost:<any-port>) with no
// pre-registration, so we can complete consent locally. The resulting
// access/refresh tokens are bearer credentials that patch's googleapis client
// uses directly to call the REAL Calendar API (events.watch / events.list).
//
// Usage:
//   node scripts/gcal-oauth-loopback.mjs \
//     --client <desktop-credentials.json> \
//     --data-dir <patch-data-dir> \
//     [--scope https://www.googleapis.com/auth/calendar]
//
// It prints a consent URL; open it (the account owner approves once), Google
// redirects back to the loopback server, and tokens are written. Re-running is
// safe.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const clientPath = arg('client', '/Users/tomchambers/.gmail_credentials/credentials.json');
const dataDir = arg('data-dir');
const scope = arg('scope', 'https://www.googleapis.com/auth/calendar');
if (!dataDir) {
  console.error('ERROR: --data-dir <patch-data-dir> is required');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(clientPath, 'utf8'));
const c = raw.installed ?? raw.web ?? raw;
const clientId = c.client_id;
const clientSecret = c.client_secret;
if (!clientId || !clientSecret) {
  console.error('ERROR: client file has no client_id/client_secret');
  process.exit(2);
}

const port = Number(arg('port', '47919'));
const redirectUri = `http://localhost:${port}`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\n=== Open this URL and approve consent ===\n');
console.log(authUrl.toString());
console.log('\n=== Waiting for the redirect on', redirectUri, '===\n');

const server = createServer(async (req, res) => {
  const u = new URL(req.url, redirectUri);
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err) {
    res.end(`OAuth error: ${err}`);
    console.error('OAuth error:', err);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.end('waiting…');
    return;
  }
  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tok));
    const out = {
      access_token: tok.access_token,
      ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
      scope: tok.scope,
      token_type: tok.token_type ?? 'Bearer',
      expiry_date: Date.now() + (tok.expires_in ?? 3600) * 1000,
    };
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'google-oauth.json'), JSON.stringify(out, null, 2), 'utf8');
    res.end('Calendar connected. You can close this window.');
    console.log('WROTE', join(dataDir, 'google-oauth.json'), 'scope:', tok.scope);
    server.close();
    process.exit(0);
  } catch (e) {
    res.end('token exchange failed');
    console.error('token exchange failed:', e.message);
    server.close();
    process.exit(1);
  }
});
server.listen(port, '127.0.0.1');
