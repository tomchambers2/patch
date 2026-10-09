// Single-line status strip: folder, chatId, connection state.
// Per spec/13-design-terminal.md "Rendering" — the only chrome we add.

import React from 'react';
import { Box, Text } from 'ink';
import type { ConnectionState } from '../transport/ws.js';

export interface StatusStripProps {
  folder?: string;
  chatId?: string;
  state: ConnectionState;
  /** Other surface foregrounded for the same chat. */
  phoneActive?: boolean;
}

const STATE_GLYPHS: Record<ConnectionState, string> = {
  connecting: '🟠 connecting',
  connected: '🟢 connected',
  reconnecting: '🟠 reconnecting',
  offline: '🔴 offline',
};

export function StatusStrip(props: StatusStripProps): React.JSX.Element {
  const folder = props.folder ?? '(no folder)';
  const chat = props.chatId ? props.chatId.slice(0, 8) : '(no chat)';
  const conn = props.phoneActive ? '🟡 phone active' : STATE_GLYPHS[props.state];
  return (
    <Box>
      <Text dimColor={props.phoneActive}>
        ┌ {folder} · {chat} · {conn}
      </Text>
    </Box>
  );
}
