// Reconstructing a chat's own log as a native session on either harness
// (spec/04 § History — a seamless provider switch, and reseeding a lost
// session).

import { describe, it, expect } from 'vitest';
import type { LoggedEvent } from '@patch/wire';
import {
  toClaudeSessionEntries,
  toResponsesItems,
  estimateTokens,
  type TrackEntry,
} from '../src/nativeReconstruct.js';

function track(events: LoggedEvent[]): TrackEntry[] {
  return events.map((event, i) => ({ record: { seq: i, at: 1_700_000_000_000 + i }, event }));
}

function msg(role: 'user' | 'assistant' | 'system', content: string): LoggedEvent {
  return { type: 'chat.message', chatId: 'c1', role, content, seq: 0 };
}
function toolCall(tool: string, args: unknown, callId: string): LoggedEvent {
  return { type: 'chat.tool_call', chatId: 'c1', tool, args, callId, seq: 0 };
}
function toolResult(tool: string, result: unknown, callId: string, isError = false): LoggedEvent {
  return {
    type: 'chat.tool_result',
    chatId: 'c1',
    tool,
    result,
    callId,
    seq: 0,
    ...(isError ? { isError: true } : {}),
  };
}

describe('toClaudeSessionEntries', () => {
  it('translates a plain user/assistant exchange, threaded by parentUuid', () => {
    const entries = toClaudeSessionEntries(track([msg('user', 'hi'), msg('assistant', 'hello')]), {
      sessionId: 'sess-1',
      folder: '/w',
      model: 'claude-opus-5',
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'user',
      parentUuid: null,
      message: { role: 'user', content: 'hi' },
    });
    expect(entries[1]).toMatchObject({
      type: 'assistant',
      parentUuid: entries[0]!['uuid'],
      message: { role: 'assistant', content: 'hello', model: 'claude-opus-5' },
    });
  });

  it("drops system messages — they were never part of the model's own context", () => {
    const entries = toClaudeSessionEntries(
      track([msg('user', 'a'), msg('system', 'mode changed'), msg('assistant', 'b')]),
      { sessionId: 's', folder: '/w', model: null },
    );
    expect(entries.map((e) => e['type'])).toEqual(['user', 'assistant']);
    // The assistant reply's parent skips straight past the dropped system note.
    expect(entries[1]!['parentUuid']).toBe(entries[0]!['uuid']);
  });

  it('a native Claude tool becomes a real tool_use/tool_result pair', () => {
    const entries = toClaudeSessionEntries(
      track([toolCall('Bash', { command: 'ls' }, 'c1'), toolResult('Bash', 'file.txt', 'c1')]),
      { sessionId: 's', folder: '/w', model: null },
    );
    expect(entries[0]).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    expect(entries[1]).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file.txt' }],
      },
    });
  });

  it('an unmapped tool (no Claude native equivalent) becomes plain text, never a tool_use block', () => {
    const entries = toClaudeSessionEntries(
      track([
        toolCall('mcp__todoist__add_task', { content: 'buy milk' }, 'c9'),
        toolResult('mcp__todoist__add_task', { id: '123' }, 'c9'),
      ]),
      { sessionId: 's', folder: '/w', model: null },
    );
    for (const e of entries) {
      const content = (e['message'] as { content: unknown }).content;
      expect(Array.isArray(content)).toBe(false);
      expect(typeof content).toBe('string');
    }
    expect((entries[0]!['message'] as { content: string }).content).toContain(
      'mcp__todoist__add_task',
    );
  });

  it('closes a dangling trailing tool_use with a synthetic interrupted result', () => {
    const entries = toClaudeSessionEntries(
      track([toolCall('Bash', { command: 'sleep 100' }, 'c1')]),
      {
        sessionId: 's',
        folder: '/w',
        model: null,
      },
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      type: 'user',
      message: {
        content: [
          expect.objectContaining({ type: 'tool_result', tool_use_id: 'c1', is_error: true }),
        ],
      },
    });
  });

  it('an artifact becomes a text note, since Claude has no native artifact concept to resume into', () => {
    const entries = toClaudeSessionEntries(
      track([
        {
          type: 'chat.artifact',
          chatId: 'c1',
          artifactId: 'a1',
          title: 'Report',
          url: '/x',
          path: 'r.html',
          updatedAt: 1,
          seq: 0,
        },
      ]),
      { sessionId: 's', folder: '/w', model: null },
    );
    expect(entries).toHaveLength(1);
    expect((entries[0]!['message'] as { content: string }).content).toContain('Report');
  });

  // spec/04 § History — "make the rebuilt entries deterministic... so
  // rebuilding the same track twice gives byte-identical history": this is
  // what makes a resume-and-append idempotent (append()'s uuid dedup only
  // works if the SAME delta always produces the SAME uuids) and what makes
  // two independent rebuilds of one track comparable at all.
  it('reconstructing the same track twice, with the same opts, is byte-identical', () => {
    const t = track([
      msg('user', 'hi'),
      toolCall('Bash', { command: 'ls' }, 'c1'),
      toolResult('Bash', 'file.txt', 'c1'),
      msg('assistant', 'hello'),
    ]);
    const opts = { sessionId: 'sess-1', folder: '/w', model: 'claude-opus-5' };
    const a = toClaudeSessionEntries(t, opts);
    const b = toClaudeSessionEntries(t, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('the SAME event keeps its uuid across a rebuild even alongside a different trailing event', () => {
    const shared = [msg('user', 'hi'), msg('assistant', 'hello')];
    const opts = { sessionId: 'sess-1', folder: '/w', model: null };
    const a = toClaudeSessionEntries(track(shared), opts);
    const b = toClaudeSessionEntries(track([...shared, msg('user', 'more')]), opts);
    expect(b[0]!['uuid']).toBe(a[0]!['uuid']);
    expect(b[1]!['uuid']).toBe(a[1]!['uuid']);
  });

  it('a dangling tool_use closes with a deterministic uuid and timestamp too', () => {
    const t = track([toolCall('Bash', { command: 'sleep 100' }, 'c1')]);
    const opts = { sessionId: 's', folder: '/w', model: null };
    const a = toClaudeSessionEntries(t, opts);
    const b = toClaudeSessionEntries(t, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('startParentUuid threads the delta onto an existing session instead of starting a second root', () => {
    const entries = toClaudeSessionEntries(track([msg('user', 'continuing')]), {
      sessionId: 'sess-1',
      folder: '/w',
      model: null,
      startParentUuid: 'existing-last-uuid',
    });
    expect(entries[0]).toMatchObject({ parentUuid: 'existing-last-uuid' });
  });
});

describe('toResponsesItems', () => {
  it('translates a plain exchange into message items with input_text/output_text', () => {
    const items = toResponsesItems(track([msg('user', 'hi'), msg('assistant', 'hello')]));
    expect(items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ]);
  });

  it('maps Bash to a shell function_call/function_call_output pair', () => {
    const items = toResponsesItems(
      track([toolCall('Bash', { command: 'ls' }, 'c1'), toolResult('Bash', 'ok', 'c1')]),
    );
    expect(items[0]).toMatchObject({ type: 'function_call', call_id: 'c1', name: 'shell' });
    expect(JSON.parse((items[0] as { arguments: string }).arguments)).toEqual({ command: 'ls' });
    expect(items[1]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'ok' });
  });

  it('maps Edit/Write to apply_patch', () => {
    const items = toResponsesItems(track([toolCall('Edit', { file: 'a.ts' }, 'c1')]));
    expect(items[0]).toMatchObject({ type: 'function_call', name: 'apply_patch' });
  });

  it('an unmapped tool becomes message text, never a function_call', () => {
    const items = toResponsesItems(
      track([toolCall('Grep', { pattern: 'foo' }, 'c1'), toolResult('Grep', 'match', 'c1')]),
    );
    for (const item of items) expect(item['type']).toBe('message');
  });

  it('closes a dangling trailing function_call with a synthetic output', () => {
    const items = toResponsesItems(track([toolCall('Bash', { command: 'sleep 100' }, 'c1')]));
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
  });

  it('drops system messages', () => {
    const items = toResponsesItems(track([msg('system', 'note'), msg('user', 'hi')]));
    expect(items).toHaveLength(1);
  });
});

describe('estimateTokens', () => {
  it('is roughly chars/4 across the track', () => {
    // 'hi' (2 chars) + 'hello there' (11 chars) = 13 chars -> round(13/4) = 3
    const n = estimateTokens(track([msg('user', 'hi'), msg('assistant', 'hello there')]));
    expect(n).toBe(3);
  });

  it('excludes system messages — they never reach the reconstruction', () => {
    const withSystem = estimateTokens(track([msg('system', 'x'.repeat(4000)), msg('user', 'hi')]));
    const withoutSystem = estimateTokens(track([msg('user', 'hi')]));
    expect(withSystem).toBe(withoutSystem);
  });

  it('counts tool call args and tool result content', () => {
    const n = estimateTokens(
      track([toolCall('Bash', { command: 'ls -la' }, 'c1'), toolResult('Bash', 'file.txt', 'c1')]),
    );
    expect(n).toBeGreaterThan(0);
  });

  it('a longer track estimates more tokens than a shorter one', () => {
    const short = estimateTokens(track([msg('user', 'hi')]));
    const long = estimateTokens(track([msg('user', 'x'.repeat(4000))]));
    expect(long).toBeGreaterThan(short);
  });
});
