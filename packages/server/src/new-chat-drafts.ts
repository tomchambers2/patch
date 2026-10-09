// Server-owned NEW-CHAT drafts (spec/14 § New chat drafts).
//
// A not-yet-sent new chat: folder + host + model + text. Account-wide, so a
// draft typed on one surface is listed on, and deletable from, every other —
// the same ownership as composer drafts (`composer-drafts.ts`), but keyed by a
// surface-minted draft id rather than a chatId.
//
// Persisted as `<dataDir>/new-chat-drafts.json`, written atomically (temp
// file + rename). A re-derivable store must never take the service down: a
// corrupt file is logged loudly and the store starts empty. `dataDir` is
// optional (a bare-registry test): in memory only then.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import type { NewChatDraftBody } from '@patch/wire';
import { hasDraftText } from './composer-drafts.js';

export type NewChatDraft = NewChatDraftBody & { updatedAt: number };

export type NewChatDraftChange =
  | { type: 'set'; draft: NewChatDraft }
  | { type: 'removed'; id: string; updatedAt: number };

export class NewChatDraftStore {
  private readonly path: string | null;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly nowMs: () => number;
  private drafts: Record<string, NewChatDraft>;
  private readonly handlers = new Set<(change: NewChatDraftChange) => void>();

  constructor(opts: { dataDir?: string; logger?: Pick<Logger, 'warn'>; nowMs?: () => number }) {
    this.path = opts.dataDir ? join(opts.dataDir, 'new-chat-drafts.json') : null;
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.drafts = this.load();
  }

  private load(): Record<string, NewChatDraft> {
    if (!this.path || !existsSync(this.path)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      this.logger?.warn(
        { path: this.path, err: (err as Error).message },
        'new-chat-drafts: unreadable file; starting empty',
      );
      return {};
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.logger?.warn({ path: this.path }, 'new-chat-drafts: malformed file; starting empty');
      return {};
    }
    const out: Record<string, NewChatDraft> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const d = value as Partial<NewChatDraft> | null;
      if (
        typeof d === 'object' &&
        d !== null &&
        typeof d.folder === 'string' &&
        typeof d.text === 'string' &&
        typeof d.updatedAt === 'number' &&
        hasDraftText(d.text)
      ) {
        out[id] = {
          id,
          folder: d.folder,
          text: d.text,
          ...(typeof d.daemonId === 'string' && d.daemonId ? { daemonId: d.daemonId } : {}),
          ...(typeof d.model === 'string' && d.model ? { model: d.model } : {}),
          updatedAt: d.updatedAt,
        };
      }
    }
    return out;
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.drafts, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  private emit(change: NewChatDraftChange): void {
    for (const h of this.handlers) {
      try {
        h(change);
      } catch (err) {
        this.logger?.warn(
          { err: (err as Error).message, type: change.type },
          'new-chat-drafts: change handler threw',
        );
      }
    }
  }

  list(): NewChatDraft[] {
    return Object.values(this.drafts);
  }

  /** Record a draft; whitespace-only text is not a draft and is a remove instead. */
  set(draft: NewChatDraftBody): void {
    if (!hasDraftText(draft.text)) {
      this.remove(draft.id);
      return;
    }
    const stored: NewChatDraft = { ...draft, updatedAt: this.nowMs() };
    this.drafts = { ...this.drafts, [draft.id]: stored };
    this.persist();
    this.emit({ type: 'set', draft: stored });
  }

  /** Always emits, even when absent, so a surface holding a stale copy drops it. */
  remove(id: string): void {
    const updatedAt = this.nowMs();
    if (id in this.drafts) {
      const next = { ...this.drafts };
      delete next[id];
      this.drafts = next;
      this.persist();
    }
    this.emit({ type: 'removed', id, updatedAt });
  }

  onChange(handler: (change: NewChatDraftChange) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
