// spec/04 § History — the provider-switch confirmation. A cross-provider
// model change (Claude <-> Codex) shows a modal with Tom's exact copy before
// `chat.model_request` goes out; a same-provider change never shows it.
// "Don't show again" persists as an account setting (packages/server's
// `suppressProviderSwitchWarning`), so it must survive on every surface, not
// just this session.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { WireEvent } from '@patch/wire';
import { ChatModelControl } from '../components/ChatModelControl.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';

const setPreferences = vi.fn(async (patch: Record<string, unknown>) => ({
  preferences: { ...DEFAULT_PREFERENCES, ...patch },
}));

vi.mock('../api/rest.js', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    renameChat: vi.fn(),
    archiveChat: vi.fn(),
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
    setPreferences: (patch: Record<string, unknown>) => setPreferences(patch),
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

describe('model control — provider-switch confirmation', () => {
  beforeEach(() => {
    sent.length = 0;
    setPreferences.mockClear();
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePreferencesStore.setState({ preferences: { ...DEFAULT_PREFERENCES }, loaded: true });
    resetModelCatalog();
    setModelCatalog({
      status: 'ready',
      models: [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'claude-opus-4-1', label: 'Opus 4.1' },
        { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
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
  });

  it("shows the modal with exactly Tom's copy on a cross-provider pick, and sends nothing yet", () => {
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    expect(screen.getByTestId('provider-switch-modal')).toBeInTheDocument();
    expect(screen.getByTestId('provider-switch-modal').textContent).toContain(
      'Switching provider may cost more due to lack of a cache, are you sure?',
    );
    expect(sent).toEqual([]);
  });

  it('never shows the modal for a same-provider model change', () => {
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-opus-4-1'));
    expect(screen.queryByTestId('provider-switch-modal')).not.toBeInTheDocument();
    expect(sent).toEqual([{ type: 'chat.model_request', chatId: 'c1', model: 'claude-opus-4-1' }]);
  });

  it('Switch sends chat.model_request and closes the modal', () => {
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    fireEvent.click(screen.getByTestId('provider-switch-switch'));
    expect(sent).toEqual([
      { type: 'chat.model_request', chatId: 'c1', model: 'openai/gpt-5-codex' },
    ]);
    expect(screen.queryByTestId('provider-switch-modal')).not.toBeInTheDocument();
    // No checkbox ticked -> no settings write.
    expect(setPreferences).not.toHaveBeenCalled();
  });

  it('Cancel sends nothing and closes the modal', () => {
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    fireEvent.click(screen.getByTestId('provider-switch-cancel'));
    expect(sent).toEqual([]);
    expect(screen.queryByTestId('provider-switch-modal')).not.toBeInTheDocument();
  });

  it('"Don\'t show again" persists the account setting and still switches', () => {
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    fireEvent.click(screen.getByTestId('provider-switch-dont-show-again'));
    fireEvent.click(screen.getByTestId('provider-switch-switch'));
    expect(setPreferences).toHaveBeenCalledWith({ suppressProviderSwitchWarning: true });
    expect(sent).toEqual([
      { type: 'chat.model_request', chatId: 'c1', model: 'openai/gpt-5-codex' },
    ]);
  });

  it('never shows the modal once the account setting is on, even cross-provider', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, suppressProviderSwitchWarning: true },
      loaded: true,
    });
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    expect(screen.queryByTestId('provider-switch-modal')).not.toBeInTheDocument();
    expect(sent).toEqual([
      { type: 'chat.model_request', chatId: 'c1', model: 'openai/gpt-5-codex' },
    ]);
  });
});
