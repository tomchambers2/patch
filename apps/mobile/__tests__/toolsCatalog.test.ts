// Mirrors packages/web/src/__tests__/tools.test.tsx's completeness gate (same
// duplication convention as toolsCatalog.ts itself — mobile depends on
// @patch/wire, not @patch/web). Every tool `buildPatchToolsServer`
// (packages/daemon/src/mcp.ts) registers must have a catalog entry here too,
// or the mobile Tools sheet leaves it invisible and un-toggleable.

import { describe, it, expect } from 'vitest';
import { TOOL_CATALOG, patchToolId, PATCH_MCP_PREFIX, describeTool } from '../src/lib/toolsCatalog';

// Pinned against packages/daemon/test/mcp-tools.test.ts's own
// "listTools returns the full tool catalogue" gate — update both together.
const EXPECTED_PATCH_TOOLS = [
  'patch_peek',
  'patch_send_to',
  'patch_send_back',
  'patch_spawn',
  'patch_wake_me',
  'patch_cancel_wake',
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
  'patch_list_devices',
  'patch_stop',
  'patch_notify',
  'patch_speak',
  'patch_ask_human',
  'patch_report',
  'patch_artifact',
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
  'patch_browser_screenshot',
  'patch_browser_tabs',
  'patch_browser_close',
];

describe('toolsCatalog', () => {
  it('lists native tools first, then patch tools, each with a full definition', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThan(0);
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

  it('describes each tool in exactly one sentence, starting with the verb', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.description, `${t.label}: one sentence only`).not.toMatch(/[.!?]\s+[A-Z]/);
      expect(t.description, `${t.label}: ends in a full stop`).toMatch(/\.$/);
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

  describe('completeness (patch/todo.md "nothing invisible or unexplained")', () => {
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
});
