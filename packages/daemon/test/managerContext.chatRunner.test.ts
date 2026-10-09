// spec/06 § Manager conversation — bounded context, the host-side half:
// `ChatRunner.ensureBoundedManagerContext` decides WHEN the pure windowing
// (`managerContext.test.ts`) applies, and rewrites `claudeSessionId` to a
// fresh session seeded from the window when it does. Full history in the
// log is never touched either way.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { Daemon, type DaemonOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(managerContextWindow: number | undefined) {
  const home = mkdtempSync(join(tmpdir(), 'patch-mgrctx-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-mgrctx-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => SPECIAL_THREAD_IDS.manager,
    ...(managerContextWindow !== undefined ? { managerContextWindow } : {}),
  } satisfies DaemonOptions);
  return { daemon, sdk, events, folder, metaStore };
}

let n = 0;
async function turn(
  daemon: ReturnType<typeof setup>['daemon'],
  sdk: ReturnType<typeof setup>['sdk'],
  chatId: string,
): Promise<void> {
  n += 1;
  sdk.enqueue([{ type: 'assistant', content: `reply ${n}`, sessionId: `native-${n}` }]);
  await daemon.sendInput({ chatId, message: `msg ${n}`, localId: `L${n}` });
  await new Promise((r) => setTimeout(r, 30));
}

describe('ensureBoundedManagerContext (via ordinary Manager turns)', () => {
  it('leaves claudeSessionId alone while the track is within the window', async () => {
    n = 0;
    const { daemon, sdk, folder } = setup(40);
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    const after1 = daemon.chatState.get(chatId)?.claudeSessionId;
    await turn(daemon, sdk, chatId);
    const after2 = daemon.chatState.get(chatId)?.claudeSessionId;
    // Ordinary resume: the SDK's own reported session id each time, untouched.
    expect(after1).toBe('native-1');
    expect(after2).toBe('native-2');
  });

  it('rewrites claudeSessionId to a fresh one once the track grows past the window, and the full history survives', async () => {
    n = 0;
    const { daemon, sdk, folder } = setup(2); // 2 messages — one user+assistant exchange
    const chatId = await daemon.spawnChat({ folder });
    // Turn 1: track is empty beforehand (the incoming user message is logged
    // before the bounded-context check runs, so turn 1 sees 1, not 0 — still
    // nothing to bound, since there is no existing session yet to reseed).
    await turn(daemon, sdk, chatId);
    expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('native-1');
    // Turn 2: by the time the check runs, the track already carries this
    // turn's own incoming message (3: msg1, reply1, msg2) — past the window
    // of 2. `ensureBoundedManagerContext` checks BEFORE the turn's reply
    // lands, so this is visible in what got RESUMED, not in what the mock
    // reports back afterward (which overwrites it regardless — see
    // `setManagerContextWindow` below for why that assertion is the wrong one).
    await turn(daemon, sdk, chatId);
    const resumed = sdk.lastOptions()?.resumeSessionId;
    expect(resumed).toBeDefined();
    expect(resumed).not.toBe('native-1'); // a fresh uuid was minted and seeded instead

    // History in the LOG is untouched — every message is still there.
    const history = daemon.readHistory({ chatId, limit: 200 });
    const messages = history.events.filter((e) => e.type === 'chat.message' && e.role !== 'system');
    expect(messages).toHaveLength(4); // 2 exchanges — all still in the log
  });

  it('a host with no managerContextWindow configured never reseeds', async () => {
    n = 0;
    const { daemon, sdk, folder } = setup(undefined);
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    // Every turn just resumes the SDK's own reported session, unbounded.
    expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('native-3');
  });

  it('setManagerContextWindow changes the live window for the NEXT turn', async () => {
    n = 0;
    const { daemon, sdk, folder } = setup(40); // starts generous
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId); // track now has 4 messages, well within 40
    expect(sdk.lastOptions()?.resumeSessionId).toBe('native-1'); // ordinary resume, no reseed

    daemon.setManagerContextWindow(2); // tighten it live
    await turn(daemon, sdk, chatId); // track beforehand is 4 messages — now past the new window of 2
    expect(sdk.lastOptions()?.resumeSessionId).not.toBe('native-2');
  });

  it('a non-Manager chat is never bounded, even with a tiny window configured', async () => {
    n = 0;
    const home = mkdtempSync(join(tmpdir(), 'patch-mgrctx-ord-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-mgrctx-ord-folder-')));
    mkdirSync(folder, { recursive: true });
    const metaStore = createMetaStore(home);
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      managerContextWindow: 2,
    });
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    // An ordinary chat always just resumes the SDK's own session — bounding
    // is Manager-only (spec/06 § Manager conversation).
    expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('native-3');
  });
});
