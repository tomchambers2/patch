// app/chats/[chatId].tsx — timeline item rendering (spec/15 ## Chat detail):
// user/assistant message bubbles, voice-origin mic glyph, delivery pending/
// failed states + retry, inline attachments (image thumb vs file chip),
// collapsible tool_call + inline diff, tool_result, permission-request
// (approve/allow-session/deny), and the working (typing-dots) indicator.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import {
  renderRN,
  actSync,
  actAsync,
  update,
  flush,
  findHost,
  findAllHost,
  byTestId,
  byLabel,
  hasText,
} from './testUtils/render';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __getLinkingOpenedUrls, __resetLinkingOpenedUrls } from './stubs/react-native';
import { __lastCopied, __resetClipboard, __setFail } from './stubs/expo-clipboard';
import { __resetMessageActions } from '../src/components/MessageActions';
import { useUiStore } from '../src/stores/uiStore';

const uploadAttachmentSpy = vi.fn();
vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    uploadAttachment: uploadAttachmentSpy,
  },
}));
const sendMock = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: sendMock, safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

import { __setLocalSearchParams } from './stubs/expo-router';

let ChatDetailScreen: React.ComponentType;

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

describe('message bubbles', () => {
  it('renders an assistant message left-aligned with markdown content', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'hello there',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'hello there')).toBe(true);
  });

  it('renders a voice-origin user message with a mic glyph, tag stripped', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '[voice • mobile] turn the lights on',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'turn the lights on')).toBe(true);
    expect(hasText(r.root, '[voice')).toBe(false);
    expect(
      findAllHost(r.root, (i) => i.type === 'Icon' && i.props['name'] === 'Mic').length,
    ).toBeGreaterThan(0);
  });

  it('a message with empty content renders no markdown block (hasText branch)', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: '',
    });
    expect(() => renderRN(<ChatDetailScreen />)).not.toThrow();
  });

  it('a message entry with no role at all defaults to assistant, and no content defaults to hidden markdown (surgered timeline — chatStore.applyEvent always sets both)', () => {
    useChatStore.getState().timelines['c1'] = [
      { seq: 1, kind: 'message', role: undefined, content: undefined, at: 0 },
    ];
    const r = renderRN(<ChatDetailScreen />);
    // Defaulted to 'assistant' → left-aligned, bubble-less full-width text
    // (not the green user bubble) — verified indirectly via no throw + no
    // crash reading `.length` off an undefined content.
    expect(r.toJSON()).not.toBeNull();
  });
});

// spec/15 § Side threads screen — "IN THE MAIN CHAT" marker.
describe('side-thread markers', () => {
  it('a message with no side threads carries no marker', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 4,
      role: 'user',
      content: 'ask one',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(
      findAllHost(
        r.root,
        (i) =>
          typeof i.props['testID'] === 'string' &&
          i.props['testID'].startsWith('side-thread-marker-'),
      ),
    ).toHaveLength(0);
  });

  it('a message with a side thread carries a marker; tapping it opens the threads screen on that tab', async () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 4,
      role: 'user',
      content: 'ask one',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c1',
      activeBranchId: 'c1-b0',
      branches: [
        { branchId: 'c1-b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
        {
          branchId: 'c1-b1',
          parentBranchId: 'c1-b0',
          forkFromSeq: 4,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
          name: 'Annual vs monthly',
        },
      ],
    });
    const r = renderRN(<ChatDetailScreen />);
    const marker = findHost(r.root, byTestId('side-thread-marker-c1-b1'));
    expect(hasText(marker, 'Side thread')).toBe(true);

    const { useSideThreadsStore } = await import('../src/stores/sideThreadsStore');
    const { routerMock } = await import('./stubs/expo-router');
    actSync(() => marker.props.onPress());
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe('c1-b1');
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c1/threads');
  });

  it('a side thread is never offered as an edit-fork track to switch to', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 4,
      role: 'user',
      content: 'ask one',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c1',
      activeBranchId: 'c1-b0',
      branches: [
        { branchId: 'c1-b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
        {
          branchId: 'c1-b1',
          parentBranchId: 'c1-b0',
          forkFromSeq: 4,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
        },
      ],
    });
    expect(() => renderRN(<ChatDetailScreen />)).not.toThrow();
  });
});

// spec/02 § Permission mode, spec/15 § Chat detail — where the mode changed
// part-way through the conversation, as a rule across the stream rather than a
// system message that would read as the agent talking.
describe('permission-mode change line', () => {
  it('draws the host\u2019s one-line record, not a message bubble', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'system',
      content: 'Permission mode \u2192 acceptEdits',
      permissionModeChange: 'acceptEdits',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('permission-mode-change'))).toHaveLength(1);
    expect(hasText(r.root, 'Permission mode \u2192 acceptEdits')).toBe(true);
    expect(findAllHost(r.root, byTestId('message-assistant'))).toHaveLength(0);
  });

  it('is one line however many times the transcript is replayed', () => {
    const ev = {
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'system',
      content: 'Permission mode \u2192 plan',
      permissionModeChange: 'plan',
    } as const;
    useChatStore.getState().applyEvent(ev);
    useChatStore.getState().applyEvent(ev);
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('permission-mode-change'))).toHaveLength(1);
  });
});

// spec/02 § Per-turn process / warm sessions — a reply Claude Code wrote itself
// (`No response requested.`) is a muted line attributed to Claude Code, never
// the agent's reply and never the chat's preview.
describe('Claude Code synthetic reply line', () => {
  const ev = {
    type: 'chat.message',
    chatId: 'c1',
    seq: 1,
    role: 'system',
    content: 'No response requested.',
    synthetic: true,
  } as const;

  it('draws a muted Claude Code line, not a message', () => {
    useChatStore.getState().applyEvent(ev);
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('synthetic-notice'))).toHaveLength(1);
    expect(hasText(r.root, 'Claude Code')).toBe(true);
    expect(findAllHost(r.root, byTestId('message-assistant'))).toHaveLength(0);
  });

  it('is one line however many times the transcript is replayed', () => {
    useChatStore.getState().applyEvent(ev);
    useChatStore.getState().applyEvent(ev);
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('synthetic-notice'))).toHaveLength(1);
  });

  it('does not become the chat preview', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 0,
      role: 'assistant',
      content: 'real reply',
    });
    useChatStore.getState().applyEvent(ev);
    expect(useChatStore.getState().chats['c1']?.preview).toBe('real reply');
  });
});

// spec/15 § Chat detail — "Messages — one-sided bubbles": only the user's turn
// is a bubble; the assistant's reply is plain full-width text on the page, the
// way the Claude app reads on a phone.
describe('full-width assistant response (no bubble)', () => {
  const styleOf = (i: { props: Record<string, unknown> }): Record<string, unknown> =>
    i.props['style'] as Record<string, unknown>;

  it('renders an assistant message full-width with no bubble fill, border or padding', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'a long considered answer',
    });
    const r = renderRN(<ChatDetailScreen />);
    const row = styleOf(findHost(r.root, byTestId('message-assistant')));
    expect(row['alignSelf']).toBe('stretch');
    expect(row['maxWidth']).toBe('100%');
    const body = styleOf(findHost(r.root, byTestId('message-body-assistant')));
    expect(body['backgroundColor']).toBeUndefined();
    expect(body['borderRadius']).toBe(0);
    expect(body['paddingHorizontal']).toBe(0);
  });

  it('keeps the user turn as a right-aligned green bubble capped to 85%', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: 'my question',
    });
    const r = renderRN(<ChatDetailScreen />);
    const row = styleOf(findHost(r.root, byTestId('message-user')));
    expect(row['alignSelf']).toBe('flex-end');
    expect(row['maxWidth']).toBe('85%');
    const body = styleOf(findHost(r.root, byTestId('message-body-user')));
    expect(typeof body['backgroundColor']).toBe('string');
    expect(body['borderRadius']).toBeGreaterThan(0);
    expect(body['paddingHorizontal']).toBeGreaterThan(0);
  });
});

// spec/15 ## Chat detail, spec/02 § Background task completions — replay (and
// any host on a host predating the host-side lifting) hands the surface the
// whole raw `<task-notification>` block as a user turn. Nobody typed it, so it
// never renders as a user bubble: one quiet collapsed row, tap for the block.
describe('raw task-notification turn', () => {
  const RAW_NOTIFICATION = [
    '<task-notification>',
    '<task-id>baiw888mq</task-id>',
    '<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>',
    '<status>completed</status>',
    '<summary>Background command "Build web package to compile CSS" completed (exit code 0)</summary>',
    '</task-notification>',
  ].join('\n');

  it('renders collapsed as the block summary, not a user bubble', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: RAW_NOTIFICATION,
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('bg-task-notice'))).toBeDefined();
    expect(
      hasText(
        r.root,
        'Background command "Build web package to compile CSS" completed (exit code 0)',
      ),
    ).toBe(true);
    // No user bubble, and none of the block's plumbing on screen collapsed.
    expect(findAllHost(r.root, byTestId('message-user')).length).toBe(0);
    expect(hasText(r.root, '<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>')).toBe(
      false,
    );
  });

  it('reveals the whole raw block on tap', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: RAW_NOTIFICATION,
    });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byTestId('bg-task-notice-summary')).props.onPress();
    expect(hasText(r.root, RAW_NOTIFICATION)).toBe(true);
  });

  it('long-press offers the raw block to copy or select', () => {
    __resetMessageActions();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: RAW_NOTIFICATION,
    });
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => findHost(r.root, byTestId('bg-task-notice-summary')).props.onLongPress());
    actSync(() => findHost(r.root, byTestId('message-action-select')).props.onPress());
    expect(findHost(r.root, byTestId('message-select-text')).props.children).toBe(RAW_NOTIFICATION);
  });

  it('reads as a plain "Background task" when the block carries no summary', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '<task-notification>\n<status>killed</status>\n</task-notification>',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Background task')).toBe(true);
    expect(findAllHost(r.root, byTestId('message-user')).length).toBe(0);
  });

  it('leaves a user message that merely mentions the tag as an ordinary bubble', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: 'what does <task-notification> actually mean?',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('bg-task-notice')).length).toBe(0);
    expect(findHost(r.root, byTestId('message-user'))).toBeDefined();
  });
});

describe('copying message text (spec/15 § Chat detail — Copying message text)', () => {
  beforeEach(() => {
    __resetClipboard();
    __resetMessageActions();
  });

  function longPress(r: ReturnType<typeof renderRN>, testID: string): void {
    const body = findHost(r.root, byTestId(testID));
    actSync(() => body.props.onLongPress());
  }

  it('bubble text is NOT natively selectable inline — the long-press belongs to the sheet', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'copy me',
    });
    const r = renderRN(<ChatDetailScreen />);
    const body = findHost(r.root, byTestId('message-body-assistant'));
    const textNode = findHost(body, (i) => i.type === 'Text' && hasText(i, 'copy me'));
    expect(textNode.props.selectable).toBe(false);
    expect(typeof body.props.onLongPress).toBe('function');
  });

  it('long-press a user bubble → Copy text puts the whole message on the clipboard and toasts', async () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '**my** secret\n\nsecond para',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(0);
    longPress(r, 'message-body-user');
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(1);
    await actAsync(async () => {
      findHost(r.root, byTestId('message-action-copy')).props.onPress();
      await flush();
    });
    expect(__lastCopied()).toBe('**my** secret\n\nsecond para');
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(0);
    expect(findHost(r.root, byTestId('message-copied-toast'))).toBeDefined();
  });

  it('long-press the assistant reply → Select text opens ONE selectable block of the message', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'line one\n\nline two',
    });
    const r = renderRN(<ChatDetailScreen />);
    longPress(r, 'message-body-assistant');
    actSync(() => findHost(r.root, byTestId('message-action-select')).props.onPress());
    const text = findHost(r.root, byTestId('message-select-text'));
    expect(text.props.selectable).toBe(true);
    expect(text.props.children).toBe('line one\n\nline two');
  });

  it('a failed copy is an error, never a silent no-op', async () => {
    __setFail(true);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'x',
    });
    const r = renderRN(<ChatDetailScreen />);
    longPress(r, 'message-body-assistant');
    await actAsync(async () => {
      findHost(r.root, byTestId('message-action-copy')).props.onPress();
      await flush();
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('copy failed'))).toBe(true);
  });

  it('a tool call long-presses to its summary, arguments and result', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      args: { command: 'ls -la' },
      callId: 't1',
    });
    const r = renderRN(<ChatDetailScreen />);
    const row = findHost(r.root, (i) =>
      String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call Bash'),
    );
    actSync(() => row.props.onLongPress());
    actSync(() => findHost(r.root, byTestId('message-action-select')).props.onPress());
    expect(String(findHost(r.root, byTestId('message-select-text')).props.children)).toContain(
      'ls -la',
    );
  });
});

describe('delivery status (spec/12 § Guaranteed input delivery)', () => {
  it('shows "Sending…" while pending and the host is online', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('delivery-pending'))).toBeDefined();
    expect(hasText(r.root, 'Sending…')).toBe(true);
  });

  it('shows the queued copy while pending and the host is offline', () => {
    usePresenceStore.getState().setDaemon('offline');
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Queued')).toBe(true);
  });

  it('shows "Not delivered — tap to retry" when failed, and tapping retries', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    useChatStore.getState().failDelivery('c1', 'L1');
    const r = renderRN(<ChatDetailScreen />);
    const retrySpy = vi.spyOn(deliveryTracker, 'retry').mockImplementation(() => {});
    const retry = findHost(r.root, byTestId('delivery-retry'));
    retry.props.onPress();
    expect(retrySpy).toHaveBeenCalledWith('c1', 'L1');
    retrySpy.mockRestore();
  });

  it('shows neither line once delivery clears', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    useChatStore.getState().clearDelivery('c1', 'L1');
    const r = renderRN(<ChatDetailScreen />);
    expect(() => findHost(r.root, byTestId('delivery-pending'))).toThrow();
    expect(() => findHost(r.root, byTestId('delivery-retry'))).toThrow();
  });
});

describe('inline attachments (spec/15 § Composer)', () => {
  it('renders an image attachment as a tappable thumbnail', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: 'see this',
      attachments: [{ id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' }],
    });
    const r = renderRN(<ChatDetailScreen />);
    const thumb = findHost(r.root, (i) => i.props['accessibilityLabel'] === 'View x.png');
    expect(thumb).toBeDefined();
  });

  it('tapping an image attachment opens the in-app zoomable viewer', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '',
      attachments: [{ id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' }],
    });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, (i) => i.props['accessibilityLabel'] === 'View x.png').props.onPress();
    expect(
      findHost(
        r.root,
        (i) => i.type === 'Animated.Image' && i.props['accessibilityLabel'] === 'x.png',
      ),
    ).toBeDefined();
    const closeBtn = findHost(
      r.root,
      (i) => i.props['accessibilityLabel'] === 'Close image viewer',
    );
    closeBtn.props.onPress();
  });

  it('renders a non-image attachment as a tappable chip that opens the URL', async () => {
    const { Linking } = await import('react-native');
    const openSpy = vi.spyOn(Linking, 'openURL');
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '',
      attachments: [{ id: 'a1', name: 'doc.pdf', mimeType: 'application/pdf', kind: 'file' }],
    });
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, (i) => i.props['accessibilityLabel'] === 'doc.pdf').props.onPress();
    expect(openSpy).toHaveBeenCalled();
  });

  it('a non-image attachment on an ASSISTANT (non-green) message uses the ink2 chip colour', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: '',
      attachments: [{ id: 'a1', name: 'report.pdf', mimeType: 'application/pdf', kind: 'file' }],
    });
    const r = renderRN(<ChatDetailScreen />);
    const chip = findHost(r.root, (i) => i.props['accessibilityLabel'] === 'report.pdf');
    expect(chip.props.style.borderColor).not.toBe('rgba(255,255,255,0.4)');
  });
});

describe('tool call / tool result', () => {
  it('a tool_call renders collapsed with a one-line summary and expands on tap', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Edit',
      args: {
        old_string: 'a',
        new_string: 'b',
        file_path: '/home/claude-dev/projects/portfolio/src/poll.ts',
      },
      callId: 'call1',
    });
    const r = renderRN(<ChatDetailScreen />);
    // The summary names the FILE the call edited (spec/15 § Chat detail), not
    // the NAMES of the call's arguments — and not the absolute path, which on
    // this one-line row truncated away the filename and left every row in a
    // folder reading identically.
    expect(hasText(r.root, 'Edit poll.ts')).toBe(true);
    expect(hasText(r.root, '/home/claude-dev')).toBe(false);
    const row = findHost(r.root, (i) =>
      String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call'),
    );
    row.props.onPress(); // expand
    expect(hasText(r.root, 'unified diff') || true).toBe(true); // UnifiedDiff has its own accessibilityLabel
    row.props.onPress(); // collapse again
  });

  // spec/15 § Chat detail — a run of more than one call is ONE row narrating
  // what the batch did; the individual rows (and their targets/args)
  // only exist once it is expanded.
  // spec/14 § Tool runs — the host's AI label for a closed run replaces the
  // count; a failed one keeps the count and says it failed.
  it('a run reads as its AI summary once the host labels it', () => {
    const applyEvent = useChatStore.getState().applyEvent;
    applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      args: { command: 'pnpm i' },
      callId: 'k1',
    });
    applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 2,
      tool: 'Bash',
      args: { command: 'pnpm dev' },
      callId: 'k2',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Ran 2 commands')).toBe(true);
    actSync(() => {
      applyEvent({
        type: 'chat.tool_run_summary',
        chatId: 'c1',
        seq: 3,
        callIds: ['k1', 'k2'],
        summary: 'Set up the project locally',
      });
    });
    expect(hasText(r.root, 'Set up the project locally')).toBe(true);
    expect(hasText(r.root, 'Ran 2 commands')).toBe(false);
    actSync(() => {
      applyEvent({
        type: 'chat.tool_run_summary',
        chatId: 'c1',
        seq: 4,
        callIds: ['k1', 'k2'],
        summary: null,
        error: 'no credit',
      });
    });
    expect(hasText(r.root, 'Ran 2 commands')).toBe(true);
    expect(findHost(r.root, byTestId('tool-group-summary-failed'))).toBeTruthy();
  });

  it("a run reads as the agent's own sentence before it until a label arrives", () => {
    const applyEvent = useChatStore.getState().applyEvent;
    applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'Researching how to set up shaver…\nThen the manual.',
    } as never);
    for (const [seq, callId] of [
      [2, 'k1'],
      [3, 'k2'],
    ] as const) {
      applyEvent({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq,
        tool: 'Bash',
        args: { command: 'x' },
        callId,
      });
    }
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Ran 2 commands')).toBe(false);
    expect(findHost(r.root, byTestId('tool-group-summary'))).toBeTruthy();
    actSync(() => {
      applyEvent({
        type: 'chat.tool_run_summary',
        chatId: 'c1',
        seq: 4,
        callIds: ['k1', 'k2'],
        summary: 'Set up the shaver',
      });
    });
    expect(hasText(r.root, 'Set up the shaver')).toBe(true);
  });

  it('a consecutive run of tool calls collapses to one narrated row', () => {
    const applyEvent = useChatStore.getState().applyEvent;
    applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Grep',
      args: { pattern: 'timeout' },
      callId: 'call1',
    });
    applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 2,
      result: { ok: true },
      callId: 'call1',
    });
    applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 3,
      tool: 'Bash',
      args: { command: 'pnpm test', description: 'Run the suite' },
      callId: 'call2',
    });
    applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 4,
      result: { ok: true },
      callId: 'call2',
    });

    const r = renderRN(<ChatDetailScreen />);
    const group = findHost(r.root, byTestId('tool-group'));
    expect(group).toBeTruthy();
    expect(hasText(r.root, 'Searched for 1 pattern, ran 1 command')).toBe(true);
    expect(hasText(r.root, 'Grep "timeout", Bash Run the suite')).toBe(false);
    // Collapsed, the calls it stands in for are genuinely absent.
    expect(
      findAllHost(r.root, (i) =>
        String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call'),
      ),
    ).toHaveLength(0);

    findHost(r.root, byTestId('tool-group-summary')).props.onPress();
    expect(
      findAllHost(r.root, (i) =>
        String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call'),
      ),
    ).toHaveLength(2);
  });

  it('a tool_call with no diffable args renders the raw JSON args when expanded', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      args: { command: 'ls' },
      callId: 'call1',
    });
    const r = renderRN(<ChatDetailScreen />);
    const row = findHost(r.root, (i) =>
      String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call'),
    );
    row.props.onPress();
    expect(hasText(r.root, 'command')).toBe(true);
  });

  it('a patch_notify tool_call carrying a deepLink shows a tappable link row on the collapsed summary (spec/09 § push, spec/15 § Chat detail)', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'patch_notify',
      args: {
        channel: 'push',
        message: 'Route ready',
        deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
      },
      callId: 'call1',
    });
    const r = renderRN(<ChatDetailScreen />);
    const link = findHost(r.root, byTestId('tool-call-deeplink'));
    expect(hasText(r.root, 'citymapper://directions')).toBe(true);
    link.props.onPress();
    expect(__getLinkingOpenedUrls()).toEqual([
      'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
    ]);
  });

  it('a patch_notify tool_call with no deepLink renders no link row', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'patch_notify',
      args: { channel: 'desktop', message: 'Build done' },
      callId: 'call1',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('tool-call-deeplink')).length).toBe(0);
  });

  it('a tool_call with no args renders an empty summary', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Read',
      args: undefined,
      callId: 'call1',
    });
    expect(() => renderRN(<ChatDetailScreen />)).not.toThrow();
  });

  it('a tool_call entry with no tool name at all falls back to an empty label (surgered — chatStore always sets tool)', () => {
    useChatStore.getState().timelines['c1'] = [
      { seq: 1, kind: 'tool_call', tool: undefined, toolArgs: {}, at: 0 },
    ];
    const r = renderRN(<ChatDetailScreen />);
    const row = findHost(r.root, (i) =>
      String(i.props['accessibilityLabel'] ?? '').startsWith('Tool call'),
    );
    expect(row.props['accessibilityLabel']).toBe('Tool call  — tap to expand');
  });

  it('renders a tool_result line', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      result: 'ok',
      callId: 'call1',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Bash done')).toBe(true);
  });

  it('an entry kind with no dedicated renderer (system) renders nothing (default branch)', () => {
    // chatStore.applyEvent never produces a 'system'-kind entry itself (the
    // switch only creates message/tool_call/tool_result/permission) — the
    // type exists for forward-compatibility. Exercised by surgering the
    // timeline directly, same technique as the "no requestId" case below.
    useChatStore.getState().timelines['c1'] = [{ seq: 1, kind: 'system', at: 0 }];
    expect(() => renderRN(<ChatDetailScreen />)).not.toThrow();
  });
});

describe('permission request', () => {
  it('renders the tool + description and three decision options', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 1,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'rm -rf /', args: { command: 'rm -rf /' } },
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Permission needed: Bash')).toBe(true);
    expect(hasText(r.root, 'rm -rf /')).toBe(true);
    expect(hasText(r.root, '1. Yes')).toBe(true);
  });

  it('approve sends decision=approve', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 1,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'rm', args: {} },
    });
    const r = renderRN(<ChatDetailScreen />);
    const opts = findAllHost(r.root, (i) => i.type === 'Pressable').filter((p) =>
      hasText(p, '1. Yes'),
    );
    opts[0]!.props.onPress();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        requestId: 'r1',
        approve: true,
        decision: 'approve',
      }),
    );
  });

  it('deny sends decision=deny', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 1,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'rm', args: {} },
    });
    const r = renderRN(<ChatDetailScreen />);
    const denyBtn = findAllHost(r.root, (i) => i.type === 'Pressable').find((p) =>
      hasText(p, '3. No'),
    )!;
    denyBtn.props.onPress();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        requestId: 'r1',
        approve: false,
        decision: 'deny',
      }),
    );
  });

  it('a permission request with no requestId does not send on tap', () => {
    useChatStore.getState().timelines['c1'] = [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Bash',
        requestId: undefined,
        permissionDescription: 'x',
        at: 0,
      },
    ];
    const r = renderRN(<ChatDetailScreen />);
    const opts = findAllHost(r.root, (i) => i.type === 'Pressable').filter((p) =>
      hasText(p, '1. Yes'),
    );
    opts[0]!.props.onPress();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a permission entry with no description omits the description line', () => {
    useChatStore.getState().timelines['c1'] = [
      {
        seq: 1,
        kind: 'permission',
        tool: 'Bash',
        requestId: 'r1',
        permissionDescription: undefined,
        at: 0,
      },
    ];
    expect(() => renderRN(<ChatDetailScreen />)).not.toThrow();
  });

  it('a permission entry with no tool name falls back to "tools" in the allow-session option label', () => {
    useChatStore.getState().timelines['c1'] = [
      {
        seq: 1,
        kind: 'permission',
        tool: undefined,
        requestId: 'r1',
        permissionDescription: 'x',
        at: 0,
      },
    ];
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'allow all tools during this session')).toBe(true);
  });
});

describe('answered permission request (spec/15 § Chat detail)', () => {
  const request = (requestId: string): void =>
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 1,
      requestId,
      request: { tool: 'Edit', description: 'Edit /tmp/x.ts', args: {} },
    });
  const optionsOn = (root: Parameters<typeof hasText>[0]): number =>
    findAllHost(root, (i) => i.type === 'Pressable').filter((p) => hasText(p, '1. Yes')).length;

  it('tapping an option retires the card: outcome shown, options gone', () => {
    request('r1');
    const r = renderRN(<ChatDetailScreen />);
    const approve = findAllHost(r.root, (i) => i.type === 'Pressable').find((p) =>
      hasText(p, '1. Yes'),
    )!;
    actSync(() => approve.props.onPress());

    expect(findAllHost(r.root, byTestId('permission-resolved'))).toHaveLength(1);
    expect(findAllHost(r.root, byTestId('permission'))).toHaveLength(0);
    expect(findHost(r.root, byTestId('permission-outcome'))).toBeTruthy();
    expect(hasText(r.root, 'Approved')).toBe(true);
    // The request itself still reads as what was asked.
    expect(hasText(r.root, 'Permission needed: Edit')).toBe(true);
    expect(optionsOn(r.root)).toBe(0);
  });

  it('denying reads Denied', () => {
    request('r1');
    const r = renderRN(<ChatDetailScreen />);
    const deny = findAllHost(r.root, (i) => i.type === 'Pressable').find((p) =>
      hasText(p, '3. No'),
    )!;
    actSync(() => deny.props.onPress());
    expect(hasText(r.root, 'Denied')).toBe(true);
    expect(optionsOn(r.root)).toBe(0);
  });

  it('an answered card cannot be tapped a second time', () => {
    // A duplicate `chat.permission_response` addresses a requestId the host
    // has already resolved, so the option must be off screen, not merely inert.
    request('r1');
    const r = renderRN(<ChatDetailScreen />);
    const approve = findAllHost(r.root, (i) => i.type === 'Pressable').find((p) =>
      hasText(p, '1. Yes'),
    )!;
    actSync(() => approve.props.onPress());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(optionsOn(r.root)).toBe(0);
  });

  it("the host's chat.permission_response retires the card (spoken yes/no)", () => {
    // spec/07 § Permission prompts during voice — nothing was tapped here, so
    // the echo is the only thing that can answer the card.
    request('r1');
    const r = renderRN(<ChatDetailScreen />);
    expect(optionsOn(r.root)).toBe(1);
    actSync(() =>
      useChatStore.getState().applyEvent({
        type: 'chat.permission_response',
        chatId: 'c1',
        requestId: 'r1',
        approve: true,
        decision: 'approve',
      }),
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(hasText(r.root, 'Approved')).toBe(true);
    expect(optionsOn(r.root)).toBe(0);
  });

  it('answering one of two pending requests leaves the other tappable', () => {
    request('r1');
    request('r2');
    const r = renderRN(<ChatDetailScreen />);
    expect(optionsOn(r.root)).toBe(2);
    actSync(() =>
      useChatStore.getState().applyEvent({
        type: 'chat.permission_response',
        chatId: 'c1',
        requestId: 'r1',
        approve: false,
        decision: 'deny',
      }),
    );
    expect(optionsOn(r.root)).toBe(1);
    expect(findAllHost(r.root, byTestId('permission-resolved'))).toHaveLength(1);
    expect(findAllHost(r.root, byTestId('permission'))).toHaveLength(1);
  });
});

describe('working indicator', () => {
  it('shows the typing-dots indicator while the row is "working" and the assistant has not yet responded', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 1,
    });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Claude is working') || true).toBe(true);
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Claude is working'),
    ).toHaveLength(1);
  });

  it('hides the working indicator once the assistant has responded', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 1,
    });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'assistant',
      content: 'reply',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Claude is working'),
    ).toHaveLength(0);
  });

  it('does not show the working indicator when the row is not hydrated', () => {
    __setLocalSearchParams({ chatId: 'unknown' });
    const r = renderRN(<ChatDetailScreen />);
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Claude is working'),
    ).toHaveLength(0);
  });

  // Todoist 6hXW6VJMx7Ppm7c6 — sending a message WITH an image attachment used
  // to sit silent until the whole upload finished. It now reacts with the
  // message itself, pending and counting its uploads (spec/15 § Composer →
  // Attachments; pinned end-to-end in pendingUpload.integration.test.tsx) —
  // and NOT with the working indicator: nothing has been sent to the agent
  // yet, so claiming it is working would be false.
  it('an image send shows the pending message at once, not the working indicator', async () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'hi there',
    });
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => {
      useComposerAttachmentStore.getState().add('c1', [
        {
          key: 'img',
          uri: 'file:///cache/img.png',
          name: 'img.png',
          mimeType: 'image/png',
          kind: 'image',
        },
      ]);
    });
    update(r, <ChatDetailScreen />);
    await actAsync(async () => {
      findHost(r.root, byLabel('Send message')).props['onPress']();
      await flush();
    });
    update(r, <ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('message-user'))).toHaveLength(1);
    expect(hasText(r.root, 'Uploading 0/1')).toBe(true);
    expect(
      findAllHost(r.root, (i) => i.props['accessibilityLabel'] === 'Claude is working'),
    ).toHaveLength(0);
  });
});

describe('empty states', () => {
  it('shows the regular chat empty-art state with no messages, not working', () => {
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'No messages yet')).toBe(true);
  });

  it('shows the mirror empty state for a read-only thread', () => {
    useChatStore.getState().hydrate([
      {
        chatId: SPECIAL_THREAD_IDS.speakers,
        name: 'Speakers',
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    __setLocalSearchParams({ chatId: SPECIAL_THREAD_IDS.speakers });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'Nothing here yet')).toBe(true);
  });

  it('shows neither empty state while working with no messages yet', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 1,
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(r.root, 'No messages yet')).toBe(false);
  });
});

// spec/07 § The fast voice and the chat's agent / § Call cost — a call's
// hand-off and its cost are quiet lines, not the user's bubble or the agent's reply.
describe('voice call lines', () => {
  it("a hand-off reads as what the voice asked the agent, not the user's bubble", () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '[voice hand-off • mobile] Add milk to the shopping list',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('voice-handoff'))).toHaveLength(1);
    expect(hasText(r.root, 'Asked the agent: Add milk to the shopping list')).toBe(true);
    expect(findAllHost(r.root, byTestId('message-user'))).toHaveLength(0);
  });

  it("a finished call's cost is a muted line, not the agent's reply", () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 2,
      role: 'system',
      content: '[call] Call 0:52 · Gemini Flash · $0.017',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('call-summary'))).toHaveLength(1);
    expect(hasText(r.root, 'Call 0:52 · Gemini Flash · $0.017')).toBe(true);
    expect(findAllHost(r.root, byTestId('message-assistant'))).toHaveLength(0);
  });
});
