// A skill named in the transcript, as a link to its own SKILL.md — the Edit-link
// mechanism the Jobs view's Skill field uses (`resolveSkillLink`,
// `openFileInBrowser`). Shared by the Skill tool-call row and a `/skill` in a
// sent user message.

import type { JSX } from 'react';
import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { resolveSkillLink, type SkillLinkTarget } from '../routes/JobEditorRoute.js';

/** The chat whose folder resolves skill names; Markdown rendered outside a chat has none. */
export const SkillRefChatContext = createContext<string | null>(null);

/** `[/name](patch-skill:name)` — the href a user message's skill token is rewritten to. */
export const SKILL_HREF_PREFIX = 'patch-skill:';

export function useSkillTarget(
  chatId: string,
  skillName: string,
): { target: SkillLinkTarget; description: string | undefined; open(): void } {
  const chatRow = useChatStore((s) => s.chats[chatId]);
  const chats = useChatStore((s) => s.chats);
  const setActiveChat = useChatStore((s) => s.setActiveChat);
  const openFileInBrowser = useUiStore((s) => s.openFileInBrowser);
  const folder = chatRow?.folder ?? '';
  const daemonId = chatRow?.daemonId ?? '';
  const { data } = useQuery({
    queryKey: ['skills', folder, daemonId],
    queryFn: () => api.skills(folder, daemonId),
    enabled: folder.trim() !== '' && daemonId.trim() !== '' && skillName !== '',
  });
  const target =
    skillName === ''
      ? null
      : resolveSkillLink({
          skill: skillName,
          paths: data?.paths,
          daemonId,
          folder,
          chats: Object.values(chats).map((c) => ({
            chatId: c.chatId,
            folder: c.folder,
            daemonId: c.daemonId,
          })),
        });
  return {
    target,
    description: skillName ? data?.descriptions?.[skillName] || undefined : undefined,
    open: () => {
      if (!target || 'reason' in target) return;
      setActiveChat(target.chatId);
      openFileInBrowser(target);
    },
  };
}

/** `/name` in a user message: a link when the file is reachable, plain text otherwise. */
export function SkillRef({ name }: { name: string }): JSX.Element {
  const chatId = useContext(SkillRefChatContext) ?? '';
  const { target, description, open } = useSkillTarget(chatId, name);
  if (target && !('reason' in target)) {
    return (
      <button
        type="button"
        className="link-btn msg-skill-link"
        data-testid="msg-skill-link"
        title={description}
        onClick={open}
      >
        /{name}
      </button>
    );
  }
  return <span title={target && 'reason' in target ? target.reason : description}>/{name}</span>;
}
