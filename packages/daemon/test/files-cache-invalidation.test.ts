// Perf follow-up to G3-d3 / Group 20 fix #5: `gitDirtyPaths` (git-dirty.ts)
// and `listFilesRecursive` (files-recursive.ts) both cache their answer per
// chat-folder root for a short TTL so a burst of near-simultaneous listings
// (regular browse + ⌘P, or a re-render) doesn't each shell out to git. That
// cache must never survive a write the host knows about — these exercise
// the three points that call `invalidateFileListCaches`: `Daemon.writeFile`
// (editor save), `Daemon.fileOp` (file-browser create/rename/delete), and the
// `tool_result` handling for an agent `Edit`/`Write`/`NotebookEdit` call.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { gitDirtyPaths } from '../src/git-dirty.js';

const silent = pino({ level: 'silent' });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function freshRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-cache-inv-')));
  git(root, 'init');
  git(root, 'config', 'user.email', 't@e.com');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'note.txt'), 'hello world\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'init');
  return root;
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-cache-inv-home-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-cache-inv-proj-'));
  const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events };
}

describe('file-listing cache invalidation on write', () => {
  it('an editor save (Daemon.writeFile) is reflected by gitDirtyPaths immediately, not after the TTL', async () => {
    const root = freshRepo();
    const { daemon } = setup();
    const chatId = await daemon.spawnChat({ folder: root });
    // Prime the cache with the clean answer, exactly as a directory listing
    // fired just before the save would have.
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);

    daemon.writeFile(chatId, 'note.txt', 'edited via the web editor\n');

    // Same root, well within the cache's TTL — this only comes back dirty if
    // writeFile actively dropped the cached (stale) clean answer.
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(true);
  });

  it('a file-browser create (Daemon.fileOp) is reflected by gitDirtyPaths immediately', async () => {
    const root = freshRepo();
    const { daemon } = setup();
    const chatId = await daemon.spawnChat({ folder: root });
    expect((await gitDirtyPaths(root)).has('fresh.ts')).toBe(false);

    const outcome = daemon.fileOp({ chatId, op: 'create', path: 'fresh.ts' });
    expect(outcome.ok).toBe(true);

    expect((await gitDirtyPaths(root)).has('fresh.ts')).toBe(true);
  });

  it('a completed agent Edit tool call is reflected by gitDirtyPaths immediately', async () => {
    const root = freshRepo();
    const { daemon, sdk } = setup();
    // Prime the cache clean, BEFORE the on-disk change below — if the
    // tool_result handler did not invalidate the cache, the assertion at the
    // end would still see this stale clean snapshot (well within the TTL).
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);

    // Stand in for the real SDK's own tool execution, which writes the file
    // to disk itself (the host never sees that write directly — only the
    // tool_use/tool_result envelopes either side of it).
    writeFileSync(join(root, 'note.txt'), 'edited by the agent\n');

    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      {
        type: 'tool_use',
        tool: {
          name: 'Edit',
          args: {
            file_path: join(root, 'note.txt'),
            old_string: 'hello world\n',
            new_string: 'edited by the agent\n',
          },
          callId: 'toolu_1',
        },
      },
      {
        type: 'tool_result',
        toolResult: { name: 'Edit', callId: 'toolu_1', result: 'ok' },
      },
      { type: 'assistant', content: 'done', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder: root, prompt: 'edit note.txt' });
    await new Promise((r) => setTimeout(r, 30));

    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(true);
  });

  it('an ERRORED Edit tool result does NOT invalidate the cache (nothing landed on disk)', async () => {
    const root = freshRepo();
    const { daemon, sdk } = setup();
    expect((await gitDirtyPaths(root)).has('note.txt')).toBe(false);

    // The file changes on disk by some OTHER means (not this failed tool
    // call) between priming the cache and the assert below — if the errored
    // result wrongly invalidated the cache, the final call would shell out
    // fresh and see this change; asserting it does NOT proves the isError
    // check actually gates the invalidation rather than it never firing at
    // all for unrelated reasons.
    writeFileSync(join(root, 'unrelated.txt'), 'a genuinely separate change\n');

    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      {
        type: 'tool_use',
        tool: {
          name: 'Edit',
          args: { file_path: join(root, 'note.txt'), old_string: 'x', new_string: 'y' },
          callId: 'toolu_1',
        },
      },
      {
        type: 'tool_result',
        toolResult: {
          name: 'Edit',
          callId: 'toolu_1',
          result: 'old_string not found',
          isError: true,
        },
      },
      { type: 'assistant', content: 'could not apply the edit', sessionId: 'sess-A' },
    ]);
    await daemon.spawnChat({ folder: root, prompt: 'edit note.txt' });
    await new Promise((r) => setTimeout(r, 30));

    // Still serving the primed (stale) clean snapshot from before
    // `unrelated.txt` was created — the errored tool_result did not
    // invalidate the cache.
    expect((await gitDirtyPaths(root)).has('unrelated.txt')).toBe(false);
  });
});
