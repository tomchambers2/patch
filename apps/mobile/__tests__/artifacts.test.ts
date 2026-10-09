// src/lib/artifacts.ts — deriving the artifact bar's rows from a chat's
// timeline (spec/15 § Artifacts), newest-published-first, mirroring web's
// packages/web/src/__tests__/artifacts.test.ts.

import { describe, it, expect } from 'vitest';
import { deriveArtifacts } from '../src/lib/artifacts';
import type { ChatEventEntry } from '../src/stores/chatStore';

const artifactEntry = (seq: number, artifactId: string, title: string): ChatEventEntry => ({
  seq,
  kind: 'artifact',
  artifactId,
  artifactTitle: title,
  artifactUrl: `/api/chats/c1/artifact/${artifactId}`,
  artifactPath: `out/${artifactId}.html`,
  at: 0,
});

describe('deriveArtifacts', () => {
  it('returns nothing for a timeline with no artifacts', () => {
    expect(deriveArtifacts([{ seq: 1, kind: 'message', content: 'hi', at: 0 }])).toEqual([]);
  });

  it('returns one row per artifact, newest (highest seq) first', () => {
    const rows = deriveArtifacts([
      artifactEntry(1, 'a1', 'Bristol bus times'),
      artifactEntry(2, 'a2', 'Garden plan'),
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Garden plan', 'Bristol bus times']);
  });

  it('ignores non-artifact entries interleaved with artifacts', () => {
    const rows = deriveArtifacts([
      { seq: 1, kind: 'message', content: 'hi', at: 0 },
      artifactEntry(2, 'a1', 'Bristol bus times'),
      { seq: 3, kind: 'tool_call', tool: 'Read', at: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.artifactId).toBe('a1');
  });
});
