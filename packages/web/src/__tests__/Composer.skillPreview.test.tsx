// spec/14 § Skill autocomplete — the highlighted row's preview panel: full
// description, the rest of the frontmatter, an Edit link, and the "no filler
// text" rules for a skill with no description or no frontmatter at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { api } from '../api/rest.js';

function seedChat(folder = '/proj'): void {
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

describe('Composer — skill preview panel', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    useUiStore.getState().clearToasts();
    useChatStore.getState()._reset();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderComposer(folder = '/proj'): void {
    seedChat(folder);
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        folder={folder}
        onSend={() => {}}
        onStartVoiceNote={() => {}}
      />,
    );
  }

  it('shows a second, muted description line on a skill row, not just a built-in', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/proj/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
      frontmatter: { plant: { description: 'Sow what is in season.' } },
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/plant' } });

    const option = await screen.findByTestId('composer-skill-option-plant');
    const desc = option.querySelector('.composer-skill-desc');
    expect(desc?.textContent).toBe('Sow what is in season.');
  });

  it('the preview panel follows the highlighted row on ↑/↓', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plant', 'plan-travel'],
      paths: {
        plant: '/proj/.claude/skills/plant/SKILL.md',
        'plan-travel': '/proj/.claude/skills/plan-travel/SKILL.md',
      },
      descriptions: { plant: 'Sow what is in season.', 'plan-travel': 'Plan a trip.' },
      frontmatter: {
        plant: { description: 'Sow what is in season.' },
        'plan-travel': { description: 'Plan a trip.' },
      },
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    // `/pla` matches both skills and no built-in, so the built-ins-lead rule
    // (spec/14 § Skill autocomplete) doesn't put `/clear` in front of them.
    fireEvent.change(input, { target: { value: '/pla' } });
    await screen.findByTestId('composer-skill-option-plant');

    // plant sorts first, so it's highlighted by default.
    await waitFor(() => {
      expect(screen.getByTestId('composer-skill-preview-desc').textContent).toBe(
        'Sow what is in season.',
      );
    });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(screen.getByTestId('composer-skill-preview-desc').textContent).toBe('Plan a trip.');
    });
  });

  it('shows the rest of the frontmatter beyond the description', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['sync'],
      paths: { sync: '/proj/.claude/skills/sync/SKILL.md' },
      descriptions: { sync: 'Sync everything.' },
      frontmatter: {
        sync: { name: 'sync', description: 'Sync everything.', 'user-invocable': 'true' },
      },
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/sync' } });
    await screen.findByTestId('composer-skill-option-sync');

    const fields = await screen.findByTestId('composer-skill-preview-fields');
    // `name` is excluded (shown as the row's own name already); `description`
    // is excluded too (shown as its own line above).
    expect(fields.textContent).toContain('user-invocable');
    expect(fields.textContent).toContain('true');
    expect(fields.textContent).not.toContain('sync');
  });

  it('a skill with no description shows just its name in the row and the panel — no filler text', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['bare'],
      paths: { bare: '/proj/.claude/skills/bare/SKILL.md' },
      frontmatter: { bare: { 'user-invocable': 'true' } },
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/bare' } });

    const option = await screen.findByTestId('composer-skill-option-bare');
    expect(option.querySelector('.composer-skill-desc')).toBeNull();

    const panel = await screen.findByTestId('composer-skill-preview');
    expect(screen.queryByTestId('composer-skill-preview-desc')).toBeNull();
    expect(panel.textContent).toContain('bare');
    expect(panel.textContent).toContain('user-invocable');
  });

  it('a skill with no frontmatter at all shows no preview panel beyond its name and Edit link', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plain'],
      paths: { plain: '/proj/.claude/skills/plain/SKILL.md' },
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/plain' } });

    const panel = await screen.findByTestId('composer-skill-preview');
    expect(screen.queryByTestId('composer-skill-preview-desc')).toBeNull();
    expect(screen.queryByTestId('composer-skill-preview-fields')).toBeNull();
    expect(panel.textContent).toContain('plain');
    expect(screen.getByTestId('composer-skill-preview-edit')).toBeInTheDocument();
  });

  it('a built-in command gets a one-line description and no Edit link or fields', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({ skills: [] });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/cl' } });

    await screen.findByTestId('composer-skill-option-clear');
    const panel = await screen.findByTestId('composer-skill-preview');
    expect(panel.textContent).toContain('clear');
    expect(screen.queryByTestId('composer-skill-preview-edit')).toBeNull();
    expect(screen.queryByTestId('composer-skill-preview-fields')).toBeNull();
  });

  it('/goal is offered as a built-in command with a description', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({ skills: [] });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/go' } });

    await screen.findByTestId('composer-skill-option-goal');
    const panel = await screen.findByTestId('composer-skill-preview');
    expect(panel.textContent).toContain('goal');
    expect(screen.queryByTestId('composer-skill-preview-edit')).toBeNull();
  });

  it('the Edit link opens the skill file through the chat on its folder', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/proj/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/plant' } });

    const edit = await screen.findByTestId('composer-skill-preview-edit');
    edit.click();

    await waitFor(() => {
      expect(
        useLayoutStore
          .getState()
          .findTab({ kind: 'file', chatId: 'c1', path: '.claude/skills/plant/SKILL.md' }),
      ).not.toBeNull();
    });
    expect(useChatStore.getState().activeChatId).toBe('c1');
  });

  it('older host answering with only descriptions (no frontmatter field) still shows the description', async () => {
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/proj/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
      // no `frontmatter` field at all — an older host.
    });
    renderComposer();
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/plant' } });

    const panel = await screen.findByTestId('composer-skill-preview');
    expect(screen.getByTestId('composer-skill-preview-desc').textContent).toBe(
      'Sow what is in season.',
    );
    expect(screen.queryByTestId('composer-skill-preview-fields')).toBeNull();
    expect(panel.textContent).toContain('plant');
  });
});
