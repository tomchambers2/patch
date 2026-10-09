// The Claude Agent SDK's `SessionStore` adapter (spec/04 § History — the
// native resume cache, and the mechanism behind a seamless switch onto
// Claude). One instance per `query()` call — cheap to build, closes over
// exactly the one session that call is resuming.
//
// `append()` mirrors every live entry into
// `~/.patch/chats/<chatId>/native/claude/<sessionId>.jsonl` — an independent
// copy that outlives Claude Code's own cleanup of `~/.claude/projects/...`.
// `load()` is the resume path, in priority order:
//   1. A reseed target (a provider switch, or an explicit reconstruction):
//      synthesize from the chat's own log via `toClaudeSessionEntries`.
//   2. The native mirror, if this session has one.
//   3. The harness's own on-disk transcript, if the mirror doesn't have it yet
//      (an existing session touched for the first time since this adapter
//      shipped) — never mirrored, but a resume must not regress on it.
//   4. `null` — genuinely never seen (a brand new session's first turn).
// Whatever it loads, it hands the model only the conversation: every entry
// the harness wrote itself is stripped first (`syntheticTurns.ts`).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { encodeFolder } from './history.js';
import {
  toClaudeSessionEntries,
  type ClaudeSessionEntry,
  type TrackEntry,
} from './nativeReconstruct.js';
import { stripSyntheticTurns } from './syntheticTurns.js';

export interface ClaudeSessionStoreOptions {
  chatId: string;
  folder: string;
  /** `~/.patch/chats/<chatId>/native/claude`. */
  nativeDir: string;
  claudeProjectsRoot: string;
  logger: Logger;
  /** Set only when this query is a provider switch or an explicit reseed. */
  reseed?: { sessionId: string; events: readonly TrackEntry[]; model: string | null };
  /**
   * Called with each batch of entries newly written to the mirror. Some of
   * what Claude Code writes never crosses the SDK stream — the `No response
   * requested.` it inserts when it resumes a session that ended on an
   * unanswered turn is written straight to the transcript — so this is the
   * only place the daemon gets to see it (spec/02 § Per-turn process).
   */
  onAppend?: (entries: readonly SessionStoreEntry[]) => void;
}

function parseJsonl(text: string): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as SessionStoreEntry);
    } catch {
      // A damaged line in a mirror we wrote ourselves would be a bug; skip it
      // rather than fail the whole resume over one line.
    }
  }
  return out;
}

export function createClaudeSessionStore(opts: ClaudeSessionStoreOptions): SessionStore {
  const seenUuidsByPath = new Map<string, Set<string>>();

  function mirrorPath(key: SessionKey): string {
    const suffix = key.subpath ? `-${key.subpath.replace(/\//g, '_')}` : '';
    return join(opts.nativeDir, `${key.sessionId}${suffix}.jsonl`);
  }

  function seenSetFor(path: string): Set<string> {
    let seen = seenUuidsByPath.get(path);
    if (seen) return seen;
    seen = new Set();
    if (existsSync(path)) {
      for (const entry of parseJsonl(readFileSync(path, 'utf8'))) {
        if (entry.uuid) seen.add(entry.uuid);
      }
    }
    seenUuidsByPath.set(path, seen);
    return seen;
  }

  return {
    async append(key, entries) {
      mkdirSync(opts.nativeDir, { recursive: true });
      const path = mirrorPath(key);
      const seen = seenSetFor(path);
      // Entries without a uuid (titles, tags, mode markers) are appended
      // unconditionally, matching the SDK's own dedup guidance.
      const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
      if (fresh.length === 0) return;
      appendFileSync(path, fresh.map((e) => JSON.stringify(e) + '\n').join(''));
      for (const e of fresh) if (e.uuid) seen.add(e.uuid);
      opts.onAppend?.(fresh);
    },

    async load(key) {
      const loaded = loadRaw(key);
      if (loaded === null) return null;
      const result = stripSyntheticTurns(loaded);
      if (result.synthetic > 0 || result.unansweredPrompts > 0) {
        opts.logger.info(
          {
            chatId: opts.chatId,
            sessionId: key.sessionId,
            synthetic: result.synthetic,
            injectedPrompts: result.injectedPrompts,
            unansweredPrompts: result.unansweredPrompts,
          },
          'claude session store: kept harness-written turns out of the resumed context',
        );
      }
      return result.entries;
    },
  };

  function loadRaw(key: SessionKey): SessionStoreEntry[] | null {
    if (opts.reseed && key.sessionId === opts.reseed.sessionId) {
      const entries = toClaudeSessionEntries(opts.reseed.events, {
        sessionId: opts.reseed.sessionId,
        folder: opts.folder,
        model: opts.reseed.model,
      });
      opts.logger.info(
        { chatId: opts.chatId, sessionId: opts.reseed.sessionId, entries: entries.length },
        "claude session store: reseeded from the chat's own log",
      );
      return entries as ClaudeSessionEntry[] as SessionStoreEntry[];
    }
    const mirrored = mirrorPath(key);
    if (existsSync(mirrored)) {
      const entries = parseJsonl(readFileSync(mirrored, 'utf8'));
      if (entries.length > 0) return entries;
    }
    const local = join(
      opts.claudeProjectsRoot,
      encodeFolder(opts.folder),
      `${key.sessionId}${key.subpath ? `/${key.subpath}` : ''}.jsonl`,
    );
    if (existsSync(local)) return parseJsonl(readFileSync(local, 'utf8'));
    return null;
  }
}
