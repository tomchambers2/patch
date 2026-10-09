// spec/14-design-web.md § File browser, spec/03-wire-protocol.md § Files —
// the host is the enforcer for the browser's create / rename / delete. It
// owns the chat folder, so it owns the two rules that keep these from being
// destructive: nothing is ever overwritten, and nothing recurses.
//
// These exercise Daemon.fileOp directly — the same method index.ts's
// `handleFileOpRequest` calls when the server's frame arrives over the link.

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { handleFileOpRequest } from '../src/index.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-fop-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-fop-folder-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-fop-projects-'));
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

describe('file browser — create', () => {
  it('creates an empty file the editor can then open', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    const out = daemon.fileOp({ chatId, op: 'create', path: 'notes.md' });

    expect(out).toEqual({ ok: true, path: 'notes.md' });
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('');
  });

  it('creates inside an existing subdirectory', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'src'));

    expect(daemon.fileOp({ chatId, op: 'create', path: 'src/a.ts' })).toEqual({
      ok: true,
      path: 'src/a.ts',
    });
  });

  it('refuses to create over an existing file — that is the file blanked', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'KEEP ME');

    const out = daemon.fileOp({ chatId, op: 'create', path: 'a.ts' });

    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ code: 'exists' });
    expect(readFileSync(join(folder, 'a.ts'), 'utf8')).toBe('KEEP ME');
  });

  it('refuses a path whose directory does not exist rather than inventing it', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    const out = daemon.fileOp({ chatId, op: 'create', path: 'scr/a.ts' });

    expect(out).toMatchObject({ ok: false, code: 'not_found' });
    expect(existsSync(join(folder, 'scr'))).toBe(false);
  });

  it('makes one directory, and only one', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    expect(daemon.fileOp({ chatId, op: 'create_dir', path: 'src' })).toEqual({
      ok: true,
      path: 'src',
    });
    expect(existsSync(join(folder, 'src'))).toBe(true);
    expect(daemon.fileOp({ chatId, op: 'create_dir', path: 'a/b/c' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(existsSync(join(folder, 'a'))).toBe(false);
  });

  it('refuses an existing directory name', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'src'));

    expect(daemon.fileOp({ chatId, op: 'create_dir', path: 'src' })).toMatchObject({
      ok: false,
      code: 'exists',
    });
  });
});

describe('file browser — delete', () => {
  it('deletes a file', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'x');

    expect(daemon.fileOp({ chatId, op: 'delete', path: 'a.ts' })).toEqual({
      ok: true,
      path: 'a.ts',
    });
    expect(existsSync(join(folder, 'a.ts'))).toBe(false);
  });

  it('deletes an EMPTY directory', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'empty'));

    expect(daemon.fileOp({ chatId, op: 'delete', path: 'empty' })).toMatchObject({ ok: true });
    expect(existsSync(join(folder, 'empty'))).toBe(false);
  });

  it('NEVER recurses: a directory with anything in it is refused, contents intact', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'a.ts'), 'IMPORTANT');

    const out = daemon.fileOp({ chatId, op: 'delete', path: 'src' });

    expect(out).toMatchObject({ ok: false, code: 'not_empty' });
    expect(readFileSync(join(folder, 'src', 'a.ts'), 'utf8')).toBe('IMPORTANT');
  });

  it('refuses a path that is not there rather than reporting a silent success', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    expect(daemon.fileOp({ chatId, op: 'delete', path: 'gone.ts' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('file browser — rename', () => {
  it('renames a file, keeping its bytes', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'BYTES');

    expect(daemon.fileOp({ chatId, op: 'rename', path: 'a.ts', to: 'b.ts' })).toEqual({
      ok: true,
      path: 'b.ts',
    });
    expect(existsSync(join(folder, 'a.ts'))).toBe(false);
    expect(readFileSync(join(folder, 'b.ts'), 'utf8')).toBe('BYTES');
  });

  it('moves a file into an existing directory', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'a.ts'), 'BYTES');

    expect(daemon.fileOp({ chatId, op: 'rename', path: 'a.ts', to: 'src/a.ts' })).toMatchObject({
      ok: true,
      path: 'src/a.ts',
    });
    expect(readFileSync(join(folder, 'src', 'a.ts'), 'utf8')).toBe('BYTES');
  });

  it('renames a directory with its contents', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'old'));
    writeFileSync(join(folder, 'old', 'a.ts'), 'BYTES');

    expect(daemon.fileOp({ chatId, op: 'rename', path: 'old', to: 'new' })).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(folder, 'new', 'a.ts'), 'utf8')).toBe('BYTES');
  });

  it('NEVER overwrites: an occupied destination is refused and both files survive', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'SOURCE');
    writeFileSync(join(folder, 'b.ts'), 'DESTINATION');

    const out = daemon.fileOp({ chatId, op: 'rename', path: 'a.ts', to: 'b.ts' });

    expect(out).toMatchObject({ ok: false, code: 'exists' });
    expect(readFileSync(join(folder, 'a.ts'), 'utf8')).toBe('SOURCE');
    expect(readFileSync(join(folder, 'b.ts'), 'utf8')).toBe('DESTINATION');
  });

  it('refuses a destination directory that does not exist', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'BYTES');

    expect(daemon.fileOp({ chatId, op: 'rename', path: 'a.ts', to: 'scr/a.ts' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(readFileSync(join(folder, 'a.ts'), 'utf8')).toBe('BYTES');
  });

  it('refuses a rename with no destination', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'BYTES');

    expect(daemon.fileOp({ chatId, op: 'rename', path: 'a.ts' })).toMatchObject({
      ok: false,
      code: 'missing_target',
    });
  });
});

describe('file browser — the escape guard', () => {
  it('refuses a traversing path on every operation', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const outside = join(folder, '..', 'patch-fop-outside.txt');
    writeFileSync(outside, 'OUTSIDE');

    for (const op of ['create', 'create_dir', 'delete'] as const) {
      expect(daemon.fileOp({ chatId, op, path: '../patch-fop-outside.txt' })).toMatchObject({
        ok: false,
        code: 'path_escape',
      });
    }
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE');
  });

  it('refuses an absolute path', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    expect(daemon.fileOp({ chatId, op: 'delete', path: '/etc/hosts' })).toMatchObject({
      ok: false,
      code: 'path_escape',
    });
  });

  it('refuses a rename whose DESTINATION escapes, leaving the source where it was', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'BYTES');

    expect(
      daemon.fileOp({ chatId, op: 'rename', path: 'a.ts', to: '../escaped.ts' }),
    ).toMatchObject({ ok: false, code: 'path_escape' });
    expect(readFileSync(join(folder, 'a.ts'), 'utf8')).toBe('BYTES');
  });

  it('refuses the chat folder itself as a target', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    expect(daemon.fileOp({ chatId, op: 'delete', path: '.' })).toMatchObject({
      ok: false,
      code: 'path_escape',
    });
  });

  it('refuses a path reached through a symlinked directory out of the folder', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const outsideDir = mkdtempSync(join(tmpdir(), 'patch-fop-elsewhere-'));
    writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET');
    symlinkSync(outsideDir, join(folder, 'link'));

    const out = daemon.fileOp({ chatId, op: 'delete', path: 'link/secret.txt' });

    expect(out).toMatchObject({ ok: false, code: 'path_escape' });
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('SECRET');
  });

  it('refuses an unknown chat', () => {
    const { daemon } = setup();

    expect(daemon.fileOp({ chatId: 'nope', op: 'delete', path: 'a.ts' })).toMatchObject({
      ok: false,
      code: 'chat_not_found',
    });
  });
});

// The frame half: the server's `patch.file_op.request` is answered, always,
// with a `patch.file_op.response`. A destructive operation that produced no
// frame would leave the surface unable to tell "refused" from "lost".
describe('handleFileOpRequest', () => {
  function captureSender() {
    const sent: WireEvent[] = [];
    return { sender: (e: WireEvent) => sent.push(e), sent };
  }

  it('answers a success with the path the operation landed on', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'a.ts'), 'BYTES');
    const { sender, sent } = captureSender();

    handleFileOpRequest(
      {
        type: 'patch.file_op.request',
        requestId: 'f1',
        chatId,
        op: 'rename',
        path: 'a.ts',
        to: 'b.ts',
      },
      daemon,
      sender,
    );

    expect(sent).toEqual([
      { type: 'patch.file_op.response', requestId: 'f1', ok: true, path: 'b.ts' },
    ]);
  });

  it('answers a refusal with its code and the reason, and changes nothing', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'a.ts'), 'IMPORTANT');
    const { sender, sent } = captureSender();

    handleFileOpRequest(
      { type: 'patch.file_op.request', requestId: 'f2', chatId, op: 'delete', path: 'src' },
      daemon,
      sender,
    );

    expect(sent[0]).toMatchObject({
      type: 'patch.file_op.response',
      requestId: 'f2',
      ok: false,
      error: { code: 'not_empty' },
    });
    expect(readFileSync(join(folder, 'src', 'a.ts'), 'utf8')).toBe('IMPORTANT');
  });
});

// spec/14 § File browser — live updates: create/rename/delete changes the
// TREE, not just one file's bytes — every watching surface's own recursive
// listing needs to know, whether or not it has the changed path open.
describe('patch.file_changed broadcast', () => {
  function fileChanged(
    events: WireEvent[],
  ): Array<Extract<WireEvent, { type: 'patch.file_changed' }>> {
    return events.filter(
      (e): e is Extract<WireEvent, { type: 'patch.file_changed' }> =>
        e.type === 'patch.file_changed',
    );
  }

  it('fires with {chatId, path} where path is where the entry LANDED, on create', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.fileOp({ chatId, op: 'create', path: 'notes.md' });

    expect(fileChanged(events)).toEqual([{ type: 'patch.file_changed', chatId, path: 'notes.md' }]);
  });

  it('fires with the DESTINATION path on a rename', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'old.ts'), 'x');

    daemon.fileOp({ chatId, op: 'rename', path: 'old.ts', to: 'new.ts' });

    expect(fileChanged(events)).toEqual([{ type: 'patch.file_changed', chatId, path: 'new.ts' }]);
  });

  it('does NOT fire when the op is refused', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'a.ts'), 'IMPORTANT');

    daemon.fileOp({ chatId, op: 'delete', path: 'src' });

    expect(fileChanged(events)).toEqual([]);
  });
});
