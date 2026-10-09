// Server-only chatId → jobId links, for the sidebar's Automations group
// (spec/14 § Sidebar, spec/08 § Action).
//
// `spawn` and `ensure` actions are linked — a chat that exists ONLY because a
// job fired, whether that is a fresh one per fire (`spawn`) or the durable one
// the job owns (`ensure`, one per subject when the action is keyed). `message`
// delivers into a chat the user already owns and already knows about, so it
// carries no link.
//
// The host has no notion of jobs, so this cannot live in `chat.spawned`'s
// payload without the host's involvement — instead the SERVER records the
// link itself, at the moment `JobDispatcher.dispatch()` allocates the
// spawn's chatId (before the host has even confirmed the spawn), and reads
// it back independently in `ChatRegistry` (REST cold-start) and `WsHub`
// (live WS relay). One file: `<dataDir>/job-chat-links.json` — NOT inside
// `<dataDir>/jobs/`, which `JobStore` scans for job DEFINITIONS.
//
// Persisted (not in-memory-only): this server restarts on every deploy, and
// a deploy losing every automation tag would defeat the point of tagging.
// Capped at a bounded number of entries — an unbounded map would grow
// forever on a busy webhook job.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

/** Oldest links are evicted past this — bounds file size on a busy job. */
const DEFAULT_CAP = 2000;

export interface JobChatLinksOptions {
  dataDir: string;
  logger?: Pick<Logger, 'warn'>;
  cap?: number;
}

export class JobChatLinks {
  private readonly path: string;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly cap: number;
  /** Insertion-ordered (Map preserves insertion order) — oldest-first for eviction. */
  private readonly links = new Map<string, string>();

  constructor(opts: JobChatLinksOptions) {
    this.path = join(opts.dataDir, 'job-chat-links.json');
    this.logger = opts.logger;
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      this.logger?.warn(
        { err: (err as Error).message },
        'job-chat-links: read failed, starting empty',
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger?.warn(
        { err: (err as Error).message },
        'job-chat-links: malformed JSON, starting empty',
      );
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    for (const [chatId, jobId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof jobId === 'string' && jobId.length > 0) this.links.set(chatId, jobId);
    }
  }

  private persist(): void {
    const dir = join(this.path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.links)), 'utf8');
  }

  /** Record that `chatId` was created by `jobId`'s `spawn`/`ensure` action. */
  record(chatId: string, jobId: string): void {
    // Idempotent and free to call on every fire: an `ensure` action re-asserts
    // the link each time it delivers into its durable chat, and re-persisting
    // an unchanged map on every fire would be a disk write per job run.
    if (this.links.get(chatId) === jobId) return;
    this.links.set(chatId, jobId);
    while (this.links.size > this.cap) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    this.persist();
  }

  /** The job that spawned `chatId`, or null if it wasn't job-spawned. */
  get(chatId: string): string | null {
    return this.links.get(chatId) ?? null;
  }
}
