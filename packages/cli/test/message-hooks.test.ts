// `patch message-hooks *` — REST CRUD against the server (spec/20-hooks.md,
// spec/17-cli.md). Same real-http-server harness as commands.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(__dirname, '..', 'dist', 'index.js');

function withSetup<T>(
  routes: (req: { url: string; method: string; body: unknown }) => {
    status: number;
    body: unknown;
  },
  fn: (env: NodeJS.ProcessEnv) => T | Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
        const out = routes({ url: req.url ?? '/', method: req.method ?? 'GET', body });
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
      const dir = mkdtempSync(join(tmpdir(), 'patch-cli-msghooks-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'credential.jwt'), 'aGVhZA.e30.c2ln\n', { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATCH_HOME: dir,
        PATCH_SERVER_URL: `http://127.0.0.1:${addr.port}`,
      };
      delete env['PATCH_DAEMON_SOCKET'];
      delete env['PATCH_DAEMON_LOCAL_KEY'];
      Promise.resolve(fn(env))
        .then((r) => {
          server.close(() => {
            rmSync(dir, { recursive: true, force: true });
            resolve(r);
          });
        })
        .catch((e) => {
          server.close(() => {
            rmSync(dir, { recursive: true, force: true });
            reject(e);
          });
        });
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
      reject(new Error('runCli: timed out after 15s'));
    }, 15_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

test('message-hooks list --json: REST happy path', async () => {
  await withSetup(
    (req) => {
      if (req.url === '/api/hooks' && req.method === 'GET') {
        return {
          status: 200,
          body: {
            hooks: [
              {
                id: 'hook_1',
                name: 'no secrets',
                enabled: true,
                when: 'user_message',
                kind: 'script',
              },
            ],
          },
        };
      }
      return { status: 404, body: { error: 'not found' } };
    },
    async (env) => {
      const r = await runCli(['message-hooks', 'list', '--json'], env);
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout) as { hooks: Array<{ id: string }> };
      assert.equal(parsed.hooks[0]?.id, 'hook_1');
    },
  );
});

test('message-hooks list (no --json): human output names enabled state', async () => {
  await withSetup(
    () => ({
      status: 200,
      body: {
        hooks: [
          {
            id: 'hook_1',
            name: 'no secrets',
            enabled: false,
            when: 'user_message',
            kind: 'prompt',
          },
        ],
      },
    }),
    async (env) => {
      const r = await runCli(['message-hooks', 'list'], env);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /hook_1 {2}no secrets {2}\[disabled\] {2}user_message\/prompt/);
    },
  );
});

test('message-hooks create <file>: posts the file body to /api/hooks', async () => {
  const posted: unknown[] = [];
  await withSetup(
    (req) => {
      if (req.url === '/api/hooks' && req.method === 'POST') {
        posted.push(req.body);
        return { status: 201, body: { id: 'hook_new', ...(req.body as object) } };
      }
      return { status: 404, body: { error: 'not found' } };
    },
    async (env) => {
      const dir = mkdtempSync(join(tmpdir(), 'patch-cli-msghooks-file-'));
      const file = join(dir, 'hook.json');
      writeFileSync(
        file,
        JSON.stringify({
          name: 'no secrets',
          when: 'user_message',
          kind: 'script',
          script: { command: 'exit 0' },
        }),
      );
      const r = await runCli(['message-hooks', 'create', file, '--json'], env);
      rmSync(dir, { recursive: true, force: true });
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      assert.equal(posted.length, 1);
      assert.equal((posted[0] as { name: string }).name, 'no secrets');
      const parsed = JSON.parse(r.stdout) as { id: string };
      assert.equal(parsed.id, 'hook_new');
    },
  );
});

test('message-hooks enable/disable hit the right endpoint', async () => {
  const hits: string[] = [];
  await withSetup(
    (req) => {
      hits.push(`${req.method} ${req.url}`);
      return { status: 200, body: { id: 'hook_1', enabled: req.url?.endsWith('/enable') } };
    },
    async (env) => {
      const en = await runCli(['message-hooks', 'enable', 'hook_1'], env);
      assert.equal(en.code, 0);
      const dis = await runCli(['message-hooks', 'disable', 'hook_1'], env);
      assert.equal(dis.code, 0);
      assert.ok(hits.includes('POST /api/hooks/hook_1/enable'));
      assert.ok(hits.includes('POST /api/hooks/hook_1/disable'));
    },
  );
});

test('message-hooks delete <id>: DELETE /api/hooks/:id', async () => {
  const hits: string[] = [];
  await withSetup(
    (req) => {
      hits.push(`${req.method} ${req.url}`);
      return { status: 204, body: undefined };
    },
    async (env) => {
      const r = await runCli(['message-hooks', 'delete', 'hook_1'], env);
      assert.equal(r.code, 0, `stderr=${r.stderr}`);
      assert.ok(hits.includes('DELETE /api/hooks/hook_1'));
    },
  );
});

test('message-hooks list --json: bad auth → exit 1 with {error}', async () => {
  await withSetup(
    () => ({ status: 401, body: { error: 'unauthenticated' } }),
    async (env) => {
      const r = await runCli(['message-hooks', 'list', '--json'], env);
      assert.equal(r.code, 1);
      const parsed = JSON.parse(r.stdout) as { error: string };
      assert.match(parsed.error, /401|invalid bearer|unauthenticated/);
    },
  );
});
