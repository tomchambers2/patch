// Document editor — modes, suggestions, comments, history (spec/14 § Document
// editor, step 2 of 3). Exercises the `Daemon` methods the server's
// `patch.doc.request`/`patch.doc_action.request` RPCs and the agent's
// `patch_doc_suggest`/`patch_doc_comment`/`patch_doc_reply` tools (mcp.ts →
// `/internal/doc/*`, control.ts) all resolve to.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
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
  const home = mkdtempSync(join(tmpdir(), 'patch-doc-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-doc-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const capturedPrompts: string[] = [];
  let id = 0;
  let now = 1_700_000_000_000;
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
    now: () => now,
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-doc-claude-')),
    }),
  });
  return {
    daemon,
    events,
    folder,
    capturedPrompts,
    advanceClock: (ms: number) => {
      now += ms;
    },
  };
}

describe('document editor — modes (spec/14 § Document editor)', () => {
  it('defaults to change mode for a document with no sidecar', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), '# Notes\n');

    const view = daemon.getDocView(chatId, 'notes.md');
    expect(view).toEqual({ ok: true, value: expect.objectContaining({ mode: 'change' }) });
  });

  it('setDocMode switches the mode and it sticks across reads', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), '# Notes\n');

    const set = daemon.setDocMode(chatId, 'notes.md', 'propose');
    expect(set.ok && set.value.mode).toBe('propose');
    const read = daemon.getDocView(chatId, 'notes.md');
    expect(read.ok && read.value.mode).toBe('propose');
  });

  it('refuses a doc action against an unknown chat', async () => {
    const { daemon } = setup();
    const result = daemon.getDocView('no-such-chat', 'notes.md');
    expect(result).toEqual({ ok: false, code: 'chat_not_found', message: expect.any(String) });
  });

  it('refuses a doc action against a file that does not exist', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const result = daemon.getDocView(chatId, 'missing.md');
    expect(result).toEqual({ ok: false, code: 'not_found', message: expect.any(String) });
  });

  it('refuses a doc action whose path escapes the chat folder', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const result = daemon.getDocView(chatId, '../outside.md');
    expect(result.ok).toBe(false);
    expect(result.ok || result.code).toBe('path_escape');
  });
});

describe('document editor — suggestions (spec/14 § Document editor — Propose mode)', () => {
  it('patch_doc_suggest (suggestDoc) is refused outside propose mode, naming the mode', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');

    const result = daemon.suggestDoc(chatId, 'notes.md', 'world', 'there');
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain('change mode');
  });

  it('creates a pending suggestion in propose mode, requiring a unique find', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');

    const result = daemon.suggestDoc(chatId, 'notes.md', 'world', 'there');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ find: 'world', replace: 'there', status: 'pending' });

    const view = daemon.getDocView(chatId, 'notes.md');
    expect(view.ok && view.value.suggestions).toHaveLength(1);
    // The document is untouched — a suggestion is tracked, not applied.
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('Hello world.\n');
  });

  it('refuses a non-unique find at creation time', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'one one one\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');

    const result = daemon.suggestDoc(chatId, 'notes.md', 'one', 'ONE');
    expect(result.ok).toBe(false);
    expect(result.ok || result.code).toBe('conflict');
  });

  it('accepting a suggestion applies it and records one version', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');
    const created = daemon.suggestDoc(chatId, 'notes.md', 'world', 'there');
    if (!created.ok) throw new Error('setup failed');

    const accepted = daemon.acceptDocSuggestion(chatId, 'notes.md', created.value.id);
    expect(accepted.ok).toBe(true);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('Hello there.\n');
    if (!accepted.ok) return;
    expect(accepted.value.suggestions[0]).toMatchObject({ status: 'accepted' });
    expect(accepted.value.versions.map((v) => v.content)).toContain('Hello there.\n');
    expect(accepted.value.versions.at(-1)!.savedBy).toBe('user');
  });

  it('rejecting a suggestion leaves the document untouched', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');
    const created = daemon.suggestDoc(chatId, 'notes.md', 'world', 'there');
    if (!created.ok) throw new Error('setup failed');

    const rejected = daemon.rejectDocSuggestion(chatId, 'notes.md', created.value.id);
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.suggestions[0]).toMatchObject({ status: 'rejected' });
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('Hello world.\n');
  });

  it('accepting an already-resolved suggestion is a conflict', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');
    const created = daemon.suggestDoc(chatId, 'notes.md', 'world', 'there');
    if (!created.ok) throw new Error('setup failed');
    daemon.rejectDocSuggestion(chatId, 'notes.md', created.value.id);

    const result = daemon.acceptDocSuggestion(chatId, 'notes.md', created.value.id);
    expect(result.ok).toBe(false);
    expect(result.ok || result.code).toBe('conflict');
  });

  it('accept all applies every pending suggestion in one write', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'one two three\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');
    daemon.suggestDoc(chatId, 'notes.md', 'one', 'ONE');
    daemon.suggestDoc(chatId, 'notes.md', 'three', 'THREE');

    const result = daemon.acceptAllDocSuggestions(chatId, 'notes.md');
    expect(result.ok).toBe(true);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('ONE two THREE\n');
    if (!result.ok) return;
    expect(result.value.suggestions.every((s) => s.status === 'accepted')).toBe(true);
  });

  it('accept all skips (leaves pending) a suggestion whose find no longer matches', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'one two\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');
    const stale = daemon.suggestDoc(chatId, 'notes.md', 'one', 'ONE');
    if (!stale.ok) throw new Error('setup failed');
    // The document moves out from under the suggestion before accept-all runs.
    daemon.setDocMode(chatId, 'notes.md', 'change');
    daemon.writeFile(chatId, 'notes.md', 'completely different text\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');

    const result = daemon.acceptAllDocSuggestions(chatId, 'notes.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestions.find((s) => s.id === stale.value.id)?.status).toBe('pending');
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('completely different text\n');
  });

  it('reject all marks every pending suggestion rejected, untouched otherwise', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'one two\n');
    daemon.setDocMode(chatId, 'notes.md', 'propose');
    daemon.suggestDoc(chatId, 'notes.md', 'one', 'ONE');
    daemon.suggestDoc(chatId, 'notes.md', 'two', 'TWO');

    const result = daemon.rejectAllDocSuggestions(chatId, 'notes.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestions.every((s) => s.status === 'rejected')).toBe(true);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('one two\n');
  });
});

describe('document editor — comments both ways (spec/14 § Document editor)', () => {
  it("a user comment reaches the agent's next turn as a system-reminder naming the thread, then clears", async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');

    const created = daemon.addDocComment(chatId, 'notes.md', 'Hello', 'is this the right tone?');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const threadId = created.value.threads[0]!.id;

    await daemon.sendInput({ chatId, message: 'carry on', localId: randomUUID() });
    const prompt = capturedPrompts.at(-1) ?? '';
    expect(prompt).toContain('<system-reminder>');
    expect(prompt).toContain('notes.md');
    expect(prompt).toContain(threadId);
    expect(prompt).toContain('is this the right tone?');
    expect(prompt).toContain('patch_doc_reply');
    expect(prompt.endsWith('carry on')).toBe(true);

    await daemon.sendInput({ chatId, message: 'second turn', localId: randomUUID() });
    expect(capturedPrompts.at(-1)).toBe('second turn');
  });

  it("the agent's own patch_doc_comment/patch_doc_reply never queue a reminder", async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');

    daemon.agentDocComment(chatId, 'notes.md', 'Hello', 'noting this is a placeholder');
    await daemon.sendInput({ chatId, message: 'go', localId: randomUUID() });
    expect(capturedPrompts.at(-1)).toBe('go');
  });

  it('a reply appends to the existing thread rather than opening a new one', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');
    const created = daemon.addDocComment(chatId, 'notes.md', 'Hello', 'question?');
    if (!created.ok) throw new Error('setup failed');
    const threadId = created.value.threads[0]!.id;

    daemon.agentDocReply(chatId, 'notes.md', threadId, 'answer.');
    const view = daemon.getDocView(chatId, 'notes.md');
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.threads).toHaveLength(1);
    expect(view.value.threads[0]!.comments.map((c) => [c.author, c.text])).toEqual([
      ['user', 'question?'],
      ['agent', 'answer.'],
    ]);
  });

  it('replying to an unknown thread is a not_found error', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');

    const result = daemon.replyDocComment(chatId, 'notes.md', 'no-such-thread', 'hi');
    expect(result.ok).toBe(false);
    expect(result.ok || result.code).toBe('not_found');
  });

  it('resolving a thread collapses it; reopening un-resolves it', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'Hello world.\n');
    const created = daemon.addDocComment(chatId, 'notes.md', 'Hello', 'q?');
    if (!created.ok) throw new Error('setup failed');
    const threadId = created.value.threads[0]!.id;

    const resolved = daemon.resolveDocThread(chatId, 'notes.md', threadId, true);
    expect(resolved.ok && resolved.value.threads[0]!.resolved).toBe(true);

    const reopened = daemon.resolveDocThread(chatId, 'notes.md', threadId, false);
    expect(reopened.ok && reopened.value.threads[0]!.resolved).toBe(false);
  });
});

describe('document editor — history (spec/14 § Document editor)', () => {
  it('every surface save is a version, attributed to the user', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'v1\n');

    daemon.writeFile(chatId, 'notes.md', 'v2\n');
    daemon.writeFile(chatId, 'notes.md', 'v3\n');

    const view = daemon.getDocView(chatId, 'notes.md');
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.versions.map((v) => [v.content, v.savedBy])).toEqual([
      ['v2\n', 'user'],
      ['v3\n', 'user'],
    ]);
  });

  it('a save with the same content already on disk is not a new version', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'same\n');

    daemon.writeFile(chatId, 'notes.md', 'same\n');

    const view = daemon.getDocView(chatId, 'notes.md');
    expect(view.ok && view.value.versions).toHaveLength(0);
  });

  it('restoring an earlier version writes it back and records a version stamped restoredFrom', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.writeFile(chatId, 'notes.md', 'v1\n');
    daemon.writeFile(chatId, 'notes.md', 'v2\n');
    const before = daemon.getDocView(chatId, 'notes.md');
    if (!before.ok) throw new Error('setup failed');
    const v1Id = before.value.versions[0]!.id;

    const restored = daemon.restoreDocVersion(chatId, 'notes.md', v1Id);
    expect(restored.ok).toBe(true);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('v1\n');
    if (!restored.ok) return;
    const last = restored.value.versions.at(-1)!;
    expect(last.content).toBe('v1\n');
    expect(last.restoredFrom).toBe(v1Id);
  });

  it('restoring an unknown version is a not_found error', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    writeFileSync(join(folder, 'notes.md'), 'v1\n');

    const result = daemon.restoreDocVersion(chatId, 'notes.md', 'no-such-version');
    expect(result.ok).toBe(false);
    expect(result.ok || result.code).toBe('not_found');
  });
});
