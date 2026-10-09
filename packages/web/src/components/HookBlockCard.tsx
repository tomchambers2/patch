// The block/failure card above the composer (spec/20-hooks.md § On the
// user's message). Shown instead of sending when a `POST /api/hooks/check`
// comes back `block` — the message stays in the composer, and this names
// why: one entry per hook that blocked or failed/timed out, each with its
// own analysis (or error) and, for a genuine block, an optional suggestion.

import type { JSX } from 'react';
import type { HookRunResult } from '@patch/wire/hooks';

export interface HookBlockCardProps {
  results: HookRunResult[];
  /** Replace the composer text with this hook's suggestion. Does not send. */
  onUseSuggestion(suggestion: string): void;
  /** Close the card, leave the composer text as it is. */
  onEdit(): void;
  /** Send the original text, skipping every hook on this card for this send only. */
  onSendAnyway(): void;
}

export function HookBlockCard({
  results,
  onUseSuggestion,
  onEdit,
  onSendAnyway,
}: HookBlockCardProps): JSX.Element {
  return (
    <div className="hook-block-card" data-testid="hook-block-card" role="alert">
      {results.map((r) => (
        <div
          key={r.hookId}
          className="hook-block-entry"
          data-testid={`hook-block-entry-${r.hookId}`}
        >
          <div className="hook-block-name">{r.hookName}</div>
          {r.status === 'ok' ? (
            <div className="hook-block-analysis" data-testid="hook-block-analysis">
              {r.analysis}
            </div>
          ) : (
            <div className="hook-block-error" data-testid="hook-block-error">
              {r.status === 'timeout' ? 'Timed out' : 'Failed'}
              {r.error ? `: ${r.error}` : ''}
            </div>
          )}
          {r.status === 'ok' && r.suggestion ? (
            <button
              type="button"
              className="hook-block-use-suggestion"
              data-testid={`hook-use-suggestion-${r.hookId}`}
              onClick={() => onUseSuggestion(r.suggestion as string)}
            >
              Use suggestion
            </button>
          ) : null}
        </div>
      ))}
      <div className="hook-block-actions">
        <button type="button" data-testid="hook-block-edit" onClick={onEdit}>
          Edit
        </button>
        <button type="button" data-testid="hook-block-send-anyway" onClick={onSendAnyway}>
          Send anyway
        </button>
      </div>
    </div>
  );
}
