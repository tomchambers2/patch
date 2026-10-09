// PadCard — a Pad in a transcript (spec/14 § Pads). The agent starting or
// updating a Pad, or answering a batch, stamps one into the chat: a picture of
// its first screen, its name, how it stands (Working / N changes / the screens
// it now has) and an Open button that puts it beside this chat.

import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { api } from '../api/rest.js';
import { openPadBesideChat } from '../lib/openPad.js';
import { PadBadge, PadThumb } from './PadsPage.js';

export function padIdOfArtifact(artifactId: string | undefined): string | null {
  return artifactId?.startsWith('pad-') ? artifactId.slice('pad-'.length) : null;
}

export function PadCard({
  padId,
  title,
  chatId,
}: {
  padId: string;
  title: string;
  chatId: string;
}): JSX.Element {
  const { data: pad, error } = useQuery({
    queryKey: ['pad', padId],
    queryFn: () => api.getPad(padId),
    refetchInterval: 10_000,
  });
  const screens = pad?.screens.length ?? 0;
  return (
    <div
      className={`pads-card${pad?.device === 'phone' ? ' is-phone' : ''}`}
      data-testid="pad-card"
    >
      {pad ? <PadThumb pad={pad} /> : <div className="pads-thumb" />}
      <div className="pads-card-body">
        <div className="pads-card-title">
          <Layers size={14} aria-hidden />
          <span>{title}</span>
        </div>
        <div className="pads-card-meta">
          {error ? (
            <span data-testid="pad-card-error">Pad unavailable: {(error as Error).message}</span>
          ) : pad ? (
            <>
              {screens} {screens === 1 ? 'screen' : 'screens'}
              <PadBadge pad={pad} />
            </>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="pads-open"
        data-testid="pad-card-open"
        disabled={Boolean(error)}
        onClick={() => openPadBesideChat(padId, chatId)}
      >
        Open
      </button>
    </div>
  );
}
