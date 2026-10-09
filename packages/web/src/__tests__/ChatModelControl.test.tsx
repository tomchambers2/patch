// Changing a live chat's model from the composer's model control (spec/04 § Model, spec/14 §
// Model selector).
//
// This is the wire-effect half of the feature, so it lives in jsdom: the
// Playwright harness renders the app with no socket, so an outbound
// `chat.model_request` cannot be observed there at all.
//
// The properties under test:
//   1. The composer's model readout IS the model picker — one control, not a second
//      pill built beside the new-chat one.
//   2. Choosing a model sends `chat.model_request` on the live socket.
//   3. The pill shows the choice as PENDING until the host confirms it on
//      `chat.state`, then settles — a host that never confirms has not
//      switched, and that is said out loud rather than left on screen as a
//      model the chat is not running.
//   4. The pop-up says which turn the change applies to, and says it
//      differently while a turn is running.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { WireEvent } from '@patch/wire';
import { ChatModelControl } from '../components/ChatModelControl.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { setActiveWs } from '../api/ws.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';

vi.mock('../api/rest.js', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    renameChat: vi.fn(),
    archiveChat: vi.fn(),
    // The picker reloads the host's catalogue when it opens; the tests seed the
    // catalogue directly, so this only has to not blow up.
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
  },
}));
vi.mock('../lib/voiceController.js', () => ({ startVoiceCall: vi.fn(async () => {}) }));

const sent: WireEvent[] = [];

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '~/projects/foo',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: 'claude-sonnet-4-6',
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

/** The control reads its chat from the store, as it does in the composer. */
function seed(r: ChatRow): void {
  useChatStore.setState((s) => ({ chats: { ...s.chats, [r.chatId]: r } }));
}

function render(r: ChatRow): ReturnType<typeof rtlRender> {
  seed(r);
  return rtlRender(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="*" element={<ChatModelControl chatId={r.chatId} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function pillLabel(): string | undefined {
  return (
    screen.getByTestId('chat-model').querySelector('.model-pill-label')?.textContent ?? undefined
  );
}

describe('composer model selector', () => {
  beforeEach(() => {
    sent.length = 0;
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    resetModelCatalog();
    setModelCatalog({
      status: 'ready',
      models: [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'claude-opus-4-1', label: 'Opus 4.1' },
      ],
    });
    setActiveWs({
      send: (e: WireEvent) => {
        sent.push(e);
      },
    } as never);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
    resetModelCatalog();
    vi.useRealTimers();
  });

  it('is still on screen when the host has reported no model — never a guessed one', () => {
    render(row({ model: null }));
    expect(screen.getByTestId('chat-model')).toBeInTheDocument();
  });

  it('the model readout IS the picker — clicking it opens the model list', () => {
    render(row());
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-model'));
    expect(screen.getByTestId('model-popup')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-claude-opus-4-1')).toBeInTheDocument();
  });

  it('marks the model the chat is currently on as the selected option', () => {
    render(row());
    fireEvent.click(screen.getByTestId('chat-model'));
    expect(screen.getByTestId('model-option-claude-sonnet-4-6')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('model-option-claude-opus-4-1')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('choosing a model sends chat.model_request for this chat', () => {
    render(row());
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-opus-4-1'));
    expect(sent).toEqual([{ type: 'chat.model_request', chatId: 'c1', model: 'claude-opus-4-1' }]);
  });

  it('sends nothing when the chat is already on the chosen model', () => {
    render(row());
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-sonnet-4-6'));
    expect(sent).toEqual([]);
  });

  it('closes the pop-up on choosing', () => {
    render(row());
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-opus-4-1'));
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
  });

  it('shows the chosen model as pending until the host confirms it', () => {
    render(row());
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-opus-4-1'));
    // The pill reads the choice, marked not-yet-settled: until the host answers
    // the chat is still running the old model.
    expect(pillLabel()).toBe('Opus 4.1');
    expect(screen.getByTestId('chat-model').className).toContain('is-pending');

    // The host's `chat.state` is the acknowledgement; it arrives as a new
    // `row.model`, and the pill settles.
    act(() => seed(row({ model: 'claude-opus-4-1' })));
    expect(pillLabel()).toBe('Opus 4.1');
    expect(screen.getByTestId('chat-model').className).not.toContain('is-pending');
  });

  it('says so out loud when the host never confirms, naming the host', () => {
    // A host too old to know `chat.model_request` rejects the frame outright
    // and answers nothing. NO FALLBACK: the pill must not sit there reading a
    // model the chat is not on.
    vi.useFakeTimers();
    render(row());
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-opus-4-1'));
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    const toasts = useUiStore.getState().errors.map((t) => t.message);
    expect(toasts.some((m) => m.includes('d1') && m.includes('did not switch'))).toBe(true);
    // …and the pill goes back to the model the chat is actually running.
    expect(pillLabel()).toBe('Sonnet 4.6');
  });

  it('says which turn the change applies to', () => {
    render(row({ activity: 'idle' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    expect(screen.getByTestId('model-popup-note').textContent).toBe('Applies to your next message');
  });

  it('says the running turn keeps its model while a turn is running', () => {
    // Presenting the switch as instant would misdescribe the reply streaming
    // underneath the pop-up (spec/04 § Model).
    render(row({ activity: 'running' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    expect(screen.getByTestId('model-popup-note').textContent).toBe(
      'Applies to your next message — this turn keeps its model',
    );
  });

  it('keeps the pop-up on screen when the anchor is too low for it to fully open upward', () => {
    // Todoist "patch top of model select is cut off": the crumb's pop-up is
    // portalled and `bottom`-anchored when it opens upward, so a
    // maxHeight larger than the room above could push its top edge above y=0 —
    // off the window, not just clipped by a container. Simulate an anchor low
    // in a short window (92px above it) and assert the rendered top never goes
    // negative: maxHeight is capped to the real room, never floored.
    const originalInnerHeight = window.innerHeight;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(window, 'innerHeight', { value: 150, configurable: true });
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        top: 100,
        bottom: 120,
        left: 10,
        right: 200,
        width: 190,
        height: 20,
        x: 10,
        y: 100,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      render(row());
      fireEvent.click(screen.getByTestId('chat-model'));
      const popup = screen.getByTestId('model-popup');
      expect(popup.style.position).toBe('fixed');
      const top = 150 - parseFloat(popup.style.bottom) - parseFloat(popup.style.maxHeight);
      expect(top).toBeGreaterThanOrEqual(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      Object.defineProperty(window, 'innerHeight', {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  it('anchors the pop-up against the anchor, not the top of the window, when there is plenty of room above', () => {
    // Todoist 6hfRR66wjXh4g7Hc "patch dropdowns are broken": with an anchor low
    // in a TALL window, the old code sized the pop-up to the full space above
    // it (top-anchored) regardless of how few rows the list actually holds —
    // a two-model list rendered starting just under the menu bar, leaving a
    // gap of hundreds of pixels down to the anchor it was meant to sit against.
    // Bottom-anchoring pins the pop-up's bottom edge just above the anchor
    // however short its content is.
    const originalInnerHeight = window.innerHeight;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(window, 'innerHeight', { value: 1300, configurable: true });
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        top: 1240,
        bottom: 1270,
        left: 10,
        right: 200,
        width: 190,
        height: 30,
        x: 10,
        y: 1240,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      render(row());
      fireEvent.click(screen.getByTestId('chat-model'));
      const popup = screen.getByTestId('model-popup');
      expect(popup.style.position).toBe('fixed');
      // Pinned by `bottom`, just above the anchor — not by `top`, which would
      // leave it floating near the top of the window instead.
      expect(popup.style.top).toBe('');
      expect(parseFloat(popup.style.bottom)).toBeCloseTo(window.innerHeight - 1240 + 4);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      Object.defineProperty(window, 'innerHeight', {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });
});
