// spec/14 ## Main chat panel — "Transcript render cost is O(changed), not
// O(transcript)".
//
// A long chat is the normal case and an assistant turn streams in one
// `chat.message_delta` per token. If a delta re-renders every entry in the
// transcript, the page gets progressively slower the longer the chat is —
// Tom's "Chat page slow" (patch/todo.md).
//
// The probe: `Markdown` is mocked with a counting stub, so each call is one
// transcript-entry render. Applying a delta that touches exactly ONE entry
// must produce exactly ONE entry render, no matter how long the transcript is.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

const counter = vi.hoisted(() => ({ renders: 0 }));

vi.mock('../components/Markdown.js', () => ({
  Markdown: ({ content }: { content: string }) => {
    counter.renders++;
    return <div data-testid="md">{content}</div>;
  },
  // Identity, deliberately. The real hook holds intermediate streaming frames
  // back to a rate the markdown parse can afford, which is a different concern
  // from this file's: here the stub IS the parse, it is free, and what is being
  // probed is WHICH entries re-render, not how often the streaming one does.
  // Throttling here would simply stop the delta reaching the counter.
  useStreamingMarkdownText: (text: string) => text,
}));

const CHAT = 'perf-chat';
const SETTLED = 120;

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: CHAT,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: CHAT,
      folder: 'foo',
      activity: 'running',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  const timeline: ChatEventEntry[] = [];
  for (let i = 0; i < SETTLED; i++) {
    timeline.push({
      seq: i,
      kind: 'message',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `settled message ${i}`,
      at: i,
    });
  }
  // One in-flight streaming assistant entry — the accumulator the delta lands on.
  timeline.push({
    seq: SETTLED,
    kind: 'message',
    role: 'assistant',
    content: 'streaming',
    streaming: true,
    at: SETTLED,
  });
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [CHAT]: timeline } }));
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={[`/chats/${CHAT}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute transcript render cost', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    counter.renders = 0;
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    vi.clearAllMocks();
  });

  it('re-renders only the changed entry when a streaming delta lands', () => {
    seed();
    renderChat();
    // Mount rendered every entry once — that's the baseline, not the subject.
    expect(counter.renders).toBeGreaterThanOrEqual(SETTLED);
    counter.renders = 0;

    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.message_delta',
        chatId: CHAT,
        messageSeq: SETTLED,
        delta: ' more',
      });
    });

    // Exactly one entry changed identity, so exactly one entry may re-render.
    expect(counter.renders).toBe(1);
  });

  it('stays O(changed) across a burst of deltas', () => {
    seed();
    renderChat();
    counter.renders = 0;

    const DELTAS = 10;
    for (let i = 0; i < DELTAS; i++) {
      act(() => {
        useChatStore.getState().applyEvent({
          type: 'chat.message_delta',
          chatId: CHAT,
          messageSeq: SETTLED,
          delta: `t${i}`,
        });
      });
    }

    expect(counter.renders).toBe(DELTAS);
  });
});
