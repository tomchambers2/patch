// Direct unit coverage for `createMockSdkBackend()` itself (src/sdkBackend.ts)
// — the dev-trigger scripts, on-disk transcript persistence, and the
// abort/turnDelay plumbing. Every OTHER test file that uses the mock backend
// exercises it incidentally through `Daemon`; this file calls `sdk.run()`
// directly so every branch of the mock's own logic (not just the happy
// paths other tests happen to hit) gets covered:
//   - the `[[multi-edit]]` dev trigger (success + its best-effort catch)
//   - the `[[edit]]` dev trigger's best-effort catch
//   - `turnDelayMs`'s env-var fallback (`opts.turnDelayMs` omitted)
//   - transcript persistence's permission/tool_result branches + write failure
//   - the abort-before-any-event early return

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';

async function drain(
  backend: ReturnType<typeof createMockSdkBackend>,
  opts: Parameters<ReturnType<typeof createMockSdkBackend>['run']>[0],
): Promise<SdkEnvelope[]> {
  const out: SdkEnvelope[] = [];
  for await (const ev of backend.run(opts)) out.push(ev);
  return out;
}

function tmpFolder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'patch-mockbackend-')));
}

describe('createMockSdkBackend — [[multi-edit]] dev trigger', () => {
  it('applies all three edits to disk on a valid cwd', async () => {
    const backend = createMockSdkBackend();
    const cwd = tmpFolder();
    const out = await drain(backend, {
      prompt: '[[multi-edit]]',
      cwd,
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    expect(out.some((e) => e.type === 'tool_use' && e.tool?.name === 'Edit')).toBe(true);
    expect(readFileSync(join(cwd, 'note.txt'), 'utf8')).toBe('hello patch\n');
    expect(readFileSync(join(cwd, 'src', 'layout.ts'), 'utf8')).toBe('const a = 2;\n');
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('# Project (patched)\n');
  });

  it('a cwd that cannot be written to is swallowed by the best-effort catch (still emits the script)', async () => {
    const backend = createMockSdkBackend();
    // A REGULAR FILE (not a directory) as `cwd` — `mkdirSync(dirname(...))`
    // for every edit target fails (ENOTDIR/EEXIST), exercising the dev
    // trigger's `try { ... } catch { /* best-effort */ }` around the
    // filesystem write for EACH of the three edits.
    const cwdAsFile = join(tmpdir(), `patch-mockbackend-file-${Date.now()}`);
    writeFileSync(cwdAsFile, 'not a directory');
    const out = await drain(backend, {
      prompt: '[[multi-edit]]',
      cwd: cwdAsFile,
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    // The script still completes (envelopes yielded) despite every on-disk
    // write failing — NO throw propagates out of run().
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });
});

describe('createMockSdkBackend — [[edit]] dev trigger', () => {
  it('a cwd that cannot be written to is swallowed by the best-effort catch', async () => {
    const backend = createMockSdkBackend();
    const cwdAsFile = join(tmpdir(), `patch-mockbackend-file2-${Date.now()}`);
    writeFileSync(cwdAsFile, 'not a directory');
    const out = await drain(backend, {
      prompt: '[[edit]]',
      cwd: cwdAsFile,
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });
});

describe('createMockSdkBackend — turnDelayMs env-var fallback', () => {
  it('reads PATCH_MOCK_TURN_DELAY_MS when opts.turnDelayMs is omitted', async () => {
    const prev = process.env['PATCH_MOCK_TURN_DELAY_MS'];
    process.env['PATCH_MOCK_TURN_DELAY_MS'] = '0';
    try {
      // No `turnDelayMs` in the options object at all — every OTHER test in
      // this package either omits the env var too (falls back to the `?? 0`
      // literal without ever evaluating the env-var branch) or passes
      // `turnDelayMs` explicitly (short-circuiting `??` before the env-var
      // check runs). This is the only case that reaches it.
      const backend = createMockSdkBackend({});
      const out = await drain(backend, {
        prompt: 'hello',
        cwd: tmpFolder(),
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      });
      expect(out.some((e) => e.type === 'result')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['PATCH_MOCK_TURN_DELAY_MS'];
      else process.env['PATCH_MOCK_TURN_DELAY_MS'] = prev;
    }
  });
});

describe('createMockSdkBackend — on-disk transcript persistence branches', () => {
  it('a permission envelope WITH a description persists it onto the tool_use block', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-mockbackend-proj-'));
    const backend = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    const cwd = tmpFolder();
    backend.enqueue([
      { type: 'assistant', content: 'about to edit' },
      {
        type: 'permission',
        permission: {
          requestId: 'perm-1',
          tool: 'Edit',
          args: { file_path: 'x.ts' },
          description: 'Edit x.ts',
        },
      },
      { type: 'result', sessionId: 'sess-perm' },
    ]);
    await drain(backend, {
      prompt: 'edit please',
      cwd,
      // Pins the transcript filename to the `sessionId` set on the enqueued
      // `result` envelope — without this, the mock generates its OWN random
      // session id (the enqueued envelope's `sessionId` is only stamped back
      // onto a `result` that lacks one, see `run()`'s final loop).
      resumeSessionId: 'sess-perm',
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    const encodedFolder = cwd.replace(/[/.]/g, '-').replace(/^-+|-+$/g, '-');
    const dir = join(projectsRoot, encodedFolder);
    const transcript = readFileSync(join(dir, 'sess-perm.jsonl'), 'utf8');
    expect(transcript).toContain('"description":"Edit x.ts"');
  });

  it('a tool_result envelope with isError:true persists `is_error:true` on the transcript', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-mockbackend-proj-'));
    const backend = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    const cwd = tmpFolder();
    backend.enqueue([
      { type: 'assistant', content: "I'll run a command." },
      {
        type: 'tool_use',
        tool: { name: 'Bash', args: { command: 'false' }, callId: 'call-err-1' },
      },
      {
        type: 'tool_result',
        toolResult: { name: 'Bash', callId: 'call-err-1', result: 'exit 1', isError: true },
      },
      { type: 'result', sessionId: 'sess-err' },
    ]);
    await drain(backend, {
      prompt: 'run a failing command',
      cwd,
      resumeSessionId: 'sess-err',
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    const encodedFolder = cwd.replace(/[/.]/g, '-').replace(/^-+|-+$/g, '-');
    const dir = join(projectsRoot, encodedFolder);
    const files = readFileSync(join(dir, 'sess-err.jsonl'), 'utf8');
    expect(files).toContain('"is_error":true');
  });

  it('a permission envelope with NO description omits the description field on the transcript', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-mockbackend-proj-'));
    const backend = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    const cwd = tmpFolder();
    backend.enqueue([
      { type: 'assistant', content: 'about to edit, no description' },
      {
        type: 'permission',
        permission: { requestId: 'perm-2', tool: 'Edit', args: { file_path: 'y.ts' } },
      },
      { type: 'result', sessionId: 'sess-perm-nodesc' },
    ]);
    await drain(backend, {
      prompt: 'edit please, no description',
      cwd,
      resumeSessionId: 'sess-perm-nodesc',
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    const encodedFolder = cwd.replace(/[/.]/g, '-').replace(/^-+|-+$/g, '-');
    const dir = join(projectsRoot, encodedFolder);
    const files = readFileSync(join(dir, 'sess-perm-nodesc.jsonl'), 'utf8');
    expect(files).not.toContain('"description"');
    expect(files).toContain('"name":"Edit"');
  });

  it('a write failure under claudeProjectsRoot throws a clear, non-swallowed error', async () => {
    // `claudeProjectsRoot` itself is a REGULAR FILE, not a directory —
    // `mkdirSync(dir, {recursive:true})` fails because a path component
    // (the root itself) is a file, exercising the mock's own
    // `catch (err) { throw new Error(...) }` NO-FALLBACK wrapper (distinct
    // from the dev-triggers' best-effort catches above: a transcript write
    // failure is a real operator-visible error, never silenced).
    const projectsRootAsFile = join(tmpdir(), `patch-mockbackend-projfile-${Date.now()}`);
    writeFileSync(projectsRootAsFile, 'not a directory');
    const backend = createMockSdkBackend({ claudeProjectsRoot: projectsRootAsFile });
    await expect(
      drain(backend, {
        prompt: 'hello',
        cwd: tmpFolder(),
        abortController: new AbortController(),
        oauthAccessToken: 'tok',
      }),
    ).rejects.toThrow(/failed to persist transcript under/);
  });
});

describe('createMockSdkBackend — abort before any event is yielded', () => {
  it('an already-aborted controller short-circuits the whole script (zero envelopes)', async () => {
    const backend = createMockSdkBackend();
    const ac = new AbortController();
    ac.abort();
    const out = await drain(backend, {
      prompt: 'hello, but already aborted',
      cwd: tmpFolder(),
      abortController: ac,
      oauthAccessToken: 'tok',
    });
    expect(out).toEqual([]);
  });
});

describe('createMockSdkBackend — [[bash-permission]] dev trigger', () => {
  it('runs the Bash tool unblocked when no onPermissionRequest is supplied (auto/bypassPermissions)', async () => {
    const backend = createMockSdkBackend();
    const out = await drain(backend, {
      prompt: '[[bash-permission]]',
      cwd: tmpFolder(),
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    expect(out.some((e) => e.type === 'tool_use' && e.tool?.name === 'Bash')).toBe(true);
    const result = out.find((e) => e.type === 'tool_result');
    expect(result?.toolResult?.result).toBe('hi\n');
    expect(out.some((e) => e.type === 'result')).toBe(true);
  });

  it('awaits onPermissionRequest and runs the tool when it approves', async () => {
    const backend = createMockSdkBackend();
    let calledWith:
      | { tool: string; args: Record<string, unknown>; description?: string }
      | undefined;
    const out = await drain(backend, {
      prompt: '[[bash-permission]]',
      cwd: tmpFolder(),
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
      permissionMode: 'default',
      onPermissionRequest: async (req) => {
        calledWith = req;
        return { approve: true };
      },
    });
    expect(calledWith?.tool).toBe('Bash');
    expect(calledWith?.args).toEqual({ command: 'echo hi' });
    expect(out.some((e) => e.type === 'tool_use' && e.tool?.name === 'Bash')).toBe(true);
    expect(out.find((e) => e.type === 'tool_result')?.toolResult?.result).toBe('hi\n');
  });

  it('awaits onPermissionRequest and denies the tool call without running it', async () => {
    const backend = createMockSdkBackend();
    const out = await drain(backend, {
      prompt: '[[bash-permission]]',
      cwd: tmpFolder(),
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
      permissionMode: 'default',
      onPermissionRequest: async () => ({ approve: false }),
    });
    expect(out.some((e) => e.type === 'tool_use' && e.tool?.name === 'Bash')).toBe(false);
    const result = out.find((e) => e.type === 'tool_result');
    expect(result?.toolResult?.isError).toBe(true);
    expect(result?.toolResult?.result).toBe('Permission denied by user');
  });
});

describe('createMockSdkBackend — folder registry helper collisions (sanity)', () => {
  it('spawns without throwing when claudeProjectsRoot is unset (pure in-memory echo)', async () => {
    const backend = createMockSdkBackend();
    const out = await drain(backend, {
      prompt: 'plain message',
      cwd: tmpFolder(),
      abortController: new AbortController(),
      oauthAccessToken: 'tok',
    });
    expect(out.some((e) => e.type === 'assistant' && e.content?.includes('plain message'))).toBe(
      true,
    );
  });
});
