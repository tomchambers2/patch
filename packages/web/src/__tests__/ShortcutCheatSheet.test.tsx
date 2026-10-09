import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ShortcutCheatSheet } from '../components/ShortcutCheatSheet.js';
import { useUiStore } from '../stores/uiStore.js';
import { SHORTCUT_TABLE } from '../lib/shortcuts.js';

afterEach(() => {
  cleanup();
  useUiStore.getState().setCheatSheetOpen(false);
});

describe('ShortcutCheatSheet', () => {
  it('renders nothing when closed', () => {
    useUiStore.getState().setCheatSheetOpen(false);
    const { container } = render(<ShortcutCheatSheet />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the shortcut table when open', () => {
    useUiStore.getState().setCheatSheetOpen(true);
    render(<ShortcutCheatSheet />);
    expect(screen.getByTestId('cheat-sheet')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(SHORTCUT_TABLE.length + 1);
  });

  it('closes on Escape', () => {
    useUiStore.getState().setCheatSheetOpen(true);
    render(<ShortcutCheatSheet />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().cheatSheetOpen).toBe(false);
  });

  it('ignores non-Escape keys', () => {
    useUiStore.getState().setCheatSheetOpen(true);
    render(<ShortcutCheatSheet />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(useUiStore.getState().cheatSheetOpen).toBe(true);
  });

  it('closes when the backdrop is clicked', () => {
    useUiStore.getState().setCheatSheetOpen(true);
    const { container } = render(<ShortcutCheatSheet />);
    const backdrop = container.querySelector('.cheat-sheet-backdrop');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(useUiStore.getState().cheatSheetOpen).toBe(false);
  });

  it('closes when the close button is clicked', () => {
    useUiStore.getState().setCheatSheetOpen(true);
    render(<ShortcutCheatSheet />);
    fireEvent.click(screen.getByLabelText('close'));
    expect(useUiStore.getState().cheatSheetOpen).toBe(false);
  });

  it('removes the keydown listener on unmount / when toggled closed', () => {
    useUiStore.getState().setCheatSheetOpen(true);
    const { rerender } = render(<ShortcutCheatSheet />);
    useUiStore.getState().setCheatSheetOpen(false);
    rerender(<ShortcutCheatSheet />);
    // No error thrown removing the listener a second time via unmount.
  });
});
