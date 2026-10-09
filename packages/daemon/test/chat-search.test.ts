// Chat search (spec/02 § Chat search): an in-memory index derived from the
// backends' own transcripts, kept current incrementally, answering ranked hits
// with snippets and the matched message's canonical seq.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import {
  ChatSearchIndex,
  handleChatSearchRequest,
  highlightRanges,
  makeSnippet,
  queryTerms,
  type SearchableChat,
} from '../src/chatSearch.js';
import { encodeFolder, eventIdentity } from '../src/history.js';
import { identityHash } from '../src/seqIndex.js';

const NOW = 1_800_000_000_000;
const FOLDER = '/home/tom/project';

let root: string;
let claudeRoot: string;
let codexRoot: string;
let chatsRoot: string;
let corrupt: { path: string; message: string }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-chat-search-'));
  claudeRoot = join(root, 'claude-projects');
  codexRoot = join(root, 'openai-history');
  chatsRoot = join(root, 'chats');
  mkdirSync(join(claudeRoot, encodeFolder(FOLDER)), { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  corrupt = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function index(): ChatSearchIndex {
  return new ChatSearchIndex(
    {
      claudeProjectsRoot: claudeRoot,
      codexHistoryRoot: codexRoot,
      seqIndexPath: (chatId) => join(chatsRoot, chatId, 'seqindex.jsonl'),
      now: () => NOW,
      onCorruptLine: (info) => corrupt.push(info),
    },
    'host-a',
  );
}

function chat(over: Partial<SearchableChat> & { chatId: string }): SearchableChat {
  return {
    name: null,
    preview: null,
    folder: FOLDER,
    status: 'active',
    pinned: false,
    snoozedUntil: null,
    lastUpdated: NOW - 1000,
    claudeSessionId: `s-${over.chatId}`,
    ...over,
  };
}

const user = (text: string, ts = '2026-09-01T10:00:00.000Z'): string =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const assistant = (text: string, ts = '2026-09-01T10:00:05.000Z'): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  });
const toolUse = (id: string, input: unknown): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id, name: 'Bash', input }],
    },
  });
const toolResult = (id: string, content: string): string =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] },
  });

function transcriptPath(c: SearchableChat): string {
  return join(claudeRoot, encodeFolder(c.folder), `${c.claudeSessionId}.jsonl`);
}
function writeTranscript(c: SearchableChat, lines: string[]): void {
  writeFileSync(transcriptPath(c), lines.map((l) => `${l}\n`).join(''));
}
/** Record canonical seqs for messages, as chatRunner's emit() would. */
function recordSeq(chatId: string, role: 'user' | 'assistant', content: string, seq: number): void {
  const ev = { type: 'chat.message', chatId, role, content, seq } as WireEvent;
  mkdirSync(join(chatsRoot, chatId), { recursive: true });
  appendFileSync(
    join(chatsRoot, chatId, 'seqindex.jsonl'),
    `${JSON.stringify({ seq, hash: identityHash(eventIdentity(ev)!) })}\n`,
  );
}

describe('chat search index', () => {
  it('finds user and assistant text case-insensitively, every term in one message', () => {
    const c = chat({ chatId: 'c1', name: 'Heating' });
    writeTranscript(c, [
      user('Why is the Boiler losing pressure?'),
      assistant('The boiler pressure drops when the expansion vessel fails.'),
      user('pressure only'),
    ]);
    const r = index().search([c], 'BOILER pressure', 20);
    expect(r.total).toBe(1);
    const hit = r.hits[0]!;
    expect(hit.nameMatch).toBe(false);
    expect(hit.messageMatches).toBe(2);
    // The most recent matching message is the snippet.
    expect(hit.snippet).toMatchObject({ role: 'assistant' });
    expect(hit.snippet!.text).toBe('The boiler pressure drops when the expansion vessel fails.');
    expect(hit.snippet!.highlights).toEqual([
      [4, 10],
      [11, 19],
    ]);
    expect(hit.snippet!.createdAt).toBe(Date.parse('2026-09-01T10:00:05.000Z'));
  });

  it('treats a quoted run as an exact phrase, across a line break', () => {
    const c1 = chat({ chatId: 'c1' });
    const c2 = chat({ chatId: 'c2' });
    writeTranscript(c1, [user('the expansion vessel is split')]);
    writeTranscript(c2, [user('vessel for the expansion\nbut not in that order')]);
    const idx = index();
    expect(idx.search([c1, c2], 'expansion vessel', 20).total).toBe(2);
    const r = idx.search([c1, c2], '"expansion vessel"', 20);
    expect(r.hits.map((h) => h.chatId)).toEqual(['c1']);
    expect(r.hits[0]!.snippet!.highlights).toEqual([[4, 20]]);
    const wrapped = chat({ chatId: 'c3' });
    writeTranscript(wrapped, [user('the expansion\n  vessel')]);
    expect(idx.search([wrapped], '"expansion vessel"', 20).total).toBe(1);
    // A phrase and a plain term must both hold.
    expect(idx.search([c1], '"expansion vessel" split', 20).total).toBe(1);
    expect(idx.search([c1], '"expansion vessel" kettle', 20).total).toBe(0);
  });

  it('searches names only when fullText is false, reading no transcript', () => {
    const named = chat({ chatId: 'n', name: 'Garden plan' });
    const said = chat({ chatId: 's', name: 'Other', preview: 'garden preview' });
    writeTranscript(named, [user('nothing')]);
    writeTranscript(said, [user('the garden is wet')]);
    const idx = index();
    expect(
      idx
        .search([named, said], 'garden', 20, true)
        .hits.map((h) => h.chatId)
        .sort(),
    ).toEqual(['n', 's']);
    const r = idx.search([named, said], 'garden', 20, false);
    expect(r.hits.map((h) => h.chatId)).toEqual(['n']);
    expect(r.hits[0]).toMatchObject({ nameMatch: true, messageMatches: 0, snippet: null });
    expect(idx.search([named, said], '"garden plan"', 20, false).total).toBe(1);
    // A pruned transcript is not "missing" when none was going to be read.
    const gone = chat({ chatId: 'g', name: 'garden gone' });
    expect(index().search([gone], 'garden', 20, false).transcriptsMissing).toBe(0);
  });

  it('does not search tool calls, tool output or thinking', () => {
    const c = chat({ chatId: 'c1' });
    writeTranscript(c, [
      user('list the files'),
      toolUse('t1', { command: 'cat secret-kumquat.txt' }),
      toolResult('t1', 'kumquat '.repeat(20_000)),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'thinking', thinking: 'the kumquat file' }],
        },
      }),
      assistant('Done.'),
    ]);
    expect(index().search([c], 'kumquat', 20).total).toBe(0);
  });

  it('orders hits by most recent activity, name match or not', () => {
    const older = chat({ chatId: 'old', name: 'Garden plan', lastUpdated: NOW - 5000 });
    const newer = chat({ chatId: 'new', lastUpdated: NOW - 10 });
    const middle = chat({ chatId: 'mid', lastUpdated: NOW - 100 });
    writeTranscript(older, [user('nothing here')]);
    writeTranscript(newer, [assistant('the garden needs water')]);
    writeTranscript(middle, [user('garden gnomes')]);
    const r = index().search([middle, newer, older], 'garden', 20);
    expect(r.hits.map((h) => h.chatId)).toEqual(['new', 'mid', 'old']);
    expect(r.hits[2]!).toMatchObject({ nameMatch: true, nameHighlights: [[0, 6]], snippet: null });
  });

  it('labels every section and never searches a deleted chat', () => {
    const chats = [
      chat({ chatId: 'thread_manager', name: 'Manager moss' }),
      chat({ chatId: 'thread_speakers', name: 'Speakers moss' }),
      chat({ chatId: 'arch', name: 'moss archived', status: 'archived' }),
      chat({ chatId: 'snz', name: 'moss snoozed', snoozedUntil: NOW + 60_000 }),
      chat({ chatId: 'lapsed', name: 'moss lapsed snooze', snoozedUntil: NOW - 60_000 }),
      chat({ chatId: 'pin', name: 'moss pinned', pinned: true }),
      chat({ chatId: 'del', name: 'moss deleted', status: 'deleted' }),
    ];
    const r = index().search(chats, 'moss', 20);
    const sections = Object.fromEntries(r.hits.map((h) => [h.chatId, h.section]));
    expect(sections).toEqual({
      thread_manager: 'manager',
      thread_speakers: 'channels',
      arch: 'archived',
      snz: 'snoozed',
      lapsed: 'folders',
      pin: 'pinned',
    });
    expect(r.searchedChats).toBe(6);
    expect(r.hits.every((h) => h.daemonId === 'host-a')).toBe(true);
  });

  it('finds a message appended after the last search, and waits for an unfinished line', () => {
    const c = chat({ chatId: 'c1' });
    writeTranscript(c, [user('first message')]);
    const idx = index();
    expect(idx.search([c], 'walnut', 20).total).toBe(0);
    // Half a line: the backend is still writing it.
    const line = assistant('a walnut tree');
    appendFileSync(transcriptPath(c), line.slice(0, 20));
    expect(idx.search([c], 'walnut', 20).total).toBe(0);
    appendFileSync(transcriptPath(c), `${line.slice(20)}\n`);
    const r = idx.search([c], 'walnut', 20);
    expect(r.total).toBe(1);
    expect(r.hits[0]!.snippet!.text).toBe('a walnut tree');
    // Nothing is counted twice across incremental reads.
    expect(idx.search([c], 'message', 20).hits[0]!.messageMatches).toBe(1);
  });

  it('re-reads a transcript that was rewritten shorter, or a session that changed', () => {
    const c = chat({ chatId: 'c1' });
    writeTranscript(c, [user('alpha one'), user('alpha two'), user('alpha three')]);
    const idx = index();
    expect(idx.search([c], 'alpha', 20).hits[0]!.messageMatches).toBe(3);
    writeTranscript(c, [user('alpha only')]);
    expect(idx.search([c], 'alpha', 20).hits[0]!.messageMatches).toBe(1);
    const switched = { ...c, claudeSessionId: 's-other-track' };
    writeTranscript(switched, [user('beta')]);
    expect(idx.search([switched], 'alpha', 20).total).toBe(0);
    expect(idx.search([switched], 'beta', 20).total).toBe(1);
  });

  it('counts a transcript the backend pruned, and still matches its stored preview', () => {
    const gone = chat({ chatId: 'gone', preview: 'Plan the Cornwall trip' });
    const fresh = chat({ chatId: 'fresh', claudeSessionId: undefined, name: 'New' });
    const r = index().search([gone, fresh], 'cornwall', 20);
    expect(r.transcriptsMissing).toBe(1);
    expect(r.total).toBe(1);
    expect(r.hits[0]!.snippet).toEqual({
      text: 'Plan the Cornwall trip',
      highlights: [[9, 17]],
      role: 'user',
      seq: null,
      createdAt: null,
    });
  });

  it("resolves the matched message's canonical seq, occurrence by occurrence, without writing", () => {
    const c = chat({ chatId: 'c1' });
    writeTranscript(c, [user('yes'), assistant('ok'), user('yes'), assistant('otter found')]);
    recordSeq('c1', 'user', 'yes', 4);
    recordSeq('c1', 'assistant', 'ok', 5);
    recordSeq('c1', 'user', 'yes', 9);
    const sidecar = join(chatsRoot, 'c1', 'seqindex.jsonl');
    const before = readFileSync(sidecar, 'utf8');
    const idx = index();
    // The most recent "yes" is the SECOND occurrence → the second recorded seq.
    expect(idx.search([c], 'yes', 20).hits[0]!.snippet!.seq).toBe(9);
    // Never emitted live, never replayed: no seq, and none is allocated.
    expect(idx.search([c], 'otter', 20).hits[0]!.snippet!.seq).toBeNull();
    expect(readFileSync(sidecar, 'utf8')).toBe(before);
    expect(existsSync(join(chatsRoot, 'c2'))).toBe(false);
  });

  it('reports and skips a corrupt line', () => {
    const c = chat({ chatId: 'c1' });
    writeTranscript(c, [user('before'), '{"type":"user", not json', user('after heron')]);
    const r = index().search([c], 'heron', 20);
    expect(r.total).toBe(1);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]!.path).toBe(transcriptPath(c));
  });

  it('reads the Codex backend history', () => {
    const c = chat({ chatId: 'cx', claudeSessionId: 'codex-abc' });
    const ev = (role: 'user' | 'assistant', content: string): string =>
      JSON.stringify({
        turnId: 't1',
        event: { type: 'chat.message', chatId: 'cx', role, content, seq: 0, createdAt: 5 },
      });
    writeFileSync(
      join(codexRoot, 'codex-abc.jsonl'),
      `${ev('user', 'tell me about lichen')}\n${JSON.stringify({ turnId: 't1', event: { type: 'chat.tool_call', chatId: 'cx', tool: 'x', args: { q: 'lichen' }, callId: 'k', seq: 0 } })}\n`,
    );
    const r = index().search([c], 'lichen', 20);
    expect(r.hits[0]!.messageMatches).toBe(1);
    expect(r.hits[0]!.snippet).toMatchObject({ role: 'user', createdAt: 5 });
  });

  it('returns the top `limit` hits and the full total', () => {
    const chats = Array.from({ length: 5 }, (_, i) =>
      chat({ chatId: `c${i}`, name: `fern ${i}`, lastUpdated: NOW - i }),
    );
    const r = index().search(chats, 'fern', 2);
    expect(r.total).toBe(5);
    expect(r.hits.map((h) => h.chatId)).toEqual(['c0', 'c1']);
  });

  it('warm() builds the index for every live chat', async () => {
    const a = chat({ chatId: 'a' });
    const d = chat({ chatId: 'd', status: 'deleted' });
    writeTranscript(a, [user('x')]);
    writeTranscript(d, [user('y')]);
    const idx = index();
    await idx.warm([a, d]);
    expect(idx.size()).toBe(1);
  });
});

describe('snippets and highlights', () => {
  it('splits a query into distinct lowercase terms', () => {
    expect(queryTerms('  Foo  bar foo ')).toEqual(['foo', 'bar']);
  });

  it('merges overlapping ranges', () => {
    expect(highlightRanges('abcabc', ['abc', 'bca'])).toEqual([[0, 6]]);
    expect(highlightRanges('a.b a+b', ['a.b', 'a+b'])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('windows a long message around the match, marking cut ends', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    words[50] = 'NEEDLE';
    const s = makeSnippet(words.join('\n  '), ['needle']);
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.text).not.toMatch(/\s{2}|\n/);
    expect(s.highlights).toHaveLength(1);
    const [start, end] = s.highlights[0]!;
    expect(s.text.slice(start, end)).toBe('NEEDLE');
    // Cut on word boundaries.
    expect(s.text).toMatch(/^…word\d+ /);
    expect(s.text).toMatch(/ word\d+…$/);
  });

  it('keeps a short message whole', () => {
    expect(makeSnippet('short and sweet', ['sweet'])).toEqual({
      text: 'short and sweet',
      highlights: [[10, 15]],
    });
  });
});

describe('handleChatSearchRequest', () => {
  const logger = { info: () => {}, error: () => {} };

  it('waits for the index build, then answers once with the hits', async () => {
    const c = chat({ chatId: 'c1', name: 'Birch' });
    let release: () => void = () => {};
    const ready = new Promise<void>((r) => (release = r));
    const sent: WireEvent[] = [];
    const done = handleChatSearchRequest(
      {
        type: 'patch.chat_search.request',
        requestId: 'r1',
        daemonId: 'host-a',
        query: 'birch',
        limit: 5,
      },
      { index: index(), ready, listChats: () => [c], daemonId: 'host-a', logger },
      (e) => sent.push(e),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(0);
    release();
    await done;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'patch.chat_search.response',
      requestId: 'r1',
      daemonId: 'host-a',
      ok: true,
      total: 1,
      searchedChats: 1,
      transcriptsMissing: 1,
    });
  });

  it('passes fullText from the request to the search', async () => {
    const c = chat({ chatId: 'c1', name: 'Other' });
    writeTranscript(c, [user('the walnut tree')]);
    const ask = async (fullText: boolean | undefined): Promise<number> => {
      const sent: WireEvent[] = [];
      await handleChatSearchRequest(
        {
          type: 'patch.chat_search.request',
          requestId: 'r',
          daemonId: 'host-a',
          query: 'walnut',
          limit: 5,
          ...(fullText === undefined ? {} : { fullText }),
        },
        {
          index: index(),
          ready: Promise.resolve(),
          listChats: () => [c],
          daemonId: 'host-a',
          logger,
        },
        (e) => sent.push(e),
      );
      return (sent[0] as { total: number }).total;
    };
    expect(await ask(undefined)).toBe(1);
    expect(await ask(true)).toBe(1);
    expect(await ask(false)).toBe(0);
  });

  it('answers a failure as ok:false with the reason', async () => {
    const c = chat({ chatId: 'c1' });
    writeTranscript(c, [user('oak')]);
    mkdirSync(join(chatsRoot, 'c1'), { recursive: true });
    writeFileSync(join(chatsRoot, 'c1', 'seqindex.jsonl'), 'not json\n');
    const sent: WireEvent[] = [];
    await handleChatSearchRequest(
      {
        type: 'patch.chat_search.request',
        requestId: 'r2',
        daemonId: 'host-a',
        query: 'oak',
        limit: 5,
      },
      {
        index: index(),
        ready: Promise.resolve(),
        listChats: () => [c],
        daemonId: 'host-a',
        logger,
      },
      (e) => sent.push(e),
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});
