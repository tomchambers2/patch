// D1 — Special threads (Manager / Speakers) exercised against a
// RUNNING host control service over a real Unix domain socket.
//
// Complements tc3-integration.test.ts (notify/broadcast/cascade) by covering
// the thread-lifecycle + ingress-tagging behaviours specific to spec/06:
//   - bootstrap: folders + empty CLAUDE.md, never overwritten
//   - Manager pinned at the TOP of the sidebar (pinned: true)
//   - single-instance + restart survival of the stable chatId
//   - inbound voice-device turn tagged `[voice • device:<deviceId>]`
//   - voice-device tag co-exists with the broadcast <system-reminder> block
//   - folder structure is a sub-folder of the host cwd (CLAUDE.md inheritance)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { ChatInputSource, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { ChatStateMap } from '../src/chatState.js';
import {
  ensureSpecialThreads,
  appendBroadcast,
  isBroadcastSelfLoop,
  threadForChannel,
  readPendingBroadcasts,
  flushBroadcasts,
  formatRelativeTime,
  buildBroadcastSystemReminder,
  voicePrefixForSource,
  specialThreadFolder,
  SPECIAL_THREAD_IDS,
  BROADCAST_SIDECAR_THREADS,
  SPECIAL_THREAD_FOLDER_NAMES,
  type SpecialThreadId,
} from '../src/specialThreads.js';

const silent = pino({ level: 'silent' });

let tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

interface Stack {
  app: FastifyInstance;
  cwd: string;
  home: string;
  daemon: Daemon;
  capturedPrompts: string[];
  /** Mirror of index.ts source→voicePrefix derivation on the chat.input path. */
  deliver: (
    chatId: string,
    message: string,
    localId: string,
    source?: ChatInputSource,
  ) => Promise<void>;
  close: () => Promise<void>;
}

// Boot a real host control server on a real UDS socket, wired exactly like
// index.ts: real special-thread bootstrap under `cwd`, real broadcast-sidecar
// injection on reply, and the real chat.input source→voicePrefix translation.
async function startDaemon(opts: { home?: string; cwd?: string } = {}): Promise<Stack> {
  const home = opts.home ?? mkTmp('d1-home-');
  const cwd = opts.cwd ?? mkTmp('d1-cwd-');
  const sockDir = mkTmp('d1-sock-');
  const socketPath = join(sockDir, 'daemon.sock');
  const upstream: WireEvent[] = [];
  const capturedPrompts: string[] = [];

  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: {
      run: async function* (runOpts: { prompt: string }) {
        capturedPrompts.push(runOpts.prompt);
        yield { type: 'assistant', content: 'ok', sessionId: 'S1' };
      },
    },
    oauthAccessToken: 'x',
    emit: (e) => upstream.push(e),
    logger: silent,
    now: () => Date.now(),
    preprocessInput: (req: { chatId: string; message: string; voicePrefix?: string }) => {
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(req.chatId)) return undefined;
      const threadId = req.chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return undefined;
      const entries = readPendingBroadcasts(cwd, threadId);
      const block = buildBroadcastSystemReminder(entries, Date.now());
      if (!block) return undefined;
      return block + (req.voicePrefix ? `${req.voicePrefix}${req.message}` : req.message);
    },
    onTurnCommitted: (chatId: string) => {
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(chatId)) return;
      const threadId = chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return;
      flushBroadcasts(cwd, threadId);
    },
  });
  daemon.hydrate?.();
  ensureSpecialThreads({
    patchHome: cwd,
    metaStore,
    chatState: daemon.chatState,
    now: () => Date.now(),
    logger: silent,
    permissionModeDefault: 'auto',
  });

  const jobs = new MemoryJobsStore({ now: () => Date.now() });
  const app = await buildControl({
    daemon,
    jobs,
    emitWire: (e) => upstream.push(e),
    speakers: {
      presence: {
        enumerate: () => [],
        isOnline: () => false,
        isMuted: () => false,
        send: () => false,
      },
      pushFallback: () => {},
    },
    onBroadcast: ({ channel, message, sourceChatId }) => {
      const threadId = threadForChannel(channel);
      if (!threadId) return;
      if (isBroadcastSelfLoop(channel, sourceChatId)) return;
      const sourceState = daemon.chatState.get(sourceChatId);
      const sourceChatName = sourceState?.name ?? sourceChatId;
      appendBroadcast(cwd, threadId, { ts: Date.now(), sourceChatName, message });
    },
  });
  await app.listen({ path: socketPath });

  return {
    app,
    cwd,
    home,
    daemon,
    capturedPrompts,
    events: upstream,
    // Exactly mirrors index.ts `case 'chat.input'`: derive voicePrefix from
    // the ingress source, then sendInput.
    deliver: async (chatId, message, localId, source) => {
      const voicePrefix = voicePrefixForSource(source);
      await daemon.sendInput({
        chatId,
        message,
        localId,
        ...(voicePrefix !== undefined ? { voicePrefix } : {}),
      });
    },
    close: async () => {
      await app.close();
    },
  };
}

beforeEach(() => {
  tmpRoots = [];
});
afterEach(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe('D1 thread bootstrap over a running host', () => {
  it('creates manager/speakers folders + an empty CLAUDE.md, registers stable chatIds', async () => {
    const s = await startDaemon();
    try {
      for (const id of SPECIAL_THREAD_IDS) {
        const folder = specialThreadFolder(s.cwd, id);
        expect(existsSync(folder)).toBe(true);
        const claude = join(folder, 'CLAUDE.md');
        expect(existsSync(claude)).toBe(true);
        expect(readFileSync(claude, 'utf8')).toBe(''); // empty, never written into
        const state = s.daemon.chatState.get(id);
        expect(state).toBeDefined();
        expect(state?.folder).toBe(folder);
      }
    } finally {
      await s.close();
    }
  });

  it('folder is a sub-folder of the patch home (parent CLAUDE.md inheritance via dir-walk)', async () => {
    const cwd = mkTmp('d1-cwd-');
    // Parent-dir CLAUDE.md + a parent skill: Claude Code walks up from the
    // thread folder and inherits these.
    writeFileSync(join(cwd, 'CLAUDE.md'), '# project root guidance\n', 'utf8');
    const s = await startDaemon({ cwd });
    try {
      for (const id of SPECIAL_THREAD_IDS) {
        const folder = specialThreadFolder(s.cwd, id);
        // threads/<name> is nested under ~/.patch → parent walk reaches it.
        expect(folder.startsWith(join(s.cwd, 'threads'))).toBe(true);
        expect(dirname(dirname(folder))).toBe(s.cwd);
        // The inherited parent CLAUDE.md is reachable by walking up.
        expect(existsSync(join(s.cwd, 'CLAUDE.md'))).toBe(true);
      }
    } finally {
      await s.close();
    }
  });

  it('Manager sits at the TOP — pinned:true; Speakers is not pinned', async () => {
    const s = await startDaemon();
    try {
      expect(s.daemon.chatState.get('thread_manager')?.pinned).toBe(true);
      expect(s.daemon.chatState.get('thread_speakers')?.pinned).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('never overwrites a user-edited CLAUDE.md; never spawns a second instance on re-bootstrap', async () => {
    const home = mkTmp('d1-home-');
    const cwd = mkTmp('d1-cwd-');
    const s1 = await startDaemon({ home, cwd });
    const managerClaude = join(specialThreadFolder(cwd, 'thread_manager'), 'CLAUDE.md');
    writeFileSync(managerClaude, 'be concise, you orchestrate', 'utf8');
    const managerId = s1.daemon.chatState.get('thread_manager')?.chatId;
    await s1.close();

    // Restart against the SAME home + cwd.
    const s2 = await startDaemon({ home, cwd });
    try {
      // CLAUDE.md preserved (never overwritten).
      expect(readFileSync(managerClaude, 'utf8')).toBe('be concise, you orchestrate');
      // Stable chatId survives restart.
      expect(s2.daemon.chatState.get('thread_manager')?.chatId).toBe(managerId);
      // Exactly one instance of each id.
      const ids = [...new Set(SPECIAL_THREAD_IDS)];
      expect(ids).toHaveLength(2);
      for (const id of SPECIAL_THREAD_IDS) {
        expect(s2.daemon.chatState.get(id)).toBeDefined();
      }
    } finally {
      await s2.close();
    }
  });

  it('CLAUDE.md is mode 0644 and a real file (not a dir)', async () => {
    const s = await startDaemon();
    try {
      const claude = join(specialThreadFolder(s.cwd, 'thread_speakers'), 'CLAUDE.md');
      const st = statSync(claude);
      expect(st.isFile()).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('D1 Speakers ingress — voice-device tagging over a running host', () => {
  it('tags an inbound voice-device turn [voice • device:<deviceId>] in the prompt', async () => {
    const s = await startDaemon();
    try {
      await s.deliver('thread_speakers', "what's agent two doing", 'vd1', {
        kind: 'voice-device',
        deviceId: 'kitchen',
      });
      const prompt = s.capturedPrompts.at(-1) ?? '';
      expect(prompt.startsWith('[voice • device:kitchen] ')).toBe(true);
      expect(prompt).toContain("what's agent two doing");
    } finally {
      await s.close();
    }
  });

  it('voice-device tag co-exists with the broadcast <system-reminder> block', async () => {
    const s = await startDaemon();
    // A broadcast from a normal chat lands in the speakers sidecar first.
    appendBroadcast(s.cwd, 'thread_speakers', {
      ts: Date.now(),
      sourceChatName: 'bus-watch',
      message: 'bus leaves in 5',
    });
    try {
      await s.deliver('thread_speakers', 'remind me when it leaves', 'vd2', {
        kind: 'voice-device',
        deviceId: 'bedroom',
      });
      const prompt = s.capturedPrompts.at(-1) ?? '';
      expect(prompt).toContain('<system-reminder>');
      expect(prompt).toContain('bus leaves in 5');
      expect(prompt).toContain('[voice • device:bedroom] remind me when it leaves');
      // Sidecar flushed after the turn committed.
      expect(readPendingBroadcasts(s.cwd, 'thread_speakers')).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('the live chat.message carries the broadcast digest as systemContext, not inlined into content (spec/02 § System-reminder disclosure)', async () => {
    const s = await startDaemon();
    appendBroadcast(s.cwd, 'thread_speakers', {
      ts: Date.now(),
      sourceChatName: 'bus-watch',
      message: 'bus leaves in 5',
    });
    try {
      await s.deliver('thread_speakers', 'remind me when it leaves', 'vd3', {
        kind: 'voice-device',
        deviceId: 'bedroom',
      });
      const userMsg = s.events.find(
        (e) => e.type === 'chat.message' && 'role' in e && e.role === 'user',
      );
      expect(userMsg).toBeDefined();
      const systemContext =
        userMsg && 'systemContext' in userMsg ? userMsg.systemContext : undefined;
      expect(systemContext).toEqual([
        {
          source: 'patch',
          label: 'Broadcast digest',
          text: expect.stringContaining('bus leaves in 5'),
        },
      ]);
      const content = userMsg && 'content' in userMsg ? userMsg.content : undefined;
      expect(content).not.toContain('<system-reminder>');
      expect(content).toContain('remind me when it leaves');
    } finally {
      await s.close();
    }
  });

  it('a turn with no source carries no voice tag', async () => {
    const s = await startDaemon();
    try {
      await s.deliver('thread_manager', 'what is running?', 'm1');
      const prompt = s.capturedPrompts.at(-1) ?? '';
      expect(prompt).toBe('what is running?');
      expect(prompt).not.toContain('[voice • device');
    } finally {
      await s.close();
    }
  });
});

describe('voicePrefixForSource (pure)', () => {
  it('tags voice-device and voice-app; leaves undefined untagged', () => {
    expect(voicePrefixForSource({ kind: 'voice-device', deviceId: 'kitchen' })).toBe(
      '[voice • device:kitchen] ',
    );
    // spec/07 § End-to-end voice transport — a voice-app source on a chat.input
    // is the mobile voice-NOTE upload path; it must land tagged with its
    // surfaceKind exactly as a streamed note would. (The streamed audio-WSS
    // path tags at the session boundary and never routes through here.)
    expect(voicePrefixForSource({ kind: 'voice-app', surfaceKind: 'mobile' })).toBe(
      '[voice • mobile] ',
    );
    expect(voicePrefixForSource({ kind: 'voice-app', surfaceKind: 'web', sessionId: 's' })).toBe(
      '[voice • web] ',
    );
    expect(voicePrefixForSource(undefined)).toBeUndefined();
  });
});

describe('D1 folder-name mapping', () => {
  it('maps each thread id to its on-disk folder name', () => {
    expect(SPECIAL_THREAD_FOLDER_NAMES.thread_manager).toBe('manager');
    expect(SPECIAL_THREAD_FOLDER_NAMES.thread_speakers).toBe('speakers');
  });
});

describe('threadForChannel (pure)', () => {
  it('maps speakers to its thread id and leaves push/desktop unmapped', () => {
    expect(threadForChannel('speakers')).toBe('thread_speakers');
    expect(threadForChannel('push')).toBeNull();
    expect(threadForChannel('desktop')).toBeNull();
  });
});

describe('isBroadcastSelfLoop (pure)', () => {
  it('is true only when the broadcast channel is mediated by the very thread that sent it', () => {
    expect(isBroadcastSelfLoop('speakers', 'thread_speakers')).toBe(true);
    expect(isBroadcastSelfLoop('speakers', 'some-other-chat')).toBe(false);
    // push/desktop have no mediating thread at all — never a self-loop.
    expect(isBroadcastSelfLoop('push', 'thread_speakers')).toBe(false);
  });
});

describe('formatRelativeTime (pure)', () => {
  it('formats across the seconds/minutes/hours/days boundaries', () => {
    expect(formatRelativeTime(0)).toBe('0s ago');
    expect(formatRelativeTime(-500)).toBe('0s ago'); // clamped, never negative
    expect(formatRelativeTime(30_000)).toBe('30s ago');
    expect(formatRelativeTime(5 * 60_000)).toBe('5 min ago');
    expect(formatRelativeTime(90 * 60_000)).toBe('2h ago');
    expect(formatRelativeTime(72 * 60 * 60_000)).toBe('3d ago');
  });
});

describe('readPendingBroadcasts error handling', () => {
  it('returns [] when the sidecar path exists but readFileSync throws (e.g. is a directory)', () => {
    const cwd = mkTmp('d1-cwd-');
    const path = join(specialThreadFolder(cwd, 'thread_speakers'), 'broadcasts.jsonl');
    // Make the sidecar path itself a directory so existsSync() is true but
    // readFileSync() throws (EISDIR) rather than ENOENT.
    mkdirSync(path, { recursive: true });
    expect(readPendingBroadcasts(cwd, 'thread_speakers')).toEqual([]);
  });

  it('skips a malformed (torn) JSONL line without throwing', () => {
    const cwd = mkTmp('d1-cwd-');
    appendBroadcast(cwd, 'thread_speakers', { ts: 1, sourceChatName: 'a', message: 'good-one' });
    const path = join(specialThreadFolder(cwd, 'thread_speakers'), 'broadcasts.jsonl');
    // Simulate a torn last write: an incomplete JSON line appended after the
    // good one.
    writeFileSync(path, readFileSync(path, 'utf8') + '{"ts": 2, "sourceChatN', 'utf8');
    const entries = readPendingBroadcasts(cwd, 'thread_speakers');
    expect(entries).toEqual([{ ts: 1, sourceChatName: 'a', message: 'good-one' }]);
  });

  it('drops the oldest entries once the total exceeds capChars', () => {
    const cwd = mkTmp('d1-cwd-');
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 1,
      sourceChatName: 'a',
      message: 'x'.repeat(50),
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 2,
      sourceChatName: 'b',
      message: 'y'.repeat(50),
    });
    appendBroadcast(cwd, 'thread_speakers', {
      ts: 3,
      sourceChatName: 'c',
      message: 'z'.repeat(50),
    });
    const entries = readPendingBroadcasts(cwd, 'thread_speakers', 100);
    // Oldest (ts:1) dropped first; at least the newest survives.
    expect(entries.some((e) => e.ts === 1)).toBe(false);
    expect(entries[entries.length - 1]?.ts).toBe(3);
  });
});

describe('ensureSpecialThreads: falls back to defaults for a pre-existing meta missing optional fields', () => {
  it('defaults pinned/pinnedAt/status/archivedAt when an old-format meta.json omits them', () => {
    const home = mkTmp('d1-home-');
    const cwd = mkTmp('d1-cwd-');
    const metaStore = createMetaStore(home);
    const folder = specialThreadFolder(cwd, 'thread_manager');
    // Old-format meta: no `pinned` / `pinnedAt` / `status` / `archivedAt`.
    metaStore.write({
      chatId: 'thread_manager',
      folder,
      name: 'manager',
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const chatState = new ChatStateMap();
    ensureSpecialThreads({
      patchHome: cwd,
      metaStore,
      chatState,
      now: () => 500,
      logger: silent,
      permissionModeDefault: 'auto',
    });
    const state = chatState.get('thread_manager');
    expect(state?.pinned).toBe(true); // falls back to id === 'thread_manager'
    expect(state?.pinnedAt).toBe(500);
    expect(state?.status).toBe('active');
    expect(state?.archivedAt).toBeNull();
  });
});
