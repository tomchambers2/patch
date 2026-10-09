// spec/04 § Branching — "Every branch can take input and run independently":
// several branches of one chat can be mid-turn at once, each in its own
// session; permissions/questions route to the branch that raised them;
// archiving/stopping the chat stops every branch; the sidebar's aggregate
// status reflects the chat as a whole; and a side branch can send its
// conclusion back into its parent track.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatBranchesEvent, ChatMessageEvent, ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(
  opts: {
    turnDelayMs?: number;
    generateTitle?: (input: {
      chatId: string;
      firstUserMessage: string;
      folder: string;
    }) => Promise<string | null>;
    summarizeBranchSendBack?: (input: {
      chatId: string;
      branchId: string;
      folder: string;
      firstMessage: string;
      lastAssistantText: string;
    }) => Promise<string>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-parbranch-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-parbranch-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-parbranch-projects-'));
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
    ...(opts.generateTitle ? { generateTitle: opts.generateTitle } : {}),
    ...(opts.summarizeBranchSendBack
      ? { summarizeBranchSendBack: opts.summarizeBranchSendBack }
      : {}),
  });
  return { daemon, sdk, events, folder, metaStore };
}

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

function lastBranches(events: WireEvent[]): ChatBranchesEvent {
  const all = events.filter((e): e is ChatBranchesEvent => e.type === 'chat.branches');
  const last = all[all.length - 1];
  if (!last) throw new Error('no chat.branches event emitted');
  return last;
}

function lastState(events: WireEvent[]): ChatStateEvent {
  const all = events.filter((e): e is ChatStateEvent => e.type === 'chat.state');
  const last = all[all.length - 1];
  if (!last) throw new Error('no chat.state event emitted');
  return last;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('spec/04 § Branching — parallel branches', () => {
  it('two side branches run genuinely concurrently, not serially', async () => {
    const { daemon, events, folder } = setup({ turnDelayMs: 120 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    const start = Date.now();
    const a = daemon.sideChat({ chatId, seq: firstTurn.seq, message: 'side A', localId: 'a' });
    const b = daemon.sideChat({ chatId, seq: firstTurn.seq, message: 'side B', localId: 'b' });
    await Promise.all([a, b]);
    const elapsed = Date.now() - start;

    // Serial would be ~2×120ms; parallel is ~1×120ms. A generous ceiling
    // (1.8×) absorbs scheduling noise without passing a serial run.
    expect(elapsed).toBeLessThan(120 * 1.8);

    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(3); // root + 2 side branches
    const [, sideA, sideB] = graph.branches;
    expect(userMessages(replay(daemon, chatId, sideA!.branchId)).map((m) => m.content)).toContain(
      'side A',
    );
    expect(userMessages(replay(daemon, chatId, sideB!.branchId)).map((m) => m.content)).toContain(
      'side B',
    );
    // Neither side branch's content reached the main track's own replay.
    const onMain = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(onMain).not.toContain('side A');
    expect(onMain).not.toContain('side B');
  });

  it("a side branch's own question routes to it, tagged with its branchId — the active branch is unaffected", async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    events.length = 0;
    const sidePromise = daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: '[[sensitive-file-permission]] please',
      localId: 's1',
    });
    // Let the side branch reach its permission request before asserting.
    await sleep(20);

    const graph = lastBranches(events);
    const sideBranchId = graph.branches[1]!.branchId;
    const req = events.find((e) => e.type === 'chat.permission_request');
    expect(req).toBeDefined();
    expect((req as { branchId?: string }).branchId).toBe(sideBranchId);

    // The chat's aggregate status reflects it ("needs you")...
    const state = lastState(events);
    expect(state.activity).toBe('awaiting-permission');

    // ...but the ACTIVE branch's own turn was never touched — nothing is
    // running on it, and answering the side branch's question must not be
    // required for the main track to keep working.
    await daemon.sendInput({ chatId, message: 'meanwhile, on main', localId: 'main-1' });
    expect(userMessages(replay(daemon, chatId)).map((m) => m.content)).toContain(
      'meanwhile, on main',
    );

    // Answer the side branch's question so its turn settles cleanly.
    const requestId = (req as { requestId: string }).requestId;
    daemon.submitPermissionResponse({ requestId, decision: 'approve' });
    await sidePromise;
  });

  it('archiving the chat stops every branch, not just the active one', async () => {
    const { daemon, events, folder, metaStore } = setup({ turnDelayMs: 200 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    const sidePromise = daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'a long side thread',
      localId: 's1',
    });
    await sleep(20); // let the side branch's turn actually start

    await daemon.setArchived(chatId, true);
    // The abort unblocks the side branch's own turn promptly rather than
    // waiting out the full 200ms delay.
    await sidePromise;

    expect(metaStore.read(chatId)!.status).toBe('archived');
    const state = lastState(events);
    expect(state.activity).toBe('idle');
  });

  it('the sidebar status aggregates: a side branch working shows the chat as a whole working', async () => {
    const { daemon, events, folder } = setup({ turnDelayMs: 150 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    // The active branch is idle; only a side branch is working.
    expect(lastState(events).activity).toBe('idle');

    const sidePromise = daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'side work',
      localId: 's1',
    });
    await sleep(20);
    expect(lastState(events).activity).toBe('running');

    await sidePromise;
    expect(lastState(events).activity).toBe('idle');
  });

  it('a side branch is named from its first message, like a chat', async () => {
    const { daemon, events, folder } = setup({
      generateTitle: async ({ firstUserMessage }) => `Re: ${firstUserMessage.slice(0, 20)}`,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    await daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'name me please',
      localId: 's1',
    });
    // Title generation is fire-and-forget; give the microtask queue a turn.
    await sleep(10);

    const graph = lastBranches(events);
    const side = graph.branches[1]!;
    expect(side.name).toBe('Re: name me please');
  });

  it('a side branch has `running: true` on chat.branches while its turn is in flight, cleared once it settles', async () => {
    const { daemon, events, folder } = setup({ turnDelayMs: 100 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    const sidePromise = daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'side work',
      localId: 's1',
    });
    await sleep(20);
    const sideBranchId = lastBranches(events).branches[1]!.branchId;
    expect(lastBranches(events).branches.find((b) => b.branchId === sideBranchId)!.running).toBe(
      true,
    );
    // The active (root) branch is untouched by the side branch's own flag.
    expect(lastBranches(events).branches[0]!.running).toBeUndefined();

    await sidePromise;
    expect(lastBranches(events).branches.find((b) => b.branchId === sideBranchId)!.running).toBe(
      undefined,
    );
  });

  it('a side thread can branch again off a message inside another side thread, parented to it (not to the active branch)', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    await daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'go find out something',
      localId: 's1',
    });
    const sideBranchId = lastBranches(events).branches[1]!.branchId;
    // [0] is the shared prefix message ("first question", inherited from the
    // root); [1] is the side branch's OWN first turn ("go find out
    // something") — forking off that is what exercises nesting off content
    // that lives only on the side branch's own track.
    const sideFirstTurn = userMessages(replay(daemon, chatId, sideBranchId))[1]!;

    await daemon.sideChat({
      chatId,
      branchId: sideBranchId,
      seq: sideFirstTurn.seq,
      message: 'nested question',
      localId: 's2',
    });

    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(3);
    const nested = graph.branches[2]!;
    expect(nested.parentBranchId).toBe(sideBranchId);
    expect(nested.sideThread).toBe(true);
    expect(userMessages(replay(daemon, chatId, nested.branchId)).map((m) => m.content)).toContain(
      'nested question',
    );
    // Shares the prefix up to and including the message it hung off — the
    // side branch's own first turn — not the main track's.
    expect(userMessages(replay(daemon, chatId, nested.branchId)).map((m) => m.content)).toContain(
      'go find out something',
    );
  });

  it('nesting a side thread off an unknown branch is refused (branch_not_found), creating nothing', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    events.length = 0;
    await daemon.sideChat({
      chatId,
      branchId: 'no-such-branch',
      seq: firstTurn.seq,
      message: 'nested question',
      localId: 's2',
    });

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('branch_not_found');
    expect(daemon.branchesEvent(chatId).branches).toHaveLength(1); // just root — nothing created
  });

  it('a renamed branch is never overwritten by generation', async () => {
    const { daemon, folder, metaStore } = setup({
      generateTitle: async () => 'Generated Name',
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;
    await daemon.sideChat({ chatId, seq: firstTurn.seq, message: 'hi', localId: 's1' });
    const sideBranchId = metaStore.read(chatId)!.branches![1]!.branchId;

    daemon.renameBranch(chatId, sideBranchId, 'My Own Name');
    await sleep(10);

    expect(metaStore.read(chatId)!.branches!.find((b) => b.branchId === sideBranchId)!.name).toBe(
      'My Own Name',
    );
  });
});

describe('spec/04 § Send back', () => {
  it("a side branch's conclusion posts into its parent as a quiet row, and the parent's NEXT turn receives it", async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;

    await daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'go find out something',
      localId: 's1',
    });
    const graph = lastBranches(events);
    const sideBranchId = graph.branches[1]!.branchId;

    events.length = 0;
    const result = await daemon.sendBackToParent(chatId, sideBranchId);
    expect(result).toEqual({ ok: true });

    // The quiet row landed live, on the parent (main) track.
    const row = events.find(
      (e): e is ChatMessageEvent => e.type === 'chat.message' && e.branchSendBack !== undefined,
    );
    expect(row).toBeDefined();
    expect(row!.content).toContain('From');
    expect(row!.branchSendBack!.fromBranchId).toBe(sideBranchId);

    // The branch records that it was sent back.
    const graphAfter = lastBranches(events);
    expect(graphAfter.branches.find((b) => b.branchId === sideBranchId)!.sentBack).toBe(true);

    // The parent's NEXT turn receives the send-back as part of its own
    // context — visibly, as a disclosed systemContext entry — rather than
    // invisibly (principles.md § no invisible injection).
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'what happened?', localId: 'main-2' });
    const persistedUserTurn = events.find(
      (e): e is ChatMessageEvent =>
        e.type === 'chat.message' && e.role === 'user' && e.content === 'what happened?',
    );
    expect(persistedUserTurn).toBeDefined();
    expect(persistedUserTurn!.systemContext).toBeDefined();
    expect(persistedUserTurn!.systemContext![0]!.text).toContain('From');

    // Sending back twice is refused.
    const second = await daemon.sendBackToParent(chatId, sideBranchId);
    expect(second.ok).toBe(false);
  });

  it('the root branch has no parent to send back to', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'hello', localId: 'l1' });
    const rootBranchId = daemon.branchesEvent(chatId).branches[0]!.branchId;

    const result = await daemon.sendBackToParent(chatId, rootBranchId);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('root') });
  });
});

describe('spec/04 § Branching — edit forks are unchanged', () => {
  it('an edit fork still switches the active branch, exactly as before parallel branches existed', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const firstTurn = userMessages(replay(daemon, chatId))[0]!;
    const mainSessionId = metaStore.read(chatId)!.claudeSessionId;

    events.length = 0;
    await daemon.forkChat({
      chatId,
      seq: firstTurn.seq,
      message: 'edited question',
      localId: 'l2',
    });

    const graph = lastBranches(events);
    expect(graph.activeBranchId).toBe(graph.branches[1]!.branchId);
    expect(metaStore.read(chatId)!.claudeSessionId).not.toBe(mainSessionId);
  });
});
