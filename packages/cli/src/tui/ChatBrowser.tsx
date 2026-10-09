// Ctrl+B overlay: compact chat browser, fuzzy filter, Enter to switch.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ChatBrowserChat {
  chatId: string;
  name?: string;
  status?: string;
}

export interface ChatBrowserProps {
  chats: ChatBrowserChat[];
  onPick: (chatId: string) => void;
  onClose: () => void;
}

export function ChatBrowser(props: ChatBrowserProps): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(0);
  const filtered = props.chats.filter(
    (c) => c.chatId.includes(filter) || (c.name ?? '').includes(filter),
  );
  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      props.onClose();
      return;
    }
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(filtered.length - 1, i + 1));
    else if (key.return) {
      const choice = filtered[safeIndex];
      if (choice) props.onPick(choice.chatId);
    } else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>Chats (Esc to close, Enter to switch):</Text>
      <Text>filter: {filter}</Text>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>(no matches)</Text>
        ) : (
          filtered.map((c, i) => (
            <Text key={c.chatId} inverse={i === safeIndex}>
              {c.chatId.slice(0, 8)} {c.status ?? '?'} {c.name ?? ''}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
