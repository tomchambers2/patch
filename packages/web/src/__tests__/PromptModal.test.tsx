// PromptModal exists because Electron does not implement `window.prompt` — it
// THROWS `prompt() is not supported.` (verified against a real Electron renderer).
// Settings called it for the Claude token, so in the desktop app that button
// did nothing at all: the exception escaped the click handler and no error
// was shown.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PromptModal } from '../components/PromptModal.js';
import { useUiStore } from '../stores/uiStore.js';

afterEach(() => {
  cleanup();
  useUiStore.getState().resolvePrompt(null);
});

describe('PromptModal', () => {
  it('renders nothing until a prompt is requested', () => {
    render(<PromptModal />);
    expect(screen.queryByTestId('prompt-modal')).toBeNull();
  });

  it('resolves with the entered text', async () => {
    render(<PromptModal />);
    const pending = useUiStore.getState().prompt({ message: 'Token?' });
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('prompt-ok'));
    await expect(pending).resolves.toBe('abc');
  });

  it('resolves null on cancel, Escape and backdrop — same contract as window.prompt', async () => {
    render(<PromptModal />);
    const viaCancel = useUiStore.getState().prompt({ message: 'a' });
    fireEvent.click(await screen.findByTestId('prompt-cancel'));
    await expect(viaCancel).resolves.toBeNull();

    const viaEscape = useUiStore.getState().prompt({ message: 'b' });
    await screen.findByTestId('prompt-input');
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(viaEscape).resolves.toBeNull();

    const viaBackdrop = useUiStore.getState().prompt({ message: 'c' });
    fireEvent.click(await screen.findByTestId('prompt-modal-backdrop'));
    await expect(viaBackdrop).resolves.toBeNull();
  });

  it('submits on Enter', async () => {
    render(<PromptModal />);
    const pending = useUiStore.getState().prompt({ message: 'Token?' });
    const input = await screen.findByTestId('prompt-input');
    fireEvent.change(input, { target: { value: 'typed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await expect(pending).resolves.toBe('typed');
  });

  it('resolves an empty string when submitted blank, NOT null', async () => {
    // The Claude connect flow distinguishes them: blank means "re-adopt the host
    // credential", cancelled means "do nothing".
    render(<PromptModal />);
    const pending = useUiStore.getState().prompt({ message: 'Token?' });
    await screen.findByTestId('prompt-input');
    fireEvent.click(screen.getByTestId('prompt-ok'));
    await expect(pending).resolves.toBe('');
  });

  it('shows the title, message and placeholder it was given', async () => {
    render(<PromptModal />);
    void useUiStore.getState().prompt({
      title: 'Connect Claude',
      message: 'Paste a token',
      placeholder: 'sk-ant-…',
      confirmLabel: 'Connect',
    });
    const modal = await screen.findByTestId('prompt-modal');
    expect(modal.textContent).toContain('Connect Claude');
    expect(modal.textContent).toContain('Paste a token');
    expect(screen.getByTestId('prompt-ok').textContent).toBe('Connect');
    expect((screen.getByTestId('prompt-input') as HTMLInputElement).placeholder).toBe('sk-ant-…');
  });

  it('cancels a pending prompt when a second one opens, leaking no resolver', async () => {
    render(<PromptModal />);
    const first = useUiStore.getState().prompt({ message: 'first' });
    const second = useUiStore.getState().prompt({ message: 'second' });
    await expect(first).resolves.toBeNull();
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('prompt-ok'));
    await expect(second).resolves.toBe('x');
  });

  it('does not carry text over from a previous prompt', async () => {
    render(<PromptModal />);
    const first = useUiStore.getState().prompt({ message: 'first' });
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: 'stale' } });
    fireEvent.click(screen.getByTestId('prompt-ok'));
    await expect(first).resolves.toBe('stale');
    void useUiStore.getState().prompt({ message: 'second' });
    await waitFor(() =>
      expect((screen.getByTestId('prompt-input') as HTMLInputElement).value).toBe(''),
    );
  });
});
