import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient, redactCodexLine } from '../src/codexClient.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('strips colour and redacts token-shaped strings', () => {
  expect(
    redactCodexLine(
      '\x1b[31mERROR\x1b[0m exchange failed token=eyJhbGci.eyJzdWIi.c2ln key sk-proj-abcdefghijklmnop',
    ),
  ).toBe('ERROR exchange failed token=[redacted-jwt] key [redacted-key]');
});

it("hands Codex's stderr on line by line, redacted, instead of discarding it", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-codex-stderr-'));
  dirs.push(dir);
  const executable = join(dir, 'codex');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
process.stderr.write('ERROR codex_login: device auth failed with status 500 eyJa.eyJb.sig\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n');
});
`,
  );
  chmodSync(executable, 0o755);
  const lines: string[] = [];
  const client = new CodexClient({ home: dir, executable, onStderr: (l) => lines.push(l) });
  try {
    await client.start();
    for (let i = 0; i < 40 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(lines).toEqual(['ERROR codex_login: device auth failed with status 500 [redacted-jwt]']);
  } finally {
    await client.close();
  }
});
