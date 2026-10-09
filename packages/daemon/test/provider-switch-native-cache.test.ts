// spec/04 § History — preserve the cached prefix: a return to a harness a
// track used before must resume ITS OWN prior session and hand over only the
// delta, not rebuild the whole track from scratch. Only the delta pays for
// re-reading; everything before the switch still rides the target's own
// prompt cache.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import {
  createMockSdkBackend,
  type SdkBackend,
  type SdkEnvelope,
  type SdkRunOptions,
} from '../src/sdkBackend.js';
import { isCodexModel } from '../src/codexAccounts.js';

const silent = pino({ level: 'silent' });
const CLAUDE_MODEL = 'claude-opus-5';
const CODEX_MODEL = 'openai/mock-codex';

/** A minimal Codex-shaped mock: reuses a `codex-…` resumeSessionId when given
 * one (mirroring the real backend's resume behaviour), else mints a fresh
 * one. Records every call so a test can inspect exactly what it was asked to
 * inject. */
function createMockCodexBackend(
  knownSessions: Set<string>,
): SdkBackend & { lastOptions: () => SdkRunOptions | undefined } {
  let counter = 0;
  let last: SdkRunOptions | undefined;
  return {
    lastOptions: () => last,
    async *run(opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> {
      last = opts;
      const prior =
        opts.resumeSessionId?.startsWith('codex-') === true ? opts.resumeSessionId : undefined;
      const sessionId = prior ?? `codex-${++counter}`;
      knownSessions.add(sessionId);
      yield { type: 'system', sessionId };
      yield { type: 'assistant', content: `mock codex reply to: ${opts.prompt}` };
      yield { type: 'result', sessionId };
    },
  };
}

function setup(
  opts: {
    generateDigest?: (input: {
      chatId: string;
      resumeSessionId: string;
      folder: string;
    }) => Promise<string | null>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-switch-cache-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-switch-cache-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-switch-cache-projects-'));
  const mockClaude = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  const codexKnownSessions = new Set<string>();
  const mockCodex = createMockCodexBackend(codexKnownSessions);
  const routedBackend: SdkBackend = {
    run: (opts) => (isCodexModel(opts.model) ? mockCodex.run(opts) : mockClaude.run(opts)),
  };
  const claudeHistory = createHistoryReader({ claudeProjectsRoot: projectsRoot });
  const historyReader = {
    hasSession: (o: { folder: string; sessionId: string }) =>
      o.sessionId.startsWith('codex-')
        ? codexKnownSessions.has(o.sessionId)
        : claudeHistory.hasSession(o),
    read: (o: Parameters<typeof claudeHistory.read>[0]) => claudeHistory.read(o),
    forkPoint: (o: Parameters<typeof claudeHistory.forkPoint>[0]) => claudeHistory.forkPoint(o),
    sidePoint: (o: Parameters<typeof claudeHistory.sidePoint>[0]) => claudeHistory.sidePoint(o),
  };
  const events: WireEvent[] = [];
  const metaStore = createMetaStore(home);
  let id = 0;
  let clock = 1_700_000_000_000;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: routedBackend,
    historyReader,
    claudeProjectsRoot: projectsRoot,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => clock,
    generateChatId: () => `chat-${++id}`,
    ...(opts.generateDigest ? { generateDigest: opts.generateDigest } : {}),
  });
  return {
    daemon,
    mockClaude,
    mockCodex,
    codexKnownSessions,
    events,
    folder,
    metaStore,
    home,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}

function sessionChangeEvents(events: WireEvent[]) {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
      e.type === 'chat.message' && e.sessionChange !== undefined,
  );
}

describe('spec/04 § History — riding the cache back across a provider switch', () => {
  it('a first-ever switch to a harness rebuilds from scratch (no prior session to resume)', async () => {
    const { daemon, mockCodex, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });

    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'hello codex', localId: 'l2' });

    const opts = mockCodex.lastOptions()!;
    expect(opts.codexReseed).toBeDefined();
    expect(opts.codexAppendItems).toBeUndefined();
    // Full track: the user+assistant pair from turn 1.
    expect(opts.codexReseed!.events).toHaveLength(2);

    // The OUTGOING (Claude) session got stashed for a later return trip.
    const meta = metaStore.read(chatId)!;
    const branch = meta.branches!.find((b) => b.branchId === meta.activeBranchId)!;
    expect(branch.harnessSessions?.claude).toBeDefined();
    expect(branch.harnessSessions!.claude!.sessionId).not.toMatch(/^codex-/);
  });

  it('a return to a previously-used harness resumes its OWN session and sends only the delta', async () => {
    const { daemon, mockClaude, mockCodex, folder, metaStore, home } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    const claudeSessionA = metaStore.read(chatId)!.claudeSessionId!;

    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'hello codex', localId: 'l2' });
    const codexSessionB = metaStore.read(chatId)!.claudeSessionId!;
    expect(codexSessionB).toMatch(/^codex-/);

    await daemon.setChatModel(chatId, CLAUDE_MODEL);
    await daemon.sendInput({ chatId, message: 'back to claude', localId: 'l3' });

    // Resumed the SAME Claude session — not a fresh one, not rebuilt.
    const claudeOpts = mockClaude.lastOptions()!;
    expect(claudeOpts.resumeSessionId).toBe(claudeSessionA);
    expect(claudeOpts.claudeSessionStore?.reseed).toBeUndefined();
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(claudeSessionA);

    // The mirror got exactly the DELTA (the codex turn), threaded onto
    // whatever was already known about this session (not rebuilt).
    const nativeDir = join(home, 'chats', chatId, 'native', 'claude');
    const mirrorPath = join(nativeDir, `${claudeSessionA}.jsonl`);
    expect(existsSync(mirrorPath)).toBe(true);
    const mirrorLines = readFileSync(mirrorPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { message?: { content?: unknown }; parentUuid?: string });
    const texts = mirrorLines.map((l) =>
      typeof l.message?.content === 'string' ? l.message.content : JSON.stringify(l.message),
    );
    expect(texts.some((t) => t.includes('hello codex'))).toBe(true);
    expect(texts.some((t) => t.includes('mock codex reply'))).toBe(true);
    // This session's content lived only on local disk before this switch (the
    // mock backend never drives the SessionStore during an ordinary turn, so
    // there was no mirror yet) — seeded into the mirror alongside the delta so
    // a LATER resume finds the union here, not just the delta.
    expect(texts.some((t) => t.includes('hello claude'))).toBe(true);

    // The delta threads onto the seeded prefix, not a disconnected second root.
    expect(mirrorLines[0]!.parentUuid).toBeFalsy();
    const deltaEntry = mirrorLines.find((l) =>
      typeof l.message?.content === 'string' ? l.message.content.includes('hello codex') : false,
    )!;
    expect(deltaEntry.parentUuid).toBeTruthy();

    // And the RETURN to Codex, later, resumes codex's own thread + delta too.
    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'codex again', localId: 'l4' });
    const codexOpts = mockCodex.lastOptions()!;
    expect(codexOpts.resumeSessionId).toBe(codexSessionB);
    expect(codexOpts.codexAppendItems).toBeDefined();
    expect(codexOpts.codexReseed).toBeUndefined();
    // Delta only: the "back to claude" exchange (2 messages) plus the
    // `sessionChange` divider that switch itself logged (dropped internally
    // by `toResponsesItems`, but still one raw track entry) — not the whole
    // track from the beginning.
    expect(codexOpts.codexAppendItems!.events).toHaveLength(3);
  });

  it('falls back to a full rebuild when the prior session is no longer resolvable', async () => {
    const { daemon, mockCodex, codexKnownSessions, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });

    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'hello codex', localId: 'l2' });
    const codexSessionB = metaStore.read(chatId)!.claudeSessionId!;
    // Simulate the codex thread having genuinely been pruned/lost.
    codexKnownSessions.delete(codexSessionB);

    await daemon.setChatModel(chatId, CLAUDE_MODEL);
    await daemon.sendInput({ chatId, message: 'back to claude', localId: 'l3' });

    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'codex once more', localId: 'l4' });
    const opts = mockCodex.lastOptions()!;
    // Full rebuild again, not a resume of the now-gone thread.
    expect(opts.codexAppendItems).toBeUndefined();
    expect(opts.codexReseed).toBeDefined();
    expect(opts.codexReseed!.events.length).toBeGreaterThan(2);
  });

  it('the sessionChange divider reports the DELTA size on a resume, not the full track', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'hello codex', localId: 'l2' });
    await daemon.setChatModel(chatId, CLAUDE_MODEL);
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'back to claude', localId: 'l3' });

    const dividers = sessionChangeEvents(events);
    expect(dividers).toHaveLength(1);
    // Delta only (the codex exchange: 2 messages), not the whole track (4).
    expect(dividers[0]!.sessionChange!.seededMessages).toBe(2);
  });
});

describe('spec/04 § History — the switch confirmation cost preview', () => {
  it('is null when there is no session yet, or the target is the current harness', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    // No session yet — nothing to leave.
    expect(await daemon.estimateProviderSwitch(chatId, CODEX_MODEL)).toBeNull();
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    // Same harness as now — not actually a switch.
    expect(await daemon.estimateProviderSwitch(chatId, CLAUDE_MODEL)).toBeNull();
  });

  it('estimates the FULL track for a first-ever switch, and does not mutate anything', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    const sessionBefore = metaStore.read(chatId)!.claudeSessionId;

    const estimate = await daemon.estimateProviderSwitch(chatId, CODEX_MODEL);
    expect(estimate).toMatchObject({
      fromHarness: 'claude',
      toHarness: 'codex',
      resumesExistingSession: false,
    });
    expect(estimate!.approxTokens).toBeGreaterThan(0);

    // A preview, not an action: no model change, no session change, no
    // `harnessSessions` stash (that only happens on a REAL switch turn).
    expect(metaStore.read(chatId)!.model).toBe(CLAUDE_MODEL);
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(sessionBefore);
    const branch = metaStore.read(chatId)!.branches?.[0];
    expect(branch?.harnessSessions).toBeUndefined();
  });

  it('estimates only the DELTA for a return to a previously-used harness', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'hello codex', localId: 'l2' });

    const full = await daemon.estimateProviderSwitch(chatId, CLAUDE_MODEL);
    // Not actually switching yet — still on codex.
    await daemon.setChatModel(chatId, CLAUDE_MODEL);
    await daemon.sendInput({ chatId, message: 'back to claude', localId: 'l3' });
    await daemon.setChatModel(chatId, CODEX_MODEL);

    const deltaEstimate = await daemon.estimateProviderSwitch(chatId, CODEX_MODEL);
    expect(deltaEstimate).toMatchObject({ resumesExistingSession: true });
    // Cheaper than a from-scratch rebuild of the same track would have been.
    expect(deltaEstimate!.approxTokens).toBeLessThan(full!.approxTokens);
  });

  it('flags the cache as probably cold once the chat has been idle past the TTL', async () => {
    const { daemon, folder, advanceClock } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });

    const fresh = await daemon.estimateProviderSwitch(chatId, CODEX_MODEL);
    expect(fresh!.cacheProbablyCold).toBe(false);

    advanceClock(6 * 60 * 1000); // 6 minutes — past the 5-minute ephemeral TTL
    const stale = await daemon.estimateProviderSwitch(chatId, CODEX_MODEL);
    expect(stale!.cacheProbablyCold).toBe(true);
  });
});

describe('spec/04 § History — "switch and compact" (optional cheap path)', () => {
  it('hands the target a handoff note plus the last few turns, not the full track', async () => {
    const { daemon, mockCodex, folder } = setup({
      generateDigest: async () => 'Standing facts: the user likes tabs, not spaces.',
    });
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    // 5 turns = 10 real track entries — enough to prove OLDER ones get
    // dropped in favour of the digest, not just carried along anyway.
    for (let i = 0; i < 5; i++) {
      await daemon.sendInput({ chatId, message: `turn ${i}`, localId: `l${i}` });
    }

    await daemon.setChatModel(chatId, CODEX_MODEL, { compact: true });
    await daemon.sendInput({ chatId, message: 'now on codex', localId: 'l-last' });

    const opts = mockCodex.lastOptions()!;
    expect(opts.codexReseed).toBeDefined();
    const texts = JSON.stringify(opts.codexReseed!.events);
    expect(texts).toContain('Standing facts: the user likes tabs, not spaces');
    expect(texts).not.toContain('turn 0'); // the oldest turn was summarised, not carried
    expect(texts).toContain('turn 4'); // the most recent turn rides along verbatim
    // Handoff note + the last few turns — well short of all 10 real entries.
    expect(opts.codexReseed!.events.length).toBeLessThan(10);
  });

  it('fails the whole switch loudly when digest generation fails — NO fallback to the full handoff', async () => {
    const { daemon, mockCodex, events, folder } = setup({ generateDigest: async () => null });
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });

    await daemon.setChatModel(chatId, CODEX_MODEL, { compact: true });
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'now on codex', localId: 'l2' });

    // The switch never ran at all — not on codex, not a silent full rebuild.
    expect(mockCodex.lastOptions()).toBeUndefined();
    const errors = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.error' }> => e.type === 'chat.error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.code).toBe('switch_compact_failed');
  });

  it('properly supports an outgoing CODEX session too — resumes ITS thread for the handoff', async () => {
    const digestCalls: Array<{ resumeSessionId: string; model?: string | null }> = [];
    const { daemon, mockClaude, folder } = setup({
      generateDigest: async (input) => {
        digestCalls.push(input);
        return 'the codex session says: remember the deploy key rotates monthly';
      },
    });
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    await daemon.setChatModel(chatId, CODEX_MODEL);
    await daemon.sendInput({ chatId, message: 'hello codex', localId: 'l2' });

    await daemon.setChatModel(chatId, CLAUDE_MODEL, { compact: true });
    await daemon.sendInput({ chatId, message: 'back to claude', localId: 'l3' });

    // The digest generator resumed the OUTGOING (codex) session, on its own
    // model — not silently routed to Claude, not refused.
    expect(digestCalls).toHaveLength(1);
    expect(digestCalls[0]!.resumeSessionId).toMatch(/^codex-/);
    expect(digestCalls[0]!.model).toBe(CODEX_MODEL);

    const claudeOpts = mockClaude.lastOptions()!;
    expect(JSON.stringify(claudeOpts.claudeSessionStore?.reseed)).toContain(
      'remember the deploy key rotates monthly',
    );
  });
});
