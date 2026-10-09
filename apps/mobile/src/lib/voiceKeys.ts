// Whether this phone already knows a voice surface cannot run for a chat: the
// surface is configured onto a hosted backend and the chat's host has reported
// (`daemon.host.voiceKeys`) that it holds no key for it. The host is the
// authority and refuses such a session itself with the same sentence; this
// only lets a gesture with no session behind it until release — a voice note,
// a dictation — fail at the press instead of after the user has spoken.
// Nothing is known (config not loaded, host not reported, chat not pinned to a
// host yet) → null, and the host decides.

import { voiceCellFor, voiceKeyMissingMessage, type VoiceSurface } from '@patch/wire/audio';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { voiceConfigOrNull } from './preferences';

export function voiceKeyRefusal(chatId: string, surface: VoiceSurface): string | null {
  const config = voiceConfigOrNull();
  if (config === null) return null;
  const { backend } = voiceCellFor(config, surface);
  if (backend === 'local') return null;
  const daemonId = useChatStore.getState().chats[chatId]?.daemonId;
  if (!daemonId) return null;
  const keys = usePresenceStore.getState().hosts[daemonId]?.host?.voiceKeys;
  if (!keys || keys[backend]) return null;
  return voiceKeyMissingMessage(surface, backend);
}
