// spec/14 § Skill autocomplete — a completed `/<skill>` becomes a chip
// anywhere in the message (Patch Updates: "patch skill becomes a chip
// anywhere in the composer, with preview").

import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
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

describe('Composer — skill chips', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    useUiStore.getState().clearToasts();
    useChatStore.getState()._reset();
    localStorage.clear();
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plant'],
      paths: { plant: '/proj/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
      frontmatter: { plant: { description: 'Sow what is in season.' } },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderComposer(onSend: (text: string) => void = () => {}): HTMLTextAreaElement {
    seedChat();
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        folder="/proj"
        onSend={onSend}
        onStartVoiceNote={() => {}}
      />,
    );
    return screen.getByTestId('composer-input') as HTMLTextAreaElement;
  }

  it('opens the skill list mid-message, not only at the start', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: 'please run /pl' } });
    expect(await screen.findByTestId('composer-skill-option-plant')).toBeInTheDocument();
  });

  it('does not open when a slash does not begin a word', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: 'a/pl' } });
    // Give any (harmless) background fetch a chance to settle, then confirm
    // neither the menu nor a chip ever appears for it.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    expect(screen.queryByTestId('composer-chip')).toBeNull();
  });

  it('completing a skill mid-message splices it in, leaving the rest of the text alone', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: 'please run /pl now' } });
    // Cursor sits right after "pl" (the point the token was typed to).
    input.setSelectionRange(14, 14);
    fireEvent.keyUp(input, { key: 'l' });
    const option = await screen.findByTestId('composer-skill-option-plant');
    fireEvent.mouseDown(option);

    await waitFor(() => expect(input.value).toBe('please run /plant  now'));
    const chip = await screen.findByTestId('composer-chip');
    expect(chip.textContent).toBe('/plant');
  });

  it('typing the exact name then a space makes a chip without touching the menu', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: '/plant ' } });
    const chip = await screen.findByTestId('composer-chip');
    expect(chip.textContent).toBe('/plant');
    // The menu itself is closed — this wasn't a completion, just typing.
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
  });

  it('does not chip a name that is still being typed (no trailing space yet)', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: '/plant' } });
    await screen.findByTestId('composer-skill-option-plant'); // menu open, still active
    expect(screen.queryByTestId('composer-chip')).toBeNull();
  });

  it('shows the same preview on hover as the `/` list', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: '/plant ' } });
    const chip = await screen.findByTestId('composer-chip');
    fireEvent.mouseEnter(chip);
    const popover = await screen.findByTestId('composer-chip-preview-popover');
    expect(popover.textContent).toContain('Sow what is in season.');
    fireEvent.mouseLeave(chip);
    await waitFor(() => expect(screen.queryByTestId('composer-chip-preview-popover')).toBeNull());
  });

  it('shows the preview on click too (tap, on a touch surface)', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: '/plant ' } });
    const chip = await screen.findByTestId('composer-chip');
    fireEvent.click(chip);
    expect(await screen.findByTestId('composer-chip-preview-popover')).toBeInTheDocument();
    // Clicking the chip again closes it.
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByTestId('composer-chip-preview-popover')).toBeNull());
  });

  it('Backspace right after a chip removes it whole, not one character', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: 'run /plant now' } });
    await screen.findByTestId('composer-chip');
    input.setSelectionRange(11, 11); // right after "/plant" + the space
    fireEvent.keyDown(input, { key: 'Backspace' });
    await waitFor(() => expect(input.value).toBe('run now'));
  });

  it('Backspace elsewhere in the text behaves normally (one character)', async () => {
    const input = renderComposer();
    fireEvent.change(input, { target: { value: '/plant now' } });
    await screen.findByTestId('composer-chip');
    input.setSelectionRange(10, 10); // end of "now"
    fireEvent.keyDown(input, { key: 'Backspace' });
    // No chip logic here — an ordinary Backspace doesn't preventDefault, so
    // jsdom (which never edits the DOM on its own) leaves the value as-is;
    // the assertion is just that the chip-removal branch did NOT fire.
    expect(input.value).toBe('/plant now');
  });

  it('a pasted `/<skill> ` renders as a chip like one that was typed', async () => {
    const input = renderComposer();
    // Paste manifests as a value change, same as typing does.
    fireEvent.change(input, { target: { value: 'see /plant for details' } });
    const chip = await screen.findByTestId('composer-chip');
    expect(chip.textContent).toBe('/plant');
  });

  it('sends exactly what is in the box, chip or not', async () => {
    const sent: string[] = [];
    const input = renderComposer((text) => {
      sent.push(text);
    });
    fireEvent.change(input, { target: { value: 'please run /plant now' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(sent).toEqual(['please run /plant now']);
  });

  it("a chip in the initial draft still renders under StrictMode's double-invoked effects", async () => {
    // Regression: the background priming fetch used to mark itself "primed"
    // BEFORE it resolved. StrictMode's dev-only mount→cleanup→remount cancels
    // the first (doomed) attempt, and the ref being set already told the
    // surviving second attempt there was nothing left to do — so a chip
    // already in the draft on mount never rendered at all outside tests
    // (jsdom/RTL here doesn't double-invoke, so this only reproduces the bug
    // with StrictMode wrapped in explicitly).
    seedChat();
    render(
      <StrictMode>
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          initialValue="please run /plant today"
        />
      </StrictMode>,
    );
    const chip = await screen.findByTestId('composer-chip');
    expect(chip.textContent).toBe('/plant');
  });

  it('a chip in the initial draft renders on mount, without opening `/` first', async () => {
    seedChat();
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        folder="/proj"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        initialValue="please run /plant today"
      />,
    );
    const chip = await screen.findByTestId('composer-chip');
    expect(chip.textContent).toBe('/plant');
    // Only the one background fetch to prime it — not a second one from an
    // interactive open that never happened.
    expect(api.skills).toHaveBeenCalledTimes(1);
  });
});
