// Shift-click guard (patch/todo.md — "shift click is refreshing the window";
// spec/14 § Links and the web panel). React Router hands any MODIFIED click on
// a <Link> straight to the browser ("open in a new tab" semantics). Patch is a
// single window, so that is a full same-origin page load: the app appears to
// refresh and the socket, streaming messages, drafts and open editor go with
// it. The guard swallows those clicks — and ONLY those.

import type { JSX } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { useShiftClickGuard } from '../lib/shiftClickGuard.js';

function Harness(): JSX.Element {
  useShiftClickGuard();
  return (
    <MemoryRouter>
      <Link to="/chats/c1" data-testid="in-app">
        in-app
      </Link>
      <a href="https://example.com/doc" data-testid="external">
        external
      </a>
      <button type="button" data-testid="btn">
        button
      </button>
    </MemoryRouter>
  );
}

describe('useShiftClickGuard', () => {
  afterEach(cleanup);

  it('cancels a shift-click on an in-app link so the browser never reloads the window', () => {
    render(<Harness />);
    expect(fireEvent.click(screen.getByTestId('in-app'), { shiftKey: true, button: 0 })).toBe(
      false,
    );
  });

  it('leaves a shift-click on an EXTERNAL link alone — the desktop link policy sends it to the real browser', () => {
    render(<Harness />);
    expect(fireEvent.click(screen.getByTestId('external'), { shiftKey: true, button: 0 })).toBe(
      true,
    );
  });

  it('leaves a shift-click that is not on a link at all alone', () => {
    render(<Harness />);
    expect(fireEvent.click(screen.getByTestId('btn'), { shiftKey: true, button: 0 })).toBe(true);
  });

  it('leaves a non-left shift-click alone', () => {
    render(<Harness />);
    expect(fireEvent.click(screen.getByTestId('in-app'), { shiftKey: true, button: 1 })).toBe(true);
  });

  it('stops guarding once unmounted', () => {
    const { unmount } = render(<Harness />);
    const link = screen.getByTestId('in-app');
    expect(fireEvent.click(link, { shiftKey: true, button: 0 })).toBe(false);
    unmount();
    render(
      <MemoryRouter>
        <a href="/chats/c1" data-testid="bare">
          bare
        </a>
      </MemoryRouter>,
    );
    expect(fireEvent.click(screen.getByTestId('bare'), { shiftKey: true, button: 0 })).toBe(true);
  });
});
