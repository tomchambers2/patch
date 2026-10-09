// spec/14 § Document editor, step 2 of 3 — Propose/Comment mode refuses a
// direct `Edit`/`Write` on the document, naming the mode (sdkBackend.ts's
// `denyForDocMode`, inside `buildCanUseTool`). Same mock seam as
// disallowed-tools.test.ts's `run_in_background` gate: capture the real
// SDK's `canUseTool` and call it directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSidecar, writeSidecar } from '../src/docSidecar.js';

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: { prompt: unknown; options: Record<string, unknown> }) {
    queryCalls.push(args);
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

async function capturedCanUseTool(
  cwd: string,
): Promise<(toolName: string, input: Record<string, unknown>, ctx: unknown) => Promise<unknown>> {
  const { createRealSdkBackend } = await import('../src/sdkBackend.js');
  const backend = createRealSdkBackend();
  const ac = new AbortController();
  for await (const _msg of backend.run({
    prompt: 'hello',
    cwd,
    abortController: ac,
    oauthAccessToken: 'tok',
    onPermissionRequest: async () => ({ approve: true }),
  })) {
    void _msg;
  }
  const canUseTool = queryCalls[0]!.options['canUseTool'] as (
    toolName: string,
    input: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<unknown>;
  expect(typeof canUseTool).toBe('function');
  return canUseTool;
}

function folderWithMode(mode: 'change' | 'propose' | 'comment'): { dir: string; mdPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'patch-doc-gate-'));
  const mdPath = join(dir, 'notes.md');
  writeFileSync(mdPath, '# Notes\n');
  const sidecar = defaultSidecar();
  sidecar.mode = mode;
  writeSidecar(mdPath, sidecar);
  return { dir, mdPath };
}

describe('document editor — Propose/Comment mode refuses direct Edit/Write (spec/14)', () => {
  beforeEach(() => {
    queryCalls.length = 0;
  });
  afterEach(() => {
    queryCalls.length = 0;
  });

  it('denies Edit on a .md file in propose mode, naming the mode', async () => {
    const { dir } = folderWithMode('propose');
    const canUseTool = await capturedCanUseTool(dir);
    const result = (await canUseTool(
      'Edit',
      { file_path: 'notes.md', old_string: 'Notes', new_string: 'Edited' },
      {},
    )) as { behavior: string; message: string };
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('propose mode');
    expect(result.message).toContain('patch_doc_suggest');
  });

  it('denies Write on a .md file in comment mode, naming the mode', async () => {
    const { dir } = folderWithMode('comment');
    const canUseTool = await capturedCanUseTool(dir);
    const result = (await canUseTool('Write', { file_path: 'notes.md', content: 'new' }, {})) as {
      behavior: string;
      message: string;
    };
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('comment mode');
  });

  it('allows Edit on a .md file in change mode (falls through to the normal gate)', async () => {
    const { dir } = folderWithMode('change');
    const canUseTool = await capturedCanUseTool(dir);
    const result = (await canUseTool(
      'Edit',
      { file_path: 'notes.md', old_string: 'Notes', new_string: 'Edited' },
      {},
    )) as { behavior: string };
    // onPermissionRequest was stubbed to always approve.
    expect(result.behavior).toBe('allow');
  });

  it('allows Edit on a .md file with no sidecar at all (default is change mode)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-doc-gate-'));
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    const canUseTool = await capturedCanUseTool(dir);
    const result = (await canUseTool(
      'Edit',
      { file_path: 'notes.md', old_string: 'Notes', new_string: 'Edited' },
      {},
    )) as { behavior: string };
    expect(result.behavior).toBe('allow');
  });

  it('never gates a non-markdown file, even in propose mode', async () => {
    const { dir } = folderWithMode('propose');
    writeFileSync(join(dir, 'notes.md.ts'), 'const x = 1;\n');
    const canUseTool = await capturedCanUseTool(dir);
    const result = (await canUseTool(
      'Edit',
      { file_path: 'notes.md.ts', old_string: 'x = 1', new_string: 'x = 2' },
      {},
    )) as { behavior: string };
    expect(result.behavior).toBe('allow');
  });

  it('leaves Bash and every other tool alone, as before (sanity)', async () => {
    const { dir } = folderWithMode('propose');
    const canUseTool = await capturedCanUseTool(dir);
    const result = (await canUseTool('Bash', { command: 'echo hi' }, {})) as { behavior: string };
    expect(result.behavior).toBe('allow');
  });
});
