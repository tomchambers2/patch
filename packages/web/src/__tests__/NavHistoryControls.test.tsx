// NavHistoryControls — browser-style Back / Forward buttons that walk the
// in-app navigation history (todo: "Back/forward buttons to go through
// history"). Exercised with a MemoryRouter + Links so real react-router
// navigations drive the internal history stack.

import type { JSX } from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { NavHistoryControls, resetNavHistory } from '../components/NavHistoryControls.js';

function CurrentPath(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="current">{loc.pathname}</div>;
}

function Harness(): JSX.Element {
  return (
    <MemoryRouter initialEntries={['/chats/a']}>
      <NavHistoryControls />
      <nav>
        <Link to="/chats/a">go a</Link>
        <Link to="/chats/b">go b</Link>
        <Link to="/chats/c">go c</Link>
      </nav>
      <input data-testid="some-field" />
      <Routes>
        <Route path="/chats/:id" element={<CurrentPath />} />
      </Routes>
    </MemoryRouter>
  );
}

const back = (): HTMLButtonElement => screen.getByTestId('nav-back') as HTMLButtonElement;
const forward = (): HTMLButtonElement => screen.getByTestId('nav-forward') as HTMLButtonElement;
const current = (): string => screen.getByTestId('current').textContent ?? '';

describe('NavHistoryControls', () => {
  beforeEach(resetNavHistory);
  afterEach(cleanup);

  it('renders both buttons disabled at the first (only) history entry', () => {
    render(<Harness />);
    expect(back()).toBeDisabled();
    expect(forward()).toBeDisabled();
  });

  it('enables Back once a new location is visited, Forward stays disabled', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b'));
    expect(current()).toBe('/chats/b');
    expect(back()).not.toBeDisabled();
    expect(forward()).toBeDisabled();
  });

  it('Back returns to the previous location and enables Forward', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b'));
    fireEvent.click(back());
    expect(current()).toBe('/chats/a');
    expect(back()).toBeDisabled();
    expect(forward()).not.toBeDisabled();
  });

  it('Forward re-advances through the history after going Back', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b'));
    fireEvent.click(back());
    fireEvent.click(forward());
    expect(current()).toBe('/chats/b');
    expect(forward()).toBeDisabled();
    expect(back()).not.toBeDisabled();
  });

  it('walks a longer stack: a → b → c, Back twice, Forward twice', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b'));
    fireEvent.click(screen.getByText('go c'));
    expect(current()).toBe('/chats/c');
    fireEvent.click(back());
    expect(current()).toBe('/chats/b');
    fireEvent.click(back());
    expect(current()).toBe('/chats/a');
    expect(back()).toBeDisabled();
    fireEvent.click(forward());
    expect(current()).toBe('/chats/b');
    fireEvent.click(forward());
    expect(current()).toBe('/chats/c');
    expect(forward()).toBeDisabled();
  });

  it('navigating after Back truncates the forward history', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b')); // a → b
    fireEvent.click(back()); // back to a (forward: b)
    expect(forward()).not.toBeDisabled();
    fireEvent.click(screen.getByText('go c')); // a → c, forward history dropped
    expect(current()).toBe('/chats/c');
    expect(forward()).toBeDisabled();
    expect(back()).not.toBeDisabled();
    fireEvent.click(back());
    expect(current()).toBe('/chats/a');
  });

  it('does not push a duplicate entry when navigating to the current location', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go a')); // already on /chats/a
    expect(back()).toBeDisabled();
    expect(forward()).toBeDisabled();
  });

  it('⌘← walks back and ⌘→ walks forward, same as the buttons', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b'));
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true });
    expect(current()).toBe('/chats/a');
    expect(back()).toBeDisabled();
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
    expect(current()).toBe('/chats/b');
    expect(forward()).toBeDisabled();
  });

  it('⌘← is a no-op at the start of history', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true });
    expect(current()).toBe('/chats/a');
    expect(back()).toBeDisabled();
  });

  it('leaves ⌘←/⌘→ to the field when a text input has focus', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('go b'));
    const field = screen.getByTestId('some-field');
    field.focus();
    fireEvent.keyDown(field, { key: 'ArrowLeft', metaKey: true });
    expect(current()).toBe('/chats/b');
    expect(back()).not.toBeDisabled();
  });

  it('keeps history across routes, each of which mounts its own controls (Settings → Back)', () => {
    render(
      <MemoryRouter initialEntries={['/chats/a']}>
        <nav>
          <Link to="/chats/b">go b</Link>
          <Link to="/settings">go settings</Link>
        </nav>
        <Routes>
          <Route
            path="/chats/:id"
            element={
              <>
                <NavHistoryControls />
                <CurrentPath />
              </>
            }
          />
          <Route
            path="/settings"
            element={
              <>
                <NavHistoryControls />
                <CurrentPath />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('go b'));
    fireEvent.click(screen.getByText('go settings'));
    expect(current()).toBe('/settings');
    expect(back()).not.toBeDisabled();
    fireEvent.click(back());
    expect(current()).toBe('/chats/b');
    expect(forward()).not.toBeDisabled();
    fireEvent.click(forward());
    expect(current()).toBe('/settings');
  });
});
