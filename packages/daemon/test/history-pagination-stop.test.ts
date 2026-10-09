// C2-6 + C2-8 regression: with the mock SDK backend configured to persist a
// real Claude-Code-shaped JSONL transcript and hold a working window, the two
// behaviours the e2e reviewer flagged as un-exercisable on the live stack are
// now genuinely testable:
//
//   C2-6  patch_history paginates persisted older events with a 200 hard cap
//         that CLAMPS (not rejects) an over-limit request.
//   C2-8  patch_stop stops a RUNNING query: activity stays `running` for the
//         working window and a stop aborts it back to idle.
//
// These drive the same Daemon.readHistory / stopChat paths the control UDS
// routes (and thus the MCP tools patch_history / patch_stop) call.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatActivity, WireEvent } from '@patch/wire';
import { Daemon, HISTORY_PAGE_HARD_CAP } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(opts: { turnDelayMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-hps-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-hps-folder-'));
  mkdirSync(folder, { recursive: true });
  // Isolated projects root the mock WRITES to and the reader READS from.
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-hps-projects-'));
  const sdk = createMockSdkBackend({
    claudeProjectsRoot: projectsRoot,
    ...(opts.turnDelayMs !== undefined ? { turnDelayMs: opts.turnDelayMs } : {}),
  });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, projectsRoot };
}

function lastActivity(events: WireEvent[]): ChatActivity | undefined {
  const states = events.filter((e) => e.type === 'chat.state');
  const last = states[states.length - 1] as unknown as { activity: ChatActivity } | undefined;
  return last?.activity;
}

describe('C2-6 patch_history paginates persisted older events', () => {
  it('persists each turn to disk and pages with no overlap, clamping at 200', async () => {
    const { daemon, folder } = setup({ turnDelayMs: 0 });
    const chatId = await daemon.spawnChat({ folder });

    // Drive several turns. The mock writes user+assistant lines to the JSONL
    // transcript for each, accumulating genuine older events.
    for (const n of [1, 2, 3, 4, 5]) {
      await daemon.sendInput({ chatId, message: `turn-${n}`, localId: `local-${n}` });
    }

    // Page 1: oldest two events.
    const page1 = daemon.readHistory({ chatId, limit: 2 });
    expect(page1.events.length).toBe(2);
    expect(page1.nextFromSeq).toBeGreaterThan(0);

    // Page 2 continues from the cursor — strictly past page 1, no overlap.
    const page2 = daemon.readHistory({ chatId, fromSeq: page1.nextFromSeq!, limit: 2 });
    expect(page2.events.length).toBe(2);
    const seq = (e: WireEvent): number => (e as { seq: number }).seq;
    const maxP1 = Math.max(...page1.events.map(seq));
    const minP2 = Math.min(...page2.events.map(seq));
    expect(minP2).toBeGreaterThan(maxP1);

    // There ARE older events to page through (the core thing the reviewer said
    // was un-exercisable under the persist-nothing mock).
    const all = daemon.readHistory({ chatId, limit: HISTORY_PAGE_HARD_CAP });
    expect(all.events.length).toBeGreaterThanOrEqual(10); // 5 turns × (user+assistant)

    // Hard cap CLAMPS, never rejects.
    const over = daemon.readHistory({ chatId, limit: 5000 });
    expect(over.events.length).toBeLessThanOrEqual(HISTORY_PAGE_HARD_CAP);
  });
});

describe('C2-8 patch_stop stops a RUNNING query', () => {
  it('holds activity=running for the working window, then stop aborts to idle', async () => {
    const { daemon, events, folder } = setup({ turnDelayMs: 2_000 });
    const chatId = await daemon.spawnChat({ folder });

    // Fire a turn but DON'T await it — the mock holds the working window open.
    const turn = daemon.sendInput({ chatId, message: 'long-running', localId: 'local-stop-1' });

    // Let the run reach the working window.
    await new Promise((r) => setTimeout(r, 50));
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    // Stop the running query — must abort the window and settle to idle.
    await daemon.stopChat(chatId);
    await turn;

    expect(daemon.chatState.get(chatId)?.activity).not.toBe('running');
    expect(lastActivity(events)).not.toBe('running');
    // chat.stopped emitted with user-stop reason.
    expect(
      events.some(
        (e) => e.type === 'chat.stopped' && (e as { reason?: string }).reason === 'user-stop',
      ),
    ).toBe(true);
  });
});
