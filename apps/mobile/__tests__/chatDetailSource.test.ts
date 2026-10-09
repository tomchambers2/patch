// Render-level regressions that cannot be exercised without a React Native
// renderer are guarded here by scanning the screen source directly. Covers:
//   - item 14: the "DBG total=" debug <Text> is gone.
//   - item 3:  the parenthesised "(No messages yet)" placeholder is gone and
//              the shared EmptyState is used instead.
//   - item 15: "View event log" is not reachable from the chat view (neither
//              the chat-detail kebab nor the long-press context sheet), and the
//              event-log route file has been removed.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const chatDetail = read('app/chats/[chatId].tsx');
const longPress = read('src/components/ChatLongPressSheet.tsx');

describe('chat-detail source regressions', () => {
  it('has no "DBG total=" debug line (item 14)', () => {
    expect(chatDetail).not.toContain('DBG total=');
  });

  it('has no parenthesised "(No messages yet)" placeholder (item 3)', () => {
    expect(chatDetail).not.toContain('(No messages yet)');
  });

  it('renders the shared EmptyState in the chat stream (item 3)', () => {
    expect(chatDetail).toContain('EmptyState');
  });

  it('does not offer "View event log" from the chat view (item 15)', () => {
    expect(chatDetail).not.toContain('View event log');
    expect(longPress).not.toContain('View event log');
  });

  it('has removed the event-log route file (item 15)', () => {
    expect(existsSync(path.join(root, 'app/chats/[chatId]/log.tsx'))).toBe(false);
  });

  it('starts a voice CALL from the header (item 17)', () => {
    expect(chatDetail).toContain('startVoiceCall');
  });
});
