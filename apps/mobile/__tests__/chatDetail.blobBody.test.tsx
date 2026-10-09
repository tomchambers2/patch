// app/chats/[chatId].tsx — a tool result whose body stayed in the blob store
// (spec/04 § History — blobs). Replay sends a reference, not the bytes: tool
// output is 85-99% of a long chat's bytes and these rows arrive collapsed.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, actSync, findHost, findAllHost, byTestId, textOf } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
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
const SHA = 'd'.repeat(64);

function emitBlobResult(result: unknown): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool: 'Bash',
    args: { command: 'ls' },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'call-1',
    result,
  } as never);
}

/** Open the collapsed tool row so its body is on screen. */
function expandRow(root: never): void {
  const row = findHost(root, (i) =>
    String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call'),
  );
  actSync(() => row.props.onPress());
}

beforeEach(async () => {
  vi.clearAllMocks();
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a blob-backed tool result', () => {
  it('fetches the body the moment the row is expanded — no second tap to read a result', () => {
    const fetchMock = vi.fn(() => new Promise(() => {})); // in flight, never settles
    vi.stubGlobal('fetch', fetchMock);
    emitBlobResult({ $blob: SHA, bytes: 2_200_000, preview: 'the first part of it' });
    const r = renderRN(<ChatDetailScreen />);
    // Collapsed: the body is not mounted, so a row nobody opens costs nothing
    // — which is the whole reason replay omits the bodies.
    expect(fetchMock).not.toHaveBeenCalled();

    expandRow(r.root as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The preview and the cost show while it is in flight, not a blank.
    expect(textOf(findHost(r.root, byTestId('tool-blob')))).toContain('the first part of it');
    expect(textOf(findHost(r.root, byTestId('tool-blob-load')))).toContain('2.1 MB');
  });

  it('fetches by sha, and renders what comes back in place of the preview', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stdout: 'the whole thing' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    emitBlobResult({ $blob: SHA, bytes: 4096, preview: 'start' });
    const r = renderRN(<ChatDetailScreen />);
    expandRow(r.root as never);
    // The PATH is the contract; the base is whatever this surface is pointed
    // at, which differs between running this file alone and the whole suite.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      new RegExp(`^https?://[^/]+/api/chats/c1/blob/${SHA}$`),
    );
    await vi.waitFor(() =>
      expect(textOf(findHost(r.root, byTestId('tool-call-result')))).toContain('the whole thing'),
    );
  });

  it('says so when the body cannot be loaded, rather than leaving the preview looking whole', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    emitBlobResult({ $blob: SHA, bytes: 4096, preview: 'start' });
    const r = renderRN(<ChatDetailScreen />);
    expandRow(r.root as never);
    await vi.waitFor(() =>
      expect(findAllHost(r.root, byTestId('tool-blob-error'))).toHaveLength(1),
    );
    // And it offers to try again rather than quietly settling for the preview.
    expect(textOf(findHost(r.root, byTestId('tool-blob-load')))).toContain('Retry');
  });

  it('an ordinary result is still just its JSON', () => {
    emitBlobResult({ stdout: 'small enough to send' });
    const r = renderRN(<ChatDetailScreen />);
    expandRow(r.root as never);
    expect(findAllHost(r.root, byTestId('tool-blob'))).toHaveLength(0);
    expect(textOf(findHost(r.root, byTestId('tool-call-result')))).toContain(
      'small enough to send',
    );
  });
});
