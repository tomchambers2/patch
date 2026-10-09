// Save controls (Tom, App Updates: "patch save button is not a real button").
//
// The file editor's Save fell through to the preflight reset — no background,
// no border, no padding, a default cursor — so it read as a run of body text
// that happened to be clickable, and no commit control in the app carried the
// accent focus ring the fields already have. jsdom has no cascade, so the look
// is locked against the stylesheet's source here (the idiom of
// scrollbarStyles.test.ts) and proved in a real browser by
// e2e/save-button-affordances.spec.ts. What IS behaviour — a control and its
// chord refusing on the same predicate — is exercised directly.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { HostsPage } from '../routes/settings/HostsPage.js';
import { useSettingsHostStore } from '../routes/settings/hostScope.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { shortcutTitle } from '../lib/shortcuts.js';
import { setActiveWs } from '../api/ws.js';
import type { WireEvent } from '@patch/wire';
import { reportHost, clearHosts } from './presenceHelpers.js';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The declarations of the first rule whose selector list contains `selector`. */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm').exec(css);
  return m?.[1] ?? '';
}

describe('the file editor Save is drawn as a button', () => {
  it('is styled by the same rule as the diff footer, not left to the UA', () => {
    const rule = ruleFor('.browse-actions button');
    expect(rule).toMatch(/background:\s*var\(--bg-elevated\);/);
    expect(rule).toMatch(/border:\s*1px solid var\(--line\);/);
    expect(rule).toMatch(/padding:\s*6px 14px;/);
    expect(rule).toMatch(/border-radius:\s*var\(--radius-sm\);/);
    expect(rule).toMatch(/cursor:\s*pointer;/);
  });

  it('drops to a plain cursor when there is nothing to save', () => {
    expect(ruleFor('.browse-actions button:disabled')).toMatch(/cursor:\s*default;/);
  });

  it('answers a hover, so pointing at it says it is a target', () => {
    expect(ruleFor('.browse-actions button:hover:not(:disabled)')).toMatch(/background:/);
  });
});

describe('the commit controls carry the app focus ring', () => {
  // A real <button> is already a tab stop; without a ring of its own the cursor
  // simply cannot be seen on it.
  const ring = ruleFor('.browse-actions button:focus-visible');

  it('is the accent outline the fields already use', () => {
    expect(ring).toMatch(/outline:\s*2px solid var\(--accent\);/);
    expect(ring).toMatch(/outline-offset:\s*1px;/);
  });

  it.each([
    '.diff-panel-actions button:focus-visible',
    '.msg-edit-save:focus-visible',
    '.primary-btn:focus-visible',
    '.secondary-btn:focus-visible',
    '.danger-btn:focus-visible',
    '.set-btn:focus-visible',
    '.set-nav button:focus-visible',
    '.ctrl-btn:focus-visible',
    '.model-option:focus-visible',
  ])('covers %s too', (selector) => {
    const rule = ruleFor(selector);
    // Asserted against the outline itself, not just against `ring` — two
    // controls with no rule at all would otherwise agree with each other.
    expect(rule).toMatch(/outline:\s*2px solid var\(--accent\);/);
    expect(rule).toBe(ring);
  });
});

// The host rename used to be a text field with its own Save button. The
// reorganised Hosts page commits the name the way a single-line field should:
// on ↵, on ⌘↵, or on leaving the field — and the field's title names the chord.
describe('the host rename commits from the field', () => {
  function renderPage(): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <HostsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    clearHosts();
    vi.restoreAllMocks();
    useSettingsHostStore.setState({ selected: null });
    usePresenceStore.getState().setConnection('connected');
    useUiStore.getState().clearToasts();
    sent = [];
    setActiveWs({
      send: (e: WireEvent) => {
        sent.push(e as unknown as Record<string, unknown>);
      },
    } as never);
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    renderPage();
  });

  const field = (): HTMLInputElement =>
    screen.getByTestId('host-host-a-name-input') as HTMLInputElement;
  const renames = (): Array<Record<string, unknown>> =>
    sent.filter((m) => m['type'] === 'host.rename');

  afterEach(() => {
    setActiveWs(null);
  });

  it('has no separate Save button — the field is the control', () => {
    expect(screen.queryByTestId('host-host-a-rename-save')).toBeNull();
  });

  it('names its chord in the field title', () => {
    expect(field().title).toBe(shortcutTitle('Save', '↵'));
    expect(field().title).toBe('Save (Enter)');
  });

  it('commits on ↵', () => {
    fireEvent.change(field(), { target: { value: 'desk' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(renames()).toEqual([{ type: 'host.rename', daemonId: 'host-a', hostName: 'desk' }]);
  });

  it('commits on ⌘↵ too', () => {
    fireEvent.change(field(), { target: { value: 'desk' } });
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    expect(renames()).toEqual([{ type: 'host.rename', daemonId: 'host-a', hostName: 'desk' }]);
  });

  it('refuses an empty name on the chord exactly as it does on blur', () => {
    const said = (): string[] => useUiStore.getState().errors.map((e) => e.message);
    fireEvent.change(field(), { target: { value: '  ' } });
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    const onChord = said();
    useUiStore.getState().clearToasts();
    fireEvent.keyDown(field(), { key: 'Enter' });
    const onEnter = said();
    useUiStore.getState().clearToasts();
    fireEvent.blur(field());
    const onBlur = said();
    expect(renames()).toEqual([]);
    expect(onBlur).toEqual(['a machine name cannot be empty']);
    expect(onChord).toEqual(onBlur);
    expect(onEnter).toEqual(onBlur);
  });

  it('sends nothing when the name is unchanged', () => {
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    fireEvent.blur(field());
    expect(renames()).toEqual([]);
  });
});
