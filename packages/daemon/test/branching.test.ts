// spec/04 § Branching (edit / fork a message) — a chat is a GRAPH, not a line.
// Editing a user turn forks a new TRACK from that turn: the prefix is shared,
// the original track is left intact, and the user switches between them.
//
// Driven against the mock SDK backend configured to persist a real
// Claude-Code-shaped JSONL transcript, so the fork point is resolved from a
// genuine transcript (the same on-disk contract the real SDK provides) rather
// than a hand-rolled stub.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatBranchesEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(opts: { turnDelayMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-branch-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-branch-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-branch-projects-'));
  const sdk = createMockSdkBackend({
    claudeProjectsRoot: projectsRoot,
    ...(opts.turnDelayMs !== undefined ? { turnDelayMs: opts.turnDelayMs } : {}),
  });
  const events: WireEvent[] = [];
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore };
}

function branchEvents(events: WireEvent[]): ChatBranchesEvent[] {
  return events.filter((e): e is ChatBranchesEvent => e.type === 'chat.branches');
}

function lastBranches(events: WireEvent[]): ChatBranchesEvent {
  const all = branchEvents(events);
  const last = all[all.length - 1];
  if (!last) throw new Error('no chat.branches event emitted');
  return last;
}

/** The replayed transcript, as the surface would see it. */
function replay(daemon: Daemon, chatId: string, branchId?: string): WireEvent[] {
  const out: WireEvent[] = [];
  daemon.replayChat(chatId, -1, (e) => out.push(e), branchId);
  return out;
}

function userMessages(events: WireEvent[]): Array<{ seq: number; content: string }> {
  return events
    .filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    )
    .map((e) => ({ seq: e.seq, content: e.content }));
}

describe('spec/04 § Branching — edit a user turn forks a new track', () => {
  it('forks at the edited turn: shared prefix kept, edit runs on a NEW session, original track untouched', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });

    const before = replay(daemon, chatId);
    const secondTurn = userMessages(before).find((m) => m.content === 'second question');
    expect(secondTurn).toBeDefined();
    const rootSessionId = metaStore.read(chatId)?.claudeSessionId;
    expect(rootSessionId).toBeTruthy();

    events.length = 0;
    await daemon.forkChat({
      chatId,
      seq: secondTurn!.seq,
      message: 'second question, rephrased',
      localId: 'l3',
    });

    // The graph is published: root + the new track, the new one active.
    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    const root = graph.branches[0]!;
    const forked = graph.branches[1]!;
    expect(root.parentBranchId).toBeNull();
    expect(root.forkFromSeq).toBeNull();
    expect(forked.parentBranchId).toBe(root.branchId);
    expect(forked.forkFromSeq).toBe(secondTurn!.seq);
    expect(graph.activeBranchId).toBe(forked.branchId);

    // The fork got its OWN Claude session — the original is not mutated.
    const meta = metaStore.read(chatId)!;
    expect(meta.claudeSessionId).toBeTruthy();
    expect(meta.claudeSessionId).not.toBe(rootSessionId);

    // The new track: shared prefix (`first question`) + the edited turn.
    // The turn it replaced is gone from THIS track.
    const after = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(after).toContain('first question');
    expect(after).toContain('second question, rephrased');
    expect(after).not.toContain('second question');
  });

  it('switching back to the original track restores its session and transcript', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    const rootSessionId = metaStore.read(chatId)!.claudeSessionId;
    const secondTurn = userMessages(replay(daemon, chatId)).find(
      (m) => m.content === 'second question',
    )!;

    await daemon.forkChat({
      chatId,
      seq: secondTurn.seq,
      message: 'second question, rephrased',
      localId: 'l3',
    });
    const rootBranchId = lastBranches(events).branches[0]!.branchId;

    events.length = 0;
    await daemon.switchBranch(chatId, rootBranchId);

    expect(lastBranches(events).activeBranchId).toBe(rootBranchId);
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(rootSessionId);
    const back = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(back).toContain('second question');
    expect(back).not.toContain('second question, rephrased');
    // Surfaces are told the chat changed underneath them.
    expect(events.some((e) => e.type === 'chat.state')).toBe(true);
  });

  it('the graph survives a host restart (persisted in meta.json)', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    await daemon.forkChat({ chatId, seq: turn.seq, message: 'rephrased', localId: 'l2' });
    const graph = lastBranches(events);

    const persisted = metaStore.read(chatId)!;
    expect(persisted.branches).toHaveLength(2);
    expect(persisted.activeBranchId).toBe(graph.activeBranchId);
  });

  it('a replay publishes the graph so a reconnecting surface learns the tracks', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    await daemon.forkChat({ chatId, seq: turn.seq, message: 'rephrased', localId: 'l2' });

    const out = replay(daemon, chatId);
    const graph = out.find((e): e is ChatBranchesEvent => e.type === 'chat.branches');
    expect(graph).toBeDefined();
    expect(graph!.branches).toHaveLength(2);
  });

  it('a chat that has never been forked publishes a single root track', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'only question', localId: 'l1' });

    const graph = replay(daemon, chatId).find(
      (e): e is ChatBranchesEvent => e.type === 'chat.branches',
    );
    expect(graph).toBeDefined();
    expect(graph!.branches).toHaveLength(1);
    expect(graph!.branches[0]!.parentBranchId).toBeNull();
    expect(graph!.activeBranchId).toBe(graph!.branches[0]!.branchId);
  });
});

describe('spec/04 § Branching — forking while a turn is running', () => {
  it('the fork QUEUES behind the running turn and still forks when it runs, not before', async () => {
    const { daemon, events, folder, metaStore } = setup({ turnDelayMs: 40 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    const rootSessionId = metaStore.read(chatId)!.claudeSessionId;

    // A turn is in flight when the edit lands (type-ahead, spec/04 § queueing).
    const inFlight = daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    await daemon.forkChat({ chatId, seq: turn.seq, message: 'rephrased', localId: 'l3' });
    await inFlight;

    // The running turn finished on the ORIGINAL session; the fork then ran on
    // its own — a fork carried through the queue forks when IT runs, never
    // earlier and never on someone else's turn.
    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    expect(graph.activeBranchId).toBe(graph.branches[1]!.branchId);
    expect(metaStore.read(chatId)!.claudeSessionId).not.toBe(rootSessionId);
    const after = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(after).toContain('rephrased');
    expect(after).not.toContain('second question');
  });
});

describe('spec/04 § Branching — NO FALLBACK on a bad fork/switch', () => {
  it('forking a seq that is not a user turn errors with fork_point_not_found and creates no branch', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    events.length = 0;
    await daemon.forkChat({ chatId, seq: 9999, message: 'nope', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('fork_point_not_found');
    expect(branchEvents(events)).toHaveLength(0);
    expect(metaStore.read(chatId)!.branches ?? []).toHaveLength(1);
  });

  it('switching to an unknown branch errors with branch_not_found and leaves the active track alone', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const sessionBefore = metaStore.read(chatId)!.claudeSessionId;

    events.length = 0;
    await daemon.switchBranch(chatId, 'branch-that-does-not-exist');

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('branch_not_found');
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(sessionBefore);
  });
});

describe('spec/04 § Side threads — a side message extends the graph SIDEWAYS', () => {
  it('keeps the prefix up to AND INCLUDING the message, and leaves the main track intact', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    const mainSessionId = metaStore.read(chatId)!.claudeSessionId;
    const firstTurn = userMessages(replay(daemon, chatId)).find(
      (m) => m.content === 'first question',
    )!;

    events.length = 0;
    await daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'a question on the side',
      localId: 'l3',
    });

    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    const side = graph.branches[1]!;
    expect(side.parentBranchId).toBe(graph.branches[0]!.branchId);
    expect(side.forkFromSeq).toBe(firstTurn.seq);
    expect(side.label).toMatch(/^side/);
    // spec/04 § Branching — "activeBranchId stays as the chat's main track":
    // a side branch runs independently and never becomes active, unlike an
    // edit fork. The main track's own session is therefore untouched too.
    expect(graph.activeBranchId).toBe(graph.branches[0]!.branchId);
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(mainSessionId);

    // The main track (the default/active replay) is completely undisturbed —
    // the side branch's content never lands on it.
    const onMain = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(onMain).toContain('first question');
    expect(onMain).toContain('second question');
    expect(onMain).not.toContain('a question on the side');

    // The side track: the message it hangs off is KEPT (unlike an edit, which
    // replaces it); the main track's continuation is not part of this track.
    // Requested explicitly by branchId — it is not what the chat's default
    // replay shows (spec/04 § Parallel branches: a side branch's content is
    // not broadcast into the one view a surface draws for this chat).
    const onSide = userMessages(replay(daemon, chatId, side.branchId)).map((m) => m.content);
    expect(onSide).toContain('first question');
    expect(onSide).toContain('a question on the side');
    expect(onSide).not.toContain('second question');
  });

  it('hangs off an ASSISTANT message too — asking about an answer is the common case', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const answer = replay(daemon, chatId).find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'assistant',
    );
    expect(answer).toBeDefined();

    events.length = 0;
    await daemon.sideChat({
      chatId,
      seq: answer!.seq,
      message: 'why did you say that?',
      localId: 'l2',
    });

    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    expect(graph.branches[1]!.forkFromSeq).toBe(answer!.seq);
    const side = graph.branches[1]!;
    expect(userMessages(replay(daemon, chatId, side.branchId)).map((m) => m.content)).toContain(
      'why did you say that?',
    );
  });

  it('NO FALLBACK: a seq with no transcript entry errors and creates no branch', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    events.length = 0;
    await daemon.sideChat({ chatId, seq: 9999, message: 'nope', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('fork_point_not_found');
    expect(branchEvents(events)).toHaveLength(0);
    expect(metaStore.read(chatId)!.branches ?? []).toHaveLength(1);
  });
});
