// Flag pass-through (spec/13 ## Flag pass-through): `--model` and
// `--dangerously-skip-permissions` on `chats spawn` (and the TUI launch) must
// translate into the host spawn RPC's SDK query() options — NOT be rejected
// as unknown options, and NOT be silently dropped. An unknown/unmappable flag
// must still error clearly.
//
// We back REST with a body-capturing http.Server and assert the POST /api/chats
// body. The compiled binary is run, not src.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(__dirname, '..', 'dist', 'index.js');

interface Captured {
  body: Record<string, unknown>;
}

function withBodyCapturingServer<T>(
  responder: (req: { url: string; method: string }) => { status: number; body: unknown },
  fn: (env: NodeJS.ProcessEnv, captured: Captured) => T | Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const captured: Captured = { body: {} };
    const server: Server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'POST' && raw) {
          try {
            captured.body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            /* leave empty */
          }
        }
        const out = responder({ url: req.url ?? '/', method: req.method ?? 'GET' });
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('no addr'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      const dir = mkdtempSync(join(tmpdir(), 'patch-cli-flag-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'credential.jwt'), 'aGVhZA.e30.c2ln\n', { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATCH_HOME: dir,
        PATCH_SERVER_URL: url,
      };
      delete env['PATCH_DAEMON_SOCKET'];
      delete env['PATCH_DAEMON_LOCAL_KEY'];
      Promise.resolve(fn(env, captured))
        .then((r) =>
          server.close(() => (rmSync(dir, { recursive: true, force: true }), resolve(r))),
        )
        .catch((e) =>
          server.close(() => (rmSync(dir, { recursive: true, force: true }), reject(e))),
        );
    });
  });
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('runCli: timed out'));
    }, 15_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

test('chats spawn --model: translates into spawn body model', async () => {
  await withBodyCapturingServer(
    (req) =>
      req.url === '/api/chats' && req.method === 'POST'
        ? { status: 202, body: { chatId: 'c1', status: 'pending' } }
        : { status: 404, body: { error: 'not found' } },
    async (env, captured) => {
      const r = await runCli(['chats', 'spawn', '/tmp/x', '--model', 'opus', '--json'], env);
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      assert.equal(captured.body['model'], 'opus');
    },
  );
});

test('chats spawn --dangerously-skip-permissions: translates into permissionMode', async () => {
  await withBodyCapturingServer(
    (req) =>
      req.url === '/api/chats' && req.method === 'POST'
        ? { status: 202, body: { chatId: 'c1', status: 'pending' } }
        : { status: 404, body: { error: 'not found' } },
    async (env, captured) => {
      const r = await runCli(
        ['chats', 'spawn', '/tmp/x', '--dangerously-skip-permissions', '--json'],
        env,
      );
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      assert.equal(captured.body['permissionMode'], 'bypassPermissions');
    },
  );
});

test('chats spawn --model + --dangerously-skip-permissions: both translate', async () => {
  await withBodyCapturingServer(
    (req) =>
      req.url === '/api/chats' && req.method === 'POST'
        ? { status: 202, body: { chatId: 'c1', status: 'pending' } }
        : { status: 404, body: { error: 'not found' } },
    async (env, captured) => {
      const r = await runCli(
        [
          'chats',
          'spawn',
          '/tmp/x',
          '--model',
          'sonnet',
          '--dangerously-skip-permissions',
          '--json',
        ],
        env,
      );
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      assert.equal(captured.body['model'], 'sonnet');
      assert.equal(captured.body['permissionMode'], 'bypassPermissions');
    },
  );
});

test('chats spawn: named flags are accepted (not rejected as unknown options)', async () => {
  await withBodyCapturingServer(
    () => ({ status: 202, body: { chatId: 'c1', status: 'pending' } }),
    async (env) => {
      const r = await runCli(
        ['chats', 'spawn', '/tmp/x', '--model', 'opus', '--dangerously-skip-permissions', '--json'],
        env,
      );
      assert.equal(r.code, 0, `should not error; stderr=${r.stderr}`);
      assert.doesNotMatch(r.stderr, /unknown option/);
    },
  );
});

test('chats spawn: an unknown/unmappable flag errors clearly', async () => {
  await withBodyCapturingServer(
    () => ({ status: 202, body: { chatId: 'c1' } }),
    async (env) => {
      const r = await runCli(['chats', 'spawn', '/tmp/x', '--no-such-flag', '--json'], env);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /unknown option/);
    },
  );
});

test('top-level --model / --dangerously-skip-permissions are accepted (not unknown options)', async () => {
  // The bare `patch` launch is the TUI; without a TTY it exits 2 with a helpful
  // line. The point here is that commander PARSES these flags rather than
  // rejecting them as unknown options before the TTY guard fires.
  await withBodyCapturingServer(
    () => ({ status: 200, body: {} }),
    async (env) => {
      const r = await runCli(['--model', 'opus', '--dangerously-skip-permissions'], env);
      assert.doesNotMatch(r.stderr, /unknown option/, `stderr=${r.stderr}`);
      // TTY guard (no PTY in test) → exit 2 with the scripted-use hint.
      assert.equal(r.code, 2);
      assert.match(r.stderr, /TTY required/);
    },
  );
});

test('top-level --resume is accepted (not an unknown option)', async () => {
  await withBodyCapturingServer(
    () => ({ status: 200, body: {} }),
    async (env) => {
      const r = await runCli(['--resume', 'c_01HXY'], env);
      assert.doesNotMatch(r.stderr, /unknown option/, `stderr=${r.stderr}`);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /TTY required/);
    },
  );
});
