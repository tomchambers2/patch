// The provider-level context bar (spec/15 § Chat detail → Status bars, spec/02
// § Provider-level context) — Claude Code's own context, one quiet row per
// category, mounted through ChatBars over the real chat store. Its default
// expand state is the account's `providerContextVerbosity`.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
  actSync,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import type { SettingsResponse } from '../src/api/rest';

vi.mock('../src/api/rest', () => ({ api: { watchList: vi.fn(async () => ({ tasks: [] })) } }));

const { ChatBars } = await import('../src/components/ChatBars');

function Harness(): React.ReactElement {
  const row = useChatStore((s) => s.chats['c1']);
  return <ChatBars chatId="c1" row={row} />;
}

function provider(seq: number, providerType: string, label: string, text: string): void {
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.provider_context', chatId: 'c1', seq, providerType, label, text });
}

function verbosity(v: 'off' | 'summary' | 'full'): void {
  useSettingsStore.setState({
    data: { preferences: { providerContextVerbosity: v } } as unknown as SettingsResponse,
  });
}

beforeEach(() => {
  useChatStore.getState()._reset();
  useSettingsStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Chat',
      daemonId: 'd1',
      folder: '/home/tom/p',
      activity: 'idle',
      permissionMode: 'auto',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  provider(1, 'model', 'Model', 'You are powered by Sonnet 5.');
  provider(2, 'total_tokens_reminder', 'Tokens remaining', '900 tokens left');
  provider(3, 'total_tokens_reminder', 'Tokens remaining', '800 tokens left');
});

describe('ProviderContextBar', () => {
  it('draws one collapsed row per category in first-seen order, counting repeats', () => {
    const r = renderRN(<Harness />);
    const summaries = findAllHost(r.root, byTestId('provider-context-summary'));
    expect(summaries).toHaveLength(2);
    expect(hasText(summaries[0]!, 'Model')).toBe(true);
    expect(hasText(summaries[1]!, 'Tokens remaining ×2')).toBe(true);
    expect(queryHost(r.root, byTestId('provider-context-detail'))).toBeNull();
  });

  it('opens a row to its latest text on tap', () => {
    const r = renderRN(<Harness />);
    actSync(() => findAllHost(r.root, byTestId('provider-context-summary'))[1]!.props.onPress());
    expect(hasText(findHost(r.root, byTestId('provider-context-detail')), '800 tokens left')).toBe(
      true,
    );
  });

  it('draws nothing on a chat that has received none', () => {
    useChatStore.getState()._reset();
    const r = renderRN(<Harness />);
    expect(queryHost(r.root, byTestId('provider-context-bar'))).toBeNull();
  });

  it('off hides it; full opens every row and a tap still closes one', () => {
    verbosity('off');
    const off = renderRN(<Harness />);
    expect(queryHost(off.root, byTestId('provider-context-bar'))).toBeNull();
    off.unmount();

    verbosity('full');
    const full = renderRN(<Harness />);
    expect(findAllHost(full.root, byTestId('provider-context-detail'))).toHaveLength(2);
    actSync(() => findAllHost(full.root, byTestId('provider-context-summary'))[0]!.props.onPress());
    expect(findAllHost(full.root, byTestId('provider-context-detail'))).toHaveLength(1);
  });
});
