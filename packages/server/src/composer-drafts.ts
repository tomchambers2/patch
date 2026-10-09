// Server-owned composer drafts (spec/14 § Composer, spec/15 § Composer).
//
// One entry per chatId: the unsent text sitting in that chat's composer,
// followed onto every surface that has the chat open. The SERVER holds this,
// not the host — a chat's host can be asleep, but the server is always up
// and every surface talks to it directly (spec/01 § Responsibilities).
//
// Persisted as one file, `<dataDir>/composer-drafts.json` — a chatId -> entry
// map, the same shape the web store kept in its own `localStorage` blob
// before this. `dataDir` is optional (a bare-registry test has nowhere to
// persist): the store still works, in memory only, for the life of the
// process. NO FALLBACK: a corrupt file is reported and the store starts
// empty, never a silently-wrong draft.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';

/**
 * True when `text` is a real draft — not empty, not whitespace-only. Same
 * rule as every surface's own store (`hasDraftText` in `packages/web/src/lib/
 * draftText.ts` and `apps/mobile/src/lib/composerDraft.ts`): typing and then
 * deleting again must leave nothing behind here either, or the server would
 * disagree with every surface about whether a chat has a draft.
 */
export function hasDraftText(text: string): boolean {
  return text.trim() !== '';
}

/**
 * The key a surface's new-chat composer types into before any chat exists. It
 * belongs to no chat, so it is never a server draft: stored, it would be
 * handed to every surface's new-chat composer as if it were theirs.
 */
export const NEW_CHAT_PLACEHOLDER_ID = 'new';

export interface ComposerDraftEntry {
  chatId: string;
  text: string;
  updatedAt: number;
}

export type ComposerDraftChange =
  | { type: 'set'; chatId: string; text: string; updatedAt: number }
  | { type: 'cleared'; chatId: string; updatedAt: number };

interface StoredDraft {
  text: string;
  updatedAt: number;
}

export class ComposerDraftStore {
  private readonly path: string | null;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly nowMs: () => number;
  private drafts: Record<string, StoredDraft>;
  private readonly handlers = new Set<(change: ComposerDraftChange) => void>();

  constructor(opts: { dataDir?: string; logger?: Pick<Logger, 'warn'>; nowMs?: () => number }) {
    this.path = opts.dataDir ? join(opts.dataDir, 'composer-drafts.json') : null;
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.drafts = this.load();
  }

  private load(): Record<string, StoredDraft> {
    if (!this.path || !existsSync(this.path)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      this.logger?.warn(
        { path: this.path, err: (err as Error).message },
        'composer-drafts: unreadable file; starting empty',
      );
      return {};
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.logger?.warn({ path: this.path }, 'composer-drafts: malformed file; starting empty');
      return {};
    }
    const out: Record<string, StoredDraft> = {};
    for (const [chatId, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<StoredDraft> | null;
      if (
        chatId !== NEW_CHAT_PLACEHOLDER_ID &&
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.text === 'string' &&
        typeof entry.updatedAt === 'number' &&
        hasDraftText(entry.text)
      ) {
        out[chatId] = { text: entry.text, updatedAt: entry.updatedAt };
      }
    }
    return out;
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.drafts, null, 2), 'utf8');
  }

  private emit(change: ComposerDraftChange): void {
    for (const h of this.handlers) {
      try {
        h(change);
      } catch (err) {
        this.logger?.warn(
          { err: (err as Error).message, type: change.type },
          'composer-drafts: change handler threw',
        );
      }
    }
  }

  /**
   * Every draft the account currently has — the cold-start snapshot a
   * newly-connecting surface needs (`composer_draft.list`, sent once right
   * after `auth.ok`).
   */
  list(): ComposerDraftEntry[] {
    return Object.entries(this.drafts).map(([chatId, d]) => ({ chatId, ...d }));
  }

  get(chatId: string): ComposerDraftEntry | undefined {
    const d = this.drafts[chatId];
    return d ? { chatId, ...d } : undefined;
  }

  /**
   * Record what a surface's composer holds for `chatId`, stamped with the
   * server's own receipt time — the newest-write-wins clock every surface
   * compares against before applying an incoming draft over a newer local
   * edit still in flight. Whitespace-only or empty text is not a draft
   * (`hasDraftText`) and is a CLEAR instead, so the store never grows a key
   * per chat ever opened.
   */
  set(chatId: string, text: string): void {
    if (chatId === NEW_CHAT_PLACEHOLDER_ID) return;
    if (!hasDraftText(text)) {
      this.clear(chatId);
      return;
    }
    const updatedAt = this.nowMs();
    this.drafts = { ...this.drafts, [chatId]: { text, updatedAt } };
    this.persist();
    this.emit({ type: 'set', chatId, text, updatedAt });
  }

  /**
   * Drop `chatId`'s draft — its text was sent, its composer was emptied back
   * out, or the chat was deleted. Always emits, even when there was nothing
   * to drop, so every surface is told to drop its own local copy too (a
   * surface that typed something then went offline before the clear reached
   * the server must still hear about it once reconnected).
   */
  clear(chatId: string): void {
    const updatedAt = this.nowMs();
    if (chatId in this.drafts) {
      const next = { ...this.drafts };
      delete next[chatId];
      this.drafts = next;
      this.persist();
    }
    this.emit({ type: 'cleared', chatId, updatedAt });
  }

  onChange(handler: (change: ComposerDraftChange) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
