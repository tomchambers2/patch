// ArtifactBar — every artifact this chat has published, above the transcript
// (spec/14 § Artifacts — Artifact bar).
//
// The transcript already carries each artifact as its own card, but finding an
// earlier one again means scrolling back to find it. This bar is the standing
// index: one chip per artifact, newest first, clicking a chip opens exactly
// what clicking its card would. Nothing to show when the chat has published
// nothing.

import { type JSX } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { deriveArtifacts } from '../lib/artifacts.js';
import { openArtifact } from '../lib/openArtifact.js';

export function ArtifactBar({ chatId }: { chatId: string }): JSX.Element | null {
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const artifacts = deriveArtifacts(timeline ?? []);
  if (artifacts.length === 0) return null;

  return (
    <div className="artifact-bar" data-testid="artifact-bar" role="toolbar">
      {artifacts.map((artifact) => (
        <button
          key={artifact.artifactId}
          type="button"
          className="artifact-bar-chip"
          data-testid="artifact-bar-chip"
          title={artifact.path}
          onClick={() => openArtifact(artifact.url, chatId)}
        >
          <LayoutTemplate size={14} aria-hidden />
          <span className="artifact-bar-title">{artifact.title}</span>
        </button>
      ))}
    </div>
  );
}
