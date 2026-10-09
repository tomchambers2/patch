// InlineEditText — tap-to-edit single-line text, the phone's port of web's
// InlineEditText (packages/web/src/components/InlineEditText.tsx). The goal bar
// and every task row share its rules: tap the text to edit it, the keyboard's
// submit (or tapping away) commits. Empty or unchanged text commits nothing —
// clearing is the row's explicit × control, never a side effect of deleting
// the text. There is no Escape on a phone, so backing out of an edit is
// "leave it as it was": unchanged text is simply not written.

import React, { useRef, useState, type ReactElement } from 'react';
import { Pressable, Text, TextInput, type TextStyle } from 'react-native';
import { useTheme } from '../../lib/theme';

export function InlineEditText({
  value,
  onCommit,
  editLabel,
  testID,
  textStyle,
}: {
  value: string;
  /** Called with the new text. Only fires when it actually changed. */
  onCommit: (next: string) => void;
  /** Accessible name for the read-mode button and the input. */
  editLabel: string;
  testID: string;
  textStyle: TextStyle;
}): ReactElement {
  const colors = useTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Submit blurs the input too; without this the blur would commit a second time.
  const done = useRef(false);

  function start(): void {
    setDraft(value);
    done.current = false;
    setEditing(true);
  }

  function commit(): void {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next === '' || next === value) return;
    onCommit(next);
  }

  if (editing) {
    return (
      <TextInput
        testID={`${testID}-input`}
        accessibilityLabel={editLabel}
        autoFocus
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={commit}
        onBlur={commit}
        returnKeyType="done"
        style={[textStyle, { flex: 1, padding: 0, color: colors.ink }]}
      />
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={editLabel}
      onPress={start}
      style={{ flex: 1 }}
    >
      <Text style={textStyle}>{value}</Text>
    </Pressable>
  );
}
