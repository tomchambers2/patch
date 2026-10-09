// spec/14 § Tool runs — the host labels each closed run of tool calls. A run
// is what a surface collapses: consecutive groupable calls, cut by prose, by a
// call that keeps its own row (an edit), and by the end of the turn. Only runs
// of more than one call are summarised, and a failure is stamped, not hidden.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatToolRunSummaryEvent, WireEvent } from '@patch/wire';
import { Daemon, type DaemonOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';
import {
  buildToolRunPrompt,
  parseToolRunSummary,
  makeToolRunSummarizer,
} from '../src/toolRunGen.js';

const silent = pino({ level: 'silent' });

type SummarizeInput = Parameters<NonNullable<DaemonOptions['summarizeToolRun']>>[0];

function setup(summarize: (input: SummarizeInput) => Promise<string>) {
  const home = mkdtempSync(join(tmpdir(), 'patch-trs-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-trs-folder-')));
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const asked: SummarizeInput[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => 'chat-1',
    discoverClaudeMcpServers: () => [],
    summarizeToolRun: async (input) => {
      asked.push(input);
      return await summarize(input);
    },
  });
  return { daemon, sdk, events, folder, asked };
}

const call = (callId: string, name: string, args: unknown = {}): SdkEnvelope => ({
  type: 'tool_use',
  tool: { name, args, callId },
});
const result = (callId: string, name: string): SdkEnvelope => ({
  type: 'tool_result',
  toolResult: { name, callId, result: 'ok' },
});

const settle = () => new Promise((r) => setTimeout(r, 40));
const summaries = (events: WireEvent[]) =>
  events.filter((e): e is ChatToolRunSummaryEvent => e.type === 'chat.tool_run_summary');

describe('tool run summaries', () => {
  it('labels each closed run of 2+ calls, keyed by its call ids, with the prose around it', async () => {
    const { daemon, sdk, events, folder, asked } = setup(async (i) =>
      i.calls.length === 2 ? 'Found the poller' : 'Ran the suite',
    );
    sdk.enqueue([
      { type: 'assistant', content: 'Looking at the poller.' },
      call('a', 'Grep', { pattern: 'poll' }),
      call('b', 'Read', { file_path: '/x/poll.ts' }),
      result('a', 'Grep'),
      result('b', 'Read'),
      { type: 'assistant', content: 'Now the tests.' },
      call('c', 'Bash', { command: 'pnpm test' }),
      result('c', 'Bash'),
      call('d', 'Bash', { command: 'pnpm lint' }),
      result('d', 'Bash'),
      call('e', 'Bash', { command: 'pnpm build' }),
      result('e', 'Bash'),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'tidy the poller' });
    await settle();

    const got = summaries(events);
    expect(got.map((s) => [s.callIds, s.summary])).toEqual([
      [['a', 'b'], 'Found the poller'],
      [['c', 'd', 'e'], 'Ran the suite'],
    ]);
    expect(asked[0]).toMatchObject({
      userMessage: 'tidy the poller',
      assistantBefore: 'Looking at the poller.',
      calls: [
        { tool: 'Grep', args: { pattern: 'poll' } },
        { tool: 'Read', args: { file_path: '/x/poll.ts' } },
      ],
    });
    // The last run closed on the END of the turn, not on a following message.
    expect(asked[1]?.assistantBefore).toBe('Now the tests.');
    // Each summary has its own seq, after everything it labels.
    const callSeqs = events.filter((e) => e.type === 'chat.tool_call').map((e) => e.seq);
    for (const s of got) expect(s.seq).toBeGreaterThan(Math.min(...callSeqs));
  });

  it('tells the summariser which calls failed and why, so the label cannot claim they worked', async () => {
    const { daemon, sdk, asked } = setup(async () => 'Tried to file a ticket');
    sdk.enqueue([
      call('a', 'Bash', { command: 'jira create' }),
      {
        type: 'tool_result',
        toolResult: { name: 'Bash', callId: 'a', result: 'HTTP 400 bad request', isError: true },
      },
      call('b', 'Bash', { command: 'jira create --retry' }),
      { type: 'tool_result', toolResult: { name: 'Bash', callId: 'b', result: 'ok' } },
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({
      folder: realpathSync(mkdtempSync(join(tmpdir(), 'patch-trs-f-'))),
      prompt: 'go',
    });
    await settle();
    expect(asked[0]?.calls).toEqual([
      expect.objectContaining({ tool: 'Bash', failed: true, outcome: 'HTTP 400 bad request' }),
      expect.objectContaining({ tool: 'Bash', failed: false }),
    ]);
  });

  it('never summarises a lone call, and an edit splits a run the way a surface draws it', async () => {
    const { daemon, sdk, events, folder, asked } = setup(async () => 'x');
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      result('a', 'Read'),
      call('e', 'Edit', { file_path: 'a.ts', old_string: '1', new_string: '2' }),
      result('e', 'Edit'),
      call('b', 'Bash', { command: 'pnpm test' }),
      result('b', 'Bash'),
      call('c', 'Read', { file_path: 'b.ts' }),
      result('c', 'Read'),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    expect(asked).toHaveLength(1);
    expect(summaries(events).map((s) => s.callIds)).toEqual([['b', 'c']]);
  });

  it('stamps a failure with its reason rather than leaving the run silently unlabelled', async () => {
    const { daemon, sdk, events, folder } = setup(async () => {
      throw new Error('no Claude account with credit could answer');
    });
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      call('b', 'Read', { file_path: 'b.ts' }),
      result('a', 'Read'),
      result('b', 'Read'),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    expect(summaries(events)).toEqual([
      expect.objectContaining({
        callIds: ['a', 'b'],
        summary: null,
        error: 'no Claude account with credit could answer',
      }),
    ]);
  });

  it('keeps summaries in history, so a replay brings them back', async () => {
    const { daemon, sdk, folder } = setup(async () => 'Read both files');
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      call('b', 'Read', { file_path: 'b.ts' }),
      result('a', 'Read'),
      result('b', 'Read'),
      { type: 'result', sessionId: 's1' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (e) => replayed.push(e));
    await settle();
    expect(summaries(replayed).map((s) => [s.callIds, s.summary])).toEqual([
      [['a', 'b'], 'Read both files'],
    ]);
  });
});

describe('toolRunGen', () => {
  it('asks for the purpose of the batch, with the calls and the prose around them', () => {
    const prompt = buildToolRunPrompt({
      chatId: 'c',
      folder: '/f',
      userMessage: 'why is the deploy stuck',
      assistantBefore: 'Checking the lock.',
      calls: [{ tool: 'Bash', args: { command: 'cat deploy.lock', description: 'Read the lock' } }],
    });
    expect(prompt).toContain('why is the deploy stuck');
    expect(prompt).toContain('Checking the lock.');
    expect(prompt).toContain('- Bash {"command":"cat deploy.lock","description":"Read the lock"}');
  });

  it('marks failed calls in the prompt and tells the model not to claim they succeeded', () => {
    const prompt = buildToolRunPrompt({
      chatId: 'c',
      folder: '/f',
      userMessage: 'file a ticket',
      assistantBefore: '',
      calls: [
        { tool: 'Bash', args: { command: 'jira create' }, failed: true, outcome: 'HTTP 400' },
        { tool: 'Bash', args: { command: 'ls' }, failed: false },
      ],
    });
    expect(prompt).toContain('- Bash {"command":"jira create"} [FAILED: HTTP 400]');
    expect(prompt).toContain('- Bash {"command":"ls"}\n');
    expect(prompt).toMatch(/never say a failed call succeeded/i);
  });

  it('keeps the first line, without quotes, markdown or a trailing full stop', () => {
    expect(parseToolRunSummary('"Set up the project locally."\nBecause…')).toBe(
      'Set up the project locally',
    );
    expect(parseToolRunSummary('**Checked the deploy lock**')).toBe('Checked the deploy lock');
    expect(parseToolRunSummary('  \n ')).toBeNull();
  });

  it('throws when no account can answer, instead of returning nothing', async () => {
    const gen = makeToolRunSummarizer({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: async () => null,
    });
    await expect(
      gen({ chatId: 'c', folder: '/f', userMessage: '', assistantBefore: '', calls: [] }),
    ).rejects.toThrow('no Claude account with credit could answer');
  });

  it('returns the model reply through the account gate', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'Searched the web for Haiku pricing' }]);
    const gen = makeToolRunSummarizer({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_label, run) => await run('tok'),
    });
    await expect(
      gen({ chatId: 'c', folder: '/f', userMessage: '', assistantBefore: '', calls: [] }),
    ).resolves.toBe('Searched the web for Haiku pricing');
  });
});
