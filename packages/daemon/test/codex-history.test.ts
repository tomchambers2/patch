import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexHistory } from '../src/codexHistory.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-history-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('durable OpenAI history', () => {
  it('keeps the pending input across a restart and clears only explicitly', () => {
    const h = new CodexHistory(root);
    h.begin('codex-one');
    h.setPending('codex-one', { id: 'request', prompt: 'write a file' });
    expect(new CodexHistory(root).pending('codex-one')).toEqual({
      id: 'request',
      prompt: 'write a file',
    });
    h.setPending('codex-one', null);
    expect(h.pending('codex-one')).toBeNull();
  });
  it('deduplicates recovered items while preserving separate turns', () => {
    const h = new CodexHistory(root);
    h.begin('codex-one');
    const event = { type: 'assistant' as const, content: 'Done' };
    h.append('codex-one', 'turn-1', 'chat', event);
    h.append('codex-one', 'turn-1', 'chat', event);
    h.append('codex-one', 'turn-2', 'chat', event);
    expect(h.entries('codex-one')).toHaveLength(2);
  });
  it('forks only the prefix and leaves the original untouched', () => {
    const h = new CodexHistory(root);
    h.begin('codex-one');
    h.begin('codex-two');
    h.append('codex-one', 'turn-1', 'chat', { type: 'user', content: 'One' });
    h.append('codex-one', 'turn-2', 'chat', { type: 'user', content: 'Two' });
    h.fork('codex-one', 'codex-two', 'before:turn-2');
    expect(h.entries('codex-two')).toHaveLength(1);
    expect(h.entries('codex-one')).toHaveLength(2);
  });
  it('rejects paths that could escape its own storage', () => {
    expect(() => new CodexHistory(root).begin('../outside')).toThrow();
  });
  // spec/14 § Messages — the per-message meta strip's real time. Codex's own
  // envelope carries no timestamp, so `append` stamps one itself at write
  // time; that stamp is still a real creation time (unlike a surface's "now"
  // on replay) because it's persisted into the JSONL line and read back
  // unchanged, not re-minted on every `entries()` call.
  it('stamps createdAt on a chat.message at write time and keeps it on replay', () => {
    const h = new CodexHistory(root);
    h.begin('codex-one');
    const before = Date.now();
    h.append('codex-one', 'turn-1', 'chat', { type: 'assistant', content: 'Done' });
    const after = Date.now();
    const [entry] = h.entries('codex-one');
    expect(entry!.event).toMatchObject({ type: 'chat.message', content: 'Done' });
    const createdAt = (entry!.event as { createdAt?: number }).createdAt;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);

    // Re-open the store (simulates a restart) and read the same entry back —
    // the stamp must be the one written, not a fresh "now".
    const reopened = new CodexHistory(root).entries('codex-one');
    expect((reopened[0]!.event as { createdAt?: number }).createdAt).toBe(createdAt);
  });
  it('does not stamp createdAt on a tool_call or tool_result event', () => {
    const h = new CodexHistory(root);
    h.begin('codex-one');
    h.append('codex-one', 'turn-1', 'chat', {
      type: 'tool_use',
      tool: { name: 'Read', args: {}, callId: 'call-1' },
    });
    h.append('codex-one', 'turn-1', 'chat', {
      type: 'tool_result',
      toolResult: { name: 'Read', result: 'ok', callId: 'call-1', isError: false },
    });
    const entries = h.entries('codex-one');
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.event).not.toHaveProperty('createdAt');
  });
});
