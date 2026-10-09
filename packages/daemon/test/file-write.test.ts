// G3 (spec/14-design-web.md § Editor, spec/03-wire-protocol.md `file.write`):
// the host is the enforcer for editor saves. Both web editor surfaces (diff
// editor + file browser) commit via the same `file.write` wire event, and the
// daemon:
//   - commits the write to disk atomically, whatever the chat's activity is —
//     the editor is writable mid-turn and the atomic replace is what keeps a
//     concurrent agent write from tearing the file;
//   - refuses a path that escapes the chat folder.
//
// These exercise Daemon.writeFile directly — the same method index.ts's
// `case 'file.write'` calls when a surface frame arrives over the WS link.

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-fw-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-fw-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-fw-projects-'));
  const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, folder };
}

function errors(events: WireEvent[]): Array<Extract<WireEvent, { type: 'chat.error' }>> {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.error' }> => e.type === 'chat.error',
  );
}

function fileChanged(
  events: WireEvent[],
): Array<Extract<WireEvent, { type: 'patch.file_changed' }>> {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'patch.file_changed' }> => e.type === 'patch.file_changed',
  );
}

describe('G3 file.write — host enforcement', () => {
  it('commits a write to disk while the chat is idle (G3-4)', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // chat is idle after spawn
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');

    daemon.writeFile(chatId, 'notes.txt', 'hello from editor');

    const onDisk = readFileSync(join(folder, 'notes.txt'), 'utf8');
    expect(onDisk).toBe('hello from editor');
    // No chat.error on the happy path.
    expect(errors(events)).toHaveLength(0);
  });

  it('overwrites an existing file the agent created, idle (G3-4)', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'export const a = 1;\n');

    daemon.writeFile(chatId, 'a.ts', 'export const a = 2;\n');

    expect(readFileSync(join(folder, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('commits a write while the chat is running', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'ORIGINAL\n');
    daemon.chatState.setActivity(chatId, 'running');

    daemon.writeFile(chatId, 'a.ts', 'TWEAKED\n');

    expect(readFileSync(join(folder, 'a.ts'), 'utf8')).toBe('TWEAKED\n');
    expect(errors(events)).toHaveLength(0);
  });

  it('commits a write while awaiting-permission', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.chatState.setActivity(chatId, 'awaiting-permission');

    daemon.writeFile(chatId, 'x.txt', 'saved anyway');

    expect(readFileSync(join(folder, 'x.txt'), 'utf8')).toBe('saved anyway');
    expect(errors(events)).toHaveLength(0);
  });

  it('commits a write in every activity state', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    for (const activity of ['idle', 'running', 'awaiting-permission', 'errored'] as const) {
      daemon.chatState.setActivity(chatId, activity);
      daemon.writeFile(chatId, 'r.txt', `written while ${activity}`);
      expect(readFileSync(join(folder, 'r.txt'), 'utf8')).toBe(`written while ${activity}`);
    }
    expect(errors(events)).toHaveLength(0);
  });

  it('replaces the file atomically, so a concurrent reader never sees a torn write', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'big.txt'), 'OLD\n');
    daemon.chatState.setActivity(chatId, 'running');

    // A large payload is the case a non-atomic write would tear: any read
    // landing mid-write would see a prefix. The rename-based commit means the
    // path only ever resolves to the whole old file or the whole new one.
    const big = 'x'.repeat(200_000);
    daemon.writeFile(chatId, 'big.txt', big);

    expect(readFileSync(join(folder, 'big.txt'), 'utf8')).toBe(big);
    // The temp file used for the atomic rename is not left behind.
    const leftovers = readdirSync(folder).filter((f) => f.includes('patch-tmp'));
    expect(leftovers).toEqual([]);
  });

  it('rejects an ABSOLUTE path instead of rebasing it onto the chat folder (G3-4)', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // The diff editor used to send the file's absolute path; the old code
    // stripped the leading slash and joined it onto the chat folder, committing
    // to a WRONG nested path (e.g. <folder>/private/tmp/.../sample.txt) and
    // never touching the intended file. The fix: reject absolute paths loudly.
    const abs = join(folder, 'sample.txt');
    daemon.writeFile(chatId, abs, 'EDITED\n');

    // No file written at the intended absolute path (the write was rejected,
    // not silently committed elsewhere).
    expect(existsSync(abs)).toBe(false);
    // And crucially: NO wrong nested path was created by rebasing.
    expect(existsSync(join(folder, folder))).toBe(false);
    const err = errors(events).at(-1);
    expect(err?.error.code).toBe('file_write_rejected');
    expect(err?.error.message).toMatch(/relative/i);
  });

  it('refuses a path that escapes the chat folder with a chat.error', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.writeFile(chatId, '../escape.txt', 'pwned');

    expect(existsSync(join(folder, '..', 'escape.txt'))).toBe(false);
    expect(errors(events).at(-1)?.error.code).toBe('file_write_rejected');
  });

  it('emits chat.error for an unknown chat id', () => {
    const { daemon, events } = setup();
    daemon.writeFile('does-not-exist', 'x.txt', 'y');
    expect(errors(events).at(-1)?.error.code).toBe('chat_not_found');
  });

  it('emits chat.error (file_write_rejected) when the disk write itself fails', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // Create a FILE at a path segment, so mkdirSync(dirname(target)) fails
    // (ENOTDIR: can't create a directory where a file already exists).
    writeFileSync(join(folder, 'blocker'), 'im-a-file');

    daemon.writeFile(chatId, 'blocker/nested/target.txt', 'content');

    const errs = errors(events);
    expect(errs.at(-1)?.error.code).toBe('file_write_rejected');
    expect(existsSync(join(folder, 'blocker', 'nested'))).toBe(false);
  });

  // spec/14 § File browser — live updates: every successful write broadcasts
  // `patch.file_changed` so every OTHER surface watching this chat knows its
  // own cached copy just went stale, whether or not it was the one saving.
  describe('patch.file_changed broadcast', () => {
    it('fires with {chatId, path} on a successful write', async () => {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });

      daemon.writeFile(chatId, 'notes.txt', 'hello');

      expect(fileChanged(events)).toEqual([
        { type: 'patch.file_changed', chatId, path: 'notes.txt' },
      ]);
    });

    it('does NOT fire when the write is rejected (unknown chat, escaped path, or a disk failure)', async () => {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      writeFileSync(join(folder, 'blocker'), 'im-a-file');

      daemon.writeFile('does-not-exist', 'x.txt', 'y');
      daemon.writeFile(chatId, '../escape.txt', 'pwned');
      daemon.writeFile(chatId, 'blocker/nested/target.txt', 'content');

      expect(fileChanged(events)).toEqual([]);
    });
  });
});
