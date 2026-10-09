// lib/badge.ts — pure UI-computed helpers used by ChatRow/StatusBadge.
import { describe, it, expect } from 'vitest';
import { badgeColor, previewLine } from '../src/lib/badge';
import { lightColors } from '../src/lib/theme';
import type { ChatRow } from '../src/stores/types';

function row(overrides: Partial<ChatRow>): ChatRow {
  return {
    chatId: 'c1',
    name: 'One',
    folder: '~/x',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    lastVisitedAt: 0,
    preview: '',
    pendingPermissions: [],
    awaitingPermission: false,
    ...overrides,
  } as ChatRow;
}

describe('badgeColor', () => {
  it('working and done both use the leaf accent', () => {
    expect(badgeColor('working', lightColors)).toBe(lightColors.leaf);
    expect(badgeColor('done', lightColors)).toBe(lightColors.leaf);
  });
  it('permission uses the waiting amber', () => {
    expect(badgeColor('permission', lightColors)).toBe(lightColors.waiting);
  });
  it('errored uses the danger red', () => {
    expect(badgeColor('errored', lightColors)).toBe(lightColors.red);
  });
  it('background, monitoring and read all use muted ink-3', () => {
    expect(badgeColor('background', lightColors)).toBe(lightColors.ink3);
    expect(badgeColor('monitoring', lightColors)).toBe(lightColors.ink3);
    expect(badgeColor('read', lightColors)).toBe(lightColors.ink3);
  });
});

describe('previewLine', () => {
  it('prefers an explicit preview over activity-derived text', () => {
    expect(previewLine(row({ preview: 'hello', activity: 'running' }))).toBe('hello');
  });
  it('shows "waiting on you" while awaiting permission with no preview', () => {
    expect(previewLine(row({ preview: '', activity: 'awaiting-permission' }))).toBe(
      'waiting on you',
    );
  });
  it('shows an ellipsis while running with no preview', () => {
    expect(previewLine(row({ preview: '', activity: 'running' }))).toBe('…');
  });
  it('is empty when idle with no preview', () => {
    expect(previewLine(row({ preview: '', activity: 'idle' }))).toBe('');
  });
});
