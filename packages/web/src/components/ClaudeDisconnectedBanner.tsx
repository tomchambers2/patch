import { accountConnectedForModel } from '@patch/wire';
// ClaudeDisconnectedBanner — shown when THIS chat's host has no Claude
// credential.
//
// Without it, disconnecting Claude produced a silent app: Settings said "Not
// connected" if you went looking, but every other surface behaved normally. You
// could open a new chat, type, and send, and the turn just failed. The host
// emits `daemon.unauthenticated` for exactly this and the SPA dropped it on the
// floor.
//
// Credentials are per host per backend (spec/10 § Surface in Settings), so the
// banner takes the host it speaks for. A logged-out machine says nothing about a
// chat running on a different machine — reading an account-wide slot here raised
// this banner over a perfectly healthy chat.
//
// This is the case where text IS the feature — the state is otherwise invisible —
// so it says what's wrong and where to fix it, and nothing else.

import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { CLAUDE_BACKEND_ID } from '@patch/wire';
import { hostAccount, usePresenceStore } from '../stores/presenceStore.js';

export function ClaudeDisconnectedBanner({
  daemonId,
  model,
}: {
  daemonId: string | null;
  model?: string;
}): JSX.Element | null {
  const account = usePresenceStore((s) =>
    hostAccount(s.hosts, daemonId, model?.startsWith('openai/') ? 'codex' : CLAUDE_BACKEND_ID),
  );
  // Name the machine. "this host" made a person work out which of their machines
  // the warning was about, and "host" is not a word the app should use at all.
  const machine = usePresenceStore((s) =>
    daemonId ? (s.hosts[daemonId]?.host?.hostName ?? daemonId) : null,
  );
  // null = no host chosen yet, or this host hasn't reported. Only a definite
  // `connected: false` from THIS host is a problem; guessing during startup
  // would flash a warning on every load.
  if (account === null || accountConnectedForModel(account, model)) return null;
  return (
    <div
      className="claude-disconnected-banner"
      data-testid="claude-disconnected-banner"
      role="alert"
    >
      <span className="dot" aria-hidden />
      <span>
        {machine ?? 'This machine'} isn’t signed in to{' '}
        {model?.startsWith('openai/') ? 'OpenAI' : 'Claude'}. Chats can’t run.{' '}
        <Link to="/settings/usage">Sign in</Link>
      </span>
    </div>
  );
}
