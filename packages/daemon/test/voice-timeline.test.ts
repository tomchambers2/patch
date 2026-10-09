// spec/07 § Keeping voice and text as one conversation — a call is the chat it
// was started on, spoken. A fast-voice exchange (Gemini Live / OpenAI Realtime
// answering on its own) never runs an agent turn, yet it must land in the
// chat's timeline as ordinary messages, the reply streaming as it is spoken,
// and the agent's NEXT turn must be told what was said. The fast voice, in
// turn, is seeded from the chat's MOST RECENT messages, not its oldest page.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createHistoryReader } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup(opts: { costPerTurn?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-voicetl-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-voicetl-folder-')));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const capturedPrompts: string[] = [];
  let id = 0;
  let reply = 0;
  const costPerTurn = opts.costPerTurn;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: {
      run: async function* (opts: { prompt: string }) {
        capturedPrompts.push(opts.prompt);
        yield { type: 'assistant' as const, content: `reply ${++reply}`, sessionId: 'S1' };
        if (costPerTurn !== undefined) {
          yield {
            type: 'result' as const,
            sessionId: 'S1',
            raw: { type: 'result', total_cost_usd: costPerTurn },
          };
        }
      },
    },
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-voicetl-claude-')),
    }),
  });
  return { daemon, events, folder, capturedPrompts };
}

const messages = (events: WireEvent[]) =>
  events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message',
  );

describe('voice exchanges in the chat timeline', () => {
  it('records a spoken utterance and the fast voice reply as ordinary messages, with no agent turn', async () => {
    const { daemon, events, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    daemon.recordVoiceMessage({ chatId, role: 'user', content: '[voice • web] what is a nebula' });
    daemon.recordVoiceMessage({ chatId, role: 'assistant', content: 'A cloud of gas and dust.' });

    expect(capturedPrompts).toEqual([]);
    const msgs = messages(events);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', '[voice • web] what is a nebula'],
      ['assistant', 'A cloud of gas and dust.'],
    ]);
    expect(msgs[1]!.seq).toBe(msgs[0]!.seq + 1);

    // Durable: a fresh read of the chat's history has both.
    const { events: hist } = daemon.readHistory({ chatId, limit: 200 });
    expect(
      messages(hist)
        .map((m) => m.content)
        .slice(-2),
    ).toEqual(['[voice • web] what is a nebula', 'A cloud of gas and dust.']);
  });

  it('streams a fast-voice reply as deltas on a reserved seq, then finalises it on that seq', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;

    const seq = daemon.reserveVoiceSeq(chatId);
    daemon.emitVoiceDelta(chatId, seq, 'A cloud ');
    daemon.emitVoiceDelta(chatId, seq, 'of gas.');
    daemon.recordVoiceMessage({ chatId, role: 'assistant', content: 'A cloud of gas.', seq });

    const deltas = events.filter((e) => e.type === 'chat.message_delta');
    expect(deltas).toEqual([
      { type: 'chat.message_delta', chatId, messageSeq: seq, delta: 'A cloud ' },
      { type: 'chat.message_delta', chatId, messageSeq: seq, delta: 'of gas.' },
    ]);
    const final = messages(events).at(-1)!;
    expect(final.seq).toBe(seq);
    expect(final.content).toBe('A cloud of gas.');
  });

  it("tells the agent's next turn what was said by voice, once, as a disclosed reminder", async () => {
    const { daemon, events, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.recordVoiceMessage({ chatId, role: 'user', content: '[voice • web] what is a nebula' });
    daemon.recordVoiceMessage({ chatId, role: 'assistant', content: 'A cloud of gas and dust.' });
    events.length = 0;

    await daemon.sendInput({ chatId, message: 'make me notes on that', localId: randomUUID() });
    await daemon.sendInput({ chatId, message: 'thanks', localId: randomUUID() });

    const first = capturedPrompts[0] ?? '';
    expect(first).toContain('<system-reminder>');
    expect(first).toContain('User: what is a nebula');
    expect(first).toContain('Voice: A cloud of gas and dust.');
    expect(first.endsWith('make me notes on that')).toBe(true);
    expect(capturedPrompts[1]).toBe('thanks');

    const userMsg = messages(events).find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('make me notes on that');
    expect(userMsg && 'systemContext' in userMsg ? userMsg.systemContext : undefined).toEqual([
      { source: 'patch', label: 'Voice conversation', text: expect.stringContaining('nebula') },
    ]);
  });

  it('does not replay voice exchanges the agent already saw', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.recordVoiceMessage({ chatId, role: 'user', content: '[voice • web] one' });
    await daemon.sendInput({ chatId, message: 'a', localId: randomUUID() });
    daemon.recordVoiceMessage({ chatId, role: 'user', content: '[voice • web] two' });
    await daemon.sendInput({ chatId, message: 'b', localId: randomUUID() });

    expect(capturedPrompts[1]).toContain('User: two');
    expect(capturedPrompts[1]).not.toContain('User: one');
  });
});

describe('voice context — what the fast voice is seeded with', () => {
  it("returns the chat's MOST RECENT messages within the budget, newest kept, in order", async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // Far more than one 200-event history page.
    for (let i = 0; i < 260; i++) {
      daemon.recordVoiceMessage({
        chatId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      });
    }
    const ctx = daemon.voiceContext(chatId, { maxChars: 40 });
    const texts = ctx.turns.map((t) => t.text);
    expect(texts.at(-1)).toBe('m259');
    expect(texts).not.toContain('m0');
    expect(texts.join('').length).toBeLessThanOrEqual(40);
    // Chronological, alternating roles mapped to the provider's vocabulary.
    expect(texts).toEqual([...texts].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    expect(ctx.turns.at(-1)!.role).toBe('model');
  });

  it('gives a call how the chat began, even when that is long ago', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.recordVoiceMessage({
      chatId,
      role: 'user',
      content: '[voice • web] fix the voice call',
    });
    for (let i = 0; i < 6; i++) {
      daemon.recordVoiceMessage({
        chatId,
        role: 'assistant',
        content: `status ${i} ${'x'.repeat(30)}`,
      });
    }
    // A budget that leaves the first message out of the recent turns.
    const ctx = daemon.voiceContext(chatId, { maxChars: 120 });
    expect(ctx.turns.some((t) => t.text === 'fix the voice call')).toBe(false);
    expect(ctx.opening).toBe('fix the voice call');
  });

  it('strips the voice tag and leaves out system messages', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.recordVoiceMessage({ chatId, role: 'user', content: '[voice • mobile] hello there' });
    const ctx = daemon.voiceContext(chatId, { maxChars: 10_000 });
    expect(ctx.turns).toEqual([{ role: 'user', text: 'hello there' }]);
  });
});

describe('call summary (spec/07 § Call cost)', () => {
  it('leaves the call summary in the chat as a system note, not a turn', async () => {
    const { daemon, events, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    daemon.recordCallSummary(chatId, 'Call 0:52 · Gemini Flash · $0.017');
    expect(capturedPrompts).toEqual([]);
    expect(messages(events).map((m) => [m.role, m.content])).toEqual([
      ['system', '[call] Call 0:52 · Gemini Flash · $0.017'],
    ]);
    // Never owed to the agent as a voice exchange.
    await daemon.sendInput({ chatId, message: 'x', localId: randomUUID() });
    expect(capturedPrompts[0]).toBe('x');
  });
});

describe("a hand-off turn (spec/07 § The fast voice and the chat's agent)", () => {
  it('tells the agent to do only the spoken request, and a typed turn gets no such note', async () => {
    const { daemon, folder, capturedPrompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({
      chatId,
      message: 'ls the folder',
      localId: randomUUID(),
      voicePrefix: '[voice hand-off • web] ',
    });
    await daemon.sendInput({ chatId, message: 'typed', localId: randomUUID() });
    expect(capturedPrompts[0]).toContain('relayed to you by the call');
    expect(capturedPrompts[0]).toContain('do not resume, continue or report on any other work');
    expect(capturedPrompts[0]).toContain('[voice hand-off • web] ls the folder');
    expect(capturedPrompts[1]).not.toContain('relayed to you by the call');
  });
});

describe('looking back in a chat (spec/07 § Keeping voice and text as one conversation)', () => {
  async function chatWith(lines: Array<['user' | 'assistant', string]>) {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    for (const [role, content] of lines) daemon.recordVoiceMessage({ chatId, role, content });
    return { daemon, chatId };
  }

  it('returns the messages that match the most words, oldest first, each shortened', async () => {
    const { daemon, chatId } = await chatWith([
      ['user', 'the archive request fails on the server'],
      ['assistant', 'weather is fine today'],
      ['user', 'why did the chat get archived last night'],
      ['assistant', `archived by a client on your IP ${'x'.repeat(600)}`],
    ]);
    const out = daemon.searchChat(chatId, 'archived chat');
    const lines = out.split('\n');
    expect(lines[0]).toBe('User: why did the chat get archived last night');
    expect(lines.some((l) => l.includes('weather'))).toBe(false);
    expect(lines.at(-1)!.length).toBeLessThan(420);
    expect(lines.at(-1)).toMatch(/^Agent: archived by a client/);
  });

  it('says plainly when nothing matches or there is nothing to search for', async () => {
    const { daemon, chatId } = await chatWith([['user', 'hello there']]);
    expect(daemon.searchChat(chatId, 'zebra')).toBe('Nothing in this chat matches "zebra".');
    expect(daemon.searchChat(chatId, 'a an')).toMatch(/key words/);
  });

  it('leaves out the voice tag, and fails for a chat that does not exist', async () => {
    const { daemon, chatId } = await chatWith([['user', '[voice • web] the oven is broken']]);
    expect(daemon.searchChat(chatId, 'oven')).toBe('User: the oven is broken');
    expect(() => daemon.searchChat('no-such-chat', 'oven')).toThrow();
  });

  it("hands a call the chat's goal, open to-dos and status alongside its history", async () => {
    const { daemon, chatId } = await chatWith([['user', 'fix the voice call']]);
    daemon.setTodos(chatId, [
      { text: 'write tests', status: 'completed' },
      { text: 'deploy it', status: 'pending' },
    ]);
    const ctx = daemon.voiceContext(chatId, { maxChars: 10_000 });
    expect(ctx.openTodos).toEqual(['deploy it']);
    expect(ctx.status).toBeNull();
    expect(ctx.goal).toBeNull();
  });
});
