// app/chats/[chatId].tsx + src/components/chatBars/ArtifactBar.tsx +
// src/components/ArtifactViewer.tsx — mobile parity for artifacts (spec/15 §
// Artifacts): a `chat.artifact` event becomes its own transcript card (title +
// source filename, nothing else), tapping it opens the artifact full-screen in
// an in-app WebView with an Open in browser action, republishing the same
// `artifactId` updates the existing card/chip in place, and the artifact bar
// above the transcript shows every published artifact newest first.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  actSync,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __getLinkingOpenedUrls, __resetLinkingOpenedUrls } from './stubs/react-native';
import { TEST_SERVER_URL as DEFAULT_SERVER_URL } from './stubs/mmkv';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const artifactEvent = (artifactId: string, title: string, seq: number, chatId = 'c1') => ({
  type: 'chat.artifact' as const,
  chatId,
  artifactId,
  title,
  url: `/api/chats/${chatId}/artifact/${artifactId}`,
  path: `out/${artifactId}.html`,
  updatedAt: 1_700_000_000_000,
  seq,
});

beforeEach(async () => {
  vi.clearAllMocks();
  __resetLinkingOpenedUrls();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('Artifact card', () => {
  it('renders the artifact title and its source filename, nothing else carried', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    const r = renderRN(<ChatDetailScreen />);
    const card = findHost(r.root, byTestId('artifact-card'));
    expect(hasText(card, 'Bristol bus times')).toBe(true);
    expect(hasText(card, 'out/a1.html')).toBe(true);
  });

  it('lays out as content-sized: no flex:1 in the card, a plain stretch cell around it, a non-pill radius', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    const r = renderRN(<ChatDetailScreen />);
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(9));
    const cell = flat(findHost(r.root, byTestId('artifact-card-cell')).props.style);
    const card = flat(findHost(r.root, byTestId('artifact-card')).props.style);
    expect(cell.alignSelf).toBe('stretch');
    expect(card.alignSelf).toBe('flex-start');
    expect(card.borderRadius).toBeLessThan(999);
    expect(
      findAllHost(
        findHost(r.root, byTestId('artifact-card')),
        (n) => flat(n.props.style).flex === 1,
      ),
    ).toHaveLength(0);
  });

  it('tapping the card opens the artifact full-screen with an Open in browser action', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('artifact-viewer'))).toBeNull();

    actSync(() => findHost(r.root, byTestId('artifact-card')).props.onPress());

    expect(hasText(findHost(r.root, byTestId('artifact-viewer-title')), 'Bristol bus times')).toBe(
      true,
    );
    const webview = findHost(r.root, byTestId('artifact-viewer-webview'));
    expect(webview.props.source.uri).toBe(`${DEFAULT_SERVER_URL}/api/chats/c1/artifact/a1`);

    actSync(() => findHost(r.root, byTestId('artifact-viewer-open-browser')).props.onPress());
    expect(__getLinkingOpenedUrls()).toEqual([`${DEFAULT_SERVER_URL}/api/chats/c1/artifact/a1`]);
  });

  it('closing the viewer removes it from the tree', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => findHost(r.root, byTestId('artifact-card')).props.onPress());
    expect(queryHost(r.root, byTestId('artifact-viewer'))).not.toBeNull();

    actSync(() => findHost(r.root, byTestId('artifact-viewer-close')).props.onPress());
    expect(queryHost(r.root, byTestId('artifact-viewer'))).toBeNull();
  });

  it('republishing the same artifact updates the existing card instead of adding one', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times v2', 9));
    const r = renderRN(<ChatDetailScreen />);
    const cards = findAllHost(r.root, byTestId('artifact-card'));
    expect(cards).toHaveLength(1);
    expect(hasText(cards[0]!, 'Bristol bus times v2')).toBe(true);
  });
});

describe('Artifact bar', () => {
  it('shows no bar for a chat that has published nothing', () => {
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('artifact-bar'))).toBeNull();
  });

  it('shows one chip per published artifact, newest first', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    useChatStore.getState().applyEvent(artifactEvent('a2', 'Garden plan', 2));
    const r = renderRN(<ChatDetailScreen />);
    const chips = findAllHost(r.root, byTestId('artifact-bar-chip'));
    expect(chips).toHaveLength(2);
    expect(hasText(chips[0]!, 'Garden plan')).toBe(true);
    expect(hasText(chips[1]!, 'Bristol bus times')).toBe(true);
  });

  it('tapping an earlier chip opens that artifact', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    useChatStore.getState().applyEvent(artifactEvent('a2', 'Garden plan', 2));
    const r = renderRN(<ChatDetailScreen />);
    const chips = findAllHost(r.root, byTestId('artifact-bar-chip'));
    actSync(() => chips[1]!.props.onPress()); // the older one, "Bristol bus times"
    const webview = findHost(r.root, byTestId('artifact-viewer-webview'));
    expect(webview.props.source.uri).toBe(`${DEFAULT_SERVER_URL}/api/chats/c1/artifact/a1`);
  });

  it('republishing the same artifact updates its chip instead of adding one', () => {
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times', 1));
    useChatStore.getState().applyEvent(artifactEvent('a1', 'Bristol bus times v2', 9));
    const r = renderRN(<ChatDetailScreen />);
    const chips = findAllHost(r.root, byTestId('artifact-bar-chip'));
    expect(chips).toHaveLength(1);
    expect(hasText(chips[0]!, 'Bristol bus times v2')).toBe(true);
  });
});
