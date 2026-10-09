// patch/todo.md § Features to add — "todo list". Integration: on a real Host
// (autoAdvanceTodos on), a turn whose agent updates its native TodoWrite list
// and settles with pending items left triggers the host to fire the NEXT
// still-pending todo back into the SAME chat as a `[todo]`-prefixed turn — so the
// agent works its list one focused turn at a time instead of getting distracted.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Env = { type: string; [k: string]: unknown };
type TodoStatus = 'pending' | 'in_progress' | 'completed';

function todoWrite(items: Array<[string, TodoStatus]>): Env {
  return {
    type: 'tool_use',
    tool: {
      name: 'TodoWrite',
      args: {
        todos: items.map(([content, status]) => ({ content, status, activeForm: content })),
      },
      callId: `tw-${Math.random().toString(36).slice(2, 8)}`,
    },
  };
}

/**
 * Drop the leading `<system-reminder>` block(s) the host prepends to a turn —
 * what the user's message would be without the injected agent context. Scripts
 * key on that, so a test reads as the turn the chat actually shows.
 */
const withoutReminder = (prompt: string): string =>
  prompt.replace(/^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, '');

/**
 * A backend that emits a scripted TodoWrite list for each prompt, so the test
 * drives the agent's todo progression deterministically. `script[prompt]` gives
 * the todo list the agent "writes" during that turn.
 */
function scriptedBackend(script: Record<string, Array<[string, TodoStatus]>>) {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<Env> {
      prompts.push(opts.prompt);
      const list = script[withoutReminder(opts.prompt)];
      if (list) yield todoWrite(list);
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts };
}

function setup(backend: SdkBackend, opts: { autoAdvanceTodos?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-todo-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-todofolder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    autoAdvanceTodos: opts.autoAdvanceTodos ?? false,
  });
  return { daemon, folder, events };
}

const todoPrompts = (prompts: string[]): string[] =>
  prompts.map(withoutReminder).filter((p) => p.startsWith('[todo]'));

/** The most recent `chat.state` that carried a todo list. */
const lastTodos = (events: WireEvent[]): unknown =>
  [...events]
    .reverse()
    .map((e) => (e.type === 'chat.state' ? (e as { todos?: unknown }).todos : undefined))
    .find((t) => Array.isArray(t));

describe('todo auto-advance on the host (patch/todo.md § todo list)', () => {
  it('fires each next pending todo as a [todo] turn until the list is done', async () => {
    const { backend, prompts } = scriptedBackend({
      'do my chores': [
        ['sweep', 'pending'],
        ['mop', 'pending'],
      ],
      '[todo] sweep': [
        ['sweep', 'completed'],
        ['mop', 'pending'],
      ],
      '[todo] mop': [
        ['sweep', 'completed'],
        ['mop', 'completed'],
      ],
    });
    const { daemon, folder, events } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'do my chores', localId: 'u1' });
    await tick(120); // let the advance chain drain

    // The host worked the list one focused turn at a time, in order.
    expect(todoPrompts(prompts)).toEqual(['[todo] sweep', '[todo] mop']);
    // The chat settled with all todos completed — nothing left pending (read the
    // most-recent chat.state that carried a todo list).
    expect(lastTodos(events)).toEqual([
      { text: 'sweep', status: 'completed' },
      { text: 'mop', status: 'completed' },
    ]);
  });

  it('tells the agent, on the fired turn, to close the item out in TodoWrite', async () => {
    // The bug this guards: the fired turn used to be the bare `[todo] sweep`
    // line, which never told the agent that "sweep" is one of its own TodoWrite
    // items — so it did the work, never called TodoWrite, and the task sat
    // reading `pending` for ever even though its turn had finished.
    const { backend, prompts } = scriptedBackend({
      'do my chores': [['sweep', 'pending']],
      '[todo] sweep': [['sweep', 'completed']],
    });
    const { daemon, folder } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'do my chores', localId: 'u1' });
    await tick(120);

    const fired = prompts.find((p) => withoutReminder(p).startsWith('[todo]'));
    expect(fired).toBeDefined();
    expect(fired).toContain('<system-reminder>');
    expect(fired).toContain('TodoWrite');
    expect(fired).toContain('completed');
    // The reminder leads, so the persisted/displayed turn is just the [todo]
    // line — the surface never shows the injected XML.
    expect(withoutReminder(fired as string)).toBe('[todo] sweep');
  });

  it("emits the fired turn's reminder as systemContext on its chat.message (spec/02 § System-reminder disclosure)", async () => {
    const { backend } = scriptedBackend({
      'do my chores': [['sweep', 'pending']],
      '[todo] sweep': [['sweep', 'completed']],
    });
    const { daemon, folder, events } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'do my chores', localId: 'u1' });
    await tick(120);

    const firedMsg = events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user' && e.content === '[todo] sweep',
    );
    expect(firedMsg).toBeDefined();
    expect(firedMsg!.systemContext).toEqual([
      { source: 'patch', label: 'Todo item fired', text: expect.stringContaining('sweep') },
    ]);
    // The user's own turn carried no reminder, so it has no disclosure.
    const own = events.find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user' && e.content === 'do my chores',
    );
    expect(own!.systemContext).toBeUndefined();
  });

  it('marks a fired item that came back still pending as in progress, not pending', async () => {
    // A turn was demonstrably spent on the item, so showing it as `pending`
    // (never started) is a lie. It is NOT auto-completed — the agent stopped for
    // a reason — and it is NOT re-fired.
    const { backend, prompts } = scriptedBackend({
      'help me': [
        ['decide the colour', 'pending'],
        ['paint it', 'pending'],
      ],
      // The fired turn runs and never touches TodoWrite (no script entry).
    });
    const { daemon, folder, events } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.sendInput({ chatId, message: 'help me', localId: 'u1' });
    await tick(120);

    expect(todoPrompts(prompts)).toEqual(['[todo] decide the colour']);
    expect(lastTodos(events)).toEqual([
      { text: 'decide the colour', status: 'in_progress' },
      { text: 'paint it', status: 'pending' },
    ]);
  });

  it('does NOT re-fire a head todo the agent left pending (asked a question)', async () => {
    // The agent writes one todo and never completes it (it stopped to ask the
    // user something). The first settle fires it once; the follow-up settle must
    // NOT fire the same still-pending todo again — that would nag the agent in a
    // loop and steamroll the user's turn.
    const { backend, prompts } = scriptedBackend({
      'help me': [['decide the colour', 'pending']],
      '[todo] decide the colour': [['decide the colour', 'pending']],
    });
    const { daemon, folder } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'help me', localId: 'u1' });
    await tick(120);

    expect(todoPrompts(prompts)).toEqual(['[todo] decide the colour']);
  });

  it('mirrors the todo list onto chat.state so surfaces can show it', async () => {
    const { backend } = scriptedBackend({
      'plan it': [
        ['step one', 'in_progress'],
        ['step two', 'pending'],
      ],
      // Once fired, complete everything so the chain terminates.
      '[todo] step one': [
        ['step one', 'completed'],
        ['step two', 'completed'],
      ],
    });
    const { daemon, folder, events } = setup(backend, { autoAdvanceTodos: true });
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'plan it', localId: 'u1' });
    await tick(120);

    const withTodos = events.filter(
      (e) => e.type === 'chat.state' && Array.isArray((e as { todos?: unknown }).todos),
    ) as Array<{ todos: Array<{ text: string; status: string }> }>;
    expect(withTodos.length).toBeGreaterThan(0);
    // At least one chat.state carried the initial two-item list.
    expect(
      withTodos.some(
        (e) =>
          e.todos.length === 2 &&
          e.todos[0]?.text === 'step one' &&
          e.todos[1]?.text === 'step two',
      ),
    ).toBe(true);
  });

  it('does nothing when autoAdvanceTodos is off (default): no [todo] turns fire', async () => {
    const { backend, prompts } = scriptedBackend({
      'do my chores': [
        ['sweep', 'pending'],
        ['mop', 'pending'],
      ],
    });
    const { daemon, folder } = setup(backend); // flag defaults off
    const chatId = await daemon.spawnChat({ folder });
    await tick();

    await daemon.sendInput({ chatId, message: 'do my chores', localId: 'u1' });
    await tick(120);

    expect(todoPrompts(prompts)).toEqual([]);
  });
});
