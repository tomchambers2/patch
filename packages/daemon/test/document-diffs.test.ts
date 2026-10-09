// Document editor (spec/14 § Document editor, step 1 of 3) — "When you edit,
// the agent's next turn receives only what changed since it last saw the
// document, as a diff (visible in the transcript as a collapsed row, not
// invisible injection)." A surface save (`writeFile`, the same `file.write`
// path the file browser and the document editor both use) of a `.md` file
// queues a diff against what was on disk before; the chat's next turn
// prefixes that diff as a `<system-reminder>` (spec/02 § System-reminder
// disclosure's capture-and-disclose mechanism — the same one
// `todos-edit.test.ts` pins for the task-list reminder), then clears it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createHistoryReader } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-docdiff-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-docdiff-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const capturedPrompts: string[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: {
      run: async function* (opts: { prompt: string }) {
        capturedPrompts.push(opts.prompt);
        yield { type: 'assistant' as const, content: 'ok', sessionId: 'S1' };
      },
    },
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-docdiff-claude-')),
    }),
  });
  return { daemon, events, folder, capturedPrompts };
}

describe('document editor — diff-since-last-seen (spec/14 § Document editor)', () => {
  it("prefixes the chat's next turn with a <system-reminder> diff of the edited document", async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), '# Title\n\nOriginal line.\n');

    daemon.writeFile(chatId, 'notes.md', '# Title\n\nEdited line.\n');
    await daemon.sendInput({ chatId, message: 'carry on', localId: randomUUID() });

    const prompt = capturedPrompts.at(-1) ?? '';
    expect(prompt).toContain('<system-reminder>');
    expect(prompt).toContain('notes.md');
    expect(prompt).toContain('-Original line.');
    expect(prompt).toContain('+Edited line.');
    // The user's own words still terminate the prompt — the reminder is a
    // prefix, not a replacement.
    expect(prompt.endsWith('carry on')).toBe(true);
  });

  it('emits the live chat.message with the diff as systemContext, not inlined into content', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'before\n');
    daemon.writeFile(chatId, 'notes.md', 'after\n');
    events.length = 0;

    await daemon.sendInput({ chatId, message: 'carry on', localId: randomUUID() });

    const userMsg = events.find(
      (e) => e.type === 'chat.message' && 'role' in e && e.role === 'user',
    );
    expect(userMsg).toBeDefined();
    const systemContext = userMsg && 'systemContext' in userMsg ? userMsg.systemContext : undefined;
    expect(systemContext).toEqual([
      {
        source: 'patch',
        label: 'Document edited',
        text: expect.stringContaining('notes.md'),
      },
    ]);
    expect(userMsg && 'content' in userMsg ? userMsg.content : undefined).toBe('carry on');
  });

  it('sends that reminder once, not on every later turn', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'before\n');
    daemon.writeFile(chatId, 'notes.md', 'after\n');

    await daemon.sendInput({ chatId, message: 'first', localId: randomUUID() });
    await daemon.sendInput({ chatId, message: 'second', localId: randomUUID() });

    expect(capturedPrompts[0]).toContain('<system-reminder>');
    expect(capturedPrompts[1]).not.toContain('<system-reminder>');
    expect(capturedPrompts[1]).toBe('second');
  });

  it('diffs start-to-latest across a run of saves, not just the final keystroke', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'start\n');

    daemon.writeFile(chatId, 'notes.md', 'middle\n');
    daemon.writeFile(chatId, 'notes.md', 'final\n');
    await daemon.sendInput({ chatId, message: 'go', localId: randomUUID() });

    const prompt = capturedPrompts.at(-1) ?? '';
    expect(prompt).toContain('-start');
    expect(prompt).toContain('+final');
    expect(prompt).not.toContain('middle');
  });

  it('reports nothing when the file is saved back to exactly what it was', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'same\n');

    daemon.writeFile(chatId, 'notes.md', 'changed\n');
    daemon.writeFile(chatId, 'notes.md', 'same\n');
    await daemon.sendInput({ chatId, message: 'go', localId: randomUUID() });

    expect(capturedPrompts.at(-1)).toBe('go');
  });

  it('does not track a non-markdown file', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.ts'), 'const x = 1;\n');

    daemon.writeFile(chatId, 'notes.ts', 'const x = 2;\n');
    await daemon.sendInput({ chatId, message: 'go', localId: randomUUID() });

    expect(capturedPrompts.at(-1)).toBe('go');
  });

  it('leaves an unedited chat’s turns untouched', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });

    await daemon.sendInput({ chatId, message: 'hello', localId: randomUUID() });

    expect(capturedPrompts.at(-1)).toBe('hello');
  });

  it('folds into a fully-rewritten prompt too, not only a typed-text prefix', async () => {
    // `preprocessInput` rewriting the whole message (as a slash-command
    // expansion does) takes the OTHER branch of the fold — `rewrittenWhole`
    // rather than `head` — which this covers directly rather than via the
    // real command-expansion machinery.
    const home = mkdtempSync(join(tmpdir(), 'patch-docdiff-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-docdiff-folder-')));
    mkdirSync(folder, { recursive: true });
    const capturedPrompts: string[] = [];
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: async function* (opts: { prompt: string }) {
          capturedPrompts.push(opts.prompt);
          yield { type: 'assistant' as const, content: 'ok', sessionId: 'S1' };
        },
      },
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      historyReader: createHistoryReader({
        claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-docdiff-claude-')),
      }),
      preprocessInput: () => 'a wholly different prompt',
    });
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'before\n');
    daemon.writeFile(chatId, 'notes.md', 'after\n');

    await daemon.sendInput({ chatId, message: 'go', localId: randomUUID() });

    const prompt = capturedPrompts.at(-1) ?? '';
    expect(prompt).toContain('<system-reminder>');
    expect(prompt.endsWith('a wholly different prompt')).toBe(true);
  });

  it('a brand-new document diffs against an empty baseline', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });

    daemon.writeFile(chatId, 'new.md', '# New\n');
    await daemon.sendInput({ chatId, message: 'go', localId: randomUUID() });

    const prompt = capturedPrompts.at(-1) ?? '';
    expect(prompt).toContain('new.md');
    expect(prompt).toContain('+# New');
  });
});
