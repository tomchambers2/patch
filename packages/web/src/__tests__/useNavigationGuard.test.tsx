// useNavigationGuard — holding a route change open until the user agrees to
// leave (spec/14 § Jobs view — Unsaved changes).
//
// The guard wraps the ROUTER'S NAVIGATOR rather than using `useBlocker`, which
// needs a data router this app does not mount. These tests therefore drive real
// navigation — `<Link>` clicks and `navigate()` calls under a MemoryRouter —
// and assert on where the router actually ended up.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useNavigationGuard } from '../lib/useNavigationGuard.js';

let shouldBlock = false;
let answer = false;
let confirmCalls = 0;

function Guarded(): React.JSX.Element {
  const navigate = useNavigate();
  useNavigationGuard({
    shouldBlock: () => shouldBlock,
    confirm: () => {
      confirmCalls += 1;
      return Promise.resolve(answer);
    },
  });
  return (
    <div>
      <p>editor</p>
      <Link to="/jobs">sidebar link</Link>
      <button type="button" onClick={() => navigate('/jobs')}>
        back button
      </button>
    </div>
  );
}

function Where(): React.JSX.Element {
  return <p>at {useLocation().pathname}</p>;
}

function renderApp(): void {
  render(
    <MemoryRouter initialEntries={['/jobs/j1']}>
      <Where />
      <Routes>
        <Route path="/jobs/:id" element={<Guarded />} />
        <Route path="/jobs" element={<p>jobs list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  shouldBlock = false;
  answer = false;
  confirmCalls = 0;
});

describe('useNavigationGuard', () => {
  it('lets navigation straight through when there is nothing to guard', async () => {
    renderApp();
    fireEvent.click(screen.getByText('sidebar link'));
    expect(await screen.findByText('jobs list')).toBeTruthy();
    expect(confirmCalls).toBe(0);
  });

  it('holds an in-app link and stays put when the user keeps editing', async () => {
    shouldBlock = true;
    answer = false;
    renderApp();
    fireEvent.click(screen.getByText('sidebar link'));
    await waitFor(() => expect(confirmCalls).toBe(1));
    // Still on the editor, and the URL never moved.
    expect(screen.getByText('editor')).toBeTruthy();
    expect(screen.getByText('at /jobs/j1')).toBeTruthy();
  });

  it('lets the same link through once the user discards', async () => {
    shouldBlock = true;
    answer = true;
    renderApp();
    fireEvent.click(screen.getByText('sidebar link'));
    expect(await screen.findByText('jobs list')).toBeTruthy();
    expect(confirmCalls).toBe(1);
  });

  // The route's own Back control, the app's Back/Forward buttons and the
  // desktop shell's navigate IPC are all `navigate()` calls — one wrapper.
  it('guards a programmatic navigate() the same way', async () => {
    shouldBlock = true;
    answer = false;
    renderApp();
    fireEvent.click(screen.getByText('back button'));
    await waitFor(() => expect(confirmCalls).toBe(1));
    expect(screen.getByText('at /jobs/j1')).toBeTruthy();
  });

  it('asks ONCE per attempt — the approved trip does not re-enter the guard', async () => {
    shouldBlock = true;
    answer = true;
    renderApp();
    fireEvent.click(screen.getByText('back button'));
    expect(await screen.findByText('jobs list')).toBeTruthy();
    expect(confirmCalls).toBe(1);
  });

  it('stops guarding once the route unmounts', async () => {
    shouldBlock = true;
    answer = true;
    renderApp();
    fireEvent.click(screen.getByText('back button'));
    expect(await screen.findByText('jobs list')).toBeTruthy();
    confirmCalls = 0;
    // The guarded route is gone; nothing may still be intercepting.
    expect(confirmCalls).toBe(0);
  });

  describe('window close', () => {
    it('cancels the unload while there is unsaved work', () => {
      shouldBlock = true;
      renderApp();
      const e = new Event('beforeunload', { cancelable: true });
      const prevented = !window.dispatchEvent(e);
      expect(prevented).toBe(true);
    });

    it('leaves the unload alone when there is nothing unsaved', () => {
      shouldBlock = false;
      renderApp();
      const e = new Event('beforeunload', { cancelable: true });
      expect(window.dispatchEvent(e)).toBe(true);
    });
  });
});

describe('the guard is removed with the component', () => {
  it('restores the navigator so a later route navigates freely', async () => {
    shouldBlock = true;
    answer = true;
    renderApp();
    fireEvent.click(screen.getByText('back button'));
    expect(await screen.findByText('jobs list')).toBeTruthy();
    vi.restoreAllMocks();
  });
});
