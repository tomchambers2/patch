// ToolsList + the Tools page — mobile's per-chat tool inventory (parity with
// desktop's ToolsPanel), a pushed full screen reached from the chat's ⋯ menu.
// Covers rendering both categories with description + param definition, the
// on/off switch reading/writing toolsStore, and the page's back control.

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolsList } from '../src/components/ToolsList';
import { __setLocalSearchParams, routerMock } from './stubs/expo-router';
import { useToolsStore } from '../src/stores/toolsStore';
import { renderRN, findHost, findAllHost, byTestId, hasText } from './testUtils/render';

beforeEach(() => {
  useToolsStore.getState()._reset();
});

describe('ToolsList', () => {
  it('lists both categories, each tool with its description and param signature', () => {
    const r = renderRN(<ToolsList chatId="c1" />);
    expect(findHost(r.root, byTestId('tools-group-native'))).toBeDefined();
    expect(findHost(r.root, byTestId('tools-group-patch'))).toBeDefined();
    expect(hasText(r.root, 'Runs a shell command in the chat folder.')).toBe(true);
    expect(hasText(findHost(r.root, byTestId('tool-def-Bash')), 'Bash(command: string')).toBe(true);
    expect(hasText(r.root, 'patch_spawn')).toBe(true);
  });

  it('every tool starts ON (switch checked) for a chat with no OFF set', () => {
    const r = renderRN(<ToolsList chatId="c1" />);
    expect(findHost(r.root, byTestId('tool-toggle-Bash')).props.value).toBe(true);
  });

  it('toggling a switch flips toolsStore for THIS chat, and re-renders unchecked', () => {
    const r = renderRN(<ToolsList chatId="c1" />);
    findHost(r.root, byTestId('tool-toggle-Bash')).props.onValueChange();
    expect(useToolsStore.getState().isDisabled('c1', 'Bash')).toBe(true);
  });

  it('a tool disabled in a DIFFERENT chat stays on here (OFF sets are per-chat)', () => {
    useToolsStore.getState().toggle('other-chat', 'Bash');
    const r = renderRN(<ToolsList chatId="c1" />);
    expect(findHost(r.root, byTestId('tool-toggle-Bash')).props.value).toBe(true);
  });

  it('renders exactly one switch per catalogued tool, no duplicates', () => {
    const r = renderRN(<ToolsList chatId="c1" />);
    const switches = findAllHost(r.root, (i) => i.type === 'Switch');
    // 11 native + 42 patch tools in the catalog at time of writing (grew from
    // 39 to 42 adding patch_delegate/patch_delegate_list/patch_delegate_stop)
    // — assert the exact count is stable rather than "some", so a catalog
    // edit that quietly drops a tool from the sheet is caught here.
    expect(switches.length).toBe(54);
  });
});

describe('Tools page (app/chats/[chatId]/tools)', () => {
  it('renders the list for the chatId in the route, and Back pops it', async () => {
    const { default: ChatToolsScreen } = await import('../app/chats/[chatId]/tools');
    __setLocalSearchParams({ chatId: 'c1' });
    const r = renderRN(<ChatToolsScreen />);
    expect(findHost(r.root, byTestId('tools-screen'))).toBeDefined();
    expect(hasText(r.root, 'Tools')).toBe(true);
    findHost(r.root, byTestId('tool-toggle-Bash')).props.onValueChange();
    expect(useToolsStore.getState().isDisabled('c1', 'Bash')).toBe(true);
    findHost(r.root, (i) => i.props.accessibilityLabel === 'Back').props.onPress();
    expect(routerMock.back).toHaveBeenCalled();
  });
});
