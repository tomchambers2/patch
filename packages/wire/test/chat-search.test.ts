// Chat search wire shapes (spec/03 § Chat search).

import { describe, expect, it } from 'vitest';
import {
  CHAT_SEARCH_MAX_DEPTH,
  ChatSearchResponse,
  compareChatSearchHits,
  decode,
  parseSearchQuery,
  encode,
  type ChatSearchHit,
} from '../src/index.js';

function hit(over: Partial<ChatSearchHit> = {}): ChatSearchHit {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    name: 'Fix the boiler',
    preview: 'the boiler is making a noise',
    folder: '/home/tom',
    status: 'archived',
    section: 'archived',
    pinned: false,
    snoozedUntil: null,
    lastUpdated: 1000,
    jobId: null,
    nameMatch: false,
    nameHighlights: [],
    messageMatches: 1,
    snippet: {
      text: '…the boiler pressure dropped…',
      highlights: [[5, 11]],
      role: 'assistant',
      seq: 12,
      createdAt: 999,
    },
    ...over,
  };
}

describe('chat search wire', () => {
  it('round-trips a request and a response through the codec', () => {
    const req = {
      type: 'patch.chat_search.request' as const,
      requestId: 'r1',
      daemonId: 'd1',
      query: 'boiler',
      limit: 20,
    };
    expect(decode(encode(req))).toEqual(req);
    const res = {
      type: 'patch.chat_search.response' as const,
      requestId: 'r1',
      daemonId: 'd1',
      ok: true,
      hits: [hit()],
      total: 1,
      searchedChats: 40,
      transcriptsMissing: 3,
    };
    expect(decode(encode(res))).toEqual(res);
  });

  it('refuses a one-character query and a limit past the paging depth', () => {
    const base = { type: 'patch.chat_search.request', requestId: 'r', daemonId: 'd1' };
    expect(() => decode(JSON.stringify({ ...base, query: 'a', limit: 5 }))).toThrow();
    expect(() =>
      decode(JSON.stringify({ ...base, query: 'ab', limit: CHAT_SEARCH_MAX_DEPTH + 1 })),
    ).toThrow();
  });

  it('parses quoted runs as one exact-phrase term', () => {
    expect(parseSearchQuery('  Boiler   Pressure ')).toEqual(['boiler', 'pressure']);
    expect(parseSearchQuery('"Expansion  Vessel" fails')).toEqual(['expansion vessel', 'fails']);
    expect(parseSearchQuery('a "b c')).toEqual(['a', 'b c']);
    expect(parseSearchQuery('x "" x')).toEqual(['x']);
  });

  it('a request may say fullText false, and must say it as a boolean', () => {
    const base = {
      type: 'patch.chat_search.request',
      requestId: 'r',
      daemonId: 'd1',
      query: 'ab',
      limit: 5,
    };
    expect(decode(JSON.stringify({ ...base, fullText: false }))).toMatchObject({ fullText: false });
    expect(() => decode(JSON.stringify({ ...base, fullText: 'no' }))).toThrow();
  });

  it('a snippet may carry no seq (the chat opens at its latest message)', () => {
    const r = ChatSearchResponse.parse({
      query: 'boiler',
      hits: [hit({ snippet: { ...hit().snippet!, seq: null, createdAt: null } })],
      total: 1,
      nextOffset: null,
      hosts: [{ daemonId: 'd1', hostName: 'hetzner', state: 'searched', searchedChats: 1 }],
    });
    expect(r.hits[0]!.snippet!.seq).toBeNull();
  });

  it('names an unsearched host explicitly', () => {
    const r = ChatSearchResponse.parse({
      query: 'boiler',
      hits: [],
      total: 0,
      nextOffset: null,
      hosts: [{ daemonId: 'mac', hostName: 'mac', state: 'offline' }],
    });
    expect(r.hosts[0]!.state).toBe('offline');
    expect(() =>
      ChatSearchResponse.parse({
        ...r,
        hosts: [{ daemonId: 'mac', hostName: null, state: 'gone' }],
      }),
    ).toThrow();
  });

  it('orders hits by most recent activity, whether name or body matched', () => {
    const oldName = hit({ chatId: 'a', nameMatch: true, lastUpdated: 1 });
    const newBody = hit({ chatId: 'b', lastUpdated: 50 });
    const oldBody = hit({ chatId: 'c', lastUpdated: 5 });
    const newName = hit({ chatId: 'd', nameMatch: true, lastUpdated: 9 });
    expect(
      [oldBody, oldName, newBody, newName].sort(compareChatSearchHits).map((h) => h.chatId),
    ).toEqual(['b', 'd', 'c', 'a']);
  });

  it('breaks a recency tie on chatId, so pages never overlap', () => {
    const x = hit({ chatId: 'x' });
    const y = hit({ chatId: 'y' });
    expect([y, x].sort(compareChatSearchHits).map((h) => h.chatId)).toEqual(['x', 'y']);
  });
});
