// What the user last chose in a NEW chat (host, folder, model, permission
// mode) — the one source the new-chat screen opens on (spec/15 § New chat flow).
// Written only when a new chat is created from that screen: never by hidden or
// job chats, never by continuing an existing chat, and never read live — the
// screen reads it once on open, so nothing that changes while it is showing
// can move the options under the user's thumb.

import type { PermissionMode } from '@patch/wire';
import { store } from './credential';

const KEY = 'patch.newChat.last.v1';

export interface LastNewChat {
  daemonId: string;
  folder: string;
  model: string | null;
  permissionMode: PermissionMode | null;
}

export function loadLastNewChat(): LastNewChat | null {
  const raw = store().getString(KEY);
  if (raw === undefined) return null;
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
    permissionMode: (parsed.permissionMode as PermissionMode | null | undefined) ?? null,
  };
}

export function saveLastNewChat(v: LastNewChat): void {
  store().set(KEY, JSON.stringify(v));
}
