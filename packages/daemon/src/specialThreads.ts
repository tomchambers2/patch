// Special threads — Manager / Speakers (group 11, spec/06).
//
// On host boot we ensure the two thread folders exist (each with an
// *empty* CLAUDE.md the user owns and fills in) and that the chat_state map
// contains reserved entries `thread_manager`, `thread_speakers`.
//
// Per spec/06: patch creates the folders + an *empty* CLAUDE.md and never
// overwrites it. We do the empty-file create via {flag: 'wx'} so a re-run
// never clobbers user edits.

import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { ChatInputSource } from '@patch/wire';
import { ChatStateMap } from './chatState.js';
import type { SdkPermissionMode } from './chatState.js';
import type { MetaStore, ChatMeta } from './meta.js';

/**
 * Derive the per-turn `voicePrefix` tag for an inbound `chat.input` that
 * carries ingress `source` metadata (spec/06 ## Speakers thread).
 *
 * Physical voice-device turns are tagged `[voice • device:<deviceId>]` so the
 * Speakers agent knows which device it's hearing from (kitchen, bedroom, …)
 * and can shape its reply.
 *
 * A `voice-app` source on a `chat.input` is the mobile voice-NOTE upload path
 * (spec/07 § End-to-end voice transport): the server injects the transcript as
 * a `chat.input` carrying `{ kind: 'voice-app', surfaceKind }`, and it must land
 * tagged `[voice • <surfaceKind>]` exactly as a streamed note would. (The
 * streaming audio-WSS path tags its turn at the session boundary in
 * `submitUserTurn` and never routes through here, so there's no double-tag.)
 *
 * Other sources are plain text — not tagged. Returns `undefined` when no tag
 * applies.
 */
export function voicePrefixForSource(source: ChatInputSource | undefined): string | undefined {
  if (source?.kind === 'voice-device') {
    return `[voice • device:${source.deviceId}] `;
  }
  if (source?.kind === 'voice-app') {
    return `[voice • ${source.surfaceKind}] `;
  }
  return undefined;
}

export const SPECIAL_THREAD_IDS = ['thread_manager', 'thread_speakers'] as const;
export type SpecialThreadId = (typeof SPECIAL_THREAD_IDS)[number];

export const SPECIAL_THREAD_FOLDER_NAMES: Record<SpecialThreadId, string> = {
  thread_manager: 'manager',
  thread_speakers: 'speakers',
};

/** Threads that mediate an external channel and accumulate broadcast context. */
export const BROADCAST_SIDECAR_THREADS: ReadonlySet<SpecialThreadId> = new Set(['thread_speakers']);

/** Channel → which thread accumulates broadcasts when patch_notify is called from elsewhere. */
export function threadForChannel(channel: 'push' | 'desktop' | 'speakers'): SpecialThreadId | null {
  if (channel === 'speakers') return 'thread_speakers';
  return null;
}

export interface BroadcastEntry {
  ts: number;
  sourceChatName: string;
  message: string;
}

/**
 * Where a special thread's working folder is: `~/.patch/threads/<name>` on the
 * account's home machine (spec/02 § Stack, spec/06 § Where special threads run).
 *
 * Resolved from the host's own patch home — i.e. from the host user's HOME —
 * and from nothing else. It used to be resolved from `process.cwd()`, which is
 * the same directory only when somebody happens to start the host from their
 * home directory: under a service manager the working directory is `/`, and the
 * host died at boot trying to create `/.patch/threads/manager`. The service
 * unit deliberately carries no working directory (spec/02 § Runtime and
 * installation), so this must not depend on one.
 */
export function specialThreadFolder(patchHome: string, id: SpecialThreadId): string {
  return resolve(patchHome, 'threads', SPECIAL_THREAD_FOLDER_NAMES[id]);
}

export function broadcastSidecarPath(patchHome: string, id: SpecialThreadId): string {
  return join(specialThreadFolder(patchHome, id), 'broadcasts.jsonl');
}

export interface EnsureSpecialThreadsOptions {
  /** The host's `~/.patch`, resolved from the host user's HOME. */
  patchHome: string;
  metaStore: MetaStore;
  chatState: ChatStateMap;
  now: () => number;
  logger: Logger;
  /**
   * The mode a special thread is stamped with when it is first bootstrapped
   * (spec/02 § Permission mode) — the host default in force at that moment,
   * exactly like any other chat created now.
   */
  permissionModeDefault: SdkPermissionMode;
}

/**
 * Idempotent bootstrap. Creates folders + empty CLAUDE.md (only if missing),
 * and the chat_state + meta entries for each special thread (only if missing).
 */
export function ensureSpecialThreads(opts: EnsureSpecialThreadsOptions): void {
  const { patchHome, metaStore, chatState, now, logger, permissionModeDefault } = opts;
  const ts = now();
  for (const id of SPECIAL_THREAD_IDS) {
    const folder = specialThreadFolder(patchHome, id);
    mkdirSync(folder, { recursive: true });
    const claudeMd = join(folder, 'CLAUDE.md');
    if (!existsSync(claudeMd)) {
      // Empty file per spec/06 ## Where special threads run.
      writeFileSync(claudeMd, '', { encoding: 'utf8', mode: 0o644 });
      logger.info({ threadId: id, claudeMd }, 'special-thread CLAUDE.md created (empty)');
    }
    if (!chatState.has(id)) {
      const existing = metaStore.read(id);
      const meta: ChatMeta = existing ?? {
        chatId: id,
        folder,
        name: SPECIAL_THREAD_FOLDER_NAMES[id],
        nextSeq: 0,
        pinned: id === 'thread_manager',
        pinnedAt: id === 'thread_manager' ? ts : null,
        status: 'active',
        archivedAt: null,
        permissionMode: permissionModeDefault,
        createdAt: ts,
        updatedAt: ts,
      };
      if (!existing) metaStore.write(meta);
      chatState.set({
        chatId: id,
        name: meta.name,
        preview: meta.preview ?? null,
        goal: meta.goal ?? null,
        goalProgress: null,
        lastGoal: meta.lastGoal ?? null,
        goalRefusalStreak: 0,
        goalEvalAwaitingWatches: false,
        reminder: meta.reminder ?? null,
        declaredStatus: null,
        statusSummary: null,
        statusKind: null,
        turnSummary: null,
        todos: [],
        lastFiredTodo: null,
        todosEditedBySurface: false,
        hiddenNotice: null,
        goalNotice: null,
        pendingHookAdvice: [],
        consecutiveHookBlocks: 0,
        pendingAgentResponseCheckId: null,
        turnWasHookResubmit: false,
        folder: meta.folder,
        activity: 'idle',
        // Never read for these — special threads are skipped by the
        // chat-completion notifier outright (spec/09 § Chat completion).
        turnOrigin: 'user',
        turnStopped: false,
        turnRetrying: false,
        lastMessages: [],
        lastUpdated: meta.updatedAt,
        claudeSessionId: meta.claudeSessionId,
        model: undefined,
        // A special thread carries its own mode like every other chat. An
        // existing one keeps what it was stamped with; a brand-new one takes
        // the host default now and keeps it (spec/02 § Permission mode).
        permissionMode: meta.permissionMode ?? permissionModeDefault,
        disabledTools: undefined,
        nextSeq: meta.nextSeq,
        pinned: meta.pinned ?? id === 'thread_manager',
        pinnedAt: meta.pinnedAt ?? (id === 'thread_manager' ? ts : null),
        disabled: meta.disabled ?? false,
        status: meta.status ?? 'active',
        archivedAt: meta.archivedAt ?? null,
        // Special threads occupy fixed sidebar slots and are never snoozed.
        snoozedUntil: null,
        // ...nor hidden (spec/04 § Hidden).
        hidden: false,
        createdAt: meta.createdAt,
        lastUserActivity: meta.lastUserActivity ?? meta.createdAt,
        lastError: null,
      });
      logger.info({ threadId: id, folder }, 'special-thread bootstrapped');
    }
  }
}

/**
 * Group 12 (DX-1): true when a broadcast originated FROM the very thread that
 * mediates its channel — e.g. thread_speakers firing patch_notify on the
 * `speakers` channel. The host suppresses sidecar appends in this case so
 * the thread doesn't read its own past broadcasts back as system reminders.
 *
 * The wire event still fans out upstream (the channel actually delivers);
 * only the local sidecar append is skipped.
 */
export function isBroadcastSelfLoop(
  channel: 'push' | 'desktop' | 'speakers',
  sourceChatId: string,
): boolean {
  const threadId = threadForChannel(channel);
  return threadId !== null && threadId === sourceChatId;
}

/** Append a broadcast entry to the sidecar JSONL. */
export function appendBroadcast(
  patchHome: string,
  threadId: SpecialThreadId,
  entry: BroadcastEntry,
): void {
  const path = broadcastSidecarPath(patchHome, threadId);
  mkdirSync(specialThreadFolder(patchHome, threadId), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o644 });
}

/** Read pending broadcast entries — bounded at the cap (oldest dropped first). */
export function readPendingBroadcasts(
  patchHome: string,
  threadId: SpecialThreadId,
  capChars = 10_000,
): BroadcastEntry[] {
  const path = broadcastSidecarPath(patchHome, threadId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const out: BroadcastEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as BroadcastEntry;
      if (
        typeof entry.ts === 'number' &&
        typeof entry.sourceChatName === 'string' &&
        typeof entry.message === 'string'
      ) {
        out.push(entry);
      }
    } catch {
      // skip malformed lines — append-only file may have a torn last write
    }
  }
  // Apply cap: drop oldest first if total length exceeds capChars.
  let totalChars = out.reduce((s, e) => s + e.message.length + e.sourceChatName.length + 32, 0);
  while (totalChars > capChars && out.length > 1) {
    const dropped = out.shift();
    if (dropped) {
      totalChars -= dropped.message.length + dropped.sourceChatName.length + 32;
    }
  }
  return out;
}

/** Truncate the sidecar (called after the agent commits a response). */
export function flushBroadcasts(patchHome: string, threadId: SpecialThreadId): void {
  const path = broadcastSidecarPath(patchHome, threadId);
  if (!existsSync(path)) return;
  // Truncate by writing empty content.
  writeFileSync(path, '', { encoding: 'utf8', mode: 0o644 });
}

export function formatRelativeTime(deltaMs: number): string {
  const sec = Math.max(0, Math.round(deltaMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

/** Build the <system-reminder> block. Returns null when no broadcasts pending. */
export function buildBroadcastSystemReminder(
  entries: BroadcastEntry[],
  now: number,
): string | null {
  if (entries.length === 0) return null;
  // Group 12 (sec INFO-1): `sourceChatName` is interpolated raw into a
  // <system-reminder> block delivered to the assistant. This is intentional
  // self-injection — chat names are user-owned data on a single-user system,
  // and the trust boundary is the user themselves. We JSON.stringify the
  // message body (not the chat name) because messages may contain quotes,
  // newlines, etc. that would break the bullet structure.
  const lines = entries
    .map(
      (e) =>
        `- ${formatRelativeTime(now - e.ts)}: ${JSON.stringify(e.message)} (from chat: ${e.sourceChatName})`,
    )
    .join('\n');
  return `<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n${lines}\n</system-reminder>\n\n`;
}
