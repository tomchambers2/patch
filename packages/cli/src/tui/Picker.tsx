// Recent-folders picker. Arrow-key navigation + filter typing.
// Per spec/13-design-terminal.md.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface PickerProps {
  recents: string[];
  onSubmit: (folder: string, prompt?: string) => void;
}

export function Picker(props: PickerProps): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(0);
  const filtered = props.recents.filter((r) => r.includes(filter));
  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(filtered.length - 1, i + 1));
    else if (key.return) {
      const choice = filtered[safeIndex] ?? filter;
      if (choice && choice.length > 0) props.onSubmit(choice);
    } else if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Pick a folder (type to filter, ↑/↓ to navigate, Enter to confirm):</Text>
      <Text>filter: {filter}</Text>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text dimColor>(no matches — type a path and press Enter)</Text>
        ) : (
          filtered.map((r, i) => (
            <Text key={r} inverse={i === safeIndex}>
              {r}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
