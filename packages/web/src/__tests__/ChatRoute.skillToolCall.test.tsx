// spec/14 ## Main chat panel — a `Skill` tool call's row names the skill and
// links to its own `SKILL.md`, the same Edit-link mechanism the Jobs view's
// Skill field already offers (`resolveSkillLink`, `openFileInBrowser`). A
// skill living outside the chat's folder (machine-wide) states why instead
// of offering a link that would 404 — same containment rule, same UX.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

const skillsMock = vi.fn();

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: (...args: unknown[]) => skillsMock(...args),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
  },
}));

const NOW = 1_800_000_000_000;

function seed(folder = '/home/tom/projects/bus'): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'deploy',
      folder,
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatRoute — Skill tool call', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useLayoutStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    skillsMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('renders a link on the skill name, with the description as its tooltip, and opens the file on click', async () => {
    skillsMock.mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/home/tom/projects/bus/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
    });
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Skill',
      args: { skill: 'plant' },
      callId: 'call-1',
    });
    renderChat();

    const link = await screen.findByTestId('tool-call-skill-link');
    expect(link.textContent).toContain('plant');
    expect(link.getAttribute('title')).toBe('Sow what is in season.');
    expect(screen.queryByTestId('tool-call-skill-unavailable')).toBeNull();

    link.click();

    await waitFor(() => {
      expect(
        useLayoutStore
          .getState()
          .findTab({ kind: 'file', chatId: 'c1', path: '.claude/skills/plant/SKILL.md' }),
      ).not.toBeNull();
    });
    expect(useChatStore.getState().activeChatId).toBe('c1');
  });

  it('shows the reason instead of a link when the skill lives outside the chat folder', async () => {
    skillsMock.mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/home/tom/.claude/skills/plant.md' },
      descriptions: { plant: 'Sow what is in season.' },
    });
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Skill',
      args: { skill: 'plant' },
      callId: 'call-1',
    });
    renderChat();

    const reason = await screen.findByTestId('tool-call-skill-unavailable');
    expect(reason.textContent).toContain('outside this folder');
    expect(screen.queryByTestId('tool-call-skill-link')).toBeNull();
  });

  it('links a /skill in a sent user message to its SKILL.md, and leaves unknown /words as text', async () => {
    skillsMock.mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/home/tom/projects/bus/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
    });
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: '/plant tomatoes and /nothere',
    } as never);
    renderChat();

    const link = await screen.findByTestId('msg-skill-link');
    expect(link.textContent).toBe('/plant');
    expect(link.getAttribute('title')).toBe('Sow what is in season.');
    expect(screen.getAllByTestId('msg-skill-link')).toHaveLength(1);

    link.click();

    await waitFor(() => {
      expect(
        useLayoutStore
          .getState()
          .findTab({ kind: 'file', chatId: 'c1', path: '.claude/skills/plant/SKILL.md' }),
      ).not.toBeNull();
    });
  });
});
