// What to say about a chat the server's mirror does not hold.
//
// The mirror is in memory, so after a server restart it is empty until each
// host reconnects and re-announces its chats. In that window "chat not found"
// is a false answer — the chat exists, on a host that has not reported yet
// (2026-09-29, right after a redeploy). The answer is 404 only once every
// registered host has reported; until then it is 503 naming the hosts that
// have not, and whether each is reconnecting or offline.

import type { ChatRegistry } from './chat-registry.js';
import type { DaemonLink } from './daemon-link.js';
import type { Registry } from './registry.js';

export interface UnknownChatDeps {
  registry: Registry;
  chatRegistry: ChatRegistry;
  daemonLink: DaemonLink;
}

export interface UnknownChatReply {
  status: 404 | 503;
  body: Record<string, unknown>;
}

export function unknownChatReply(deps: UnknownChatDeps, chatId: string): UnknownChatReply {
  const pending = deps.registry
    .registeredDaemonIds()
    .filter((id) => !deps.chatRegistry.hasSynced(id))
    .map((daemonId) => ({
      daemonId,
      hostName: deps.registry.hostName(daemonId) ?? daemonId,
      online: deps.daemonLink.isOnline(daemonId),
    }));
  if (pending.length === 0) {
    return { status: 404, body: { error: `chat not found: ${chatId}` } };
  }
  const offline = pending.every((h) => !h.online);
  const hosts = pending
    .map((h) => `${h.hostName} (${h.online ? 'reconnecting' : 'offline'})`)
    .join(', ');
  return {
    status: 503,
    body: {
      error: offline ? 'host_offline' : 'host_reconnecting',
      message:
        `chat ${chatId} is not known yet: ${hosts} ${pending.length === 1 ? 'has' : 'have'} not ` +
        'reported its chats since the server restarted. Try again once it is back.',
      hosts: pending,
    },
  };
}
