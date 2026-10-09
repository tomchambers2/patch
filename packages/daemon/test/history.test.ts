// History pipe: feed a JSONL fixture, assert wire events emitted with
// correct seq + filtering by fromSeq.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHistoryReader,
  encodeFolder,
  extractSystemContext,
  jsonlLineToWire,
  persistedUserContent,
  type CanonicalSeqIndex,
} from '../src/history.js';
import { claudeCodePersistedUserTurn } from '../src/sdkBackend.js';

/**
 * The seq index of a chat with NOTHING recorded — every transcript event is
 * being seen for the first time, so each is assigned the next canonical seq in
 * order. This is exactly what `chatRunner`'s index does for a transcript it
 * holds no entries for (a fixture, or a chat older than the sidecar).
 */
function assigningIndex(start = 0): CanonicalSeqIndex {
  let next = start;
  return { resolve: (keys: string[]): number[] => keys.map(() => next++) };
}

/** A seq index that answers with an explicit, pre-recorded list of seqs. */
function recordedIndex(seqs: number[]): CanonicalSeqIndex {
  return {
    resolve: (keys: string[]): number[] => {
      if (keys.length !== seqs.length) throw new Error('recordedIndex: length mismatch');
      return seqs;
    },
  };
}

describe('history reader', () => {
  it('jsonlLineToWire translates assistant + user messages with the supplied seq', () => {
    const a = jsonlLineToWire(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      'c1',
      0,
    );
    expect(a).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'hi',
        seq: 0,
      },
    ]);

    const u = jsonlLineToWire(
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      'c1',
      1,
    );
    expect(u).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'hello',
        seq: 1,
      },
    ]);
  });

  it('jsonlLineToWire expands tool_use / tool_result blocks into tool events, naming the result after its call', () => {
    // An assistant turn with narration text AND a tool_use block → two events,
    // seq-numbered in order from the supplied base seq. A `toolNames` map
    // shared across both calls (mirroring `walk()` threading it across every
    // line of a transcript) lets the second call resolve the result's name.
    const toolNames = new Map<string, string>();
    const asst = jsonlLineToWire(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: "I'll read it." },
            { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'src/x.ts' } },
          ],
        },
      }),
      'c1',
      5,
      toolNames,
    );
    expect(asst).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: "I'll read it.", seq: 5 },
      {
        type: 'chat.tool_call',
        chatId: 'c1',
        tool: 'Read',
        args: { file_path: 'src/x.ts' },
        callId: 'call-1',
        seq: 6,
      },
    ]);

    // A follow-up user turn carrying the tool_result block → one tool_result,
    // named "Read" (not the bare placeholder) because it shares `toolNames`
    // with the call above.
    const res = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'export const x = 1;' }],
        },
      }),
      'c1',
      7,
      toolNames,
    );
    expect(res).toEqual([
      {
        type: 'chat.tool_result',
        chatId: 'c1',
        tool: 'Read',
        callId: 'call-1',
        result: 'export const x = 1;',
        seq: 7,
      },
    ]);
  });

  it('jsonlLineToWire falls back to the "tool" placeholder when a tool_result has no matching call in scope', () => {
    // No shared `toolNames` map passed — each call gets its own fresh map, so
    // this mirrors a genuinely corrupt/truncated transcript (or a caller with
    // no cross-line context) where the result's call is unrecoverable.
    const res = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call-orphan', content: 'x' }],
        },
      }),
      'c1',
      0,
    );
    expect(res).toEqual([
      {
        type: 'chat.tool_result',
        chatId: 'c1',
        tool: 'tool',
        callId: 'call-orphan',
        result: 'x',
        seq: 0,
      },
    ]);
  });

  it('skips an unreadable transcript line, reporting it and marking the gap', () => {
    // Claude Code writes the transcript, and a crashed/interleaved write leaves
    // one damaged record mid-file (here: a truncated record with the next one
    // appended without a newline). The surrounding history must still replay —
    // failing the whole read bricked the chat — and the damage must be reported.
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-corrupt';
    const truncated = '{"type":"user","message":{"content":"half a mess';
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'one' } }),
      truncated + JSON.stringify({ type: 'assistant', message: { content: 'two' } }),
      JSON.stringify({ type: 'user', message: { content: 'three' } }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');

    const seen: { path: string; lineNumber: number; message: string }[] = [];
    const reader = createHistoryReader({
      claudeProjectsRoot: root,
      onCorruptLine: (info) => seen.push(info),
    });
    const all = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex: assigningIndex(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.lineNumber).toBe(2);
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ role: 'user', content: 'one', seq: 0 });
    expect(all[1]).toMatchObject({ role: 'system', seq: 1 });
    expect((all[1] as { content: string }).content).toMatch(/Unreadable transcript line 2 skipped/);
    expect(all[2]).toMatchObject({ role: 'user', content: 'three', seq: 2 });
  });

  it('reads JSONL fixture and applies fromSeq filter', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-1';
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'one' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'three' } }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');

    const reader = createHistoryReader({ claudeProjectsRoot: root });
    const all = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex: assigningIndex(),
    });
    expect(all).toHaveLength(3);
    expect((all[0] as { content: string }).content).toBe('one');
    expect((all[1] as { content: string }).content).toBe('two');

    // fromSeq=0 — emit events with seq > 0.
    const tail = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: 0,
      seqIndex: assigningIndex(),
    });
    expect(tail).toHaveLength(2);
  });

  it('reader.read() names a tool_result after its call even though they are on separate JSONL lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-tool-name';
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'call-9', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call-9', content: 'file.txt' }],
        },
      }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');

    const reader = createHistoryReader({ claudeProjectsRoot: root });
    const all = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex: assigningIndex(),
    });
    expect(all).toEqual([
      {
        type: 'chat.tool_call',
        chatId: 'c1',
        tool: 'Bash',
        args: { command: 'ls' },
        callId: 'call-9',
        seq: 0,
      },
      {
        type: 'chat.tool_result',
        chatId: 'c1',
        tool: 'Bash',
        callId: 'call-9',
        result: 'file.txt',
        seq: 1,
      },
    ]);
  });

  it('stamps the canonical seqs the index recorded, NOT the JSONL line index', () => {
    // The live stream numbered these four turns 0,1,4,5 — seqs 2 and 3 went to
    // a permission request and a control-path error, neither of which Claude
    // Code writes to the transcript. Replay must hand back the SAME numbers the
    // surface saw live, so `fromSeq = <highest seq seen>` skips nothing and
    // repeats nothing (spec/12 § Replay vs history cursors).
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-canonical';
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'second' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');
    const reader = createHistoryReader({ claudeProjectsRoot: root });

    const all = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex: recordedIndex([0, 1, 4, 5]),
    });
    expect(all.map((e) => (e as { seq: number }).seq)).toEqual([0, 1, 4, 5]);

    // A surface that last saw seq 1 gets strictly what followed it.
    const tail = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: 1,
      seqIndex: recordedIndex([0, 1, 4, 5]),
    });
    expect(tail.map((e) => (e as { seq: number }).seq)).toEqual([4, 5]);
  });

  it('resolves fork/side points by CANONICAL seq, not line position', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-fork';
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'u2',
        message: { content: [{ type: 'text', text: 'one' }] },
      }),
      JSON.stringify({ type: 'user', uuid: 'u3', message: { content: 'second' } }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');
    const reader = createHistoryReader({ claudeProjectsRoot: root });

    // The 3rd event carries canonical seq 4 (2 and 3 went to non-transcript
    // events). Forking "seq 4" must find it — and forking line-index 2 must not.
    expect(
      reader.forkPoint({ folder, sessionId, seq: 4, seqIndex: recordedIndex([0, 1, 4]) }),
    ).toEqual({ resumeAtUuid: 'u2' });
    expect(
      reader.forkPoint({ folder, sessionId, seq: 2, seqIndex: recordedIndex([0, 1, 4]) }),
    ).toBeNull();
    expect(
      reader.sidePoint({ folder, sessionId, seq: 4, seqIndex: recordedIndex([0, 1, 4]) }),
    ).toEqual({ resumeAtUuid: 'u3' });
  });

  it("resolves fork/side points from the chat's session mirror when it holds turns Claude Code's own transcript never got", () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const nativeDir = mkdtempSync(join(tmpdir(), 'patch-native-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-mirrored';
    const user = (uuid: string, text: string) =>
      JSON.stringify({ type: 'user', uuid, message: { content: text } });
    const assistant = (uuid: string, text: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        message: { content: [{ type: 'text', text }] },
      });
    // Claude Code's own file stopped after the first exchange; the mirror the
    // session store writes carries on (spec/04 § History).
    const early = [user('u1', 'first'), assistant('u2', 'one')];
    writeFileSync(join(dir, `${sessionId}.jsonl`), early.join('\n') + '\n', 'utf8');
    const full = [...early, user('u3', 'second'), assistant('u4', 'two')];
    writeFileSync(join(nativeDir, `${sessionId}.jsonl`), full.join('\n') + '\n', 'utf8');
    const reader = createHistoryReader({ claudeProjectsRoot: root });
    const seqIndex = () => recordedIndex([0, 1, 2, 3]);

    expect(
      reader.forkPoint({ folder, sessionId, seq: 2, seqIndex: seqIndex(), nativeDir }),
    ).toEqual({ resumeAtUuid: 'u2' });
    expect(
      reader.sidePoint({ folder, sessionId, seq: 3, seqIndex: seqIndex(), nativeDir }),
    ).toEqual({ resumeAtUuid: 'u4' });
  });

  it('throws (NO FALLBACK) when JSONL file missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const reader = createHistoryReader({ claudeProjectsRoot: root });
    expect(() =>
      reader.read({
        chatId: 'c1',
        folder: '/x',
        sessionId: 'nope',
        fromSeq: 0,
        seqIndex: assigningIndex(),
      }),
    ).toThrow(/JSONL not found/);
  });

  it('hasSession() reflects whether the JSONL transcript exists yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const reader = createHistoryReader({ claudeProjectsRoot: root });
    expect(reader.hasSession({ folder, sessionId: 'not-yet' })).toBe(false);
    writeFileSync(join(dir, 'now-here.jsonl'), '', 'utf8');
    expect(reader.hasSession({ folder, sessionId: 'now-here' })).toBe(true);
  });

  it('createHistoryReader() defaults to ~/.claude/projects when no override is given', () => {
    // No claudeProjectsRoot passed — exercises defaultClaudeProjectsRoot().
    // We don't touch the real ~/.claude/projects; hasSession() only stats a
    // path and returns false for a session that doesn't exist.
    const reader = createHistoryReader();
    expect(reader.hasSession({ folder: '/nonexistent-xyz', sessionId: 'nope' })).toBe(false);
  });

  it('jsonlLineToWire throws on a genuinely invalid JSON line (NO FALLBACK)', () => {
    expect(() => jsonlLineToWire('{not valid json', 'c1', 0)).toThrow(/invalid JSONL line/);
  });

  it('jsonlLineToWire returns [] for a non-object parsed value (number/null/array)', () => {
    expect(jsonlLineToWire('42', 'c1', 0)).toEqual([]);
    expect(jsonlLineToWire('null', 'c1', 0)).toEqual([]);
  });

  it('jsonlLineToWire returns [] for a line whose type is neither assistant nor user', () => {
    expect(
      jsonlLineToWire(JSON.stringify({ type: 'system', message: { content: 'ignored' } }), 'c1', 0),
    ).toEqual([]);
  });

  // spec/02 § Provider-level context — Claude Code's OWN `type: "attachment"`
  // transcript entries (environment, model identity, token counts, ...),
  // structurally unrelated to the `<system-reminder>` blocks
  // `extractLeadingSystemReminders` strips off a user turn's own prompt.
  describe('jsonlLineToWire — provider-level attachments', () => {
    it('translates a known attachment type carrying a rendered <system-reminder> block', () => {
      const out = jsonlLineToWire(
        JSON.stringify({
          type: 'attachment',
          attachment: {
            type: 'model',
            identity: { modelId: 'claude-sonnet-5' },
          },
          rendered: [
            {
              content:
                '<system-reminder>\nYou are powered by the model named Sonnet 5.\n</system-reminder>',
            },
          ],
        }),
        'c1',
        7,
      );
      expect(out).toEqual([
        {
          type: 'chat.provider_context',
          chatId: 'c1',
          seq: 7,
          providerType: 'model',
          label: 'Model',
          text: 'You are powered by the model named Sonnet 5.',
        },
      ]);
    });

    it('falls back to a legible Title-Case label for a providerType this repo has no dedicated label for', () => {
      const out = jsonlLineToWire(
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'some_future_kind' },
          rendered: [{ content: '<system-reminder>a brand new kind of context</system-reminder>' }],
        }),
        'c1',
        0,
      );
      expect(out).toEqual([
        {
          type: 'chat.provider_context',
          chatId: 'c1',
          seq: 0,
          providerType: 'some_future_kind',
          label: 'Some Future Kind',
          text: 'a brand new kind of context',
        },
      ]);
    });

    it('summarises an attachment with no rendered block at all rather than dropping it', () => {
      // command_permissions / prompt_snapshot / deferred_tools_record carry no
      // `rendered` field — pure internal bookkeeping Claude Code never turns
      // into a reminder for the model itself.
      const out = jsonlLineToWire(
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'command_permissions', allowedTools: [] },
        }),
        'c1',
        0,
      );
      expect(out).toEqual([
        {
          type: 'chat.provider_context',
          chatId: 'c1',
          seq: 0,
          providerType: 'command_permissions',
          label: 'Command permissions',
          text: 'allowedTools: []',
        },
      ]);
    });

    it('returns [] for an attachment line with no usable attachment.type (NOT the same as an unrecognised one)', () => {
      expect(
        jsonlLineToWire(JSON.stringify({ type: 'attachment', attachment: {} }), 'c1', 0),
      ).toEqual([]);
      expect(jsonlLineToWire(JSON.stringify({ type: 'attachment' }), 'c1', 0)).toEqual([]);
    });

    it('reader.read() does not throw on a transcript containing an attachment line, and stamps it a seq', () => {
      // Regression: eventIdentity() fell through `default: return null` for
      // chat.provider_context, and stamp() throws on a null key — aborting the
      // WHOLE read() for any chat whose transcript has an attachment line, not
      // just dropping that one line.
      const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
      const folder = '/work/proj';
      const dir = join(root, encodeFolder(folder));
      mkdirSync(dir, { recursive: true });
      const sessionId = 'session-attachment';
      const lines = [
        JSON.stringify({ type: 'user', message: { content: 'one' } }),
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'model', identity: { modelId: 'claude-sonnet-5' } },
          rendered: [{ content: '<system-reminder>You are Sonnet 5.</system-reminder>' }],
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'two' }] },
        }),
      ];
      writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');

      const reader = createHistoryReader({ claudeProjectsRoot: root });
      const all = reader.read({
        chatId: 'c1',
        folder,
        sessionId,
        fromSeq: -1,
        seqIndex: assigningIndex(),
      });

      expect(all).toHaveLength(3);
      expect(all[0]).toMatchObject({ type: 'chat.message', content: 'one', seq: 0 });
      expect(all[1]).toMatchObject({
        type: 'chat.provider_context',
        providerType: 'model',
        seq: 1,
      });
      expect(all[2]).toMatchObject({ type: 'chat.message', content: 'two', seq: 2 });
    });
  });

  it('jsonlLineToWire skips a tool_use block with an empty name or id', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: '', name: 'Read', input: {} },
            { type: 'tool_use', id: 'call-2', name: '', input: {} },
            { type: 'text', text: 'only this survives' },
          ],
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'only this survives',
        seq: 0,
      },
    ]);
  });

  it('jsonlLineToWire skips a tool_use block whose name/id are missing entirely (non-string)', () => {
    // No `name` / `id` keys at all — exercises the `typeof … === 'string' ? … : ''`
    // fallback side of both ternaries, distinct from the empty-string case above.
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', input: {} }] },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire skips a tool_result block with an empty tool_use_id', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: '', content: 'ignored' }],
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire skips a tool_result block with a missing (non-string) tool_use_id', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ignored' }] },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire marks isError:true on a failed tool_result, omits it otherwise', () => {
    const failed = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'boom', is_error: true },
          ],
        },
      }),
      'c1',
      0,
    );
    expect((failed[0] as { isError?: boolean }).isError).toBe(true);

    const ok = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'fine' }],
        },
      }),
      'c1',
      0,
    );
    expect((ok[0] as { isError?: boolean }).isError).toBeUndefined();
  });

  it('jsonlLineToWire reads structured blocks from a top-level `content` array (no `message` wrapper)', () => {
    const out = jsonlLineToWire(
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'top-level' }] }),
      'c1',
      0,
    );
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'top-level', seq: 0 },
    ]);
  });

  it('jsonlLineToWire falls back to a plain string `message` when there are no blocks', () => {
    const out = jsonlLineToWire(JSON.stringify({ type: 'user', message: 'plain string' }), 'c1', 2);
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: 'plain string', seq: 2 },
    ]);
  });

  it('jsonlLineToWire falls back to a top-level string `content` when `message` is absent', () => {
    const out = jsonlLineToWire(
      JSON.stringify({ type: 'user', content: 'direct top-level string' }),
      'c1',
      3,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'direct top-level string',
        seq: 3,
      },
    ]);
  });

  it('jsonlLineToWire falls back to an empty string when neither message nor content is usable', () => {
    const out = jsonlLineToWire(JSON.stringify({ type: 'user' }), 'c1', 4);
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: '', seq: 4 },
    ]);
  });

  it('jsonlLineToWire falls back to "" when `message` is an object with no usable content field', () => {
    // message is an object (not a string) but its `content` is neither a
    // string nor an array — falls through past the message.content checks to
    // the top-level `content` check, which is also absent here.
    const out = jsonlLineToWire(JSON.stringify({ type: 'user', message: {} }), 'c1', 5);
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: '', seq: 5 },
    ]);
  });

  // patch/todo.md — "Don't show skill content in history." A slash-command /
  // skill invocation is persisted by Claude Code as a `user` turn wrapped in
  // <command-message>/<command-name>/<command-args> tags, and its output as a
  // <local-command-stdout> turn. Replaying those verbatim dumps the internal
  // wrapper XML (and command output) into the transcript. History replay must
  // reconstruct the clean `/command args` the user actually typed, and drop the
  // command-output turns entirely.
  it('jsonlLineToWire reconstructs a slash-command user turn to the clean "/command args"', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<command-message>plant</command-message>\n<command-name>/plant</command-name>\n<command-args>nettle</command-args>',
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: '/plant nettle', seq: 0 },
    ]);
  });

  it('jsonlLineToWire reconstructs a command turn with no args to just "/command"', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<command-message>portfolio-cleanup</command-message>\n<command-name>/portfolio-cleanup</command-name>',
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: '/portfolio-cleanup', seq: 0 },
    ]);
  });

  it('jsonlLineToWire tolerates a command-name without a leading slash and reordered tags', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>clean up and complete the app</command-args>',
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: '/goal clean up and complete the app',
        seq: 0,
      },
    ]);
  });

  it('jsonlLineToWire drops a <local-command-stdout> command-output turn entirely', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<local-command-stdout>Goal set: clean up and complete the app</local-command-stdout>',
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire sanitises a command wrapper carried as a text block in a content array', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<command-message>weekly-timesheet</command-message>\n<command-name>/weekly-timesheet</command-name>\n<command-args>5 days</command-args>',
            },
          ],
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: '/weekly-timesheet 5 days',
        seq: 0,
      },
    ]);
  });

  // patch/todo.md — "Messages going through twice sometimes. Replies in wrong
  // place / messages in wrong place." On a special (Manager) thread the host
  // PREPENDS a broadcast `<system-reminder>…</system-reminder>` block to the
  // user's turn (index.ts preprocessInput → specialThreads
  // buildBroadcastSystemReminder) as agent context. Claude Code persists that
  // AUGMENTED prompt, so a naive replay carries the reminder XML. That corrupts
  // the transcript two ways: (a) the internal XML renders as literal user text,
  // and (b) the persisted user echo no longer equals the surface's optimistic
  // (clean) copy, so the surface's content-match reconcile misses and APPENDS
  // the echo as a DUPLICATE user bubble AFTER the assistant reply — the "twice /
  // wrong place" bug. Replay must strip the leading reminder block so it carries
  // only what the user actually typed; the reconcile then matches and the turn
  // shows exactly once, in order.
  it('jsonlLineToWire strips a leading broadcast <system-reminder> block from a user turn', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- 2m ago: "port 3000 is mine" (from chat: infra)\n</system-reminder>\n\ncarry on with the build',
        },
      }),
      'mgr',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'mgr',
        role: 'user',
        content: 'carry on with the build',
        seq: 0,
        systemContext: [
          {
            source: 'patch',
            label: 'Broadcast digest',
            text: expect.stringContaining('port 3000 is mine'),
          },
        ],
      },
    ]);
  });

  it('jsonlLineToWire strips EVERY leading <system-reminder> block, not just the first', () => {
    // One turn can carry more than one injected block — a task-list reminder in
    // front of the broadcast one — and leaving the second inline puts internal
    // XML in the transcript and breaks the surface's content-match reconcile
    // exactly as a single un-stripped block would.
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<system-reminder>\nThis turn was fired from this chat\'s task list.\n</system-reminder>\n\n<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- 2m ago: "port 3000 is mine" (from chat: infra)\n</system-reminder>\n\n[todo] sweep the yard',
        },
      }),
      'mgr',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'mgr',
        role: 'user',
        content: '[todo] sweep the yard',
        seq: 0,
        systemContext: [
          { source: 'patch', label: 'Todo item fired', text: expect.any(String) },
          {
            source: 'patch',
            label: 'Broadcast digest',
            text: expect.stringContaining('port 3000 is mine'),
          },
        ],
      },
    ]);
  });

  it('jsonlLineToWire strips the reminder block when the turn is a text block in a content array', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- 5m ago: "deploy is running" (from chat: ops)\n</system-reminder>\n\nwhat is the status?',
            },
          ],
        },
      }),
      'mgr',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'mgr',
        role: 'user',
        content: 'what is the status?',
        seq: 0,
        systemContext: [
          {
            source: 'patch',
            label: 'Broadcast digest',
            text: expect.stringContaining('deploy is running'),
          },
        ],
      },
    ]);
  });

  it('jsonlLineToWire strips the reminder block but keeps a following [voice] prefix (surface strips that)', () => {
    // preprocessInput re-appends the voice prefix INSIDE the block return, so a
    // spoken turn on a special thread persists as reminder + `[voice • …] text`.
    // History strips only the reminder; the surface strips the voice tag.
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- 1m ago: "heads up" (from chat: a)\n</system-reminder>\n\n[voice • web] pause everything',
        },
      }),
      'mgr',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'mgr',
        role: 'user',
        content: '[voice • web] pause everything',
        seq: 0,
        systemContext: [
          { source: 'patch', label: 'Broadcast digest', text: expect.stringContaining('heads up') },
        ],
      },
    ]);
  });

  it('jsonlLineToWire strips the reminder block AND reconstructs a following slash command', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- 3m ago: "note" (from chat: b)\n</system-reminder>\n\n<command-name>/goal</command-name>\n<command-args>finish the app</command-args>',
        },
      }),
      'mgr',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'mgr',
        role: 'user',
        content: '/goal finish the app',
        seq: 0,
        systemContext: [
          { source: 'patch', label: 'Broadcast digest', text: expect.stringContaining('note') },
        ],
      },
    ]);
  });

  it('jsonlLineToWire leaves a normal message that merely mentions <system-reminder> mid-text untouched', () => {
    // Only a LEADING injected block is stripped — a user who happens to write the
    // literal tag inside their message keeps it verbatim.
    const text = 'please explain what a <system-reminder> tag does in the prompt';
    const out = jsonlLineToWire(
      JSON.stringify({ type: 'user', message: { content: text } }),
      'c1',
      0,
    );
    expect(out).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: text, seq: 0 },
    ]);
  });

  it('jsonlLineToWire leaves a normal user message that merely mentions <command-name> untouched only when it is a real wrapper', () => {
    // A plain user message with no command wrapper is unchanged.
    const out = jsonlLineToWire(
      JSON.stringify({ type: 'user', message: { content: 'just a normal message' } }),
      'c1',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'just a normal message',
        seq: 0,
      },
    ]);
  });

  it('jsonlLineToWire drops a wrapper whose <command-name> is empty (nothing recoverable)', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: '<command-name></command-name>\n<command-args>orphaned</command-args>',
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire drops a <local-command-stderr> command-output turn', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: { content: '<local-command-stderr>boom</local-command-stderr>' },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire drops a command-output text block inside a content array', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: '<local-command-stdout>internal</local-command-stdout>' },
          ],
        },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  // patch/todo.md — "Continue from where you left off. = where did this come
  // from? its causing problems". That sentence is NOT typed by anyone: the
  // Claude Code CLI injects it as an `isMeta` user turn when it auto-resumes a
  // transcript whose last turn was interrupted (or that has a deferred tool),
  // and Claude Code persists it to the JSONL like any other turn. Replaying it
  // put a user bubble in Patch that the user never sent. Every `isMeta` entry
  // is CLI-injected plumbing and is dropped from replay.
  it('jsonlLineToWire drops the CLI-injected isMeta "Continue from where you left off." user turn', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Continue from where you left off.' }],
        },
        isMeta: true,
      }),
      'c1',
      0,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire drops an isMeta user turn carried as plain string content', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Continue from where you left off.' },
        isMeta: true,
      }),
      'c1',
      3,
    );
    expect(out).toEqual([]);
  });

  it('jsonlLineToWire keeps a user turn that says the same words but is NOT isMeta', () => {
    const out = jsonlLineToWire(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Continue from where you left off.' },
      }),
      'c1',
      0,
    );
    expect(out).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'Continue from where you left off.',
        seq: 0,
      },
    ]);
  });

  it('history replay drops the injected continue turn and keeps seqs contiguous around it', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-meta';
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'do the thing' } }),
      // Turn interrupted here; on resume the CLI injects its own meta prompt.
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Continue from where you left off.' }],
        },
        isMeta: true,
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');

    const reader = createHistoryReader({ claudeProjectsRoot: root });
    const all = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex: assigningIndex(),
    });
    expect(all).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: 'do the thing', seq: 0 },
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'done', seq: 1 },
    ]);
    expect(JSON.stringify(all)).not.toContain('Continue from where you left off');
  });

  it('history replay strips skill/command wrappers and command output, keeping seqs consistent', () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-history-'));
    const folder = '/work/proj';
    const dir = join(root, encodeFolder(folder));
    mkdirSync(dir, { recursive: true });
    const sessionId = 'session-skill';
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content:
            '<command-message>plant</command-message>\n<command-name>/plant</command-name>\n<command-args>nettle</command-args>',
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: '<local-command-stdout>internal output</local-command-stdout>',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Nettle is…' }] },
      }),
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');

    const reader = createHistoryReader({ claudeProjectsRoot: root });
    const all = reader.read({
      chatId: 'c1',
      folder,
      sessionId,
      fromSeq: -1,
      seqIndex: assigningIndex(),
    });
    // The command-output turn is dropped, so only the cleaned command + reply remain.
    expect(all).toEqual([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: '/plant nettle', seq: 0 },
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'Nettle is…', seq: 1 },
    ]);
    // No transcript line contains the raw wrapper XML.
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain('command-name');
    expect(serialised).not.toContain('local-command-stdout');
  });
});

// A slash-command / skill invocation is the ONE user turn whose persisted form
// is not the text the host sent: Claude Code rewrites it into
// <command-message>/<command-name>/<command-args> tags AND trims the args,
// throwing away the separator that followed the command name and any
// surrounding whitespace. That information is gone by the time `read()` sees
// the transcript, so the only way the live event and its persisted twin can
// share ONE payload identity (and therefore one canonical seq) is for the LIVE
// side to adopt the same normalised form — which is exactly what
// `persistedUserContent` is for.
//
// When they disagree the canonical-seq sidecar misses on replay and
// `canonicalSeqIndex.resolve()` treats the FIRST transcript entry as one this
// host never emitted, allocating it a brand-new seq off the tail. Surfaces
// order the transcript by seq, so the initiating prompt then re-renders BELOW
// the final answer — Todoist: "Chat transcript re-renders the triggering job
// prompt below the final answer (looks like the job ran twice)". A job with a
// `skill` hits this every single time: the server renders its first turn as
// `/<skill>\n\n<body>` (packages/server/src/jobs/dispatcher.ts renderPrompt),
// and a mustache placeholder that renders empty leaves trailing whitespace.
describe('persistedUserContent matches what the transcript will yield back', () => {
  /** The content `read()` yields for a transcript line holding `text`. */
  function readBack(text: string): string | null {
    const out = jsonlLineToWire(
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } }),
      'c1',
      0,
    );
    if (out.length === 0) return null;
    return (out[0] as { content: string }).content;
  }

  /**
   * The invariant, stated once: whatever the host SENDS, the text it emits
   * live for that turn is the text the transcript will hand back for it.
   * `claudeCodePersistedUserTurn` is the mock backend's model of what Claude
   * Code writes to disk (shared, so the two can't drift).
   */
  const roundTrips = (prompt: string): void => {
    expect(persistedUserContent(prompt)).toBe(readBack(claudeCodePersistedUserTurn(prompt)));
  };

  const cases: [label: string, prompt: string][] = [
    ['already canonical', '/plant nettle'],
    ['no args at all', '/portfolio-cleanup'],
    ['colon-namespaced command', '/plugin:skill do the thing'],
    // The real shape every skill-backed job sends.
    [
      'body on its own line, trailing whitespace from an empty mustache field',
      '/ha-update\n\nHome Automation Todoist event\n\nDescription on the task (if any): ',
    ],
    ['sloppy inner and trailing whitespace', '/dumb   lots   of   space  '],
    ['trailing newline', '/goal finish the app\n'],
    // Not an invocation: an absolute path is persisted verbatim, so the
    // normalisation must leave it alone or it breaks an identity that works.
    ['an absolute path, not a command', '/srv/patch/CONTEXT.md   needs a note  '],
    ['a plain sentence', 'turn the lights off  '],
    // spec/14 § Skill autocomplete — a `/<skill>` chip the composer renders
    // MID-message is still just text to Claude Code: only a slash at the very
    // start of the whole prompt is a command invocation (the `^` anchor
    // below), so this round-trips as an ordinary sentence, unchanged.
    ['a slash mid-message is plain text, not a command', 'please run /plant now'],
  ];

  for (const [label, prompt] of cases) {
    it(`round-trips a user turn: ${label}`, () => {
      roundTrips(prompt);
    });
  }

  it('leaves a prompt that merely starts with a path separator verbatim', () => {
    const prompt = '/srv/patch/CONTEXT.md   needs a note  ';
    expect(persistedUserContent(prompt)).toBe(prompt);
  });

  it('still strips a leading broadcast system-reminder before normalising the command', () => {
    const prompt =
      '<system-reminder>\nRecent broadcasts\n</system-reminder>\n\n/goal   finish the app  ';
    expect(persistedUserContent(prompt)).toBe('/goal finish the app');
  });

  it('still drops a command wrapper with no recoverable name', () => {
    expect(
      persistedUserContent('<command-name></command-name>\n<command-args>x</command-args>'),
    ).toBe(null);
  });
});

// spec/02 § System-reminder disclosure — every leading `<system-reminder>`
// block a prompt carried used to just vanish; `extractSystemContext` is the
// half of `sanitizeCommandTextWithContext` that captures it instead, labelled
// by which of Patch's own injection sites produced it.
describe('extractSystemContext (spec/02 § System-reminder disclosure)', () => {
  it('returns nothing for a prompt that carried no reminder', () => {
    expect(extractSystemContext('turn the lights off')).toEqual([]);
  });

  it('captures a restart reminder with its label', () => {
    const prompt =
      '<system-reminder>\nThis turn was already running when the host restarted, so it was ' +
      'cut off partway through. Check what you had already done.\n</system-reminder>\n\ncarry on';
    expect(extractSystemContext(prompt)).toEqual([
      {
        source: 'patch',
        label: 'Turn interrupted by restart',
        text: expect.stringContaining('cut off partway through'),
      },
    ]);
  });

  it('distinguishes the pending-decision restart reminder from the plain one', () => {
    const prompt =
      '<system-reminder>\nThis turn was already running when the host restarted, so it was ' +
      'cut off partway through. Before the restart it had asked: proceed?, and was waiting for ' +
      'an answer — no answer was recorded.\n</system-reminder>\n\ncarry on';
    const [item] = extractSystemContext(prompt);
    expect(item?.label).toBe('Turn interrupted by restart (pending decision)');
  });

  it('distinguishes a todo-list-edit reminder from a todo-fire reminder', () => {
    const edited =
      "<system-reminder>\nThe user edited this chat's task list. It is now, in order:\n" +
      '1. [pending] "rebuild the index"\n</system-reminder>\n\ncarry on';
    expect(extractSystemContext(edited)[0]?.label).toBe('Todo list updated');

    const fired =
      "<system-reminder>\nThis turn was fired from this chat's task list, from the item " +
      '"rebuild the index" — an item on your own TodoWrite list.\n</system-reminder>\n\n[todo] rebuild the index';
    expect(extractSystemContext(fired)[0]?.label).toBe('Todo item fired');
  });

  it('captures a broadcast digest with its label', () => {
    const prompt =
      '<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- hi\n' +
      '</system-reminder>\n\nwhat happened?';
    expect(extractSystemContext(prompt)[0]?.label).toBe('Broadcast digest');
  });

  it('captures more than one leading block, in order', () => {
    const prompt =
      '<system-reminder>\nRecent broadcasts delivered on this thread (newest last):\n- hi\n' +
      "</system-reminder>\n\n<system-reminder>\nThe user edited this chat's task list. It is now, " +
      'in order:\n1. [pending] "x"\n</system-reminder>\n\ncarry on';
    const items = extractSystemContext(prompt);
    expect(items.map((i) => i.label)).toEqual(['Broadcast digest', 'Todo list updated']);
  });

  it('falls back to a generic label for an unrecognised leading block', () => {
    const prompt = '<system-reminder>\nsomething neither builder wrote\n</system-reminder>\n\nhi';
    expect(extractSystemContext(prompt)[0]?.label).toBe('System context');
  });

  it('does not capture a literal tag the user typed mid-message', () => {
    expect(extractSystemContext('please explain <system-reminder>tags</system-reminder>')).toEqual(
      [],
    );
  });
});

// jsonlLineToWire is the REPLAY-path twin of the live emission in chatRunner —
// both funnel through sanitizeCommandTextWithContext, so a reminder captured
// live must replay back out the same way (spec/02 § System-reminder
// disclosure).
describe('jsonlLineToWire attaches systemContext on replay', () => {
  const userLine = (text: string): string =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });

  it('attaches systemContext when the persisted turn carried a reminder', () => {
    const line = userLine(
      '<system-reminder>\nThis turn was already running when the host restarted, so it was ' +
        'cut off partway through.\n</system-reminder>\n\ncarry on',
    );
    const [event] = jsonlLineToWire(line, 'c1', 0);
    expect(event && 'systemContext' in event ? event.systemContext : undefined).toEqual([
      { source: 'patch', label: 'Turn interrupted by restart', text: expect.any(String) },
    ]);
    expect(event && 'content' in event ? event.content : undefined).toBe('carry on');
  });

  it('omits systemContext entirely for an ordinary turn (no empty array on the wire)', () => {
    const [event] = jsonlLineToWire(userLine('hello'), 'c1', 0);
    expect(event && 'systemContext' in event).toBe(false);
  });
});

// spec/14 § Messages — the per-message meta strip's real time. `chat.message`
// carries a `createdAt` on replay ONLY when the transcript line itself named
// one (Claude Code's own `timestamp`), never invented — see `entryTimestamp`.
describe('history reader — createdAt (spec/14 § Messages)', () => {
  it("reads a real creation time off the transcript line's own `timestamp`", () => {
    const a = jsonlLineToWire(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2024-03-01T14:32:00.000Z',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
      'c1',
      0,
    );
    expect(a).toEqual([
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'hi',
        seq: 0,
        createdAt: Date.parse('2024-03-01T14:32:00.000Z'),
      },
    ]);
  });

  it('omits createdAt entirely when the line carries no timestamp — never invents one', () => {
    const a = jsonlLineToWire(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      'c1',
      0,
    );
    expect(a[0]).not.toHaveProperty('createdAt');
  });

  it('omits createdAt for an unparseable timestamp rather than emitting NaN', () => {
    const a = jsonlLineToWire(
      JSON.stringify({
        type: 'assistant',
        timestamp: 'not-a-date',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
      'c1',
      0,
    );
    expect(a[0]).not.toHaveProperty('createdAt');
  });

  it('carries createdAt onto every block a single line expands to', () => {
    const events = jsonlLineToWire(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2024-03-01T14:32:00.000Z',
        message: {
          content: [
            { type: 'text', text: "I'll read it." },
            { type: 'tool_use', id: 'call-1', name: 'Read', input: {} },
          ],
        },
      }),
      'c1',
      5,
    );
    // The text block is a chat.message and carries createdAt; the tool_call
    // carries the same instant as `startedAt`, so a replayed running call is
    // timed from when it began, not from when the chat was reopened.
    expect(events[0]).toMatchObject({
      type: 'chat.message',
      createdAt: Date.parse('2024-03-01T14:32:00.000Z'),
    });
    expect(events[1]).toEqual({
      type: 'chat.tool_call',
      chatId: 'c1',
      tool: 'Read',
      args: {},
      callId: 'call-1',
      seq: 6,
      startedAt: Date.parse('2024-03-01T14:32:00.000Z'),
    });
  });

  it('carries createdAt onto a compaction-boundary system message', () => {
    const events = jsonlLineToWire(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2024-03-01T14:32:00.000Z',
        compactMetadata: { trigger: 'manual', preTokens: 100 },
      }),
      'c1',
      0,
    );
    expect(events[0]).toMatchObject({
      type: 'chat.message',
      role: 'system',
      createdAt: Date.parse('2024-03-01T14:32:00.000Z'),
    });
  });
});
