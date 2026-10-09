// spec/02 § Provider-level context — Claude Code's OWN `type: "attachment"`
// stream/transcript entries (environment, model identity, token counts, ...),
// end to end through the host: the SDK stream message, the wire event, and
// the replay of a persisted one. Structurally unrelated to a Patch-injected
// `<system-reminder>` (System-reminder disclosure, `history.test.ts`) — each
// is its own top-level entry, never embedded in a turn's own prompt.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, translateSdkMessage } from '../src/sdkBackend.js';
import { jsonlLineToWire, translateAttachment } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-provider-context-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore };
}

describe('translateAttachment — the shared replay/live translation', () => {
  it('unwraps a rendered <system-reminder> block for a known attachment type', () => {
    const item = translateAttachment({
      type: 'attachment',
      attachment: { type: 'date', date: '2026-09-25' },
      rendered: [{ content: "<system-reminder>\nToday's date is 2026-09-25.\n</system-reminder>" }],
    });
    expect(item).toEqual({
      providerType: 'date',
      label: 'Date',
      text: "Today's date is 2026-09-25.",
    });
  });

  it('returns null for a non-attachment-shaped object', () => {
    expect(translateAttachment({ type: 'attachment' })).toBeNull();
    expect(translateAttachment({ type: 'attachment', attachment: 'nope' })).toBeNull();
    expect(translateAttachment({ type: 'attachment', attachment: { type: 123 } })).toBeNull();
  });
});

describe('translateSdkMessage — attachment envelopes', () => {
  it('translates a live attachment message into a provider_context envelope', () => {
    const [env] = translateSdkMessage({
      type: 'attachment',
      uuid: 'u1',
      attachment: { type: 'model', identity: { modelId: 'claude-sonnet-5' } },
      rendered: [
        {
          content:
            '<system-reminder>You are powered by the model named Sonnet 5.</system-reminder>',
        },
      ],
    });
    expect(env).toMatchObject({
      type: 'provider_context',
      providerContext: {
        providerType: 'model',
        label: 'Model',
        text: 'You are powered by the model named Sonnet 5.',
      },
    });
  });

  it('falls back to a content-less system envelope for an unusable attachment (never throws)', () => {
    const [env] = translateSdkMessage({ type: 'attachment', attachment: {} });
    expect(env).toMatchObject({ type: 'system' });
    expect(env?.providerContext).toBeUndefined();
  });
});

describe('Host — provider-level context on the wire', () => {
  it('emits a chat.provider_context event carrying the label/text, with its own seq', async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    sdk.enqueue([
      {
        type: 'provider_context',
        providerContext: {
          providerType: 'total_tokens_reminder',
          label: 'Tokens remaining',
          text: '14,961,549 tokens left',
        },
      },
      { type: 'assistant', content: 'reply', sessionId: 'sess-P' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const providerEvents = events.filter(
      (e) => e.type === 'chat.provider_context' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{
      providerType: string;
      label: string;
      text: string;
      seq: number;
    }>;
    expect(providerEvents).toHaveLength(1);
    expect(providerEvents[0]).toMatchObject({
      providerType: 'total_tokens_reminder',
      label: 'Tokens remaining',
      text: '14,961,549 tokens left',
    });
    // seq 0 is the user turn, so this (arriving before the assistant reply)
    // takes seq 1 — a real position in the chat's own sequence, not a
    // side-channel that skips it.
    expect(providerEvents[0]?.seq).toBe(1);
    expect(metaStore.read(chatId)?.nextSeq).toBeGreaterThan(1);
  });

  it('is a no-op when the envelope names itself provider_context but carries none', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'provider_context' }, { type: 'assistant', content: 'hi' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    const providerEvents = events.filter((e) => e.type === 'chat.provider_context');
    expect(providerEvents).toHaveLength(0);
    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('history replay — a persisted provider-level attachment', () => {
  it('reconstructs it from the JSONL Claude Code writes, at the supplied canonical seq', () => {
    const line = JSON.stringify({
      parentUuid: 'p1',
      type: 'attachment',
      attachment: {
        type: 'environment',
        snapshot: { workingDirectory: '/home/tom/project', platform: 'linux' },
      },
      rendered: [
        {
          content:
            '<system-reminder>\n# Environment\n - Primary working directory: /home/tom/project\n</system-reminder>',
        },
      ],
      uuid: 'u1',
    });
    expect(jsonlLineToWire(line, 'c1', 5)).toEqual([
      {
        type: 'chat.provider_context',
        chatId: 'c1',
        seq: 5,
        providerType: 'environment',
        label: 'Environment',
        text: expect.stringContaining('/home/tom/project'),
      },
    ]);
  });
});

// "File changed externally": a file the agent had read changed on disk outside
// it. Claude Code tells the agent with its own `edited_text_file` /
// `edited_image_file` attachment (never a Patch-built reminder), so it reaches
// the surface through this same provider-context path — live and on replay —
// under a name a human recognises rather than the raw attachment type.
describe('a file changed outside the agent', () => {
  const editedText = {
    type: 'attachment',
    uuid: 'u-edit',
    attachment: {
      type: 'edited_text_file',
      filename: '/home/tom/project/NOTES.md',
      displayPath: 'NOTES.md',
      snippet: '3\tbuy compost',
    },
    rendered: [
      {
        content:
          '<system-reminder>\nNote: /home/tom/project/NOTES.md changed on disk since you last read it.\n3\tbuy compost\n</system-reminder>',
      },
    ],
  };

  it('is labelled "File changed externally" live, with the rendered note as its text', () => {
    const [env] = translateSdkMessage(editedText);
    expect(env).toMatchObject({
      type: 'provider_context',
      providerContext: {
        providerType: 'edited_text_file',
        label: 'File changed externally',
        text: expect.stringContaining('NOTES.md changed on disk'),
      },
    });
  });

  it('replays identically from the persisted transcript line', () => {
    expect(jsonlLineToWire(JSON.stringify(editedText), 'c1', 9)).toEqual([
      {
        type: 'chat.provider_context',
        chatId: 'c1',
        seq: 9,
        providerType: 'edited_text_file',
        label: 'File changed externally',
        text: 'Note: /home/tom/project/NOTES.md changed on disk since you last read it.\n3\tbuy compost',
      },
    ]);
  });

  it('an edited image names the file and never dumps its base64 bytes', () => {
    const base64 = 'A'.repeat(50_000);
    const item = translateAttachment({
      type: 'attachment',
      attachment: {
        type: 'edited_image_file',
        filename: '/tmp/shot.png',
        content: { type: 'image', file: { base64 } },
      },
    });
    expect(item).toEqual({
      providerType: 'edited_image_file',
      label: 'Image changed externally',
      text: '/tmp/shot.png changed on disk since the agent last read it.',
    });
  });

  it('reaches the surface as a chat.provider_context event on a live turn', async () => {
    const { daemon, sdk, events, folder } = setup();
    const [env] = translateSdkMessage(editedText);
    sdk.enqueue([env!, { type: 'assistant', content: 'noted', sessionId: 'sess-F' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    const got = events.filter(
      (e) => e.type === 'chat.provider_context' && (e as { chatId: string }).chatId === chatId,
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      providerType: 'edited_text_file',
      label: 'File changed externally',
      text: expect.stringContaining('NOTES.md changed on disk'),
    });
  });
});
