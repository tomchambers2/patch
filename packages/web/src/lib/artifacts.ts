// Artifacts published in a chat, derived from its transcript (spec/14 §
// Artifacts — Artifact bar). The chatStore already keeps one timeline entry
// per `artifactId` (a republish replaces the existing entry in place), so this
// is a plain filter, kept newest-published-first for the bar.

import type { ChatEventEntry } from '../stores/chatStore.js';

export interface ArtifactRow {
  artifactId: string;
  title: string;
  path: string;
  url: string;
  seq: number;
}

export function deriveArtifacts(entries: ChatEventEntry[]): ArtifactRow[] {
  const rows: ArtifactRow[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'artifact' || !entry.artifactId) continue;
    rows.push({
      artifactId: entry.artifactId,
      title: entry.artifactTitle ?? '',
      path: entry.artifactPath ?? '',
      url: entry.artifactUrl ?? '',
      seq: entry.seq,
    });
  }
  return rows.sort((a, b) => b.seq - a.seq);
}
