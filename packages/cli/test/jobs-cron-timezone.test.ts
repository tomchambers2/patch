// spec/08 § Cron: the CLI stores the cron expression EXACTLY AS AUTHORED and
// attaches the zone it should be evaluated in. It used to rewrite a local
// expression into UTC at creation time, which baked in whichever offset was
// current that day — right until the next DST transition, after which a 9am
// job silently fired at 8am or 10am. These tests pin the replacement: the
// expression is never rewritten, and the zone rides along on the trigger.
//
// Each test asserts the JSON body that actually reaches POST /api/jobs, since
// that body IS the contract.

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

interface CronTriggerBody {
  type: string;
  expression: string;
  timezone?: string;
}
interface CreateBody {
  name?: string;
  trigger?: CronTriggerBody;
}

/**
 * Boot a throwaway REST server that RECORDS every POST body (the stock
 * `withSetup` in commands.test.ts only sees the URL/method), run the CLI
 * against it, and hand back both the process result and the captured bodies.
 */
function withCapture<T>(
  fn: (env: NodeJS.ProcessEnv, posted: CreateBody[]) => T | Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const posted: CreateBody[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/api/jobs' && req.method === 'POST') {
          const raw = Buffer.concat(chunks).toString('utf8');
          posted.push(raw.length > 0 ? (JSON.parse(raw) as CreateBody) : {});
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'job1' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('no addr'));
        return;
      }
      const dir = mkdtempSync(join(tmpdir(), 'patch-cli-crontz-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'credential.jwt'), 'aGVhZA.e30.c2ln\n', { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATCH_HOME: dir,
        PATCH_SERVER_URL: `http://127.0.0.1:${addr.port}`,
      };
      delete env['PATCH_DAEMON_SOCKET'];
      delete env['PATCH_DAEMON_LOCAL_KEY'];
      const done = (cb: () => void): void => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          cb();
        });
      };
      Promise.resolve(fn(env, posted))
        .then((r) => done(() => resolve(r)))
        .catch((e: unknown) => done(() => reject(e as Error)));
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

const BASE = [
  '--action',
  'spawn',
  '--folder',
  '/tmp/x',
  '--prompt',
  'morning brief',
  '--name',
  'morning',
  '--json',
];

/** `patch jobs create` with the cron flags first, then the constant tail. */
function args(...cronFlags: string[]): string[] {
  return ['jobs', 'create', ...cronFlags, ...BASE];
}

test('--timezone: the expression is sent verbatim with the zone alongside it', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 9 * * *', '--timezone', 'Europe/London'), {
      ...env,
      TZ: 'UTC',
    });
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.deepEqual(posted[0]?.trigger, {
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });
});

// The regression that started this: under TZ=Europe/London in July, the old
// CLI rewrote `0 9 * * *` to `0 8 * * *` and stored no zone, so the job
// drifted an hour the moment BST ended.
test('$TZ is the default zone, and the expression is NOT rewritten', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 9 * * *'), {
      ...env,
      TZ: 'Europe/London',
    });
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.deepEqual(posted[0]?.trigger, {
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });
});

test('--utc stores NO timezone at all — byte-identical to a pre-timezone job', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 9 * * *', '--utc'), {
      ...env,
      TZ: 'Europe/London',
    });
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.deepEqual(posted[0]?.trigger, { type: 'cron', expression: '0 9 * * *' });
    assert.equal('timezone' in (posted[0]?.trigger ?? {}), false);
  });
});

test('--utc and --timezone together: exit 1, server untouched', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 9 * * *', '--utc', '--timezone', 'Europe/London'), {
      ...env,
      TZ: 'UTC',
    });
    assert.equal(r.code, 1, `stdout=${r.stdout}`);
    assert.match(JSON.parse(r.stdout).error as string, /mutually exclusive/);
    assert.equal(posted.length, 0);
  });
});

// NO FALLBACK: a zone this machine cannot resolve is a caller error, named
// client-side, never silently demoted to UTC and never forwarded for an
// opaque server-side `invalid_input`.
test('an unresolvable --timezone: exit 1 naming the zone, server untouched', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 9 * * *', '--timezone', 'Europe/Landon'), {
      ...env,
      TZ: 'UTC',
    });
    assert.equal(r.code, 1, `stdout=${r.stdout}`);
    assert.match(JSON.parse(r.stdout).error as string, /invalid IANA timezone: "Europe\/Landon"/);
    assert.equal(posted.length, 0);
  });
});

// $TZ is ambient and can be anything the shell happens to hold; an unusable
// one must fail loudly rather than be quietly dropped.
test('an unresolvable $TZ: exit 1 naming the zone, server untouched', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 9 * * *'), { ...env, TZ: 'Mars/Olympus' });
    assert.equal(r.code, 1, `stdout=${r.stdout}`);
    assert.match(JSON.parse(r.stdout).error as string, /invalid IANA timezone/);
    assert.equal(posted.length, 0);
  });
});

test('no $TZ and no --timezone: no zone is invented, so the job stays UTC', async () => {
  await withCapture(async (env, posted) => {
    const bare = { ...env };
    delete bare['TZ'];
    const r = await runCli(args('--cron', '0 9 * * *'), bare);
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    assert.deepEqual(posted[0]?.trigger, { type: 'cron', expression: '0 9 * * *' });
  });
});

test('a malformed cron is still rejected client-side under a real $TZ', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(args('--cron', '0 99 * * *'), {
      ...env,
      TZ: 'Europe/London',
    });
    assert.equal(r.code, 1, `stdout=${r.stdout}`);
    assert.match(JSON.parse(r.stdout).error as string, /cron expression/);
    assert.equal(posted.length, 0);
  });
});
