// Ink root: picker → chat lifecycle.

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { ResolvedConfig } from '../config.js';
import { Picker } from './Picker.js';
import { ChatView } from './ChatView.js';
import { ChatBrowser } from './ChatBrowser.js';
import type { ChatBrowserChat } from './ChatBrowser.js';
import type { PatchWsClient } from '../transport/ws.js';

export interface AppProps {
  config: ResolvedConfig;
  ws: PatchWsClient | null;
  initialChatId?: string;
  initialFolder?: string;
  recents: string[];
  /**
   * Called when the user picks a folder from the picker; returns the
   * spawned chatId (REST POST /api/chats or UDS /internal/spawn).
   */
  spawnChat: (folder: string, prompt?: string) => Promise<string>;
  /** For Ctrl+B browser. */
  fetchChats: () => Promise<ChatBrowserChat[]>;
  /** When true, suppress the StatusStrip render (per --no-status). */
  hideStatus?: boolean;
}

type Phase = 'picker' | 'chat' | 'browsing';

export function App(props: AppProps): React.JSX.Element {
  const ink = useApp();
  const [phase, setPhase] = useState<Phase>(props.initialChatId ? 'chat' : 'picker');
  const [chatId, setChatId] = useState<string | null>(props.initialChatId ?? null);
  const [folder, setFolder] = useState<string | null>(props.initialFolder ?? null);
  const [error, setError] = useState<string | null>(null);
  const [browserChats, setBrowserChats] = useState<ChatBrowserChat[]>([]);

  useInput((input, key) => {
    // Ctrl+B opens chat browser when in chat phase.
    if (phase === 'chat' && key.ctrl && input === 'b') {
      props
        .fetchChats()
        .then((list) => {
          setBrowserChats(list);
          setPhase('browsing');
        })
        .catch((err: Error) => setError(err.message));
    }
  });

  useEffect(() => {
    if (phase !== 'picker' || chatId !== null) return;
    if (props.initialFolder) {
      setError(null);
      props
        .spawnChat(props.initialFolder)
        .then((id) => {
          setChatId(id);
          setFolder(props.initialFolder ?? null);
          setPhase('chat');
        })
        .catch((err: Error) => setError(err.message));
    }
  }, [phase, chatId, props]);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">error: {error}</Text>
      </Box>
    );
  }

  if (phase === 'picker') {
    return (
      <Picker
        recents={props.recents}
        onSubmit={(picked): void => {
          setError(null);
          props
            .spawnChat(picked)
            .then((id) => {
              setChatId(id);
              setFolder(picked);
              setPhase('chat');
            })
            .catch((err: Error) => setError(err.message));
        }}
      />
    );
  }

  if (phase === 'browsing') {
    return (
      <ChatBrowser
        chats={browserChats}
        onPick={(id): void => {
          setChatId(id);
          setPhase('chat');
        }}
        onClose={(): void => setPhase('chat')}
      />
    );
  }

  if (!props.ws || !chatId) {
    return (
      <Box>
        <Text>(no ws/chat — exiting)</Text>
      </Box>
    );
  }

  return (
    <ChatView
      ws={props.ws}
      chatId={chatId}
      {...(folder !== null ? { folder } : {})}
      {...(props.hideStatus ? { hideStatus: true } : {})}
      onExit={(): void => ink.exit()}
    />
  );
}
