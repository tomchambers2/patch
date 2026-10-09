// Render coverage for the shared EmptyState pattern (spec/15 § Empty states):
// icon + upright title + one line of plain-sentence body, with an OPTIONAL
// primary action. Pins both the "no action" and "with action" shapes and
// that the action button actually fires its onPress.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderRN, findHost, queryHost, byTestId, byLabel, hasText } from './testUtils/render';
import { EmptyState } from '../src/components/EmptyState';
import { Clock } from 'lucide-react-native';

describe('EmptyState — without an action', () => {
  it('renders the icon, title and body but no button', () => {
    const r = renderRN(
      <EmptyState icon={Clock} title="No jobs yet" body="Ask Manager to create one." />,
    );
    expect(hasText(r.root, 'No jobs yet')).toBe(true);
    expect(hasText(r.root, 'Ask Manager to create one.')).toBe(true);
    const icon = findHost(r.root, (i) => i.type === 'Icon');
    expect(icon.props.name).toBe('Clock');
    // No Pressable action button.
    expect(queryHost(r.root, (i) => i.type === 'Pressable')).toBeNull();
    expect(findHost(r.root, byTestId('empty-state'))).toBeDefined();
  });
});

describe('EmptyState — with a primary action', () => {
  it('renders the action button and fires onPress when tapped', () => {
    const onPress = vi.fn();
    const r = renderRN(
      <EmptyState
        icon={Clock}
        title="No chats yet"
        body="Tap + to start one."
        action={{ label: 'New chat', onPress }}
      />,
    );
    const button = findHost(r.root, byLabel('New chat'));
    expect(button.props.accessibilityRole).toBe('button');
    expect(hasText(r.root, 'New chat')).toBe(true);
    button.props.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
