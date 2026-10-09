// What the user last chose in a NEW chat (host, folder, model) — the one
// source the new-chat screen opens on (spec/14 § Sidebar §8). Written only when
// a new chat is created from that screen: never by hidden or job chats, never
// by continuing an existing chat, and read once on open, never live, so
// nothing that changes while the screen is showing can move its options.

const KEY = 'patch.newChat.last.v1';

export interface LastNewChat {
  daemonId: string;
  folder: string;
  model: string | null;
}

export function loadLastNewChat(): LastNewChat | null {
  const raw = window.localStorage.getItem(KEY);
  if (raw === null) return null;
  let parsed: Partial<LastNewChat>;
  try {
    parsed = JSON.parse(raw) as Partial<LastNewChat>;
  } catch (e) {
    throw new Error(`lastNewChat: stored value is not JSON (${(e as Error).message})`);
  }
  if (typeof parsed.daemonId !== 'string' || typeof parsed.folder !== 'string') {
    throw new Error('lastNewChat: stored value has no daemonId/folder');
  }
  return {
    daemonId: parsed.daemonId,
    folder: parsed.folder,
    model: typeof parsed.model === 'string' ? parsed.model : null,
  };
}

export function saveLastNewChat(v: LastNewChat): void {
  window.localStorage.setItem(KEY, JSON.stringify(v));
}
