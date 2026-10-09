// spec/14 § File browser — live updates: the THIRD `patch.file_changed`
// broadcast site (the other two are `Daemon.writeFile` and `Daemon.fileOp`,
// covered in file-write.test.ts / file-op.test.ts) — a completed agent
// Edit/Write/NotebookEdit tool call. The host records which path a call is
// ABOUT at `tool_use` time (the matching `tool_result` carries only a callId
// + return value, never the args back), then broadcasts once that call's
// result lands successfully.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-fctb-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-fctb-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder };
}

function fileChanged(
  events: WireEvent[],
): Array<Extract<WireEvent, { type: 'patch.file_changed' }>> {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'patch.file_changed' }> => e.type === 'patch.file_changed',
  );
}

describe('patch.file_changed broadcast — completed Edit/Write/NotebookEdit tool calls', () => {
  it('fires once a completed Edit call lands, with the path relative to the chat folder', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: "I'll fix the typo." },
      {
        type: 'tool_use',
        tool: {
          name: 'Edit',
          args: { file_path: join(folder, 'src', 'a.ts'), old_string: 'foo', new_string: 'bar' },
          callId: 'c1',
        },
      },
      { type: 'tool_result', toolResult: { name: 'Edit', callId: 'c1', result: 'ok' } },
      { type: 'result', sessionId: 'sess-edit' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const changed = fileChanged(events);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.path).toBe('src/a.ts');
  });

  it('fires for a completed Write call', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'Creating the file.' },
      {
        type: 'tool_use',
        tool: {
          name: 'Write',
          args: { file_path: join(folder, 'new.txt'), content: 'hello' },
          callId: 'c2',
        },
      },
      { type: 'tool_result', toolResult: { name: 'Write', callId: 'c2', result: 'ok' } },
      { type: 'result', sessionId: 'sess-write' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    expect(fileChanged(events)).toEqual([
      expect.objectContaining({ type: 'patch.file_changed', path: 'new.txt' }),
    ]);
  });

  it('fires for a completed NotebookEdit call, reading notebook_path', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'Editing the notebook.' },
      {
        type: 'tool_use',
        tool: {
          name: 'NotebookEdit',
          args: {
            notebook_path: join(folder, 'analysis.ipynb'),
            old_source: 'x = 1',
            new_source: 'x = 2',
          },
          callId: 'c3',
        },
      },
      { type: 'tool_result', toolResult: { name: 'NotebookEdit', callId: 'c3', result: 'ok' } },
      { type: 'result', sessionId: 'sess-nb' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    expect(fileChanged(events)).toEqual([
      expect.objectContaining({ type: 'patch.file_changed', path: 'analysis.ipynb' }),
    ]);
  });

  it('does NOT fire when the tool call errored — it never actually touched disk', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'Trying to edit.' },
      {
        type: 'tool_use',
        tool: {
          name: 'Edit',
          args: { file_path: join(folder, 'missing.ts'), old_string: 'a', new_string: 'b' },
          callId: 'c4',
        },
      },
      {
        type: 'tool_result',
        toolResult: { name: 'Edit', callId: 'c4', result: 'no such file', isError: true },
      },
      { type: 'result', sessionId: 'sess-err' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    expect(fileChanged(events)).toEqual([]);
  });

  it('does NOT fire for an unrelated tool (Read) even on success', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'Reading.' },
      {
        type: 'tool_use',
        tool: { name: 'Read', args: { file_path: join(folder, 'a.ts') }, callId: 'c5' },
      },
      { type: 'tool_result', toolResult: { name: 'Read', callId: 'c5', result: 'contents' } },
      { type: 'result', sessionId: 'sess-read' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    expect(fileChanged(events)).toEqual([]);
  });

  it('does NOT fire when the edited path is outside the chat folder', async () => {
    const { daemon, sdk, events, folder } = setup();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'patch-fctb-outside-')));
    sdk.enqueue([
      { type: 'assistant', content: 'Editing something elsewhere.' },
      {
        type: 'tool_use',
        tool: {
          name: 'Edit',
          args: { file_path: join(outside, 'x.ts'), old_string: 'a', new_string: 'b' },
          callId: 'c6',
        },
      },
      { type: 'tool_result', toolResult: { name: 'Edit', callId: 'c6', result: 'ok' } },
      { type: 'result', sessionId: 'sess-outside' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    expect(fileChanged(events)).toEqual([]);
  });
});
