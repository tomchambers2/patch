import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { ToolsPanel } from '../components/ToolsPanel.js';
import { useUiStore } from '../stores/uiStore.js';
import { useToolsStore, loadDisabledFromStorage } from '../stores/toolsStore.js';
import { useBatchStore } from '../stores/batchStore.js';
import { SidebarViewMenu } from '../components/SidebarViewMenu.js';
import { TOOL_CATALOG, describeTool, patchToolId, PATCH_MCP_PREFIX } from '../lib/toolsCatalog.js';

describe('toolsCatalog', () => {
  it('lists native tools first, then patch tools, each with a full definition', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
    // Every entry carries the four fields the Tools panel renders.
    for (const t of TOOL_CATALOG) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.params.length).toBeGreaterThan(0);
      expect(['native', 'patch']).toContain(t.category);
    }
    const firstPatchIdx = TOOL_CATALOG.findIndex((t) => t.category === 'patch');
    const lastNativeIdx = TOOL_CATALOG.map((t) => t.category).lastIndexOf('native');
    expect(lastNativeIdx).toBeLessThan(firstPatchIdx);
  });

  it('gates patch tools by their mcp__patch__ id but labels them with the bare name', () => {
    const spawn = TOOL_CATALOG.find((t) => t.label === 'patch_spawn');
    expect(spawn?.name).toBe('mcp__patch__patch_spawn');
    expect(patchToolId('patch_spawn')).toBe(`${PATCH_MCP_PREFIX}patch_spawn`);
  });

  it('gates native tools by their bare name', () => {
    const bash = TOOL_CATALOG.find((t) => t.label === 'Bash');
    expect(bash?.name).toBe('Bash');
    expect(bash?.category).toBe('native');
  });

  // spec/14-design-web.md § Copy — no helper text → "Tool descriptions are the
  // one content exception": the sentence describes the TOOL, never the control,
  // and it is exactly one sentence.
  it('describes each tool in exactly one sentence', () => {
    for (const t of TOOL_CATALOG) {
      // A second sentence shows up as a terminator followed by a capitalised
      // word ("e.g. `src/**`" is fine — lowercase/backtick after the dot).
      expect(t.description, `${t.label}: one sentence only`).not.toMatch(/[.!?]\s+[A-Z]/);
      expect(t.description, `${t.label}: ends in a full stop`).toMatch(/\.$/);
    }
  });

  it('describes what the TOOL does, never what the control does', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.description, `${t.label}: no control prose`).not.toMatch(
        /\b(toggle|switch|click|tap|turn (it )?off|turn (it )?on|use this|this dialog|this panel|below)\b/i,
      );
      // Third person, starts with the verb — not "The agent can…"/"Lets you…".
      expect(t.description, `${t.label}: starts with a verb`).toMatch(/^[A-Z][a-z]+s\b/);
    }
  });

  it('describeTool resolves a known native tool', () => {
    expect(describeTool('Bash').description).toMatch(/shell command/i);
  });

  it('describeTool resolves a known patch tool by its full id', () => {
    const e = describeTool('mcp__patch__patch_spawn');
    expect(e.label).toBe('patch_spawn');
    expect(e.category).toBe('patch');
  });

  it('describeTool falls back gracefully for an unknown MCP tool (strips prefix, keeps id)', () => {
    const e = describeTool('mcp__patch__patch_mystery');
    expect(e.name).toBe('mcp__patch__patch_mystery');
    expect(e.label).toBe('patch_mystery');
    expect(e.category).toBe('patch');
    expect(e.params).toMatch(/unavailable/i);
  });

  it('describeTool falls back gracefully for an unknown native tool', () => {
    const e = describeTool('SomeFutureTool');
    expect(e.name).toBe('SomeFutureTool');
    expect(e.label).toBe('SomeFutureTool');
    expect(e.category).toBe('native');
    expect(e.description).toMatch(/no catalog description/i);
  });
});

// Pinned completeness gate (same shape as packages/wire's host-addressing /
// codec gates, eb76ff89): every tool `buildPatchToolsServer` (daemon/src/mcp.ts)
// registers, listed by hand here. A tool added to the MCP server but not to
// this list — and so not to toolsCatalog.ts — is invisible in the Tools panel:
// the user can neither see it nor turn it off. Update BOTH this list and
// toolsCatalog.ts together when mcp.ts grows a new tool.
const EXPECTED_PATCH_TOOLS = [
  'patch_peek',
  'patch_send_to',
  'patch_send_back',
  'patch_spawn',
  'patch_wake_me',
  'patch_cancel_wake',
  'patch_loop',
  'patch_doc_suggest',
  'patch_doc_comment',
  'patch_doc_reply',
  'patch_doc_convert',
  'patch_doc_export',
  'patch_goal_set',
  'patch_goal_get',
  'patch_goal_clear',
  'patch_watch',
  'patch_watch_list',
  'patch_watch_output',
  'patch_watch_stop',
  'patch_delegate',
  'patch_delegate_list',
  'patch_delegate_send',
  'patch_delegate_stop',
  'patch_history',
  'patch_list_chats',
  'patch_activity',
  'patch_list_devices',
  'patch_stop',
  'patch_notify',
  'patch_speak',
  'patch_ask_human',
  'patch_report',
  'patch_artifact',
  'patch_pad_create',
  'patch_pad_list',
  'patch_pad_reply',
  'patch_pad_update',
  'view_file',
  'patch_call',
  'patch_job_list',
  'patch_job_create',
  'patch_job_update',
  'patch_job_delete',
  'patch_job_enable',
  'patch_job_disable',
  'patch_job_runs',
  'patch_job_webhooks',
  'patch_browser_open',
  'patch_browser_read',
  'patch_browser_click',
  'patch_browser_type',
  'patch_browser_fill_form',
  'patch_browser_select',
  'patch_browser_upload',
  'patch_browser_mouse',
  'patch_browser_key',
  'patch_browser_screenshot',
  'patch_browser_tabs',
  'patch_browser_close',
];

describe('toolsCatalog — completeness (patch/todo.md "nothing invisible or unexplained")', () => {
  it('lists every tool the patch-tools MCP server registers', () => {
    const catalogLabels = TOOL_CATALOG.filter((t) => t.category === 'patch').map((t) => t.label);
    for (const tool of EXPECTED_PATCH_TOOLS) {
      expect(catalogLabels, `${tool} missing from toolsCatalog.ts`).toContain(tool);
    }
  });

  it('carries no patch entry the MCP server does not actually expose', () => {
    const expected = new Set(EXPECTED_PATCH_TOOLS);
    for (const t of TOOL_CATALOG.filter((e) => e.category === 'patch')) {
      expect(expected, `${t.label} is stale — not registered by mcp.ts`).toContain(t.label);
    }
  });
});

const KEY = 'patch.tools.disabledByChat.v1';

describe('toolsStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useToolsStore.getState()._reset();
  });

  it('defaults to every tool ON (empty OFF set) per chat', () => {
    const s = useToolsStore.getState();
    expect(s.isDisabled('c1', 'Bash')).toBe(false);
    expect(s.disabledFor('c1')).toEqual([]);
  });

  it('toggle switches a tool OFF then back ON for a chat', () => {
    const s = () => useToolsStore.getState();
    s().toggle('c1', 'Bash');
    expect(s().isDisabled('c1', 'Bash')).toBe(true);
    expect(s().disabledFor('c1')).toEqual(['Bash']);
    s().toggle('c1', 'Bash');
    expect(s().isDisabled('c1', 'Bash')).toBe(false);
    expect(s().disabledFor('c1')).toEqual([]);
  });

  it('scopes the OFF set per chat', () => {
    const s = () => useToolsStore.getState();
    s().toggle('c1', 'Bash');
    expect(s().isDisabled('c1', 'Bash')).toBe(true);
    expect(s().isDisabled('c2', 'Bash')).toBe(false);
  });

  it('persists the OFF set to localStorage and prunes emptied chats', () => {
    const s = () => useToolsStore.getState();
    s().toggle('c1', 'Bash');
    s().toggle('c1', 'mcp__patch__patch_spawn');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({
      c1: ['Bash', 'mcp__patch__patch_spawn'],
    });
    // Turning both back on removes the chat key entirely (no empty arrays left).
    s().toggle('c1', 'Bash');
    s().toggle('c1', 'mcp__patch__patch_spawn');
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({});
  });

  it('loader hydrates valid chats and drops junk (non-arrays, non-strings, empty lists)', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ c9: ['WebSearch', 42, 'Read'], bad: 'nope', empty: [] }),
    );
    expect(loadDisabledFromStorage()).toEqual({ c9: ['WebSearch', 'Read'] });
  });

  it('loader returns empty for a missing key', () => {
    window.localStorage.clear();
    expect(loadDisabledFromStorage()).toEqual({});
  });

  it('loader returns empty for a corrupt JSON blob (no throw)', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(loadDisabledFromStorage()).toEqual({});
  });

  it('loader returns empty for a non-object JSON root', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['nope']));
    // An array is typeof 'object' but has no chat entries → empty set.
    expect(loadDisabledFromStorage()).toEqual({});
    window.localStorage.setItem(KEY, JSON.stringify(null));
    expect(loadDisabledFromStorage()).toEqual({});
  });

  it('a blocked/full localStorage on persist does not crash — in-memory state still updates', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    const s = () => useToolsStore.getState();
    expect(() => s().toggle('cQ', 'Bash')).not.toThrow();
    expect(s().isDisabled('cQ', 'Bash')).toBe(true);
    spy.mockRestore();
  });
});

// The panel is route-aware (spec/14 § Tools panel — it belongs to the chat it
// was opened for), so it is always mounted inside a router, exactly as the
// shell mounts it. `/chats/c1` is the chat every test below opens it for.
function renderPanel(path = '/chats/c1', extra: JSX.Element | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {extra}
      <ToolsPanel />
    </MemoryRouter>,
  );
}

/** A bare control that pushes a route, so a test can navigate for real. */
function GoTo({ to }: { to: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go" onClick={() => navigate(to)}>
      go
    </button>
  );
}

describe('ToolsPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useToolsStore.getState()._reset();
    useUiStore.setState({ toolsPanelChatId: null });
  });
  afterEach(() => cleanup());

  it('renders nothing when no chat has the panel open', () => {
    renderPanel();
    expect(screen.queryByTestId('tools-panel')).not.toBeInTheDocument();
  });

  it('has a drag-resizable divider whose width persists', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    const panel = screen.getByTestId('tools-panel');
    expect(panel.style.width).toBe('320px');
    const divider = screen.getByTestId('tools-divider');
    expect(divider.getAttribute('role')).toBe('separator');
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(divider, { clientX: 1000, pointerId: 1 });
    // Right-docked column: dragging left widens it.
    fireEvent(window, new MouseEvent('pointermove', { clientX: 900 }));
    fireEvent(window, new MouseEvent('pointerup'));
    expect(screen.getByTestId('tools-panel').style.width).toBe('420px');
    expect(window.localStorage.getItem('patch.layout.toolsPanelWidth')).toBe('420');
    fireEvent.doubleClick(divider);
    expect(screen.getByTestId('tools-panel').style.width).toBe('320px');
  });

  it('lists every catalog tool with its description, definition and an on switch (default ON)', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    const panel = screen.getByTestId('tools-panel');
    for (const t of TOOL_CATALOG) {
      expect(screen.getByTestId(`tool-row-${t.label}`)).toBeInTheDocument();
      // Its definition (the parameter signature) is shown.
      expect(screen.getByTestId(`tool-def-${t.label}`).textContent).toContain(t.params);
      // Default: every tool ON (switch checked).
      const sw = screen.getByTestId(`tool-toggle-${t.label}`) as HTMLInputElement;
      expect(sw.checked).toBe(true);
    }
    // What each does — description text is present.
    expect(panel.textContent).toContain('Runs a shell command');
  });

  it('carries no prose beyond the per-tool sentences — no intro, blurb or toggle caption', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    const panel = screen.getByTestId('tools-panel');
    const paras = Array.from(panel.querySelectorAll('p'));
    // Every paragraph in the dialog is a tool description, and each tool has one.
    expect(paras.length).toBe(TOOL_CATALOG.length);
    const descriptions = new Set(TOOL_CATALOG.map((t) => t.description));
    for (const p of paras) expect(descriptions).toContain(p.textContent);
  });

  it('renders each tool its own description sentence', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    for (const t of TOOL_CATALOG) {
      expect(screen.getByTestId(`tool-row-${t.label}`).textContent).toContain(t.description);
    }
  });

  // The tool DESCRIPTION is the sanctioned content exception; the switch beside
  // it is an ordinary control, so its tooltip names the state and stops. It used
  // to read "Off — hidden from the agent" / "On — available to the agent".
  it('titles the per-tool switch with the state alone, not what the state means', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    const label = screen.getByTestId('tool-toggle-Bash').closest('label')!;
    expect(label.getAttribute('title')).toBe('On');
    fireEvent.click(screen.getByTestId('tool-toggle-Bash'));
    expect(screen.getByTestId('tool-toggle-Bash').closest('label')!.getAttribute('title')).toBe(
      'Off',
    );
  });

  it('toggling a tool OFF flips the switch and records it in the per-chat OFF set', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    const bash = screen.getByTestId('tool-toggle-Bash') as HTMLInputElement;
    expect(bash.checked).toBe(true);
    fireEvent.click(bash);
    expect((screen.getByTestId('tool-toggle-Bash') as HTMLInputElement).checked).toBe(false);
    expect(useToolsStore.getState().disabledFor('c1')).toEqual(['Bash']);
    // Turning it back on clears it.
    fireEvent.click(screen.getByTestId('tool-toggle-Bash'));
    expect(useToolsStore.getState().disabledFor('c1')).toEqual([]);
  });

  it('reflects a pre-existing OFF set from the store (switch already off)', () => {
    useToolsStore.getState().toggle('c1', 'mcp__patch__patch_spawn');
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    const spawn = screen.getByTestId('tool-toggle-patch_spawn') as HTMLInputElement;
    expect(spawn.checked).toBe(false);
    // A different tool stays on.
    expect((screen.getByTestId('tool-toggle-Bash') as HTMLInputElement).checked).toBe(true);
  });

  it('closes on the close button and on Escape', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    fireEvent.click(screen.getByTestId('tools-panel-close'));
    expect(useUiStore.getState().toolsPanelChatId).toBeNull();
    cleanup();

    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().toolsPanelChatId).toBeNull();
  });

  it('ignores non-Escape keys while open', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel();
    fireEvent.keyDown(window, { key: 'a' });
    expect(useUiStore.getState().toolsPanelChatId).toBe('c1');
  });
});

// spec/14 § Tools panel — "The panel belongs to the chat it was opened for.
// Navigating anywhere that is not that chat … closes it".
describe('ToolsPanel — closes when the chat it belongs to leaves the screen', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useToolsStore.getState()._reset();
    useUiStore.setState({ toolsPanelChatId: null });
    useBatchStore.setState({ mode: 'regular' });
  });
  afterEach(() => cleanup());

  for (const to of ['/chats/c2', '/chats/new', '/jobs', '/jobs/j1', '/settings']) {
    it(`clears the open chat and unmounts on navigating to ${to}`, () => {
      useUiStore.getState().setToolsPanelChatId('c1');
      renderPanel('/chats/c1', <GoTo to={to} />);
      expect(screen.getByTestId('tools-panel')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('go'));

      expect(useUiStore.getState().toolsPanelChatId).toBeNull();
      expect(screen.queryByTestId('tools-panel')).not.toBeInTheDocument();
    });
  }

  it('stays open while the route is still its own chat', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel('/chats/c1', <GoTo to="/chats/c1?focus=composer" />);
    fireEvent.click(screen.getByTestId('go'));
    expect(useUiStore.getState().toolsPanelChatId).toBe('c1');
    expect(screen.getByTestId('tools-panel')).toBeInTheDocument();
  });

  // The left sidebar's view dropdown does not change which chat is open, and
  // the spec has the left sidebar keep its view while Tools is open.
  it('stays open across a left-sidebar view switch', () => {
    useUiStore.getState().setToolsPanelChatId('c1');
    renderPanel('/chats/c1', <SidebarViewMenu />);
    fireEvent.click(screen.getByTestId('sidebar-view-trigger'));
    fireEvent.click(screen.getByTestId('sidebar-view-option-batch'));
    expect(useBatchStore.getState().mode).toBe('batch');
    expect(useUiStore.getState().toolsPanelChatId).toBe('c1');
    expect(screen.getByTestId('tools-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-view-trigger'));
    fireEvent.click(screen.getByTestId('sidebar-view-option-all'));
    expect(useUiStore.getState().toolsPanelChatId).toBe('c1');
    expect(screen.getByTestId('tools-panel')).toBeInTheDocument();
  });

  // Opening it for the chat already on screen must not immediately self-close.
  it('opens for the chat that is on screen and stays', () => {
    renderPanel('/chats/c9');
    expect(screen.queryByTestId('tools-panel')).not.toBeInTheDocument();
    act(() => useUiStore.getState().setToolsPanelChatId('c9'));
    expect(screen.getByTestId('tools-panel')).toBeInTheDocument();
    expect(useUiStore.getState().toolsPanelChatId).toBe('c9');
  });
});
