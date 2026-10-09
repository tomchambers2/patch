// app/chats/[chatId].tsx — a `view_file` call renders the file itself, not a
// collapsed tool row (spec/15 § Chat detail; mirrors web's ViewFileCard).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, actSync, findHost, findAllHost, byTestId } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
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

const URL_PATH = '/api/chats/c1/artifact/abc123';

function emitViewFile(kind: string, result: unknown, tool = 'mcp__patch__view_file'): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool,
    args: { file_path: '/tmp/x.png' },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'call-1',
    result,
  } as never);
  void kind;
}

const ack = (kind: string) => ({ ok: true, shown: true, kind, url: URL_PATH, name: 'x.png' });
const block = (v: unknown) => [{ type: 'text', text: JSON.stringify(v) }];

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

describe('view_file tool row', () => {
  it('shows the image itself for a live content-block-array result', () => {
    emitViewFile('image', block(ack('image')));
    const r = renderRN(<ChatDetailScreen />);
    const card = findHost(r.root, byTestId('view-file'));
    const img = findHost(card, (n) => n.type === 'Image');
    expect(img.props.source).toEqual({ uri: `${DEFAULT_SERVER_URL}${URL_PATH}` });
  });

  it('also accepts the MCP envelope shape', () => {
    emitViewFile('image', { content: block(ack('image')) });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('view-file'))).toHaveLength(1);
  });

  it('opens the in-app viewer when the image is tapped', () => {
    emitViewFile('image', block(ack('image')));
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => findHost(r.root, byTestId('view-file')).props.onPress());
    expect(findAllHost(r.root, byTestId('artifact-viewer'))).toHaveLength(1);
  });

  it('gives a pdf a tappable card that opens the viewer', () => {
    emitViewFile('pdf', block(ack('pdf')));
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, (n) => n.type === 'Image')).toHaveLength(0);
    actSync(() => findHost(r.root, byTestId('view-file')).props.onPress());
    expect(findAllHost(r.root, byTestId('artifact-viewer'))).toHaveLength(1);
  });

  it('an error result stays an ordinary tool row', () => {
    emitViewFile('image', block({ ok: false, error: 'nope' }));
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('view-file'))).toHaveLength(0);
  });

  // spec/04 § History — blobs: the ack carries the picture's real pixel size,
  // so the card is the shape of the image and its height is settled before a
  // byte of it loads. Nothing below it moves when it lands.
  it('holds the image at its own aspect ratio when the ack says what size it is', () => {
    emitViewFile('image', block({ ...ack('image'), width: 390, height: 844 }));
    const r = renderRN(<ChatDetailScreen />);
    const img = findHost(findHost(r.root, byTestId('view-file')), (n) => n.type === 'Image');
    expect(img.props.style).toMatchObject({ width: '100%', aspectRatio: 390 / 844 });
    expect(img.props.style.height).toBeUndefined();
  });

  it('falls back to a fixed height only when the header was not one we parse', () => {
    emitViewFile('image', block(ack('image')));
    const r = renderRN(<ChatDetailScreen />);
    const img = findHost(findHost(r.root, byTestId('view-file')), (n) => n.type === 'Image');
    expect(img.props.style).toMatchObject({ width: '100%', height: 320 });
  });
});
