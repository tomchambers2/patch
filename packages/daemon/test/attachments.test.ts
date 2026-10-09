// Composer attachments — host side (spec/14 & spec/15 § Composer).
//
// `storeAttachment` writes an uploaded file under the chat's dir; a subsequent
// `sendInput` carrying the ref folds the on-disk path into the turn's prompt so
// Claude reads the file. NO FALLBACK: a ref with no stored file fails the turn.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent, AttachmentRef } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type MockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(): { daemon: Daemon; sdk: MockSdkBackend; folder: string } {
  const home = mkdtempSync(join(tmpdir(), 'patch-att-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-att-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-att-projects-'));
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
  return { daemon, sdk, folder };
}

describe('composer attachments — host', () => {
  it('stores a file under the chat dir and folds its path into the prompt', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    const stored = daemon.storeAttachment({
      chatId,
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'shot.png',
      mimeType: 'image/png',
      kind: 'image',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(existsSync(stored.path)).toBe(true);
    // Stored under the chat's own dir (`<folder>/.patch/attachments/<id>-<name>`).
    expect(stored.path).toContain(join('.patch', 'attachments'));
    expect(stored.path).toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV-shot.png');
    // The ref is persisted to the chat manifest so a later replay can
    // reconstruct it (spec/14 & spec/15 § Composer — attachments survive replay).
    const manifestPath = join(folder, '.patch', 'attachments', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest['01ARZ3NDEKTSV4RRFFQ69G5FAV']).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'shot.png',
      mimeType: 'image/png',
      kind: 'image',
    });

    const attachments: AttachmentRef[] = [
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'shot.png', mimeType: 'image/png', kind: 'image' },
    ];
    await daemon.sendInput({ chatId, message: 'what is this?', localId: 'l1', attachments });

    const prompt = sdk.lastOptions()?.prompt ?? '';
    expect(prompt).toContain('what is this?');
    expect(prompt).toContain('[Attachments]');
    expect(prompt).toContain(stored.path);
    expect(prompt).toContain('shot.png');
  });

  it('fails the turn loudly when a ref has no stored file (NO FALLBACK)', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const attachments: AttachmentRef[] = [
      { id: 'MISSINGID', name: 'ghost.png', mimeType: 'image/png', kind: 'image' },
    ];
    await expect(
      daemon.sendInput({ chatId, message: 'hi', localId: 'l2', attachments }),
    ).rejects.toThrow(/attachment not found on disk/);
  });

  it('re-emits attachment refs on replay and strips the [Attachments] block from the text', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.storeAttachment({
      chatId,
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'shot.png',
      mimeType: 'image/png',
      kind: 'image',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const attachments: AttachmentRef[] = [
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'shot.png', mimeType: 'image/png', kind: 'image' },
    ];
    await daemon.sendInput({ chatId, message: 'what is this?', localId: 'l1', attachments });

    // Replay (the leave-and-return path): the persisted transcript carries the
    // prompt with the appended [Attachments] block. The host must reconstruct
    // the structured refs AND strip the block so it never renders as literal
    // text (spec/14 & spec/15 § Composer — attachments survive replay).
    const { events } = daemon.readHistory({ chatId });
    const userMsg = events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toBe('what is this?');
    expect(userMsg?.content).not.toContain('[Attachments]');
    expect(userMsg?.attachments).toEqual(attachments);
  });

  it('replays an image whose filename contains parentheses (e.g. "photo (1).jpg") — block stripped, ref reconstructed', async () => {
    // Duplicate-download / screenshot naming ("photo (1).jpg", "Screenshot
    // (2).png") is common; a ')' in the DISPLAY name must not break the replay
    // parser. Before the fix the block failed to parse, so the raw
    // `[Attachments]` path text leaked into the bubble and the image vanished
    // on leave-and-return (patch/todo.md — "image being passed along properly").
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.storeAttachment({
      chatId,
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'photo (1).jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
    });
    const attachments: AttachmentRef[] = [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name: 'photo (1).jpg',
        mimeType: 'image/jpeg',
        kind: 'image',
      },
    ];
    await daemon.sendInput({ chatId, message: 'what is this?', localId: 'l1', attachments });

    const { events } = daemon.readHistory({ chatId });
    const userMsg = events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(userMsg).toBeDefined();
    // The [Attachments] block is stripped from the visible text …
    expect(userMsg?.content).toBe('what is this?');
    expect(userMsg?.content).not.toContain('[Attachments]');
    // … and the ref is reconstructed (authoritatively from the manifest by id).
    expect(userMsg?.attachments).toEqual(attachments);
  });

  it('a corrupt manifest.json does not affect a chat reading from its own log', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.storeAttachment({
      chatId,
      id: '01ABCDEFG',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      bytes: Buffer.from([1, 2, 3]),
    });
    const attachments: AttachmentRef[] = [
      { id: '01ABCDEFG', name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image' },
    ];
    // Attachment-only turn (no typed text) — also exercises the
    // message.length===0 branch that folds the block in without a separator.
    await daemon.sendInput({ chatId, message: '', localId: 'l1', attachments });

    // Corrupt the manifest AFTER storeAttachment already wrote it validly.
    const manifestPath = join(folder, '.patch', 'attachments', 'manifest.json');
    writeFileSync(manifestPath, 'not json {{{', 'utf8');

    const { events } = daemon.readHistory({ chatId });
    const userMsg = events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(userMsg).toBeDefined();
    // spec/04 § History — this chat's own log already carries the real
    // AttachmentRef from when the message was first shown, so a manifest
    // corrupted AFTERWARD has no effect: reading no longer re-derives
    // anything from the manifest at all (that fallback belongs to the
    // transcript-based path, exercised only by a chat still on it).
    expect(userMsg?.attachments).toEqual(attachments);
  });

  it('a manifest.json that parses to valid JSON but not an object does not affect a chat reading from its own log', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.storeAttachment({
      chatId,
      id: '01XYZ',
      name: 'note.pdf',
      mimeType: 'application/pdf',
      kind: 'file',
      bytes: Buffer.from([9]),
    });
    const attachments: AttachmentRef[] = [
      { id: '01XYZ', name: 'note.pdf', mimeType: 'application/pdf', kind: 'file' },
    ];
    await daemon.sendInput({ chatId, message: 'a doc', localId: 'l1', attachments });

    // Valid JSON, but a top-level number rather than an object.
    const manifestPath = join(folder, '.patch', 'attachments', 'manifest.json');
    writeFileSync(manifestPath, '42', 'utf8');

    const { events } = daemon.readHistory({ chatId });
    const userMsg = events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    );
    expect(userMsg?.attachments).toEqual(attachments);
  });

  it('rejects storeAttachment for an unknown chat', () => {
    const { daemon } = setup();
    expect(() =>
      daemon.storeAttachment({
        chatId: 'nope',
        id: 'x',
        name: 'a.png',
        mimeType: 'image/png',
        kind: 'image',
        bytes: Buffer.from([1]),
      }),
    ).toThrow(/chat not found/);
  });
});
