// The Claude SessionStore adapter (spec/04 § History — native resume cache +
// a seamless switch onto Claude).

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { LoggedEvent } from '@patch/wire';
import { createClaudeSessionStore } from '../src/claudeSessionStore.js';
import { encodeFolder } from '../src/history.js';
import type { TrackEntry } from '../src/nativeReconstruct.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'patch-claude-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function msg(role: 'user' | 'assistant', content: string): LoggedEvent {
  return { type: 'chat.message', chatId: 'c1', role, content, seq: 0 };
}

/** A reply the model wrote — the store hands it back untouched. */
const REAL_REPLY = {
  role: 'assistant',
  model: 'claude-opus-5-5',
  usage: { input_tokens: 3, output_tokens: 2 },
  content: [{ type: 'text', text: 'hello' }],
};

describe('createClaudeSessionStore', () => {
  it('append mirrors entries to disk and dedupes by uuid across calls', async () => {
    const nativeDir = join(tmp(), 'native', 'claude');
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir,
      claudeProjectsRoot: tmp(),
      logger: silent,
    });
    const key = { projectKey: 'p', sessionId: 'sess-1' };
    await store.append(key, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    ]);
    await store.append(key, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    ]); // retry, same uuid
    await store.append(key, [
      { type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: 'yo' } },
    ]);
    const lines = readFileSync(join(nativeDir, 'sess-1.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('append hands onAppend only the entries it newly wrote', async () => {
    const seen: string[][] = [];
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir: join(tmp(), 'native', 'claude'),
      claudeProjectsRoot: tmp(),
      logger: silent,
      onAppend: (entries) => seen.push(entries.map((e) => e.uuid ?? '')),
    });
    const key = { projectKey: 'p', sessionId: 'sess-1' };
    await store.append(key, [{ type: 'user', uuid: 'u1' }]);
    await store.append(key, [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]);
    await store.append(key, [{ type: 'user', uuid: 'u1' }]);
    expect(seen).toEqual([['u1'], ['u2']]);
  });

  it('append dedupes against entries already on disk from a PRIOR store instance (process restart)', async () => {
    const nativeDir = join(tmp(), 'native', 'claude');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      join(nativeDir, 'sess-1.jsonl'),
      JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n',
    );
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir,
      claudeProjectsRoot: tmp(),
      logger: silent,
    });
    await store.append({ projectKey: 'p', sessionId: 'sess-1' }, [{ type: 'user', uuid: 'u1' }]);
    const lines = readFileSync(join(nativeDir, 'sess-1.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('load returns the native mirror when it has one', async () => {
    const nativeDir = join(tmp(), 'native', 'claude');
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir,
      claudeProjectsRoot: tmp(),
      logger: silent,
    });
    const key = { projectKey: 'p', sessionId: 'sess-1' };
    await store.append(key, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: REAL_REPLY },
    ]);
    const loaded = await store.load(key);
    expect(loaded).toHaveLength(2);
    expect(loaded![0]).toMatchObject({ uuid: 'u1' });
  });

  it("load falls back to the harness's own on-disk transcript when there is no mirror yet", async () => {
    const claudeProjectsRoot = tmp();
    const dir = join(claudeProjectsRoot, encodeFolder('/w'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess-1.jsonl'),
      JSON.stringify({ type: 'user', uuid: 'legacy' }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'legacy',
          message: REAL_REPLY,
        }) +
        '\n',
    );
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir: join(tmp(), 'native', 'claude'),
      claudeProjectsRoot,
      logger: silent,
    });
    const loaded = await store.load({ projectKey: 'p', sessionId: 'sess-1' });
    expect(loaded).toHaveLength(2);
    expect(loaded![0]).toMatchObject({ uuid: 'legacy' });
  });

  it('load returns null for a session with no mirror and no local transcript', async () => {
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir: join(tmp(), 'native', 'claude'),
      claudeProjectsRoot: tmp(),
      logger: silent,
    });
    expect(await store.load({ projectKey: 'p', sessionId: 'never-seen' })).toBeNull();
  });

  it("load for the reseed target synthesizes from the chat's own track, ignoring any mirror/local file", async () => {
    const nativeDir = join(tmp(), 'native', 'claude');
    const events: TrackEntry[] = [
      { record: { seq: 0, at: 1 }, event: msg('user', 'plant a codeword') },
      { record: { seq: 1, at: 2 }, event: msg('assistant', 'the codeword is banana') },
    ];
    const store = createClaudeSessionStore({
      chatId: 'c1',
      folder: '/w',
      nativeDir,
      claudeProjectsRoot: tmp(),
      logger: silent,
      reseed: { sessionId: 'sess-new', events, model: 'claude-opus-5' },
    });
    const loaded = await store.load({ projectKey: 'p', sessionId: 'sess-new' });
    expect(loaded).toHaveLength(2);
    expect((loaded![1] as { message: { content: string } }).message.content).toContain('banana');
    // Never written to disk by load() itself — only append() (dual-write from
    // the live session that follows) touches the mirror.
    expect(existsSync(join(nativeDir, 'sess-new.jsonl'))).toBe(false);
  });
});
