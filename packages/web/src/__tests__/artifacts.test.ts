// Artifact list derivation (spec/14 § Main chat panel — Artifact bar).
//
// The chatStore already keeps one timeline entry per `artifactId` (a republish
// replaces the entry in place rather than adding a second), so deriving the
// bar's rows is a plain filter — this proves the filter and the ordering
// (newest-published-first).

import { describe, it, expect } from 'vitest';
import { deriveArtifacts } from '../lib/artifacts.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

function artifactEntry(over: Partial<ChatEventEntry> = {}): ChatEventEntry {
  return {
    seq: 1,
    kind: 'artifact',
    at: 0,
    artifactId: 'a1',
    artifactTitle: 'Bristol bus times',
    artifactUrl: '/api/chats/c1/artifact/a1',
    artifactPath: 'out/buses.html',
    ...over,
  };
}

function messageEntry(over: Partial<ChatEventEntry> = {}): ChatEventEntry {
  return { seq: 1, kind: 'message', at: 0, content: 'hi', ...over };
}

describe('deriveArtifacts', () => {
  it('returns nothing for a chat that has published no artifacts', () => {
    expect(deriveArtifacts([])).toEqual([]);
    expect(deriveArtifacts([messageEntry()])).toEqual([]);
  });

  it('reads title, path and url off an artifact entry', () => {
    const [row] = deriveArtifacts([artifactEntry()]);
    expect(row).toEqual({
      artifactId: 'a1',
      title: 'Bristol bus times',
      path: 'out/buses.html',
      url: '/api/chats/c1/artifact/a1',
      seq: 1,
    });
  });

  it('orders multiple artifacts newest-published-first', () => {
    const rows = deriveArtifacts([
      artifactEntry({ seq: 1, artifactId: 'a1', artifactTitle: 'First' }),
      artifactEntry({ seq: 4, artifactId: 'a2', artifactTitle: 'Second' }),
      artifactEntry({ seq: 9, artifactId: 'a3', artifactTitle: 'Third' }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Third', 'Second', 'First']);
  });

  it('ignores non-artifact entries mixed into the timeline', () => {
    const rows = deriveArtifacts([
      messageEntry({ seq: 1 }),
      artifactEntry({ seq: 2 }),
      { seq: 3, kind: 'tool_call', at: 0, tool: 'Read' },
    ]);
    expect(rows).toHaveLength(1);
  });
});
