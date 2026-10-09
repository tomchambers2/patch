// The server's durable copy of what was said in each chat (spec/04 § History —
// server mirror).
//
// Transcripts belong to the host that ran the chat. This persists the
// user/assistant messages that already stream through the server, one JSONL
// file per chat under `<dataDir>/chat-mirror/`, so a chat whose host is asleep
// can still be found by search.
//
// It is a re-derivable secondary store: a host replay refills it. So a corrupt
// line is logged loudly and skipped, never thrown — it must not take the
// server down. Appends are idempotent on `seq` (a replay re-sends old turns).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { makeSnippet, parseSearchQuery, type ChatSearchSnippet, type WireEvent } from '@patch/wire';

export interface MirroredMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export interface MirrorMatch {
  messageMatches: number;
  snippet: ChatSearchSnippet;
}

export interface ChatMirrorOptions {
  dataDir: string;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Lowercased, whitespace collapsed — so a phrase matches across a line break. */
const matchForm = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

export class ChatMirror {
  private readonly dir: string;
  private readonly seen = new Map<string, Set<number>>();
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly now: () => number;

  constructor(opts: ChatMirrorOptions) {
    this.dir = join(opts.dataDir, 'chat-mirror');
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
  }

  observe(event: WireEvent): void {
    if (event.type === 'chat.replay_batch') {
      for (const inner of event.events) this.observe(inner as WireEvent);
      return;
    }
    if (event.type !== 'chat.message') return;
    if (event.role !== 'user' && event.role !== 'assistant') return;
    if (event.content.length === 0) return;
    if (!SAFE_ID.test(event.chatId)) {
      this.logger.warn({ chatId: event.chatId }, 'chat mirror: unsafe chat id; not mirrored');
      return;
    }
    const seen = this.seenFor(event.chatId);
    if (seen.has(event.seq)) return;
    const line: MirroredMessage = {
      seq: event.seq,
      role: event.role,
      content: event.content,
      at: this.now(),
    };
    try {
      appendFileSync(this.path(event.chatId), `${JSON.stringify(line)}\n`, 'utf8');
      seen.add(event.seq);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, chatId: event.chatId },
        'chat mirror: write failed',
      );
    }
  }

  /** Every chat with at least one mirrored message. */
  chatIds(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length));
  }

  messages(chatId: string): MirroredMessage[] {
    if (!SAFE_ID.test(chatId) || !existsSync(this.path(chatId))) return [];
    const out: MirroredMessage[] = [];
    readFileSync(this.path(chatId), 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        if (raw.length === 0) return;
        try {
          const m = JSON.parse(raw) as MirroredMessage;
          if (typeof m.seq !== 'number' || typeof m.content !== 'string') {
            throw new Error('bad shape');
          }
          out.push(m);
        } catch (err) {
          this.logger.warn(
            { chatId, line: i + 1, err: (err as Error).message },
            'chat mirror: corrupt line skipped',
          );
        }
      });
    return out;
  }

  /** Messages containing every term; the newest is the snippet. `null` for none. */
  search(query: string, chatId: string): MirrorMatch | null {
    const terms = parseSearchQuery(query);
    if (terms.length === 0) return null;
    let matches = 0;
    let latest: MirroredMessage | null = null;
    for (const m of this.messages(chatId)) {
      const lower = matchForm(m.content);
      if (!terms.every((t) => lower.includes(t))) continue;
      matches++;
      if (latest === null || m.seq >= latest.seq) latest = m;
    }
    if (latest === null) return null;
    const { text, highlights } = makeSnippet(latest.content, terms);
    return {
      messageMatches: matches,
      snippet: { text, highlights, role: latest.role, seq: latest.seq, createdAt: latest.at },
    };
  }

  private path(chatId: string): string {
    return join(this.dir, `${chatId}.jsonl`);
  }

  private seenFor(chatId: string): Set<number> {
    let s = this.seen.get(chatId);
    if (!s) {
      s = new Set(this.messages(chatId).map((m) => m.seq));
      this.seen.set(chatId, s);
    }
    return s;
  }
}
