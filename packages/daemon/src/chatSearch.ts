// Chat search (spec/02 § Chat search, spec/03 § Chat search).
//
// Searches every chat on this host — its name, and the text of every user and
// assistant message in its transcript — and answers with ranked hits carrying a
// highlighted snippet and the matched message's canonical seq for jump-to.
//
// WHERE THE TEXT COMES FROM. Patch stores no chat history (principles.md; the
// chat directory "holds ... no transcript", spec/04 § History): the backend's
// own JSONL is the one store. So the index here is a DERIVED, IN-MEMORY cache
// of that JSONL, never written anywhere. It is built once in the background
// when the host starts and then kept current incrementally: every search
// stats each chat's transcript and reads only the bytes appended since the last
// look (the backends append; a file that shrank or a session that changed is
// re-read whole). A restart simply rebuilds it.
//
// WHY NOT A SCAN PER QUERY, OR SQLite FTS. On the host this was built against,
// the transcripts of ~2,200 live chats are 1.7 GB, of which the searchable
// text — user and assistant messages — is ~14 MB; the rest is tool output,
// tool inputs, thinking and attachments. A per-query scan re-reads the 1.7 GB
// (1.6 s warm, 6.5 s cold, and the raw bytes are JSON-escaped, so they cannot
// even be matched case-insensitively as-is). An FTS index would be a second,
// persisted copy of every message — the thing the principle forbids — plus a
// native dependency on every host. Holding the 14 MB in memory answers a query
// in tens of milliseconds and stores nothing.
//
// WHAT IS SEARCHED. User and assistant message text exactly as replay renders
// it (it goes through `jsonlLineToWire`, the replay path itself, so command
// wrappers, injected reminders, `isMeta` turns and synthetic replies are
// already gone). Tool calls and their output are NOT searched: they are 99% of
// the bytes and would drown every query in file dumps and command output — a
// search for a word finds every chat that ever `cat`-ed a file containing it.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareChatSearchHits,
  highlightRanges,
  makeSnippet,
  parseSearchQuery,
  SPECIAL_THREAD_IDS,
  type ChatSearchHit,
  type ChatSearchSection,
  type ChatStatus,
  type WireEvent,
} from '@patch/wire';
export { highlightRanges, makeSnippet };
import { encodeFolder, eventIdentity, jsonlLineToWire } from './history.js';
import { identityHash, readSeqIndexFile } from './seqIndex.js';

/** The fields of a chat the search reads — a subset of `ChatState`. */
export interface SearchableChat {
  chatId: string;
  name: string | null;
  preview: string | null;
  folder: string;
  status: ChatStatus;
  pinned: boolean;
  snoozedUntil: number | null;
  /** spec/04 § Hidden — drawn in the Hidden section while active. */
  hidden: boolean;
  lastUpdated: number;
  /** The ACTIVE track's session (spec/04 § Branching); absent before the first turn. */
  claudeSessionId: string | undefined;
}

export interface ChatSearchIndexOptions {
  /** Where Claude Code writes transcripts (`~/.claude/projects`). */
  claudeProjectsRoot: string;
  /** Where the Codex backend writes its history (`<patch home>/openai-history`). */
  codexHistoryRoot: string;
  /** A chat's canonical-seq sidecar — read, never written. */
  seqIndexPath: (chatId: string) => string;
  now: () => number;
  /** A transcript line that is not valid JSON — skipped, and reported here. */
  onCorruptLine?: (info: { path: string; message: string }) => void;
}

interface IndexedMessage {
  role: 'user' | 'assistant';
  text: string;
  lower: string;
  /** `identityHash(eventIdentity(...))` — what the seq sidecar is keyed on. */
  hash: string;
  /** How many earlier messages in this transcript share `hash`. */
  occurrence: number;
  createdAt: number | null;
}

interface ChatEntry {
  path: string;
  kind: 'claude' | 'codex';
  /** Bytes consumed — always the end of a complete line. */
  offset: number;
  messages: IndexedMessage[];
  occurrences: Map<string, number>;
}

export interface ChatSearchResult {
  hits: ChatSearchHit[];
  total: number;
  searchedChats: number;
  transcriptsMissing: number;
}

/** Characters of context either side of the match in a snippet. */

/**
 * A long JSONL line is only worth parsing if it can yield message text. Every
 * one of these, found structurally (unescaped quotes — the same bytes inside a
 * JSON string are always `\"`-escaped, so text cannot fake them) near the start
 * of the line, marks a line whose content block is tool traffic, thinking or an
 * attachment. Checking only the head keeps the scan off the megabytes of tool
 * output a single line can carry.
 */
const SKIP_MARKERS = [
  '"type":"tool_result"',
  '"type":"tool_use"',
  '"type":"thinking"',
  '"type":"redacted_thinking"',
  '"attachment":{',
  '"type":"progress"',
  '"type":"queue-operation"',
].map((m) => Buffer.from(m));
const HEAD_BYTES = 512;
/** One shared, never-read map: search keeps messages only, so tool names are moot. */
const UNUSED_TOOL_NAMES = new Map<string, string>();
/** Read transcripts in slices, so one huge file never needs one huge buffer. */
const READ_CHUNK = 8 * 1024 * 1024;

function isSkippable(line: Buffer): boolean {
  const head = line.length > HEAD_BYTES ? line.subarray(0, HEAD_BYTES) : line;
  for (const m of SKIP_MARKERS) if (head.indexOf(m) >= 0) return true;
  return false;
}

/** Query → distinct lowercase terms; a "quoted run" is one exact-phrase term. */
export function queryTerms(query: string): string[] {
  return parseSearchQuery(query);
}

/** Lowercased with whitespace runs collapsed, so a phrase matches across a line break. */
function matchForm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function includesAll(lower: string, terms: string[]): boolean {
  for (const t of terms) if (!lower.includes(t)) return false;
  return true;
}

function sectionOf(chat: SearchableChat, now: number): ChatSearchSection {
  if (chat.chatId === SPECIAL_THREAD_IDS.manager) return 'manager';
  if (chat.chatId === SPECIAL_THREAD_IDS.speakers) {
    return 'channels';
  }
  if (chat.status === 'archived') return 'archived';
  if (chat.hidden) return 'hidden';
  // spec/04 § Snooze: snoozed ⇔ a wake time still in the future on an active chat.
  if (chat.status === 'active' && chat.snoozedUntil !== null && chat.snoozedUntil > now) {
    return 'snoozed';
  }
  if (chat.pinned) return 'pinned';
  return 'folders';
}

export class ChatSearchIndex {
  private readonly entries = new Map<string, ChatEntry>();

  constructor(
    private readonly opts: ChatSearchIndexOptions,
    private readonly daemonId: string,
  ) {}

  /** The transcript a chat's active track lives in, or null before its first turn. */
  private transcriptOf(chat: SearchableChat): { path: string; kind: 'claude' | 'codex' } | null {
    const sessionId = chat.claudeSessionId;
    if (!sessionId) return null;
    if (sessionId.startsWith('codex-')) {
      return { path: join(this.opts.codexHistoryRoot, `${sessionId}.jsonl`), kind: 'codex' };
    }
    return {
      path: join(this.opts.claudeProjectsRoot, encodeFolder(chat.folder), `${sessionId}.jsonl`),
      kind: 'claude',
    };
  }

  /**
   * Bring one chat's entry up to date with its transcript. Returns false when
   * the chat has a session but its transcript is gone from disk (the backend
   * pruned it) — only its name and preview can be searched.
   */
  private refreshChat(chat: SearchableChat): boolean {
    const source = this.transcriptOf(chat);
    if (source === null) {
      this.entries.delete(chat.chatId);
      return true;
    }
    const st = statSync(source.path, { throwIfNoEntry: false });
    if (st === undefined) {
      this.entries.delete(chat.chatId);
      return false;
    }
    let entry = this.entries.get(chat.chatId);
    // A different session (a track switch, a rotation) or a file that is now
    // SHORTER than what was read (rewritten, not appended) is re-read whole.
    if (!entry || entry.path !== source.path || st.size < entry.offset) {
      entry = { ...source, offset: 0, messages: [], occurrences: new Map() };
      this.entries.set(chat.chatId, entry);
    }
    if (st.size > entry.offset) this.readAppended(chat.chatId, entry, st.size);
    return true;
  }

  private readAppended(chatId: string, entry: ChatEntry, size: number): void {
    const fd = openSync(entry.path, 'r');
    try {
      let carry: Buffer = Buffer.alloc(0);
      let position = entry.offset;
      while (position < size) {
        const want = Math.min(READ_CHUNK, size - position);
        const chunk = Buffer.allocUnsafe(want);
        const got = readSync(fd, chunk, 0, want, position);
        if (got === 0) break;
        position += got;
        const buf: Buffer =
          carry.length > 0
            ? Buffer.concat([carry, chunk.subarray(0, got)])
            : chunk.subarray(0, got);
        let start = 0;
        for (let nl = buf.indexOf(10, start); nl >= 0; nl = buf.indexOf(10, start)) {
          const line = buf.subarray(start, nl);
          start = nl + 1;
          entry.offset += line.length + 1;
          if (line.length > 0) this.ingestLine(chatId, entry, line);
        }
        // An unterminated tail is a line still being written: leave it for the
        // next refresh rather than reading half of it.
        carry = Buffer.from(buf.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  }

  private ingestLine(chatId: string, entry: ChatEntry, line: Buffer): void {
    if (entry.kind === 'claude' && isSkippable(line)) return;
    let events: WireEvent[];
    try {
      if (entry.kind === 'claude') {
        events = jsonlLineToWire(line.toString('utf8'), chatId, 0, UNUSED_TOOL_NAMES);
      } else {
        const parsed = JSON.parse(line.toString('utf8')) as { event?: WireEvent };
        events = parsed.event ? [parsed.event] : [];
      }
    } catch (err) {
      this.opts.onCorruptLine?.({ path: entry.path, message: (err as Error).message });
      return;
    }
    for (const ev of events) {
      if (ev.type !== 'chat.message') continue;
      if (ev.role !== 'user' && ev.role !== 'assistant') continue;
      if (ev.content.length === 0) continue;
      const key = eventIdentity(ev);
      /* v8 ignore next -- a chat.message always has an identity */
      if (key === null) continue;
      const hash = identityHash(key);
      const occurrence = entry.occurrences.get(hash) ?? 0;
      entry.occurrences.set(hash, occurrence + 1);
      entry.messages.push({
        role: ev.role,
        text: ev.content,
        lower: matchForm(ev.content),
        hash,
        occurrence,
        createdAt: typeof ev.createdAt === 'number' ? ev.createdAt : null,
      });
    }
  }

  /**
   * Build the index in the background, yielding to the event loop between
   * chats so the host stays responsive while ~GBs of transcript are read.
   */
  async warm(chats: SearchableChat[]): Promise<void> {
    for (const chat of chats) {
      if (chat.status === 'deleted') continue;
      this.refreshChat(chat);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** How many chats the index currently holds a transcript for. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Search `chats` for `query`, returning the top `limit` hits. Deleted chats
   * are never searched. Brings every chat up to date with its transcript first,
   * so a message written a moment ago is findable. With `fullText` false only
   * chat names are searched and no transcript is read.
   */
  search(chats: SearchableChat[], query: string, limit: number, fullText = true): ChatSearchResult {
    const terms = queryTerms(query);
    const now = this.opts.now();
    const live = chats.filter((c) => c.status !== 'deleted');
    const liveIds = new Set(live.map((c) => c.chatId));
    for (const id of [...this.entries.keys()]) if (!liveIds.has(id)) this.entries.delete(id);

    let transcriptsMissing = 0;
    const found: {
      hit: ChatSearchHit;
      message: IndexedMessage | null;
      previewMatch: boolean;
    }[] = [];
    for (const chat of live) {
      if (fullText && !this.refreshChat(chat)) transcriptsMissing += 1;
      if (terms.length === 0) continue;
      const nameMatch = chat.name !== null && includesAll(matchForm(chat.name), terms);
      const messages = fullText ? (this.entries.get(chat.chatId)?.messages ?? []) : [];
      let matches = 0;
      let newest: IndexedMessage | null = null;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        if (!includesAll(m.lower, terms)) continue;
        matches += 1;
        if (newest === null) newest = m;
      }
      // The stored first-message preview stands in for a transcript that has
      // no match — most often one the backend has since pruned from disk.
      const previewMatch =
        fullText &&
        matches === 0 &&
        chat.preview !== null &&
        includesAll(matchForm(chat.preview), terms);
      if (!nameMatch && matches === 0 && !previewMatch) continue;
      found.push({
        hit: {
          chatId: chat.chatId,
          daemonId: this.daemonId,
          name: chat.name,
          preview: chat.preview,
          folder: chat.folder,
          status: chat.status,
          section: sectionOf(chat, now),
          pinned: chat.pinned,
          snoozedUntil: chat.snoozedUntil,
          lastUpdated: chat.lastUpdated,
          jobId: null,
          nameMatch,
          nameHighlights: nameMatch ? highlightRanges(chat.name!, terms) : [],
          messageMatches: previewMatch ? 1 : matches,
          snippet: null,
        },
        message: newest,
        previewMatch,
      });
    }
    found.sort((a, b) => compareChatSearchHits(a.hit, b.hit));
    const top = found.slice(0, limit);
    // Snippets and seqs are only worth making for the hits going back, so only
    // their text is windowed and only their sidecars are read.
    for (const { hit, message, previewMatch } of top) {
      if (message !== null) {
        const seqs = readSeqIndexFile(this.opts.seqIndexPath(hit.chatId), hit.chatId);
        hit.snippet = {
          ...makeSnippet(message.text, terms),
          role: message.role,
          seq: seqs.get(message.hash)?.[message.occurrence] ?? null,
          createdAt: message.createdAt,
        };
      } else if (previewMatch) {
        hit.snippet = {
          ...makeSnippet(hit.preview!, terms),
          role: 'user',
          seq: null,
          createdAt: null,
        };
      }
    }
    return {
      hits: top.map((f) => f.hit),
      total: found.length,
      searchedChats: live.length,
      transcriptsMissing,
    };
  }
}

export interface ChatSearchHandlerDeps {
  index: ChatSearchIndex;
  /** Settles when the background build has finished (it never rejects). */
  ready: Promise<void>;
  listChats: () => SearchableChat[];
  daemonId: string;
  logger: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

/**
 * Answer one `patch.chat_search.request` with exactly one response. A request
 * that lands while the index is still being built waits for the build: an
 * answer from a half-built index would read as "not found" for chats it had
 * simply not reached yet.
 */
export async function handleChatSearchRequest(
  event: Extract<WireEvent, { type: 'patch.chat_search.request' }>,
  deps: ChatSearchHandlerDeps,
  sender: (e: WireEvent) => void,
): Promise<void> {
  await deps.ready;
  const started = Date.now();
  try {
    const result = deps.index.search(
      deps.listChats(),
      event.query,
      event.limit,
      event.fullText !== false,
    );
    deps.logger.info(
      {
        tookMs: Date.now() - started,
        total: result.total,
        searchedChats: result.searchedChats,
        transcriptsMissing: result.transcriptsMissing,
      },
      'chat search answered',
    );
    sender({
      type: 'patch.chat_search.response',
      requestId: event.requestId,
      daemonId: deps.daemonId,
      ok: true,
      hits: result.hits,
      total: result.total,
      searchedChats: result.searchedChats,
      transcriptsMissing: result.transcriptsMissing,
    });
  } catch (err) {
    const message = (err as Error).message;
    deps.logger.error({ err: message }, 'chat search failed');
    sender({
      type: 'patch.chat_search.response',
      requestId: event.requestId,
      daemonId: deps.daemonId,
      ok: false,
      error: { code: 'internal', message },
    });
  }
}
