// Live update (spec/14 § Live updates): the server reports its served bundle
// hash on auth.ok. A mismatch against the running bundle no longer reloads on
// the spot — it stages the update (webUpdateStore) for WebUpdateBanner to ask
// about, same as the desktop shell's own banner. Reloading only ever happens
// through `reloadNow`, wired to that banner's button.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onServerVersion, reloadNow, __resetLiveUpdateForTests } from '../lib/liveUpdate.js';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';

function seedRunningBundle(hash: string): void {
  const s = document.createElement('script');
  s.type = 'module';
  s.src = `/app/assets/index-${hash}.js`;
  document.head.appendChild(s);
}

/** Stand in for the Electron preload surface (window.patch). */
function seedDesktopShell(): { checkForUpdateNow: ReturnType<typeof vi.fn> } {
  const bridge = { checkForUpdateNow: vi.fn() };
  (window as unknown as { patch?: unknown }).patch = bridge;
  return bridge;
}

beforeEach(() => {
  document.head.querySelectorAll('script[type="module"]').forEach((s) => s.remove());
  delete (window as unknown as { patch?: unknown }).patch;
  __resetLiveUpdateForTests();
});

describe('onServerVersion', () => {
  it('stages the update when the server reports a different bundle than the running one', () => {
    seedRunningBundle('AAAA');
    onServerVersion('assets/index-BBBB.js');
    expect(useWebUpdateStore.getState().bundle).toBe('assets/index-BBBB.js');
    expect(useWebUpdateStore.getState().staleSince).not.toBeNull();
  });

  it('does NOT stage anything when the reported bundle matches the running one', () => {
    seedRunningBundle('AAAA');
    onServerVersion('assets/index-AAAA.js');
    expect(useWebUpdateStore.getState().bundle).toBeNull();
  });

  it('is inert when there is no hashed running bundle (dev harness)', () => {
    onServerVersion('assets/index-BBBB.js');
    expect(useWebUpdateStore.getState().bundle).toBeNull();
  });

  it('ignores an absent webBundleHash (server serves no SPA)', () => {
    seedRunningBundle('AAAA');
    onServerVersion(undefined);
    expect(useWebUpdateStore.getState().bundle).toBeNull();
  });

  it('never reloads on its own — only reloadNow does', () => {
    seedRunningBundle('AAAA');
    onServerVersion('assets/index-BBBB.js');
    onServerVersion('assets/index-CCCC.js');
    // Two deploys landing back to back stage the latest bundle, but nothing
    // has called reload.
    expect(useWebUpdateStore.getState().bundle).toBe('assets/index-CCCC.js');
  });

  // The FIRST sighting is what ages, not the latest — a second deploy landing
  // before the user reloads must not reset the escalation clock.
  it('a repeat report keeps the original staleSince', () => {
    seedRunningBundle('AAAA');
    onServerVersion('assets/index-BBBB.js');
    const firstSeen = useWebUpdateStore.getState().staleSince;
    onServerVersion('assets/index-CCCC.js');
    expect(useWebUpdateStore.getState().staleSince).toBe(firstSeen);
  });

  it('tells the desktop shell to CHECK — not to restart', () => {
    seedRunningBundle('AAAA');
    const shell = seedDesktopShell();
    onServerVersion('assets/index-BBBB.js');
    expect(shell.checkForUpdateNow).toHaveBeenCalledTimes(1);
  });

  it('does not touch the shell when the bundle is unchanged', () => {
    seedRunningBundle('AAAA');
    const shell = seedDesktopShell();
    onServerVersion('assets/index-AAAA.js');
    expect(shell.checkForUpdateNow).not.toHaveBeenCalled();
  });
});

describe('reloadNow', () => {
  it('calls the reload seam (default window.location.reload)', () => {
    const reload = vi.fn();
    reloadNow({ reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('with unsaved edits held by a navigation guard, asks first and reloads only on yes', async () => {
    const { render, cleanup } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router-dom');
    const React = await import('react');
    const { useNavigationGuard, __resetUnloadApprovalForTests } =
      await import('../lib/useNavigationGuard.js');
    let answer = false;
    const confirm = vi.fn(() => Promise.resolve(answer));
    function Editor(): null {
      useNavigationGuard({ shouldBlock: () => true, confirm });
      return null;
    }
    render(React.createElement(MemoryRouter, null, React.createElement(Editor)));
    const reload = vi.fn();

    reloadNow({ reload });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();

    answer = true;
    reloadNow({ reload });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    // The approved unload must not be vetoed a second time by beforeunload.
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    __resetUnloadApprovalForTests();
    cleanup();
  });
});
