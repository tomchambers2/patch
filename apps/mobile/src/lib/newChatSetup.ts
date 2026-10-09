// The new-chat screen's quick picks (spec/15 § New chat flow — setup), the
// phone's mirror of web's new-chat setup row (spec/14 § Sidebar §8): the
// three recent-model buttons. Pure, so the ordering rules are unit-tested
// without rendering.

import { isReservedSpecialThread } from '@patch/wire';
import type { ChatRow } from '../stores/types';
import type { ModelOption } from './models';

/** How many recent-model buttons the row carries — web's number. */
export const QUICK_PICKS = 3;

/** Real chats, newest first — the source every "recent" below reads. */
function byRecency(chats: Record<string, ChatRow>): ChatRow[] {
  return Object.values(chats)
    .filter((c) => c.status !== 'deleted')
    .sort((a, b) => b.lastUpdated - a.lastUpdated);
}

/**
 * The recent-model buttons: models used by the host's chats that the USER
 * started, newest first, topped up from the head of the catalogue. A job's chat
 * runs on the job's model and a special thread on the special-thread model —
 * neither is a model the user last chose, so neither counts. Only models the catalogue offers
 * appear, so an unloaded or failed catalogue gives no buttons at all rather
 * than buttons naming models nobody can confirm.
 */
export function recentModelPicks(
  chats: Record<string, ChatRow>,
  daemonId: string,
  catalogue: readonly ModelOption[],
): ModelOption[] {
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const out: ModelOption[] = [];
  const take = (id: string | null | undefined): void => {
    if (out.length === QUICK_PICKS || !id) return;
    const m = byId.get(id);
    if (m && !out.some((o) => o.id === id)) out.push(m);
  };
  for (const c of byRecency(chats)) {
    if (c.daemonId !== daemonId || c.jobId !== null || isReservedSpecialThread(c.chatId)) continue;
    take(c.model);
  }
  for (const m of catalogue) take(m.id);
  return out;
}
