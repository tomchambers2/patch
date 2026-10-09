// spec/04 § Moving a chat to another host — what a bundle carries, and how it
// lands: blobs, the native session mirror, Claude's own transcript and the
// chat's attachments, with the old folder rewritten to the new one.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMoveBundle,
  writeMoveBundle,
  MAX_MOVE_BUNDLE_BYTES,
  type ChatMovePaths,
} from '../src/chatMove.js';
import { encodeFolder } from '../src/history.js';

function paths(): ChatMovePaths & { folder: string } {
  const home = mkdtempSync(join(tmpdir(), 'patch-movefiles-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-movefiles-folder-'));
  const p = {
    chatsRoot: join(home, 'chats'),
    blobsDir: join(home, 'blobs'),
    claudeProjectsRoot: join(home, 'claude-projects'),
    movedRoot: join(home, 'moved'),
    folder,
  };
  mkdirSync(p.chatsRoot, { recursive: true });
  return p;
}

const CHAT = 'chat-1';

function seedChat(src: ReturnType<typeof paths>): { sha: string } {
  const dir = join(src.chatsRoot, CHAT);
  mkdirSync(join(dir, 'native', 'claude'), { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      chatId: CHAT,
      folder: src.folder,
      name: 'Plan',
      claudeSessionId: 'sess-1',
      nextSeq: 4,
      status: 'errored',
      lastError: { code: 'sdk_error', message: 'SIGTERM', at: 1 },
      pendingTurns: [{ message: 'Again' }],
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const blob = Buffer.from(JSON.stringify({ big: 'x'.repeat(100) }));
  const sha = createHash('sha256').update(blob).digest('hex');
  mkdirSync(join(src.blobsDir, 'sha256', sha.slice(0, 2)), { recursive: true });
  writeFileSync(join(src.blobsDir, 'sha256', sha.slice(0, 2), sha.slice(2)), blob);
  writeFileSync(
    join(dir, 'events.jsonl'),
    [
      JSON.stringify({
        seq: 0,
        rec: {
          content: `look\n\n[Attachments]\n- image: ${src.folder}/.patch/attachments/A1-shot.png (shot.png)`,
        },
      }),
      JSON.stringify({ seq: 1, rec: { result: { $blob: sha, bytes: blob.length } } }),
    ].join('\n') + '\n',
  );
  writeFileSync(join(dir, 'seq.tmp.1.2'), 'junk');
  writeFileSync(
    join(dir, 'native', 'claude', 'sess-1.jsonl'),
    [JSON.stringify({ uuid: 'u1', cwd: src.folder, type: 'user' }), 'not json'].join('\n'),
  );
  const project = join(src.claudeProjectsRoot, encodeFolder(src.folder));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'sess-1.jsonl'), JSON.stringify({ uuid: 'u1', cwd: src.folder }));
  const attach = join(src.folder, '.patch', 'attachments');
  mkdirSync(attach, { recursive: true });
  writeFileSync(join(attach, 'A1-shot.png'), 'PNG');
  writeFileSync(join(attach, 'B2-other.png'), 'OTHER');
  writeFileSync(
    join(attach, 'manifest.json'),
    JSON.stringify({
      A1: { id: 'A1', name: 'shot.png', mimeType: 'image/png', kind: 'image' },
      B2: { id: 'B2', name: 'other.png', mimeType: 'image/png', kind: 'image' },
    }),
  );
  return { sha };
}

describe('chat move bundle', () => {
  it('carries the chat dir, its blobs, its transcript and only its own attachments', () => {
    const src = paths();
    const { sha } = seedChat(src);
    const bundle = buildMoveBundle(CHAT, src);
    const names = bundle.files.map((f) => f.path).sort();
    expect(names).toEqual([
      'attachment/A1-shot.png',
      `blob/${sha}`,
      'chat/events.jsonl',
      'chat/meta.json',
      'chat/native/claude/sess-1.jsonl',
      'transcript/sess-1.jsonl',
    ]);
    expect(Object.keys(bundle.attachments)).toEqual(['A1']);
  });

  it('lands under the new folder, rewritten, ready to take a turn', () => {
    const src = paths();
    const { sha } = seedChat(src);
    const bundle = buildMoveBundle(CHAT, src);
    const dst = paths();
    const meta = writeMoveBundle(bundle, dst.folder, dst, 99);

    expect(meta.folder).toBe(dst.folder);
    expect(meta.status).toBe('active');
    expect(meta.lastError).toBeNull();
    expect(meta.pendingTurns).toEqual([]);
    expect(meta.claudeSessionId).toBe('sess-1');

    const mirror = readFileSync(
      join(dst.chatsRoot, CHAT, 'native', 'claude', 'sess-1.jsonl'),
      'utf8',
    );
    expect(JSON.parse(mirror.split('\n')[0]!).cwd).toBe(dst.folder);
    expect(mirror.split('\n')[1]).toBe('not json');

    const transcript = join(dst.claudeProjectsRoot, encodeFolder(dst.folder), 'sess-1.jsonl');
    expect(JSON.parse(readFileSync(transcript, 'utf8')).cwd).toBe(dst.folder);

    expect(existsSync(join(dst.blobsDir, 'sha256', sha.slice(0, 2), sha.slice(2)))).toBe(true);
    const attach = join(dst.folder, '.patch', 'attachments');
    expect(readFileSync(join(attach, 'A1-shot.png'), 'utf8')).toBe('PNG');
    expect(existsSync(join(attach, 'B2-other.png'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(attach, 'manifest.json'), 'utf8')))).toEqual([
      'A1',
    ]);
    expect(existsSync(join(dst.chatsRoot, `.incoming-${CHAT}`))).toBe(false);
  });

  it('refuses a corrupted blob and leaves no half-written chat', () => {
    const src = paths();
    seedChat(src);
    const bundle = buildMoveBundle(CHAT, src);
    const blob = bundle.files.find((f) => f.path.startsWith('blob/'))!;
    blob.data = Buffer.from('tampered').toString('base64');
    const dst = paths();
    expect(() => writeMoveBundle(bundle, dst.folder, dst, 99)).toThrow(/corrupted/);
    expect(existsSync(join(dst.chatsRoot, CHAT))).toBe(false);
    expect(existsSync(join(dst.chatsRoot, `.incoming-${CHAT}`))).toBe(false);
  });

  it('refuses a bundle path that climbs out of where it belongs', () => {
    const src = paths();
    seedChat(src);
    const bundle = buildMoveBundle(CHAT, src);
    bundle.files.push({ path: 'chat/../../escape', data: '' });
    const dst = paths();
    expect(() => writeMoveBundle(bundle, dst.folder, dst, 99)).toThrow(/not safe/);
  });

  it('refuses a chat too big to send', () => {
    const src = paths();
    seedChat(src);
    writeFileSync(join(src.chatsRoot, CHAT, 'huge.bin'), Buffer.alloc(MAX_MOVE_BUNDLE_BYTES + 1));
    expect(() => buildMoveBundle(CHAT, src)).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  it('a transcript coming back replaces the older copy it left behind', () => {
    const src = paths();
    seedChat(src);
    const bundle = buildMoveBundle(CHAT, src);
    const dst = paths();
    const project = join(dst.claudeProjectsRoot, encodeFolder(dst.folder));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'sess-1.jsonl'), '{}');
    writeMoveBundle(bundle, dst.folder, dst, 99);
    expect(readFileSync(join(project, 'sess-1.jsonl'), 'utf8')).toContain('"uuid":"u1"');
  });
});
