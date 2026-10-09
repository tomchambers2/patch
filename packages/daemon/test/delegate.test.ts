// patch_delegate — the durable subagent primitive (spec/06 § Cross-chat
// tools, spec/02 § Native subagent dispatch). Exercises the Daemon-level API
// (`createDelegate`/`listDelegates`/`stopDelegate`) directly, the same way
// cross-chat-tools.test.ts exercises patch_spawn/patch_watch, since a
// delegate is built into chatRunner.ts rather than a separate scheduler
// class: it IS an ordinary chat, carrying `meta.subagent`, so restart-resume
// and parallelism fall out of the ordinary chat machinery rather than being
// delegate-specific code paths worth re-testing here (see the "restart"
// describe block below for what that leaves to verify directly).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-delegate-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    discoverClaudeMcpServers: () => [],
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

async function flushUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function messagesOn(events: WireEvent[], chatId: string) {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
      e.type === 'chat.message' && e.chatId === chatId,
  );
}

describe('patch_delegate', () => {
  it("delivers the subagent's FULL final reply to the parent as [from <label>], and is never on the wire itself", async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    const fullReply =
      'Here is the full multi-sentence result of the research task, which must arrive ' +
      'unabridged — every word of it, not a summary.';
    sdk.enqueue([{ type: 'assistant', content: fullReply }, { type: 'result' }]);

    const { id, label } = await daemon.createDelegate({
      parentChatId,
      prompt: 'Research the thing and report back in full',
    });
    expect(id).not.toBe(parentChatId);

    await flushUntil(() =>
      messagesOn(events, parentChatId).some(
        (m) => m.role === 'user' && m.content.includes(fullReply),
      ),
    );

    const delivered = messagesOn(events, parentChatId).find((m) => m.content.includes(fullReply))!;
    expect(delivered.content).toBe(`[from ${label}] ${fullReply}`);

    // Invisible to the user: NOTHING for the subagent's own chatId ever
    // reached the outbound relay — no chat.spawned, no chat.state, no
    // chat.message, nothing (spec/02 § Native subagent dispatch).
    expect(events.some((e) => (e as { chatId?: string }).chatId === id)).toBe(false);

    const delegates = daemon.listDelegates(parentChatId);
    expect(delegates).toHaveLength(1);
    expect(delegates[0]).toMatchObject({ id, label, status: 'done' });
  });

  it('isSubagent is true for a delegate chat (live or finished) and false for ordinary and unknown chats', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'done' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'Do a thing' });
    expect(daemon.isSubagent(id)).toBe(true);
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('done')),
    );
    expect(daemon.isSubagent(id)).toBe(true);
    expect(daemon.isSubagent(parentChatId)).toBe(false);
    expect(daemon.isSubagent('pending-spawn')).toBe(false);
  });

  it('delivers an unrecoverable turn failure as a FAILED message, never silently', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-fail-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-fail-folder-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    const failing: SdkBackend = {
      async *run(): AsyncIterable<never> {
        throw new Error('session not found'); // terminal, non-retrying (isSessionInvalid)
      },
    };
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: failing,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `fail-${++n}`;
      })(),
      discoverClaudeMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });

    const { id, label } = await daemon.createDelegate({
      parentChatId,
      prompt: 'this will fail',
    });

    await flushUntil(() =>
      messagesOn(events, parentChatId).some(
        (m) => m.role === 'user' && m.content.includes('FAILED'),
      ),
    );
    const delivered = messagesOn(events, parentChatId).find((m) => m.content.includes('FAILED'))!;
    expect(delivered.content).toContain(`[from ${label}]`);
    expect(delivered.content).toContain('FAILED');

    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'failed' }),
    ]);
  });

  it('runs several delegates from the same parent in parallel, each delivering independently', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'result one' }, { type: 'result' }]);
    sdk.enqueue([{ type: 'assistant', content: 'result two' }, { type: 'result' }]);

    const [a, b] = await Promise.all([
      daemon.createDelegate({ parentChatId, prompt: 'task A' }),
      daemon.createDelegate({ parentChatId, prompt: 'task B' }),
    ]);
    expect(a.id).not.toBe(b.id);

    await flushUntil(
      () =>
        messagesOn(events, parentChatId).some((m) => m.content.includes('result one')) &&
        messagesOn(events, parentChatId).some((m) => m.content.includes('result two')),
    );

    const statuses = daemon.listDelegates(parentChatId).map((d) => d.status);
    expect(statuses).toEqual(['done', 'done']);
  });

  /** A backend whose run() hangs until the turn is aborted — deterministically
   *  "running" for as long as the test needs, no timing race against the mock's
   *  normal (near-instant) completion. */
  function hangingBackend(): SdkBackend {
    return {
      async *run(opts): AsyncIterable<never> {
        await new Promise<void>((_resolve, reject) => {
          opts.abortController.signal.addEventListener(
            'abort',
            () => {
              const e = new Error('Request was aborted');
              e.name = 'AbortError';
              reject(e);
            },
            { once: true },
          );
        });
      },
    };
  }

  function setupHanging() {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-hang-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-hang-folder-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: hangingBackend(),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `hang-${++n}`;
      })(),
      discoverClaudeMcpServers: () => [],
    });
    return { daemon, events, folder };
  }

  it('patch_delegate_stop stops a running subagent and delivers nothing for it', async () => {
    const { daemon, events, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });

    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    // Allow the in-flight SDK run to actually reach the hanging backend's
    // await before stopping it, same as chatRunner.test.ts's "allow the
    // in-flight SDK run to flush" — otherwise stopChat's `aborters.get`
    // check can race the fire-and-forget prompt kickoff.
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.listDelegates(parentChatId)[0]?.status).toBe('running');

    const stopped = await daemon.stopDelegate(parentChatId, id);
    expect(stopped).toBe(true);

    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'stopped' }),
    ]);
    // A stop is never reported as a result — the caller already knows.
    expect(messagesOn(events, parentChatId)).toHaveLength(0);

    // A second stop is a no-op, not an error (mirrors patch_watch_stop).
    expect(await daemon.stopDelegate(parentChatId, id)).toBe(false);
  });

  it("stopping a parent aborts the parent's own turn at once, not after its subagents settle", async () => {
    const aborted = new Map<string, number>();
    const backend: SdkBackend = {
      async *run(opts): AsyncIterable<never> {
        const id = String(opts.chatId);
        await new Promise<void>((_resolve, reject) => {
          opts.abortController.signal.addEventListener(
            'abort',
            () => {
              aborted.set(id, Date.now());
              // The subagent is slow to wind down; the parent is not.
              const settle = (): void => {
                const e = new Error('Request was aborted');
                e.name = 'AbortError';
                reject(e);
              };
              if (id === 'hang-1') settle();
              else setTimeout(settle, 400);
            },
            { once: true },
          );
        });
      },
    };
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-fast-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-fast-folder-')));
    let n = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `hang-${++n}`,
      discoverClaudeMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId: parentChatId, message: 'go', localId: 'L1' });
    await daemon.createDelegate({ parentChatId, prompt: 'a slow task' });
    await new Promise((r) => setTimeout(r, 20));

    const t0 = Date.now();
    const stopping = daemon.stopChat(parentChatId);
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted.has(parentChatId)).toBe(true);
    expect(aborted.get(parentChatId)! - t0).toBeLessThan(100);
    await stopping;
  });

  it("a chat cannot stop another chat's delegate", async () => {
    const { daemon, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const strangerChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'task' });
    await new Promise((r) => setTimeout(r, 20));

    expect(await daemon.stopDelegate(strangerChatId, id)).toBe(false);
    expect(daemon.listDelegates(parentChatId)[0]?.status).toBe('running');

    await daemon.stopDelegate(parentChatId, id); // clean up the hung turn
  });

  it('archiving the parent stops its still-running subagents', async () => {
    const { daemon, folder } = setupHanging();
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'task' });
    await new Promise((r) => setTimeout(r, 20));

    await daemon.setArchived(parentChatId, true);

    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'stopped' }),
    ]);
  });

  it('a finished delegate is unaffected by a later archive/stop of its parent', async () => {
    const { daemon, sdk, events, folder } = setup();
    const parentChatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'done already' }, { type: 'result' }]);
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'quick task' });
    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('done already')),
    );

    await daemon.setArchived(parentChatId, true);
    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'done' }),
    ]);
  });

  it("disables the user-facing tools for a subagent's turn, on top of the user's own toggles", async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-tools-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-tools-folder-')));
    mkdirSync(folder, { recursive: true });
    const disabledByChatId = new Map<string, string[] | undefined>();
    const capturingBackend: SdkBackend = {
      async *run(opts) {
        disabledByChatId.set(opts.chatId ?? '', opts.disabledTools);
        yield { type: 'assistant', content: 'ok' };
        yield { type: 'result' };
      },
    };
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: capturingBackend,
      oauthAccessToken: 'tok',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `tools-${++n}`;
      })(),
      discoverClaudeMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'task' });
    await new Promise((r) => setTimeout(r, 20));

    expect(disabledByChatId.get(id)).toEqual(
      expect.arrayContaining([
        'mcp__patch__patch_notify',
        'mcp__patch__patch_report',
        'mcp__patch__patch_call',
        'mcp__patch__patch_speak',
        'mcp__patch__patch_ask_human',
        'mcp__patch__patch_artifact',
      ]),
    );
  });

  it("surfaces a subagent's AskUserQuestion on the parent, labelled, and routes the answer back to unblock it", async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-ask-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-ask-folder-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    const askingBackend: SdkBackend = {
      async *run(opts) {
        const decision = await opts.onPermissionRequest!({
          tool: 'AskUserQuestion',
          args: { question: 'Which approach?' },
          description: 'Which approach should I take?',
        });
        yield { type: 'assistant', content: decision.approve ? 'took approach A' : 'gave up' };
        yield { type: 'result' };
      },
    };
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: askingBackend,
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: (() => {
        let n = 0;
        return () => `ask-${++n}`;
      })(),
      discoverClaudeMcpServers: () => [],
    });
    const parentChatId = await daemon.spawnChat({ folder });
    const { id, label } = await daemon.createDelegate({ parentChatId, prompt: 'pick an approach' });

    // The mirrored card appears on the PARENT — labelled with the subagent's
    // name — not on the subagent's own (invisible) chatId.
    const mirrored = await (async () => {
      await flushUntil(() =>
        events.some((e) => e.type === 'chat.permission_request' && e.chatId === parentChatId),
      );
      return events.find(
        (e): e is Extract<WireEvent, { type: 'chat.permission_request' }> =>
          e.type === 'chat.permission_request' && e.chatId === parentChatId,
      )!;
    })();
    expect(mirrored.request.tool).toBe('AskUserQuestion');
    expect(mirrored.request.description).toContain(label);
    expect(events.some((e) => e.type === 'chat.permission_request' && e.chatId === id)).toBe(false);
    expect(daemon.chatState.get(parentChatId)?.activity).toBe('awaiting-permission');

    // Answering the mirrored card (by requestId alone, exactly how a real
    // surface answers any permission card) unblocks the REAL subagent turn.
    daemon.submitPermissionResponse({ requestId: mirrored.requestId, decision: 'approve' });

    await flushUntil(() =>
      messagesOn(events, parentChatId).some((m) => m.content.includes('took approach A')),
    );
    expect(
      events.some((e) => e.type === 'chat.permission_response' && e.chatId === parentChatId),
    ).toBe(true);
    expect(daemon.listDelegates(parentChatId)[0]).toMatchObject({ id, status: 'done' });
  });

  describe('Task/Agent semantics — wait, capabilities, stay alive', () => {
    it('wait: true hands the final reply back inline and does NOT also deliver it as a [from] turn', async () => {
      const { daemon, sdk, events, folder } = setup();
      const parentChatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'the inline answer' }, { type: 'result' }]);
      const res = await daemon.createDelegate({ parentChatId, prompt: 'do it', wait: true });
      expect(res.result).toBeDefined();
      const settled = await res.result!;
      expect(settled).toEqual({ status: 'done', reply: 'the inline answer' });
      await new Promise((r) => setTimeout(r, 50));
      expect(
        messagesOn(events, parentChatId).some(
          (m) => m.role === 'user' && m.content.includes('[from '),
        ),
      ).toBe(false);
    });

    it('wait: true reports a failure inline too', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-delegate-waitfail-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-waitfail-f-')));
      const failing: SdkBackend = {
        async *run(): AsyncIterable<never> {
          throw new Error('session not found');
        },
      };
      let n = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: failing,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `wf-${++n}`,
        discoverClaudeMcpServers: () => [],
      });
      const parentChatId = await daemon.spawnChat({ folder });
      const res = await daemon.createDelegate({ parentChatId, prompt: 'x', wait: true });
      const settled = await res.result!;
      expect(settled.status).toBe('failed');
      expect(settled.reply).toContain('FAILED');
    });

    it("disallowedTools are the subagent's capability limits, on top of the always-disabled set", async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-delegate-caps-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-caps-folder-')));
      const seen = new Map<string, string[] | undefined>();
      const backend: SdkBackend = {
        async *run(opts) {
          seen.set(opts.chatId ?? '', opts.disabledTools);
          yield { type: 'assistant', content: 'ok' };
          yield { type: 'result' };
        },
      };
      let n = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `caps-${++n}`,
        discoverClaudeMcpServers: () => [],
      });
      const parentChatId = await daemon.spawnChat({ folder });
      const { id } = await daemon.createDelegate({
        parentChatId,
        prompt: 'task',
        disallowedTools: ['Bash', 'Write'],
      });
      await flushUntil(() => seen.has(id));
      expect(seen.get(id)).toEqual(
        expect.arrayContaining(['Bash', 'Write', 'mcp__patch__patch_notify']),
      );
    });

    it('sendToDelegate re-arms a finished subagent, keeps its context, and returns the next reply', async () => {
      const { daemon, sdk, folder } = setup();
      const parentChatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'first' }, { type: 'result' }]);
      const first = await daemon.createDelegate({ parentChatId, prompt: 'start', wait: true });
      expect((await first.result!).reply).toBe('first');
      expect(daemon.listDelegates(parentChatId)[0]!.status).toBe('done');

      sdk.enqueue([{ type: 'assistant', content: 'second' }, { type: 'result' }]);
      const next = await daemon.sendToDelegate({
        parentChatId,
        id: first.id,
        message: 'and now this',
        wait: true,
      });
      expect(await next.result!).toEqual({ status: 'done', reply: 'second' });
      expect(daemon.listDelegates(parentChatId)).toHaveLength(1);
    });

    it("sendToDelegate refuses another chat's subagent and a non-subagent", async () => {
      const { daemon, folder } = setup();
      const a = await daemon.spawnChat({ folder });
      const b = await daemon.spawnChat({ folder });
      const { id } = await daemon.createDelegate({ parentChatId: a, prompt: 'x' });
      await expect(daemon.sendToDelegate({ parentChatId: b, id, message: 'hi' })).rejects.toThrow(
        /not a subagent/,
      );
      await expect(
        daemon.sendToDelegate({ parentChatId: a, id: b, message: 'hi' }),
      ).rejects.toThrow(/not a subagent/);
    });
  });
});
