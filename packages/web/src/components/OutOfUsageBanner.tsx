// OutOfUsageBanner — shown in EVERY chat on a machine with no credit left
// anywhere.
//
// The limit bubble under a message speaks for one parked turn: it is the reply
// that is not coming, in the conversation where you were waiting for it. This
// answers a different question, and one nobody was being told the answer to —
// is there any credit left on this machine AT ALL?
//
// When there is not, nothing on that machine can run. Not this chat, not the
// twenty others, not the cron jobs that will fire into them and park. A person
// who does not know that keeps typing into chats that will never answer, which
// is exactly what happened on 2026-09-11: every account spent, every chat
// silently parked, and the only clue was inside whichever chat you happened to
// have open.
//
// So it is chrome, not a message, and it is per HOST — the same rule as
// `ClaudeDisconnectedBanner`, because credit is a property of the machine's
// accounts and says nothing about a chat running on a different machine.
//
// It is a warning colour rather than an error one on purpose: nothing is
// broken, and it comes back on its own at a time this says.

import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { CLAUDE_BACKEND_ID } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import {
  formatDurationWords,
  formatReset,
  formatResetDetail,
  hostOutage,
  listLabels,
} from '../lib/usage.js';

export function OutOfUsageBanner({
  daemonId,
  model,
}: {
  daemonId: string | null;
  model?: string;
}): JSX.Element | null {
  const account = usePresenceStore((s) =>
    daemonId
      ? (s.hosts[daemonId]?.accounts[model?.startsWith('openai/') ? 'codex' : CLAUDE_BACKEND_ID] ??
        null)
      : null,
  );
  // The countdown has to count. Ten seconds is under the minute it renders, so
  // the figure is never visibly stale, and it costs one render.
  const [now, setNow] = useState(() => Date.now());
  const outage = hostOutage(
    (account?.accounts ?? []).filter(
      (a) =>
        !model?.startsWith('openai/') ||
        (a.kind ?? 'chatgpt') === (model.startsWith('openai/api/') ? 'apiKey' : 'chatgpt'),
    ),
  );
  const soonestAt = outage?.soonest?.resetsAt;
  useEffect(() => {
    if (soonestAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, [soonestAt]);

  if (!outage) return null;
  // A machine that is not signed in at all is the disconnected banner's story;
  // `hostOutage` already refuses that case, and this is the belt to its braces.
  if (account !== null && !account.connected) return null;

  const labels = listLabels(outage.accounts.map((a) => a.label));
  const soonest = outage.soonest;

  return (
    <div className="out-of-usage-banner" data-testid="out-of-usage-banner" role="alert">
      <span className="dot" aria-hidden />
      <span>
        Out of usage on <strong data-testid="out-of-usage-accounts">{labels}</strong>
        {outage.accounts.length > 1 ? ' accounts' : ''}.{' '}
        {soonest?.resetsAt !== undefined ? (
          <span data-testid="out-of-usage-reset" title={formatResetDetail(soonest.resetsAt)}>
            {soonest.label} resets at {formatReset(soonest.resetsAt, now)}
            {soonest.resetsAt > now ? ` (${formatDurationWords(soonest.resetsAt - now)})` : ''}.
          </span>
        ) : (
          // NO FALLBACK on the time: an invented reset is worse than none,
          // because the whole value of this banner is knowing when to come back.
          <span data-testid="out-of-usage-reset">
            {model?.startsWith('openai/') ? 'OpenAI' : 'Anthropic'} gave no reset time.
          </span>
        )}{' '}
        <Link to="/settings/usage">Usage</Link>
      </span>
    </div>
  );
}
