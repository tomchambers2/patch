// spec/02 § Task list — the USER half of the task list. The agent's TodoWrite
// list is mirrored onto chat state (covered by todos.test.ts / chatRunner
// tests); these pin what happens when a SURFACE rewrites that list:
// `setTodos` adopts it wholesale and emits chat.state, the chat's next turn
// carries a <system-reminder> telling the agent to adopt it (its own TodoWrite
// state can't be written from out here), and that reminder is one-shot.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { TodoItem, WireEvent } from '@patch/wire';
import { ChatNotFoundError, Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createHistoryReader } from '../src/history.js';
import { buildTodoEditSystemReminder } from '../src/todos.js';

const silent = pino({ level: 'silent' });

const LIST: TodoItem[] = [
  { text: 'read the current indexer', status: 'completed' },
  { text: 'rebuild the index', status: 'in_progress' },
];

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-todos-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-todos-folder-')));
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
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-todos-claude-')),
    }),
  });
  return { daemon, events, folder, capturedPrompts };
}

describe('Host setTodos (spec/02 § Task list — surface edits)', () => {
  it('adopts the list wholesale and emits chat.state carrying it', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    daemon.setTodos(chatId, LIST);

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv).toBeDefined();
    expect(stateEv && 'todos' in stateEv && stateEv.todos).toEqual(LIST);
  });

  it('emits an empty list when the user deletes every task', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setTodos(chatId, LIST);
    events.length = 0;

    daemon.setTodos(chatId, []);

    const stateEv = events.find((e) => e.type === 'chat.state');
    expect(stateEv && 'todos' in stateEv && stateEv.todos).toEqual([]);
  });

  it("prefixes the chat's next turn with a <system-reminder> naming the edited list", async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setTodos(chatId, LIST);

    await daemon.sendInput({ chatId, message: 'carry on', localId: randomUUID() });

    const prompt = capturedPrompts.at(-1) ?? '';
    expect(prompt).toContain('<system-reminder>');
    expect(prompt).toContain('rebuild the index');
    expect(prompt).toContain('TodoWrite');
    // The user's own words still terminate the prompt — the reminder is a
    // prefix, not a replacement.
    expect(prompt.endsWith('carry on')).toBe(true);
  });

  it('emits the live chat.message with the reminder as systemContext, not inlined into content (spec/02 § System-reminder disclosure)', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setTodos(chatId, LIST);
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
        label: 'Todo list updated',
        text: expect.stringContaining('rebuild the index'),
      },
    ]);
    // The visible content is the user's own words only — the reminder rides
    // out-of-band, never inlined into what the transcript shows as typed.
    expect(userMsg && 'content' in userMsg ? userMsg.content : undefined).toBe('carry on');
  });

  it('sends that reminder once, not on every later turn', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setTodos(chatId, LIST);

    await daemon.sendInput({ chatId, message: 'first', localId: randomUUID() });
    await daemon.sendInput({ chatId, message: 'second', localId: randomUUID() });

    expect(capturedPrompts[0]).toContain('<system-reminder>');
    expect(capturedPrompts[1]).not.toContain('<system-reminder>');
    expect(capturedPrompts[1]).toBe('second');
  });

  it('leaves an unedited chat’s turns untouched', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });

    await daemon.sendInput({ chatId, message: 'hello', localId: randomUUID() });

    expect(capturedPrompts.at(-1)).toBe('hello');
  });

  it('throws ChatNotFoundError for an unknown chat', () => {
    const { daemon } = setup();
    expect(() => daemon.setTodos('nope', LIST)).toThrow(ChatNotFoundError);
  });
});

describe('buildTodoEditSystemReminder', () => {
  it('numbers the items with their status and ends with a blank line', () => {
    const block = buildTodoEditSystemReminder(LIST);
    expect(block).toContain('1. [completed] "read the current indexer"');
    expect(block).toContain('2. [in progress] "rebuild the index"');
    expect(block.endsWith('</system-reminder>\n\n')).toBe(true);
  });

  it('says the list was emptied when it is empty', () => {
    expect(buildTodoEditSystemReminder([])).toContain('emptied');
  });

  it("quotes item text so a newline can't break the numbered list", () => {
    const block = buildTodoEditSystemReminder([{ text: 'a\nb', status: 'pending' }]);
    expect(block).toContain('1. [pending] "a\\nb"');
  });
});
