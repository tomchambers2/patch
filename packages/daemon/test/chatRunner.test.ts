// SDK lifecycle test: feed canned envelopes through the mock backend and
// assert wire events fan out with correct seq + chat_state mutates.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import {
  Daemon,
  OUT_OF_BAND_SEQ,
  makePreviewSnippet,
  attachmentFileName,
  type DaemonOptions,
} from '../src/chatRunner.js';
import { createMetaStore, type MetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkBackend } from '../src/sdkBackend.js';
import { createHistoryReader, encodeFolder, type HistoryReader } from '../src/history.js';

const silent = pino({ level: 'silent' });

function setup(opts: { onRateLimit?: DaemonOptions['onRateLimit'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-runner-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
  // Ensure folder exists.
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
    // Otherwise defaults to reading the REAL ~/.claude.json / ~/.claude/settings.json
    // of whatever machine runs this suite — a test asserting exact SDK options
    // must not depend on that.
    discoverClaudeMcpServers: () => [],
    ...(opts.onRateLimit ? { onRateLimit: opts.onRateLimit } : {}),
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

describe('Host ChatRunner', () => {
  it('spawnChat creates meta + emits chat.spawned + runs the prompt query', async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-A' },
      { type: 'assistant', content: 'hi there', sessionId: 'sess-A' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
    // Allow the in-flight SDK run to flush.
    await new Promise((r) => setTimeout(r, 20));

    expect(chatId).toBe('chat-1');
    expect(events[0]).toEqual({ type: 'chat.spawned', daemonId: 'd1', chatId, folder });
    // The user turn is a first-class `chat.message` at its own canonical seq,
    // emitted live at the seq it will replay under; the reply follows it.
    const messages = events.filter((e) => e.type === 'chat.message');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello', seq: 0 });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'hi there', seq: 1 });

    // Meta persisted with claudeSessionId + bumped nextSeq.
    const meta = metaStore.read(chatId);
    expect(meta?.claudeSessionId).toBe('sess-A');
    expect(meta?.nextSeq).toBe(2);

    // chat_state has the message.
    const state = daemon.chatState.get(chatId);
    expect(state?.lastMessages).toHaveLength(1);
    expect(state?.lastMessages[0]?.content).toBe('hi there');
    expect(state?.activity).toBe('idle');
    expect(state?.claudeSessionId).toBe('sess-A');
  });

  // patch/todo.md — "show which model is in use on the top bar": the host
  // already resolves the model at spawn time, so it goes straight onto the
  // `chat.spawned` event itself (no separate server augmentation needed,
  // unlike `jobId`).
  it('spawnChat includes the resolved model on the chat.spawned event when one is named', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([{ type: 'result', sessionId: 'sess-B' }]);
    const chatId = await daemon.spawnChat({ folder, model: 'claude-x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(events[0]).toEqual({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId,
      folder,
      model: 'claude-x',
    });
  });

  // No model catalogue support / no model named — the field is omitted
  // entirely rather than sent as null (spec/04 § Spawn back-compat).
  it('spawnChat omits model on the chat.spawned event when none was resolved', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder });
    expect(events[0]).toEqual({ type: 'chat.spawned', daemonId: 'd1', chatId: 'chat-1', folder });
    expect(events[0]).not.toHaveProperty('model');
  });

  it('spawnChat({ hidden: true }) lands active and hidden (spec/04 § Hidden, spec/08 ## Action)', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, hidden: true });
    const meta = metaStore.read(chatId);
    // Never archived: archived means stopped, and a spawn exists to run.
    expect(meta?.status).toBe('active');
    expect(meta?.hidden).toBe(true);
    const state = daemon.chatState.get(chatId);
    expect(state?.status).toBe('active');
    expect(state?.hidden).toBe(true);
  });

  it('spawnChat without archived flag stays active (user-initiated spawn)', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    expect(metaStore.read(chatId)?.status).toBe('active');
    expect(daemon.chatState.get(chatId)?.status).toBe('active');
  });

  it('seq is per-chat monotonic across multiple emits', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: 'a' },
      { type: 'assistant', content: 'b' },
      { type: 'assistant', content: 'c' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const seqs = events
      .filter((e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId)
      .map((e) => (e as unknown as { seq: number }).seq);
    // seq 0 is the user turn; 1-3 the three assistant messages.
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it('streams assistant_delta envelopes as chat.message_delta then a final chat.message at the SAME seq', async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    // The real SDK under includePartialMessages emits text_delta partials
    // (here as assistant_delta) ahead of the turn's final assistant message.
    sdk.enqueue([
      { type: 'assistant_delta', content: 'The ' },
      { type: 'assistant_delta', content: 'cat ' },
      { type: 'assistant_delta', content: 'sat.' },
      { type: 'assistant', content: 'The cat sat.', sessionId: 'sess-S' },
      { type: 'result', sessionId: 'sess-S' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const deltas = events.filter(
      (e) => e.type === 'chat.message_delta' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ delta: string; messageSeq: number }>;
    // Three progressive chunks fanned out, in order.
    expect(deltas.map((d) => d.delta)).toEqual(['The ', 'cat ', 'sat.']);
    // All reference the SAME reserved messageSeq (seq 1 here — seq 0 is the
    // user turn), which is the seq the finalising chat.message carries.
    expect(deltas.every((d) => d.messageSeq === 1)).toBe(true);
    // Concatenated deltas reproduce the final text exactly.
    expect(deltas.map((d) => d.delta).join('')).toBe('The cat sat.');

    // Exactly ONE durable chat.message, at the SAME seq the deltas reserved —
    // no double-render and no wasted seq.
    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ content: string; seq: number; role: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'The cat sat.', seq: 1 });

    // Deltas are live-only: they carry no seq and were not persisted. Only the
    // user turn and the final message advanced nextSeq (0 -> 2).
    expect(metaStore.read(chatId)?.nextSeq).toBe(2);
    expect(daemon.chatState.get(chatId)?.lastMessages).toHaveLength(1);
  });

  it('empty assistant_delta chunks never reserve a seq', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant_delta', content: '' },
      { type: 'assistant', content: 'done', sessionId: 'sess-E' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    expect(
      events.filter(
        (e) => e.type === 'chat.message_delta' && (e as { chatId: string }).chatId === chatId,
      ),
    ).toHaveLength(0);
    const messages = events.filter(
      (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
    ) as unknown as Array<{ seq: number }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.seq).toBe(1);
  });

  it('translates tool_use + tool_result envelopes into chat.tool_call / chat.tool_result', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: "I'll read the file." },
      { type: 'tool_use', tool: { name: 'Read', args: { file_path: 'a.ts' }, callId: 'c1' } },
      { type: 'tool_result', toolResult: { name: 'Read', callId: 'c1', result: 'contents' } },
      { type: 'result', sessionId: 'sess-tool' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const call = events.find((e) => e.type === 'chat.tool_call') as
      | { tool: string; args: unknown; callId: string }
      | undefined;
    expect(call).toMatchObject({ tool: 'Read', args: { file_path: 'a.ts' }, callId: 'c1' });
    const result = events.find((e) => e.type === 'chat.tool_result') as
      | { tool: string; callId: string; result: unknown }
      | undefined;
    expect(result).toMatchObject({ tool: 'Read', callId: 'c1', result: 'contents' });
  });

  // Todoist: "Patch: render images inline in chat" — Read returning an
  // Anthropic image content block for a photo file must reach the wire event
  // unmodified, or the web surface (`ChatRoute.tsx`'s `imageDataUri`) has
  // nothing to detect. This pins the LIVE path (chatRunner.ts's tool_result
  // translation), distinct from history.ts's replay-reconstruction path.
  it('preserves an image content block in a live tool_result unmodified (not flattened/stringified)', async () => {
    const { daemon, sdk, events, folder } = setup();
    const imageContent = [
      { type: 'text', text: 'photo.png' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZS1wbmc=' },
      },
    ];
    sdk.enqueue([
      { type: 'assistant', content: "I'll look at the photo." },
      { type: 'tool_use', tool: { name: 'Read', args: { file_path: 'photo.png' }, callId: 'c2' } },
      {
        type: 'tool_result',
        toolResult: { name: 'Read', callId: 'c2', result: imageContent },
      },
      { type: 'result', sessionId: 'sess-image' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'look at photo.png' });
    await new Promise((r) => setTimeout(r, 30));

    const result = events.find((e) => e.type === 'chat.tool_result') as
      | { tool: string; callId: string; result: unknown }
      | undefined;
    expect(result?.result).toEqual(imageContent);
  });

  it('translates a permission envelope into chat.permission_request + awaiting-permission', async () => {
    const { daemon, sdk, events, folder } = setup();
    sdk.enqueue([
      { type: 'assistant', content: "I'd like to edit." },
      {
        type: 'permission',
        permission: {
          requestId: 'perm-1',
          tool: 'Edit',
          args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
          description: 'Edit a.ts',
        },
      },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));

    const perm = events.find((e) => e.type === 'chat.permission_request') as
      | { requestId: string; request: { tool: string; proposedDiff?: string } }
      | undefined;
    expect(perm).toBeDefined();
    expect(perm).toMatchObject({ requestId: 'perm-1', request: { tool: 'Edit' } });
    // Edit tool → host attaches a proposed unified diff.
    expect(perm?.request.proposedDiff).toContain('+y');
    // The chat transitioned through awaiting-permission (an emitted chat.state
    // carries that activity) when the permission request arrived mid-stream.
    const awaiting = events.some(
      (e) =>
        e.type === 'chat.state' &&
        (e as { activity?: string }).activity === 'awaiting-permission' &&
        (e as { chatId: string }).chatId === chatId,
    );
    expect(awaiting).toBe(true);
  });

  it('mock dev trigger [[tool]] emits a tool call + result without an enqueued script', async () => {
    const { daemon, sdk, events, folder } = setup();
    void sdk; // no enqueue — exercise the DEFAULT script's dev trigger.
    const toolChatId = await daemon.spawnChat({ folder, prompt: 'please [[tool]] now' });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === 'chat.tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'chat.tool_result')).toBe(true);
    expect(daemon.chatState.get(toolChatId)?.activity).toBe('idle');
  });

  it('mock dev trigger [[permission]] emits a permission request without an enqueued script', async () => {
    const { daemon, sdk, events, folder } = setup();
    void sdk;
    await daemon.spawnChat({ folder, prompt: 'please [[permission]] now' });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(true);
  });

  it('G5-9: injectPermissionRequest + submitPermissionResponse echoes chat.permission_response to surfaces', async () => {
    // The spoken yes/no voice path (and the dev diag seam behind it) resolves
    // the request DAEMON-SIDE — the surface never sent a response, so without an
    // echo the surface's inline card stays pending. Assert submitPermissionResponse
    // emits chat.permission_response carrying the chatId + decision so surfaces
    // can flip the matching inline card (spec/07 ## Permission prompts during voice).
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await new Promise((r) => setTimeout(r, 10));
    const requestId = daemon.injectPermissionRequest(chatId, 'Bash', 'rm -rf build');
    expect(requestId).toBeDefined();
    // Pending request is discoverable for the focused chat (spoken-yes/no lookup).
    expect(daemon.getPendingPermissionForChat(chatId)).toBe(requestId);
    events.length = 0;
    // Spoken "yes" → host resolves it.
    daemon.submitPermissionResponse({ requestId: requestId!, decision: 'approve' });
    const echo = events.find((e) => e.type === 'chat.permission_response');
    expect(echo).toBeDefined();
    expect((echo as { chatId?: string }).chatId).toBe(chatId);
    expect((echo as { requestId?: string }).requestId).toBe(requestId);
    expect((echo as { decision?: string }).decision).toBe('approve');
    expect((echo as { approve?: boolean }).approve).toBe(true);
    // Request is genuinely cleared, not re-surfaced.
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
    // Chat settled out of awaiting-permission.
    const lastState = [...events].reverse().find((e) => e.type === 'chat.state');
    expect((lastState as { activity?: string } | undefined)?.activity).not.toBe(
      'awaiting-permission',
    );
  });

  it('G5-9: a spoken "no" echoes decision:deny / approve:false', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await new Promise((r) => setTimeout(r, 10));
    const requestId = daemon.injectPermissionRequest(chatId, 'Bash', 'rm -rf build')!;
    events.length = 0;
    daemon.submitPermissionResponse({ requestId, decision: 'deny' });
    const echo = events.find((e) => e.type === 'chat.permission_response');
    expect((echo as { decision?: string }).decision).toBe('deny');
    expect((echo as { approve?: boolean }).approve).toBe(false);
  });

  it('sendInput is idempotent on (chatId, localId)', async () => {
    const { daemon, sdk, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'reply' }]);
    await daemon.sendInput({ chatId, message: 'hey', localId: 'L1' });
    // Duplicate localId — should be a no-op (no second SDK script consumed,
    // so the mock backend would throw "no queued script" if we re-ran).
    await daemon.sendInput({ chatId, message: 'hey-again', localId: 'L1' });
    const replies = events.filter(
      (e) => e.type === 'chat.message' && (e as { content: string }).content === 'reply',
    );
    expect(replies).toHaveLength(1);
  });

  // spec/12 § Guaranteed input delivery — the host is the sole idempotency
  // authority and emits a `chat.input_ack` receipt the moment it accepts an
  // input, so the surface can retire its `pending` state (never a silent
  // forever-spinner). Covered here: run-now, queued-behind-a-running-turn, and
  // duplicate-localId redelivery (re-ack WITHOUT re-running).
  it('emits chat.input_ack for the run-now path, before the reply and with no seq', async () => {
    const { daemon, sdk, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'reply' }]);
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1' });

    const ackIdx = events.findIndex(
      (e) => e.type === 'chat.input_ack' && (e as { localId: string }).localId === 'L1',
    );
    const replyIdx = events.findIndex(
      (e) => e.type === 'chat.message' && (e as { content: string }).content === 'reply',
    );
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(events[ackIdx]).toMatchObject({ type: 'chat.input_ack', chatId, localId: 'L1' });
    // Positive receipt precedes any output.
    expect(ackIdx).toBeLessThan(replyIdx);
    // Out-of-band: never carries a per-chat seq (so it is never replayed).
    expect('seq' in (events[ackIdx] as object)).toBe(false);
  });

  it('emits chat.input_ack for a turn QUEUED behind a running turn (both paths acked)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-runner-ackq-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-ackq-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    // A working window so the second input arrives while the first is running
    // and QUEUES behind it rather than running immediately.
    const sdk = createMockSdkBackend({ turnDelayMs: 150 });
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      generateChatId: () => `chat-${++id}`,
    });
    const chatId = await daemon.spawnChat({ folder });
    const p1 = daemon.sendInput({ chatId, message: 'a', localId: 'A' });
    // Let turn A enter its running window before submitting B.
    await new Promise((r) => setTimeout(r, 30));
    const p2 = daemon.sendInput({ chatId, message: 'b', localId: 'B' });
    await Promise.all([p1, p2]);

    // B was queued behind A (type-ahead) AND still got its delivery receipt —
    // the two concepts are distinct: chat.queued is type-ahead; chat.input_ack
    // is the delivery receipt.
    expect(
      events.some((e) => e.type === 'chat.queued' && (e as { localId: string }).localId === 'B'),
    ).toBe(true);
    expect(
      events.some((e) => e.type === 'chat.input_ack' && (e as { localId: string }).localId === 'B'),
    ).toBe(true);
    // A (run-now) is acked too.
    expect(
      events.some((e) => e.type === 'chat.input_ack' && (e as { localId: string }).localId === 'A'),
    ).toBe(true);
    daemon.shutdown();
  });

  it('re-emits chat.input_ack on a duplicate localId WITHOUT running the turn twice', async () => {
    const { daemon, sdk, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    sdk.enqueue([{ type: 'assistant', content: 'reply' }]);
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1' });
    // Redelivery (the surface's pending-timeout retry). Re-acked so the retry
    // resolves, but the turn is NOT re-run.
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L1' });

    const acks = events.filter(
      (e) => e.type === 'chat.input_ack' && (e as { localId: string }).localId === 'L1',
    );
    expect(acks.length).toBe(2); // one receipt per delivery
    const replies = events.filter(
      (e) => e.type === 'chat.message' && (e as { content: string }).content === 'reply',
    );
    expect(replies).toHaveLength(1); // turn ran exactly once
  });

  it('stopChat aborts in-flight query and emits chat.stopped', async () => {
    const { daemon, sdk, events, folder } = setup();
    // Long-ish stream we can interrupt.
    sdk.enqueue([
      { type: 'assistant', content: 'one' },
      { type: 'assistant', content: 'two' },
      { type: 'assistant', content: 'three' },
    ]);
    const chatId = await daemon.spawnChat({ folder });
    // sendInput resolves only when the SDK iterator finishes — race a stop.
    const inputP = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
    await daemon.stopChat(chatId);
    await inputP;
    const stopped = events.find((e) => e.type === 'chat.stopped');
    expect(stopped).toBeDefined();
  });

  it('stopChat on a backend that THROWS on abort settles to idle, not errored (clean user-stop)', async () => {
    // The real Agent SDK iterator throws an AbortError when the query is
    // aborted mid-flight. A user-initiated `patch stop` must NOT leave the
    // chat `errored` or emit a spurious chat.error — it is a clean
    // termination (spec/13 + spec/17). This fake reproduces the real SDK's
    // throw-on-abort behaviour that the mock backend does not.
    const home = mkdtempSync(join(tmpdir(), 'patch-runner-abort-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-abort-')));
    mkdirSync(folder, { recursive: true });
    const events: WireEvent[] = [];
    let id = 0;
    const throwingBackend: SdkBackend = {
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
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: throwingBackend,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
    });
    const chatId = await daemon.spawnChat({ folder });
    const inputP = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
    // Let the query reach 'running' before aborting.
    await new Promise((r) => setTimeout(r, 20));
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');
    await daemon.stopChat(chatId);
    await inputP;

    // Clean stop: chat.stopped emitted, NO chat.error, activity back to idle.
    expect(events.some((e) => e.type === 'chat.stopped')).toBe(true);
    expect(events.some((e) => e.type === 'chat.error')).toBe(false);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(daemon.chatState.get(chatId)?.lastError).toBeNull();
  });

  it('hydrate rebuilds chat_state with status=idle from disk', async () => {
    const { daemon, metaStore, folder } = setup();
    metaStore.write({
      chatId: 'old-chat',
      folder,
      name: 'rehydrated',
      nextSeq: 7,
      claudeSessionId: 'session-X',
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();
    const s = daemon.chatState.get('old-chat');
    expect(s).toBeDefined();
    expect(s?.activity).toBe('idle');
    expect(s?.nextSeq).toBe(7);
    expect(s?.claudeSessionId).toBe('session-X');
    expect(s?.name).toBe('rehydrated');
  });

  it('G2-d4: captures the first user message as a durable preview + emits it on chat.state', async () => {
    const { daemon, sdk, events, folder, metaStore } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-P' },
      { type: 'assistant', content: 'sure', sessionId: 'sess-P' },
    ]);
    const chatId = await daemon.spawnChat({
      folder,
      prompt: 'please [[edit]] the sidebar ordering bug',
    });
    await new Promise((r) => setTimeout(r, 20));

    // The control-token marker is stripped; the snippet is the readable text.
    expect(daemon.chatState.get(chatId)?.preview).toBe('please the sidebar ordering bug');
    expect(metaStore.read(chatId)?.preview).toBe('please the sidebar ordering bug');
    const stateEvents = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state',
    );
    expect(stateEvents.some((e) => e.preview === 'please the sidebar ordering bug')).toBe(true);
  });

  it('preview strips the appended [Attachments] block; an image-only turn previews as "Image"', () => {
    // Typed text + attachment → just the text.
    expect(
      makePreviewSnippet(
        'look at this\n\n[Attachments]\n- image: /home/x/.patch/attachments/01ABC-image.jpg (photo.jpg)',
      ),
    ).toBe('look at this');
    // Attachment-only (pasted image, no text) → a friendly label, NEVER the path.
    const imageOnly =
      '[Attachments]\n- image: /home/claude-dev/projects/p/.patch/attachments/01ABC-image.jpg (image)';
    expect(makePreviewSnippet(imageOnly)).toBe('Image');
    expect(makePreviewSnippet(imageOnly)).not.toContain('/home');
    // File-only → its display name.
    expect(
      makePreviewSnippet(
        '[Attachments]\n- file: /home/x/.patch/attachments/01ABC-report.pdf (report.pdf)',
      ),
    ).toBe('report.pdf');
  });

  it('G2-d4: preview is captured once and not overwritten by a later turn', async () => {
    const { daemon, sdk, folder, metaStore } = setup();
    sdk.enqueue([{ type: 'result', sessionId: 'sess-1' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'first message wins' });
    await new Promise((r) => setTimeout(r, 20));
    expect(metaStore.read(chatId)?.preview).toBe('first message wins');

    sdk.enqueue([{ type: 'result', sessionId: 'sess-1' }]);
    await daemon.sendInput({
      chatId,
      message: 'a totally different second message',
      localId: 'lid-2',
    });
    await new Promise((r) => setTimeout(r, 20));
    // Still the first message — preview is the chat's identity, not its latest turn.
    expect(metaStore.read(chatId)?.preview).toBe('first message wins');
  });

  it('G2-d4: hydrate backfills preview from the log for chats created before the field existed', () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-runner-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-')));
    const metaStore = createMetaStore(home);
    const chatId = 'legacy-chat';
    const branchId = `${chatId}-b0`;
    // Persist a chat with NO `preview` field (mirrors meta.json written before
    // the field existed) but WITH a log carrying its first user message.
    metaStore.write({
      chatId,
      folder,
      name: null,
      claudeSessionId: 'sess-legacy',
      nextSeq: 2,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(metaStore.read(chatId)?.preview).toBeUndefined();
    const logDir = join(home, 'chats', chatId);
    mkdirSync(logDir, { recursive: true });
    const records = [
      {
        v: 1,
        seq: 0,
        at: 1,
        branchId,
        rec: {
          k: 'event',
          event: {
            type: 'chat.message',
            chatId,
            role: 'user',
            content: 'port the legacy importer',
            seq: 0,
          },
        },
      },
      {
        v: 1,
        seq: 1,
        at: 1,
        branchId,
        rec: {
          k: 'event',
          event: { type: 'chat.message', chatId, role: 'assistant', content: 'on it', seq: 1 },
        },
      },
    ];
    writeFileSync(
      join(logDir, 'events.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'unused',
    });
    daemon.hydrate();
    // The first user message was recovered and persisted as the preview.
    expect(daemon.chatState.get(chatId)?.preview).toBe('port the legacy importer');
    expect(metaStore.read(chatId)?.preview).toBe('port the legacy importer');
  });

  it('refuses to spawn into a folder that does not exist', async () => {
    const { daemon } = setup();
    await expect(daemon.spawnChat({ folder: '/no/such/path' })).rejects.toThrow(
      /folder does not exist/,
    );
  });

  it('F1: no provider session to resume — the turn just runs, and the chat is untouched', async () => {
    // The session is a pointer into the provider's context cache, not the
    // record: the chat's own history is Patch's. Refusing left the chat
    // `errored` until a person re-sent the message, which is no recovery for an
    // unattended chat — a job's `continue` action resolves to the same durable
    // chat on every fire, so the refusal was permanent.
    const { daemon, sdk, events, metaStore, folder } = setup();
    metaStore.write({
      chatId: 'no-session',
      folder,
      name: 'no session',
      nextSeq: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();

    await daemon.sendInput({ chatId: 'no-session', message: 'hi', localId: 'L1' });

    // It runs, starting a session rather than resuming one.
    expect(sdk.lastOptions()).toBeDefined();
    expect(sdk.lastOptions()?.resume).toBeUndefined();
    // Not errored, and NOTHING is written into the transcript about it: a chat
    // is not the place for plumbing notices.
    expect(daemon.chatState.get('no-session')?.activity).not.toBe('errored');
    expect(events.find((e) => e.type === 'chat.error')).toBeUndefined();
    expect(
      events.filter((e) => e.type === 'chat.message' && (e as { role?: string }).role === 'system'),
    ).toHaveLength(0);
    expect(metaStore.read('no-session')?.status).not.toBe('errored');
  });

  it.skip('F1 (superseded): hydrated chat with no claudeSessionId goes errored on input', async () => {
    const { daemon, sdk, events, metaStore, folder } = setup();
    // Hydrate a chat from disk that has NO claudeSessionId — mirrors a host
    // restart where meta.json was written before the SDK ever emitted a
    // session_id (or it was lost).
    metaStore.write({
      chatId: 'orphan-chat',
      folder,
      name: 'orphaned',
      nextSeq: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();

    await daemon.sendInput({ chatId: 'orphan-chat', message: 'hi', localId: 'L1' });

    // NO SDK query was issued (a resume:undefined fresh session would be a
    // silent fallback — spec/04 line 46 forbids it).
    expect(sdk.lastOptions()).toBeUndefined();

    // Chat is marked errored with a clear code.
    const state = daemon.chatState.get('orphan-chat');
    expect(state?.activity).toBe('errored');
    expect(state?.lastError?.code).toBe('claude_session_missing');

    const errEv = events.find((e) => e.type === 'chat.error') as
      | { error: { code: string }; seq: number }
      | undefined;
    expect(errEv?.error.code).toBe('claude_session_missing');
    // seq is allocated through bumpSeq — continues from the hydrated nextSeq=3.
    expect(errEv?.seq).toBe(3);
    expect(metaStore.read('orphan-chat')?.status).toBe('errored');
  });

  it('F1: a hydrated chat that never had a turn (nextSeq=0) DOES start fresh on first input', async () => {
    // Special threads (Manager/Speakers) are bootstrapped into
    // meta.json on first boot and persist across host restarts. After a
    // restart they are hydrated-from-disk yet may receive their very first
    // user turn. With nextSeq=0 (no events ever emitted) they lost no context,
    // so the first query is a legitimate fresh start — NOT a claude_session
    // _missing error (spec/06 special-thread first-turn must function).
    const { daemon, sdk, events, metaStore, folder } = setup();
    sdk.enqueue([{ type: 'result', sessionId: 'sess-firstturn' }]);
    metaStore.write({
      chatId: 'thread_manager',
      folder,
      name: 'manager',
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();

    await daemon.sendInput({ chatId: 'thread_manager', message: 'hi', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));

    // The SDK query ran (no refusal), resume undefined (fresh start), and the
    // chat captured its session id and returned to idle.
    expect(sdk.lastOptions()).toBeDefined();
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
    const state = daemon.chatState.get('thread_manager');
    expect(state?.activity).toBe('idle');
    expect(state?.claudeSessionId).toBe('sess-firstturn');
    // No claude_session_missing error was emitted.
    const errEv = events.find((e) => e.type === 'chat.error');
    expect(errEv).toBeUndefined();
  });

  it('F1: a freshly-spawned chat first query DOES resume undefined (behaviour 3 preserved)', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([{ type: 'result', sessionId: 'sess-fresh' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));
    // The first query ran with resume undefined — this is the legitimate
    // contextless start, NOT an error.
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-fresh');
  });

  it('F1: real backend + resume id with NO transcript on disk → clears id, starts FRESH (no hang)', async () => {
    // Regression for the F1-audible blocker: a `claudeSessionId` persisted by a
    // prior MOCK run (mock writes `mock-session-*.jsonl`, never
    // `<sessionId>.jsonl`) is not resumable by the REAL Claude Agent SDK, whose
    // `query({ resume })` HANGS forever on a missing transcript. The host must
    // detect the orphaned id (no transcript on disk) and start fresh instead.
    const home = mkdtempSync(join(tmpdir(), 'patch-runner-real-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-real-')));
    mkdirSync(folder, { recursive: true });
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-projects-'));
    // Mimic a mock-origin transcript: the file is `mock-session-*.jsonl`, so
    // hasSession('phantom-uuid') is false — exactly the live F1 situation.
    mkdirSync(join(projectsRoot, encodeFolder(folder)), { recursive: true });
    writeFileSync(
      join(projectsRoot, encodeFolder(folder), 'mock-session-abc.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      sdkBackendKind: 'real',
      historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    sdk.enqueue([{ type: 'result', sessionId: 'fresh-real-sess' }]);
    metaStore.write({
      chatId: 'thread_speakers',
      folder,
      name: 'speakers',
      nextSeq: 4,
      claudeSessionId: 'phantom-uuid-no-transcript',
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();

    await daemon.sendInput({
      chatId: 'thread_speakers',
      message: 'what time is it',
      localId: 'L1',
    });
    await new Promise((r) => setTimeout(r, 20));

    // The orphaned resume id was cleared and the query ran FRESH (resume
    // undefined) rather than handing the real SDK a phantom resume id (hang).
    expect(sdk.lastOptions()).toBeDefined();
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
    const state = daemon.chatState.get('thread_speakers');
    expect(state?.activity).toBe('idle');
    expect(state?.claudeSessionId).toBe('fresh-real-sess');
    // No claude_session_missing error (this is a resumable-fresh recovery).
    expect(events.find((e) => e.type === 'chat.error')).toBeUndefined();
    // The orphaned id was dropped from meta before the new one was captured.
    expect(metaStore.read('thread_speakers')?.claudeSessionId).toBe('fresh-real-sess');
  });

  it('F1: real backend + resume id WITH a transcript on disk → resumes normally (no false clear)', async () => {
    // The guard must NOT fire when the transcript genuinely exists — a real
    // resumable session must still resume.
    const home = mkdtempSync(join(tmpdir(), 'patch-runner-real2-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-folder-real2-')));
    mkdirSync(folder, { recursive: true });
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-projects2-'));
    mkdirSync(join(projectsRoot, encodeFolder(folder)), { recursive: true });
    writeFileSync(
      join(projectsRoot, encodeFolder(folder), 'real-sess-99.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    const metaStore = createMetaStore(home);
    const events: WireEvent[] = [];
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      sdkBackendKind: 'real',
      historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    sdk.enqueue([{ type: 'result', sessionId: 'real-sess-99' }]);
    metaStore.write({
      chatId: 'resumable-chat',
      folder,
      name: 'resumable',
      nextSeq: 4,
      claudeSessionId: 'real-sess-99',
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();

    await daemon.sendInput({ chatId: 'resumable-chat', message: 'continue', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));

    // resume id was passed through unchanged (genuine resume).
    expect(sdk.lastOptions()?.resumeSessionId).toBe('real-sess-99');
    expect(daemon.chatState.get('resumable-chat')?.activity).toBe('idle');
  });

  it('F5: resumed chat whose folder is gone goes errored on input, no SDK query', async () => {
    const { daemon, sdk, events, metaStore } = setup();
    metaStore.write({
      chatId: 'gone-folder',
      folder: '/no/such/path/anymore',
      name: 'stale',
      nextSeq: 0,
      claudeSessionId: 'sess-Z',
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();

    await daemon.sendInput({ chatId: 'gone-folder', message: 'hi', localId: 'L1' });

    // No bad cwd handed to the SDK.
    expect(sdk.lastOptions()).toBeUndefined();
    const state = daemon.chatState.get('gone-folder');
    expect(state?.activity).toBe('errored');
    expect(state?.lastError?.code).toBe('folder_missing');
    const errEv = events.find((e) => e.type === 'chat.error') as
      | { error: { code: string } }
      | undefined;
    expect(errEv?.error.code).toBe('folder_missing');
    expect(metaStore.read('gone-folder')?.status).toBe('errored');
  });

  it('F4: allocErrorSeq routes through bumpSeq for a known chat (monotonic + persisted), not seq 0', async () => {
    const { daemon, metaStore, folder, home } = setup();
    metaStore.write({
      chatId: 'known-chat',
      folder,
      name: null,
      nextSeq: 5,
      claudeSessionId: 'sess-K',
      createdAt: 1,
      updatedAt: 2,
    });
    daemon.hydrate();
    // First control-path error takes the hydrated nextSeq, NOT a colliding 0.
    const a = daemon.allocErrorSeq('known-chat');
    const b = daemon.allocErrorSeq('known-chat');
    expect(a).toBe(5);
    expect(b).toBe(6);
    // Persisted: the history log holds both seqs, so a fresh host resumes
    // above them; shutdown mirrors the position into meta.json.
    daemon.shutdown();
    expect(metaStore.read('known-chat')?.nextSeq).toBe(7);
    const next = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
    });
    // Rewind the mirror, as a crash before shutdown would have left it.
    metaStore.write({ ...metaStore.read('known-chat')!, nextSeq: 5 });
    next.hydrate();
    expect(next.allocErrorSeq('known-chat')).toBe(7);
    next.shutdown();
  });

  it('F4: allocErrorSeq returns OUT_OF_BAND_SEQ for an unknown chat', () => {
    const { daemon } = setup();
    expect(daemon.allocErrorSeq('never-heard-of-it')).toBe(OUT_OF_BAND_SEQ);
    expect(OUT_OF_BAND_SEQ).toBe(-1);
  });

  it('replayChat serves the in-memory tail under the mock SDK backend (no JSONL on disk)', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-replay' },
      { type: 'assistant', content: 'first', sessionId: 'sess-replay' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 20));

    // The mock backend never writes a Claude Code JSONL transcript, yet the
    // message is persisted in the host's in-memory ring. A fresh surface
    // (seen nothing) replays from -1 and must receive the full history
    // including seq 0 (spec/04 § Access: JSONL *plus* in-memory tail).
    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (ev) => replayed.push(ev));
    const messages = replayed.filter((e) => e.type === 'chat.message');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi', seq: 0 });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'first', seq: 1 });
  });

  it('replayChat with fromSeq filters out already-seen events (reconnect resync)', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-resync' },
      { type: 'assistant', content: 'a', sessionId: 'sess-resync' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    // First turn: user 'go' at seq 0, assistant 'a' at seq 1.
    // Second turn → user 'again' at seq 2, assistant 'b' at seq 3.
    sdk.enqueue([{ type: 'assistant', content: 'b', sessionId: 'sess-resync' }]);
    await daemon.sendInput({ chatId, message: 'again', localId: 'l2' });
    await new Promise((r) => setTimeout(r, 20));

    // A surface whose highest seen seq is 1 asks for everything after it, and
    // gets strictly that — never the reply it already rendered.
    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, 1, (ev) => replayed.push(ev));
    const contents = replayed
      .filter((e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message')
      .map((e) => e.content);
    expect(contents).toEqual(['again', 'b']);
  });

  it('G2-d1: replayChat re-emits a still-pending permission request even when the transcript replays it as a plain tool_call', async () => {
    // Mirror the live mock stack: the SDK backend writes a Claude-Code-shaped
    // JSONL transcript, where a permission is recorded as an assistant
    // `tool_use` block. On replay the history reader reconstructs that as a
    // `chat.tool_call` (no approve/deny). The fix re-emits the canonical
    // `chat.permission_request` for any STILL-PENDING permission so a surface
    // that reconnects AFTER the turn can still resolve `awaiting-permission`.
    const home = mkdtempSync(join(tmpdir(), 'patch-g2d1-home-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-g2d1-folder-')));
    mkdirSync(folder, { recursive: true });
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-g2d1-projects-'));
    const metaStore = createMetaStore(home);
    const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    const historyReader = createHistoryReader({ claudeProjectsRoot: projectsRoot });
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      historyReader,
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `g2d1-${++id}`,
    });
    const chatId = await daemon.spawnChat({ folder, prompt: 'please [[permission]] now' });
    await new Promise((r) => setTimeout(r, 40));
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');

    // The transcript exists and replays the permission as a bare tool_call —
    // but the fix tops the replay up with the canonical permission_request.
    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (ev) => replayed.push(ev));
    const perm = replayed.find((e) => e.type === 'chat.permission_request');
    expect(perm).toBeDefined();
    const requestId = (perm as { requestId: string }).requestId;

    // Once resolved, a later reconnect must NOT re-surface the (now decided)
    // permission card.
    daemon.submitPermissionResponse({ requestId, decision: 'approve' });
    const replayed2: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (ev) => replayed2.push(ev));
    expect(replayed2.some((e) => e.type === 'chat.permission_request')).toBe(false);
  });

  it('replayChat re-emits current chat.state so a surface that reconnects after a turn finished stops showing Stop (bug: "Patch showing stop after message has returned")', async () => {
    const { daemon, sdk, folder } = setup();
    sdk.enqueue([
      { type: 'result', sessionId: 'sess-reconnect' },
      { type: 'assistant', content: 'done', sessionId: 'sess-reconnect' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 20));

    // The turn has already settled back to idle by the time the surface
    // reconnects — it missed the live running -> idle chat.state edge while
    // disconnected. Replay must still hand it the CURRENT activity so a
    // stale "running" (and the Stop button it drives) doesn't stick around
    // forever.
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');

    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (ev) => replayed.push(ev));
    const state = replayed.find(
      (e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state',
    );
    expect(state).toBeDefined();
    expect(state?.activity).toBe('idle');
  });

  describe('replayChat: a persisted turn is never emitted twice (patch/todo.md — "messages are getting repeated in chat history")', () => {
    async function setupDrifted() {
      // Real mock stack: the SDK backend writes a Claude-Code-shaped JSONL, so
      // replay merges the persisted transcript (line-index-derived seqs — see
      // history.ts KNOWN LIMITATION) with the in-memory ring (daemon-stamped
      // canonical seqs). The two numbering schemes DRIFT apart in normal use:
      // a persisted user turn takes a JSONL line but no canonical seq, while a
      // control-path error / artifact takes a canonical seq but no JSONL line.
      const home = mkdtempSync(join(tmpdir(), 'patch-dup-home-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-dup-folder-')));
      mkdirSync(folder, { recursive: true });
      const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-dup-projects-'));
      const metaStore = createMetaStore(home);
      const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
      const historyReader = createHistoryReader({ claudeProjectsRoot: projectsRoot });
      let id = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        historyReader,
        oauthAccessToken: 'fake-token',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `dup-${++id}`,
      });
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-dup' },
        { type: 'assistant', content: 'first reply', sessionId: 'sess-dup' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 40));
      // Push the canonical seq counter AHEAD of the JSONL line count: three
      // control-path errors consume canonical seqs and are never persisted to
      // the transcript.
      daemon.allocErrorSeq(chatId);
      daemon.allocErrorSeq(chatId);
      daemon.allocErrorSeq(chatId);
      sdk.enqueue([{ type: 'assistant', content: 'second reply', sessionId: 'sess-dup' }]);
      await daemon.sendInput({ chatId, message: 'again', localId: 'l2' });
      await new Promise((r) => setTimeout(r, 40));
      return { daemon, chatId };
    }

    function assistantContents(events: WireEvent[]): string[] {
      return events
        .filter((e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message')
        .filter((e) => e.role === 'assistant')
        .map((e) => e.content);
    }

    it('a full replay emits the persisted turn once — not once from the transcript and again from the ring', async () => {
      const { daemon, chatId } = await setupDrifted();
      const replayed: WireEvent[] = [];
      daemon.replayChat(chatId, -1, (ev) => replayed.push(ev));
      const contents = assistantContents(replayed);
      expect(contents.filter((c) => c === 'second reply')).toHaveLength(1);
      expect(new Set(contents).size).toBe(contents.length);
    });

    it('re-opening the chat (cursor = highest seq already rendered) replays nothing already held', async () => {
      const { daemon, chatId } = await setupDrifted();
      const first: WireEvent[] = [];
      daemon.replayChat(chatId, -1, (ev) => first.push(ev));
      // The surface's cursor is the highest durable seq it rendered — exactly
      // what `requestReplay` computes from the timeline it now holds.
      const cursor = first.reduce((max, ev) => {
        const seq = (ev as { seq?: unknown }).seq;
        return typeof seq === 'number' && seq > max ? seq : max;
      }, -1);
      const second: WireEvent[] = [];
      daemon.replayChat(chatId, cursor, (ev) => second.push(ev));
      expect(assistantContents(second)).toEqual([]);
    });
  });

  it('per-query MCP env injects PATCH_CHAT_ID for the running chat (group 10 BLOCKER A.2)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-runner-mcp-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-runner-mcp-folder-')));
    mkdirSync(folder, { recursive: true });
    const metaStore = createMetaStore(home);
    const sdk = createMockSdkBackend();
    let id = 0;
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore,
      sdkBackend: sdk,
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      mcpServer: {
        command: '/usr/bin/node',
        args: ['/tmp/mcp.js'],
        env: { PATCH_DAEMON_SOCKET: '/tmp/sock' },
      },
    });
    sdk.enqueue([{ type: 'result', sessionId: 'sess-A' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));
    const opts = sdk.lastOptions();
    expect(opts?.mcpServer?.env).toMatchObject({
      PATCH_DAEMON_SOCKET: '/tmp/sock',
      PATCH_CHAT_ID: chatId,
    });
  });

  // spec/04 § Name — AI-generated chat titles (the optional `generateTitle` DI).
  describe('AI title generation (spec/04 § Name)', () => {
    function setupTitle(
      generateTitle: (input: {
        chatId: string;
        firstUserMessage: string;
        folder: string;
        chatModel?: string;
      }) => Promise<string | null>,
    ) {
      const home = mkdtempSync(join(tmpdir(), 'patch-title-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-title-folder-')));
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
        generateTitle,
      });
      return { daemon, sdk, events, folder, metaStore };
    }

    it('sets, persists, and emits the AI title as soon as the first user message is accepted', async () => {
      const calls: { firstUserMessage: string }[] = [];
      const { daemon, sdk, events, folder, metaStore } = setupTitle(async (input) => {
        calls.push({ firstUserMessage: input.firstUserMessage });
        return 'Garden Plant Identification';
      });
      sdk.enqueue([{ type: 'assistant', content: 'That looks like sage.', sessionId: 'sess-T' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'what plant is this?' });
      await new Promise((r) => setTimeout(r, 30));

      // Name set in memory + persisted to meta.json.
      expect(daemon.chatState.get(chatId)?.name).toBe('Garden Plant Identification');
      expect(metaStore.read(chatId)?.name).toBe('Garden Plant Identification');
      // A chat.state event carried the new name to surfaces.
      const named = events.filter(
        (e) => e.type === 'chat.state' && e.name === 'Garden Plant Identification',
      );
      expect(named.length).toBeGreaterThan(0);
      // The generator saw only the first user message — no assistant reply
      // to wait on.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.firstUserMessage).toBe('what plant is this?');
    });

    it('titles a Codex (ChatGPT) chat too, handing the generator its model', async () => {
      const calls: { chatModel?: string }[] = [];
      const { daemon, sdk, folder, metaStore } = setupTitle(async (input) => {
        calls.push({ chatModel: input.chatModel });
        return 'Codex Chat Title';
      });
      sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'sess-X' }]);
      const chatId = await daemon.spawnChat({
        folder,
        prompt: 'hello there',
        model: 'openai/gpt-5-codex',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toEqual([{ chatModel: 'openai/gpt-5-codex' }]);
      expect(daemon.chatState.get(chatId)?.name).toBe('Codex Chat Title');
      expect(metaStore.read(chatId)?.name).toBe('Codex Chat Title');
    });

    it('generates the title from the first user message BEFORE a long-running first turn settles', async () => {
      const calls: string[] = [];
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const home = mkdtempSync(join(tmpdir(), 'patch-title-slow-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-title-slow-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const events: WireEvent[] = [];
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: {
          run: async function* (opts) {
            void opts;
            // Simulate a first turn that takes a long time (e.g. 5 min) to
            // produce anything — the turn is still running when we assert.
            await turnGate;
            yield { type: 'assistant', content: 'finally done', sessionId: 'sess-slow' };
          },
        },
        oauthAccessToken: 'fake-token',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'chat-slow',
        generateTitle: async (input) => {
          calls.push(input.firstUserMessage);
          return 'Long Running Task';
        },
      });

      const chatId = await daemon.spawnChat({ folder, prompt: 'run the slow migration' });
      await new Promise((r) => setTimeout(r, 30));

      // The turn is still in flight (not idle) but the title has already landed.
      expect(daemon.chatState.get(chatId)?.activity).not.toBe('idle');
      expect(calls).toEqual(['run the slow migration']);
      expect(daemon.chatState.get(chatId)?.name).toBe('Long Running Task');
      expect(metaStore.read(chatId)?.name).toBe('Long Running Task');

      releaseTurn();
      await new Promise((r) => setTimeout(r, 30));
      // Settling the turn afterwards doesn't regenerate or change the title.
      expect(calls).toHaveLength(1);
      expect(daemon.chatState.get(chatId)?.name).toBe('Long Running Task');
    });

    it('leaves name null when the generator returns null (no message-dumping fallback)', async () => {
      const { daemon, sdk, folder, metaStore } = setupTitle(async () => null);
      // An image-only turn: the [Attachments] block must never leak into a title,
      // and a null result must not dump it as the name.
      sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'sess-N' }]);
      const chatId = await daemon.spawnChat({
        folder,
        prompt: '[Attachments]\n- image: /x/.patch/attachments/01A-image.jpg (image)',
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.name).toBeNull();
      expect(metaStore.read(chatId)?.name ?? null).toBeNull();
    });

    it('generates the title once — a second turn does not regenerate', async () => {
      let n = 0;
      const { daemon, sdk, folder } = setupTitle(async () => {
        n += 1;
        return `Title ${n}`;
      });
      sdk.enqueue([{ type: 'assistant', content: 'a', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.name).toBe('Title 1');

      sdk.enqueue([{ type: 'assistant', content: 'b', sessionId: 'sess-1' }]);
      await daemon.sendInput({ chatId, message: 'second', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 30));
      expect(n).toBe(1);
      expect(daemon.chatState.get(chatId)?.name).toBe('Title 1');
    });

    // Regression: Tom reported that after adding a new Claude account, a
    // chat's main turn correctly authenticated as the new account, but a
    // background summariser fired for that same chat used a stale/default
    // account instead. Root cause: `generateTitle`/`generateStatus` were
    // invoked without the chat's own pinned `accountId`, so the host's
    // `resolveOAuth` always fell back to the host's active account rather
    // than the chat's (spec/10-auth.md § Backend credentials — multiple
    // accounts). This guards that the chat's pinned `accountId` is threaded
    // straight through to the generator input.
    it('is told nothing about an account — a chat has none (spec/10 § Backend credentials)', async () => {
      // The summariser authenticates the same way a turn does: it asks the host
      // for a credential and the host answers with the first key that has
      // credit. There is no chat-level account to thread through, and passing
      // one would be inventing a fact.
      const inputs: Record<string, unknown>[] = [];
      const { daemon, sdk, folder } = setupTitle(async (input) => {
        inputs.push(input as unknown as Record<string, unknown>);
        return 'A Title';
      });
      sdk.enqueue([{ type: 'assistant', content: 'reply', sessionId: 'sess-acct' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first message' });
      await new Promise((r) => setTimeout(r, 30));
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).not.toHaveProperty('accountId');
      expect(daemon.chatState.get(chatId)).not.toHaveProperty('accountId');
    });
  });

  // patch/todo.md § Features to add — "Current status" (the optional
  // `generateStatus` DI). The host summarises the thread after EACH turn
  // settles and re-emits it on chat.state, distinguishing a `question` from a
  // `complete` thread.
  describe('AI status generation (Current status)', () => {
    function setupStatus(
      generateStatus: (input: {
        chatId: string;
        lastUserMessage: string;
        assistantReply: string;
        folder: string;
      }) => Promise<{ kind: 'question' | 'complete'; summary: string } | null>,
    ) {
      const home = mkdtempSync(join(tmpdir(), 'patch-status-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-status-folder-')));
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
        generateStatus,
      });
      return { daemon, sdk, events, folder, metaStore };
    }

    it('sets + emits the status summary + kind after a turn settles', async () => {
      const calls: { lastUserMessage: string; assistantReply: string }[] = [];
      const { daemon, sdk, events, folder } = setupStatus(async (input) => {
        calls.push({
          lastUserMessage: input.lastUserMessage,
          assistantReply: input.assistantReply,
        });
        return { kind: 'complete', summary: 'Refactor finished, tests green' };
      });
      sdk.enqueue([{ type: 'assistant', content: 'All done.', sessionId: 'sess-S' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'refactor auth' });
      await new Promise((r) => setTimeout(r, 30));

      expect(daemon.chatState.get(chatId)?.statusSummary).toBe('Refactor finished, tests green');
      expect(daemon.chatState.get(chatId)?.statusKind).toBe('complete');
      // chat.state carried the summary + kind to surfaces.
      const withStatus = events.filter(
        (e) =>
          e.type === 'chat.state' &&
          e.statusSummary === 'Refactor finished, tests green' &&
          e.statusKind === 'complete',
      );
      expect(withStatus.length).toBeGreaterThan(0);
      // The generator saw the latest exchange (user message + assistant reply).
      expect(calls).toHaveLength(1);
      expect(calls[0]?.lastUserMessage).toBe('refactor auth');
      expect(calls[0]?.assistantReply).toBe('All done.');
    });

    it('regenerates the status on EVERY turn (unlike the once-only title)', async () => {
      let n = 0;
      const { daemon, sdk, folder } = setupStatus(async () => {
        n += 1;
        return n === 1
          ? { kind: 'complete', summary: `done ${n}` }
          : { kind: 'question', summary: `need input ${n}` };
      });
      sdk.enqueue([{ type: 'assistant', content: 'a', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.statusKind).toBe('complete');
      expect(daemon.chatState.get(chatId)?.statusSummary).toBe('done 1');

      sdk.enqueue([{ type: 'assistant', content: 'b', sessionId: 'sess-1' }]);
      await daemon.sendInput({ chatId, message: 'second', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 30));
      expect(n).toBe(2);
      expect(daemon.chatState.get(chatId)?.statusKind).toBe('question');
      expect(daemon.chatState.get(chatId)?.statusSummary).toBe('need input 2');
    });

    it('writes no fabricated status when the generator returns null', async () => {
      let n = 0;
      const { daemon, sdk, folder } = setupStatus(async () => {
        n += 1;
        return n === 1 ? { kind: 'complete', summary: 'first done' } : null;
      });
      sdk.enqueue([{ type: 'assistant', content: 'a', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.statusSummary).toBe('first done');

      sdk.enqueue([{ type: 'assistant', content: 'b', sessionId: 'sess-1' }]);
      await daemon.sendInput({ chatId, message: 'second', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 30));
      // The new message cleared the stale status (spec/04 § Current status) and
      // the failed generation wrote nothing over it — no fabricated summary, and
      // no resurrection of the summary that described the PREVIOUS turn.
      expect(daemon.chatState.get(chatId)?.statusSummary).toBeNull();
      expect(daemon.chatState.get(chatId)?.statusKind).toBeNull();
    });

    // patch/todo.md — "the status update for a chat is out of date as soon as
    // you send a new message, it should clear that".
    it('clears the status the moment a new user message is accepted', async () => {
      let n = 0;
      const { daemon, sdk, events, folder } = setupStatus(async () => {
        n += 1;
        // The 2nd generation never settles, so the only thing that can null the
        // status is the send-time clear.
        return n === 1
          ? { kind: 'complete', summary: 'first done' }
          : new Promise(() => {
              /* pending forever */
            });
      });
      sdk.enqueue([{ type: 'assistant', content: 'a', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.statusSummary).toBe('first done');

      events.length = 0;
      sdk.enqueue([{ type: 'assistant', content: 'b', sessionId: 'sess-1' }]);
      await daemon.sendInput({ chatId, message: 'second', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 30));

      expect(daemon.chatState.get(chatId)?.statusSummary).toBeNull();
      expect(daemon.chatState.get(chatId)?.statusKind).toBeNull();
      // Surfaces were told: a chat.state carrying the cleared status was emitted.
      const cleared = events.filter(
        (e) => e.type === 'chat.state' && e.statusSummary === null && e.statusKind === null,
      );
      expect(cleared.length).toBeGreaterThan(0);
    });

    it('clears at ACCEPT time, before the new turn has produced anything', async () => {
      const { daemon, sdk, folder } = setupStatus(async () => ({
        kind: 'complete',
        summary: 'first done',
      }));
      sdk.enqueue([{ type: 'assistant', content: 'a', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.statusSummary).toBe('first done');

      sdk.enqueue([{ type: 'assistant', content: 'b', sessionId: 'sess-1' }]);
      // Not awaited: the clear must have happened by the time sendInput yields,
      // i.e. it is driven by the send, not by the turn settling.
      const running = daemon.sendInput({ chatId, message: 'second', localId: 'L2' });
      expect(daemon.chatState.get(chatId)?.statusSummary).toBeNull();
      expect(daemon.chatState.get(chatId)?.statusKind).toBeNull();
      await running;
    });

    it('does not generate a status for a special thread (Manager)', async () => {
      let called = false;
      const { daemon, sdk, folder, metaStore } = setupStatus(async () => {
        called = true;
        return { kind: 'complete', summary: 'x' };
      });
      // Hydrate a manager thread from disk, then drive a turn on it.
      sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'sess-M' }]);
      metaStore.write({
        chatId: 'thread_manager',
        folder,
        name: 'manager',
        nextSeq: 0,
        createdAt: 1,
        updatedAt: 2,
      });
      daemon.hydrate();
      await daemon.sendInput({ chatId: 'thread_manager', message: 'status?', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(called).toBe(false);
      expect(daemon.chatState.get('thread_manager')?.statusSummary ?? null).toBeNull();
    });

    // Regression: same root cause as the title-generation case above — the
    // status summariser must authenticate as the CHAT's pinned account, not
    // the host's active one (spec/10-auth.md § Backend credentials).
    it('is told nothing about an account — a chat has none (spec/10 § Backend credentials)', async () => {
      const inputs: Record<string, unknown>[] = [];
      const { daemon, sdk, folder } = setupStatus(async (input) => {
        inputs.push(input as unknown as Record<string, unknown>);
        return { kind: 'complete', summary: 'done' };
      });
      sdk.enqueue([{ type: 'assistant', content: 'a', sessionId: 'sess-acct' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first' });
      await new Promise((r) => setTimeout(r, 30));
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).not.toHaveProperty('accountId');
      expect(daemon.chatState.get(chatId)).not.toHaveProperty('accountId');
    });
  });

  // spec/09 § What the message says. Tom: "patch notify needs to take specific
  // text from the agent and use it. not just the starting message". The
  // settling `chat.state` carries the agent's own last words, so the server's
  // doorbell has real text on the frame it fires on — `statusSummary` above is
  // a model's reading of the thread and lands on a LATER frame, which is why
  // the notification almost always said only "<name> finished".
  describe("the turn's closing text on chat.state (turnSummary)", () => {
    function setupTurn() {
      const home = mkdtempSync(join(tmpdir(), 'patch-turnsummary-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-turnsummary-folder-')));
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
      });
      return { daemon, sdk, events, folder, metaStore, home };
    }

    /** The `turnSummary` on the frame that settled the chat to idle. */
    function settlingSummary(events: WireEvent[]): string | null | undefined {
      const idle = events.filter((e) => e.type === 'chat.state' && e.activity === 'idle');
      const last = idle[idle.length - 1];
      return last?.type === 'chat.state' ? last.turnSummary : undefined;
    }

    it('carries the last thing the agent said on the settling frame', async () => {
      const { daemon, sdk, events, folder } = setupTurn();
      sdk.enqueue([
        { type: 'assistant', content: 'Planted the top bed.', sessionId: 'sess-1' },
        { type: 'assistant', content: 'Watered it in and tidied up.', sessionId: 'sess-1' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'do the beds' });
      await new Promise((r) => setTimeout(r, 30));

      expect(daemon.chatState.get(chatId)?.turnSummary).toBe('Watered it in and tidied up.');
      // On the SETTLING frame itself, not a later one — the doorbell fires on
      // the running → idle edge and never looks again.
      expect(settlingSummary(events)).toBe('Watered it in and tidied up.');
    });

    // A push body and a toast both cut a long body blind, mid-word. The host
    // cuts it here instead, while the text is still whole.
    it('cuts an over-long reply to notification length on a word boundary', async () => {
      const { daemon, sdk, folder } = setupTurn();
      const long = `${'wisteria '.repeat(60)}end`;
      sdk.enqueue([{ type: 'assistant', content: long, sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));

      const summary = daemon.chatState.get(chatId)?.turnSummary ?? '';
      expect(summary.length).toBeLessThanOrEqual(240);
      expect(summary.endsWith('…')).toBe(true);
      // Cut between words, so the last one is not left as a fragment.
      expect(summary).toMatch(/wisteria…$/);
      expect(long.startsWith(summary.slice(0, -1))).toBe(true);
    });

    // Markdown reads as a run of blank lines in a push body, so the text is
    // flattened rather than passed through raw.
    it('flattens the reply to one line', async () => {
      const { daemon, sdk, folder } = setupTurn();
      sdk.enqueue([
        { type: 'assistant', content: '## Done\n\n- planted\n- watered\n', sessionId: 'sess-1' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.turnSummary).toBe('## Done - planted - watered');
    });

    // NO FALLBACK: a turn that said nothing gets no words put in its mouth.
    it('is null when the agent said nothing but whitespace', async () => {
      const { daemon, sdk, events, folder } = setupTurn();
      sdk.enqueue([{ type: 'assistant', content: '   \n  ', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.turnSummary).toBeNull();
      expect(settlingSummary(events)).toBeNull();
    });

    // `lastMessages` is a window across turns, so a turn that ends on a tool
    // call leaves the PREVIOUS turn's reply sitting at the end of it. Quoting
    // that would re-announce work the user has already been told about.
    it('is null for a turn that ends on a tool call, not the previous turn’s words', async () => {
      const { daemon, sdk, events, folder } = setupTurn();
      sdk.enqueue([{ type: 'assistant', content: 'Planted the top bed.', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'do the beds' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.turnSummary).toBe('Planted the top bed.');

      events.length = 0;
      sdk.enqueue([
        { type: 'tool_use', tool: { name: 'Bash', args: { command: 'ls' }, callId: 'tc-1' } },
        { type: 'tool_result', toolResult: { name: 'Bash', callId: 'tc-1', result: 'ok' } },
      ]);
      await daemon.sendInput({ chatId, message: 'and again', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 30));

      expect(daemon.chatState.get(chatId)?.turnSummary).toBeNull();
      expect(settlingSummary(events)).toBeNull();
    });

    it('a new turn clears the previous turn’s closing text before it runs', async () => {
      const { daemon, sdk, events, folder } = setupTurn();
      sdk.enqueue([{ type: 'assistant', content: 'Planted the top bed.', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'do the beds' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.turnSummary).toBe('Planted the top bed.');

      events.length = 0;
      sdk.enqueue([{ type: 'assistant', content: 'Weeded the path.', sessionId: 'sess-1' }]);
      // Not awaited: the clear happens at ACCEPT time, so by the time sendInput
      // has yielded the stale text is already gone.
      const running = daemon.sendInput({ chatId, message: 'now the path', localId: 'L2' });
      expect(daemon.chatState.get(chatId)?.turnSummary).toBeNull();
      await running;
      await new Promise((r) => setTimeout(r, 30));

      // Surfaces were told about the clear, and no frame emitted while the new
      // turn ran was still quoting the old one.
      const cleared = events.filter((e) => e.type === 'chat.state' && e.turnSummary === null);
      expect(cleared.length).toBeGreaterThan(0);
      const stale = events.filter(
        (e) => e.type === 'chat.state' && e.turnSummary === 'Planted the top bed.',
      );
      expect(stale).toEqual([]);
      expect(daemon.chatState.get(chatId)?.turnSummary).toBe('Weeded the path.');
    });

    // It describes one settled turn, like statusSummary/statusKind — nothing
    // durable about the chat — so it is not written to meta.json.
    it('is not persisted to meta.json', async () => {
      const { daemon, sdk, folder, metaStore } = setupTurn();
      sdk.enqueue([{ type: 'assistant', content: 'Planted the top bed.', sessionId: 'sess-1' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'do the beds' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.turnSummary).toBe('Planted the top bed.');
      expect(metaStore.read(chatId)).not.toHaveProperty('turnSummary');
    });
  });

  describe('constructor / options branches', () => {
    it('constructs with resolveOAuth (not oauthAccessToken) and uses it for the OAuth gate', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-ctor-oauth-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-ctor-oauth-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const sdk = createMockSdkBackend();
      let calls = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        resolveOAuth: () => {
          calls += 1;
          return { ok: true, accessToken: 'tok-from-resolver' };
        },
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'ctor-oauth-1',
      });
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      await daemon.spawnChat({ folder, prompt: 'hi' });
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toBeGreaterThan(0);
    });

    it('throws when neither resolveOAuth nor oauthAccessToken is supplied', () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-ctor-noauth-'));
      const metaStore = createMetaStore(home);
      expect(
        () =>
          new Daemon({
            daemonId: 'd1',
            metaStore,
            sdkBackend: createMockSdkBackend(),
            emit: () => undefined,
            logger: silent,
          }),
      ).toThrow(/one of resolveOAuth \/ oauthAccessToken is required/);
    });

    it('E3: shutdown() is idempotent and never auto-archives an idle chat', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sweep-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let clock = 1_700_000_000_000;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: createMockSdkBackend(),
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => clock,
        generateChatId: () => 'sweep-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      // Auto-archive is gone: no amount of elapsed time archives an idle chat.
      clock += 24 * 60 * 60 * 1000;
      expect(daemon.chatState.get(chatId)?.status).toBe('active');
      // shutdown disarms in-memory timers; calling it (even twice) never throws.
      expect(() => daemon.shutdown()).not.toThrow();
      expect(() => daemon.shutdown()).not.toThrow();
    });
  });

  describe('hydrate edge branches', () => {
    it('warns but does not throw when a persisted chat folder no longer exists', () => {
      const { daemon, metaStore } = setup();
      metaStore.write({
        chatId: 'gone-on-hydrate',
        folder: '/no/such/folder/at/all',
        name: null,
        nextSeq: 0,
        createdAt: 1,
        updatedAt: 2,
      });
      expect(() => daemon.hydrate()).not.toThrow();
      expect(daemon.chatState.get('gone-on-hydrate')).toBeDefined();
    });

    it('G2-d4: backfill catches an unreadable transcript and leaves preview null', () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-backfill-catch-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-backfill-catch-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const brokenReader: HistoryReader = {
        hasSession: () => true,
        read: () => {
          throw new Error('boom reading transcript');
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: createMockSdkBackend(),
        historyReader: brokenReader,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'unused',
      });
      metaStore.write({
        chatId: 'legacy-unreadable',
        folder,
        name: null,
        claudeSessionId: 'sess-1',
        nextSeq: 2,
        createdAt: 1,
        updatedAt: 2,
      });
      daemon.hydrate();
      expect(daemon.chatState.get('legacy-unreadable')?.preview).toBeNull();
    });
  });

  describe('spawnChat edge branches', () => {
    // patch doesn't recognise tilde in workspace paths — the "type a path"
    // field lets someone type `~/projects/x`, which never goes through a
    // shell, so the host must expand it itself before checking the folder.
    it('expands a leading ~ in the requested folder', async () => {
      const { daemon } = setup();
      const under = mkdtempSync(join(homedir(), 'patch-tilde-spawn-'));
      try {
        const tildeFolder = join('~', under.slice(homedir().length + 1));
        const chatId = await daemon.spawnChat({ folder: tildeFolder, prompt: 'hi' });
        expect(chatId).toBeDefined();
      } finally {
        rmSync(under, { recursive: true, force: true });
      }
    });

    it('throws when the given chatId already exists', async () => {
      const { daemon, folder } = setup();
      await daemon.spawnChat({ folder, chatId: 'fixed-dup' });
      await expect(daemon.spawnChat({ folder, chatId: 'fixed-dup' })).rejects.toThrow(
        /already exists/,
      );
    });

    it('a background spawn-prompt failure is caught and logged, not thrown out of spawnChat', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-bgfail-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-bgfail-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const sdk = createMockSdkBackend();
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'bg-fail-1',
        onTurnCommitted: () => {
          throw new Error('turn-committed hook exploded');
        },
      });
      sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
      // spawnChat itself must resolve fine — the background pump's failure is
      // caught internally and logged, never rejecting spawnChat.
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));
      expect(chatId).toBeDefined();
    });
  });

  describe('setPinned / setArchived idempotent branches', () => {
    it('setPinned re-emits without persist churn when already in the desired state', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.setPinned(chatId, false)).resolves.toBeUndefined();
      expect(daemon.chatState.get(chatId)?.pinned).toBe(false);
    });

    it('setArchived re-emits without persist churn when already in the desired state', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.setArchived(chatId, false)).resolves.toBeUndefined();
      expect(daemon.chatState.get(chatId)?.status).toBe('active');
    });
  });

  describe('special threads: archive refused, disable is the real off switch', () => {
    function setupWithManager() {
      const s = setup();
      // Re-point generateChatId so the spawned chat lands on the reserved
      // Manager id — spawnChat itself doesn't special-case it, only the
      // guards on setArchived/setDisabled do, so this is enough to exercise
      // them without the full ensureSpecialThreads bootstrap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s.daemon as any).opts.generateChatId = () => SPECIAL_THREAD_IDS.manager;
      return s;
    }

    it('refuses to archive a reserved special thread — this is the production bug', async () => {
      const { daemon, folder } = setupWithManager();
      const chatId = await daemon.spawnChat({ folder });
      expect(chatId).toBe(SPECIAL_THREAD_IDS.manager);
      await expect(daemon.setArchived(chatId, true)).rejects.toThrow(/special thread/i);
      expect(daemon.chatState.get(chatId)?.status).toBe('active');
    });

    it('unarchiving a special thread is a no-op, not refused (nothing to undo elsewhere)', async () => {
      const { daemon, folder } = setupWithManager();
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.setArchived(chatId, false)).resolves.toBeUndefined();
    });

    it('setDisabled turns a special thread on/off', async () => {
      const { daemon, folder } = setupWithManager();
      const chatId = await daemon.spawnChat({ folder });
      expect(daemon.chatState.get(chatId)?.disabled).toBe(false);
      await daemon.setDisabled(chatId, true);
      expect(daemon.chatState.get(chatId)?.disabled).toBe(true);
      await daemon.setDisabled(chatId, false);
      expect(daemon.chatState.get(chatId)?.disabled).toBe(false);
    });

    it('refuses setDisabled on an ordinary (non-special) chat', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.setDisabled(chatId, true)).rejects.toThrow(/not a special thread/i);
    });
  });

  describe('rotateThread (spec/06 § Session rotation)', () => {
    function setupRotatable(generateDigest: DaemonOptions['generateDigest']) {
      const home = mkdtempSync(join(tmpdir(), 'patch-rotate-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rotate-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const events: WireEvent[] = [];
      const sdk = createMockSdkBackend();
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'fake-token',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => SPECIAL_THREAD_IDS.manager,
        ...(generateDigest ? { generateDigest } : {}),
      });
      return { daemon, sdk, events, folder, metaStore };
    }

    it('refuses to rotate a special thread with no session yet', async () => {
      const { daemon, folder } = setupRotatable(async () => 'a digest');
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.rotateThread(chatId)).resolves.toBeUndefined();
      expect(daemon.chatState.get(chatId)?.claudeSessionId).toBeUndefined();
    });

    it('refuses to rotate an ordinary (non-special) chat', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.rotateThread(chatId)).rejects.toThrow(/not a special thread/i);
    });

    it('refuses with no digest generator wired, rather than rotating blind', async () => {
      const { daemon, sdk, folder } = setupRotatable(undefined);
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-outgoing' },
        { type: 'assistant', content: 'hi', sessionId: 'sess-outgoing' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      await expect(daemon.rotateThread(chatId)).rejects.toThrow(/no digest generator/i);
      expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-outgoing');
    });

    it('skips the cycle (does not rotate) when digest generation fails', async () => {
      const { daemon, sdk, folder } = setupRotatable(async () => null);
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-outgoing' },
        { type: 'assistant', content: 'hi', sessionId: 'sess-outgoing' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      await daemon.rotateThread(chatId);
      expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-outgoing');
    });

    it('retires the outgoing session, marks the boundary, and seeds a fresh one with the digest', async () => {
      const digestCalls: Array<{ resumeSessionId: string }> = [];
      const { daemon, sdk, events, folder, metaStore } = setupRotatable(async (input) => {
        digestCalls.push({ resumeSessionId: input.resumeSessionId });
        return 'Tom prefers terse replies; nothing blocking right now.';
      });
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-outgoing' },
        { type: 'assistant', content: 'hi', sessionId: 'sess-outgoing' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-outgoing');

      // The rotation's own seeded turn, once the session has been cleared.
      sdk.enqueue([
        { type: 'result', sessionId: 'sess-fresh' },
        { type: 'assistant', content: 'got it', sessionId: 'sess-fresh' },
      ]);
      await daemon.rotateThread(chatId);
      await new Promise((r) => setTimeout(r, 20));

      // Asked the OUTGOING session for its digest, not a fresh one.
      expect(digestCalls).toEqual([{ resumeSessionId: 'sess-outgoing' }]);

      // The boundary is a system chat.message, same arrangement a compaction
      // boundary uses, so it replays with the rest of the chat.
      const boundary = events.find(
        (e) => e.type === 'chat.message' && e.role === 'system' && e.content?.includes('rotated'),
      );
      expect(boundary).toBeDefined();

      // The seeded turn carried the digest through to the fresh session.
      const seededOpts = sdk.lastOptions();
      expect(seededOpts?.prompt).toContain('Tom prefers terse replies');
      expect(seededOpts?.resumeSessionId).toBeUndefined();

      // Landed on the NEW session, meta persisted.
      expect(daemon.chatState.get(chatId)?.claudeSessionId).toBe('sess-fresh');
      expect(metaStore.read(chatId)?.claudeSessionId).toBe('sess-fresh');
    });

    it('refuses to rotate a chat that is mid-turn', async () => {
      const { daemon, sdk, folder } = setupRotatable(async () => 'digest');
      // A backend whose run() never yields until aborted — same shape as the
      // "let the query reach running before aborting" tests above — keeps the
      // chat genuinely `running` for the guard to see.
      const hangingSdk: typeof sdk = {
        ...sdk,
        async *run() {
          await new Promise(() => {
            /* never resolves within this test */
          });
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (daemon as any).opts.sdkBackend = hangingSdk;
      const chatId = await daemon.spawnChat({ folder });
      // Fire-and-forget: this run() never settles within the test, by design
      // (it awaits a promise that never resolves) — awaiting it would hang.
      void daemon.sendInput({ chatId, message: 'go', localId: 'l1' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.activity).toBe('running');
      await expect(daemon.rotateThread(chatId)).rejects.toThrow(/mid-turn/i);
    });
  });

  describe('Plan Mode sync (spec/02 § Permission mode)', () => {
    it('EnterPlanMode stamps the chat onto plan and records it as automatic', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        { type: 'result', sessionId: 's1' },
        { type: 'tool_use', tool: { name: 'EnterPlanMode', args: {}, callId: 'c1' } },
        { type: 'assistant', content: 'Let me plan this out.' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'do a big refactor' });
      await new Promise((r) => setTimeout(r, 20));

      expect(daemon.chatState.get(chatId)?.permissionMode).toBe('plan');
      const marks = events.filter(
        (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
          e.type === 'chat.message' && e.role === 'system' && 'permissionModeChange' in e,
      );
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({
        permissionModeChange: 'plan',
        permissionModeChangeAutomatic: true,
      });
    });

    it('ExitPlanMode (approved) restores the mode the chat was on before entering', async () => {
      const { daemon, sdk, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await daemon.setChatPermissionMode(chatId, 'bypassPermissions');

      sdk.enqueue([
        { type: 'result', sessionId: 's1' },
        { type: 'tool_use', tool: { name: 'EnterPlanMode', args: {}, callId: 'c1' } },
      ]);
      await daemon.sendInput({ chatId, message: 'plan it', localId: 'l1' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.permissionMode).toBe('plan');

      sdk.enqueue([
        {
          type: 'tool_result',
          toolResult: { name: 'ExitPlanMode', callId: 'c1', result: 'approved' },
        },
        { type: 'assistant', content: 'Proceeding.' },
      ]);
      await daemon.sendInput({ chatId, message: 'go ahead', localId: 'l2' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.permissionMode).toBe('bypassPermissions');
    });

    it('ExitPlanMode denied (isError) does not restore — the SDK never actually left plan', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([
        { type: 'result', sessionId: 's1' },
        { type: 'tool_use', tool: { name: 'EnterPlanMode', args: {}, callId: 'c1' } },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.permissionMode).toBe('plan');

      sdk.enqueue([
        {
          type: 'tool_result',
          toolResult: {
            name: 'ExitPlanMode',
            callId: 'c1',
            result: 'denied',
            isError: true,
          },
        },
      ]);
      await daemon.sendInput({ chatId, message: 'try again', localId: 'l1' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.permissionMode).toBe('plan');
    });

    it('a lone ExitPlanMode with nothing stashed is a no-op', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([
        { type: 'result', sessionId: 's1' },
        {
          type: 'tool_result',
          toolResult: { name: 'ExitPlanMode', callId: 'c1', result: 'ok' },
        },
        { type: 'assistant', content: 'done' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      // Never entered plan via the tool, so its ordinary configured mode
      // stands — untouched, not forced onto anything.
      expect(daemon.chatState.get(chatId)?.permissionMode).not.toBe('plan');
    });
  });

  describe('listWithFilter', () => {
    it('only/include/default filters, pinned+pinned tie-break by pinnedAt, unpinned by lastUpdated', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-listfilter-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-listfilter-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let clock = 1_700_000_000_000;
      let n = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: createMockSdkBackend(),
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => clock,
        generateChatId: () => `lf-${++n}`,
      });
      const a = await daemon.spawnChat({ folder });
      clock += 10;
      const b = await daemon.spawnChat({ folder });
      clock += 10;
      const c = await daemon.spawnChat({ folder });
      clock += 10;
      const d = await daemon.spawnChat({ folder });
      clock += 10;
      const e = await daemon.spawnChat({ folder });
      clock += 10;

      await daemon.setArchived(b, true);
      await daemon.setPinned(a, true);
      clock += 10;
      await daemon.setPinned(c, true);

      const onlyArchived = daemon.listWithFilter({ archived: 'only' });
      expect(onlyArchived.map((s) => s.chatId)).toEqual([b]);

      const includeAll = daemon.listWithFilter({ archived: 'include' });
      expect(includeAll.map((s) => s.chatId).sort()).toEqual([a, b, c, d, e].sort());

      // Default: excludes archived (b); pinned first (c pinned later than a, so
      // c ranks ahead); unpinned (d, e) trail, ordered by most-recent lastUpdated
      // (e spawned after d, so e ranks ahead of d).
      const defaultList = daemon.listWithFilter();
      expect(defaultList.map((s) => s.chatId)).toEqual([c, a, e, d]);
    });

    it('a pinned chat hydrated with a null pinnedAt (legacy/malformed meta) still sorts via the ?? 0 fallback', () => {
      const { daemon, folder, metaStore } = setup();
      metaStore.write({
        chatId: 'pinned-no-pinnedat',
        folder,
        name: null,
        nextSeq: 0,
        pinned: true,
        pinnedAt: null,
        createdAt: 1,
        updatedAt: 2,
      });
      metaStore.write({
        chatId: 'pinned-with-pinnedat',
        folder,
        name: null,
        nextSeq: 0,
        pinned: true,
        pinnedAt: 5_000,
        createdAt: 1,
        updatedAt: 2,
      });
      // A second null-pinnedAt chat so a comparator call between the two
      // null-pinnedAt chats exercises the `?? 0` fallback on BOTH operand
      // positions (sort's comparator argument order is otherwise unspecified).
      metaStore.write({
        chatId: 'pinned-no-pinnedat-2',
        folder,
        name: null,
        nextSeq: 0,
        pinned: true,
        pinnedAt: null,
        createdAt: 1,
        updatedAt: 2,
      });
      daemon.hydrate();
      const list = daemon.listWithFilter();
      // The chat with a real pinnedAt (5000 > 0) ranks ahead of the ones whose
      // pinnedAt fell back to 0 via `?? 0`.
      expect(list[0]?.chatId).toBe('pinned-with-pinnedat');
      expect(list.map((s) => s.chatId).sort()).toEqual(
        ['pinned-with-pinnedat', 'pinned-no-pinnedat', 'pinned-no-pinnedat-2'].sort(),
      );
    });
  });

  describe('stopChat / list / cleanStaleChats', () => {
    it('stopChat on an idle chat (no in-flight query) is a no-op', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await expect(daemon.stopChat(chatId)).resolves.toBeUndefined();
    });

    it('list() returns the chat_state list', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      expect(daemon.list().map((s) => s.chatId)).toContain(chatId);
    });

    it('cleanStaleChats: chats with no session id, or a resumable session, are left untouched', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-clean-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-clean-folder-')));
      mkdirSync(folder, { recursive: true });
      const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-clean-projects-'));
      const metaStore = createMetaStore(home);
      const historyReader = createHistoryReader({ claudeProjectsRoot: projectsRoot });
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: createMockSdkBackend(),
        historyReader,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'fresh-clean',
      });
      const freshChat = await daemon.spawnChat({ folder }); // no session id

      mkdirSync(join(projectsRoot, encodeFolder(folder)), { recursive: true });
      writeFileSync(
        join(projectsRoot, encodeFolder(folder), 'sess-resumable.jsonl'),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      );
      metaStore.write({
        chatId: 'resumable-clean',
        folder,
        name: null,
        claudeSessionId: 'sess-resumable',
        nextSeq: 1,
        createdAt: 1,
        updatedAt: 2,
      });
      metaStore.write({
        chatId: 'lost-clean',
        folder,
        name: null,
        claudeSessionId: 'sess-missing-xyz',
        nextSeq: 1,
        createdAt: 1,
        updatedAt: 2,
      });
      daemon.hydrate();

      const { removed } = daemon.cleanStaleChats();
      expect(removed).toEqual(['lost-clean']);
      expect(daemon.chatState.has(freshChat)).toBe(true);
      expect(daemon.chatState.has('resumable-clean')).toBe(true);
      expect(daemon.chatState.has('lost-clean')).toBe(false);
    });

    it('cleanStaleChats skips a chat that is currently running, even if its session would otherwise be lost', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-clean-running-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-clean-running-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const sdk = createMockSdkBackend({ turnDelayMs: 150 });
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'run-clean-1',
      });
      metaStore.write({
        chatId: 'running-lost',
        folder,
        name: null,
        claudeSessionId: 'sess-never-existed',
        nextSeq: 1,
        createdAt: 1,
        updatedAt: 2,
      });
      daemon.hydrate();
      sdk.enqueue([{ type: 'assistant', content: 'working' }]);
      const p = daemon.sendInput({ chatId: 'running-lost', message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get('running-lost')?.activity).toBe('running');
      const { removed } = daemon.cleanStaleChats();
      expect(removed).toEqual([]);
      await p;
    });
  });

  describe('runQuery: OAuth gate races', () => {
    it('a stopChat landing during OAuth resolution settles idle with chat.stopped (not an auth failure)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-oauth-abort-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-oauth-abort-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const sdk = createMockSdkBackend();
      const events: WireEvent[] = [];
      let resolveGate!: () => void;
      const gate = new Promise<void>((r) => {
        resolveGate = r;
      });
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        resolveOAuth: async () => {
          await gate;
          return { ok: true, accessToken: 'tok' };
        },
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'oauth-abort-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      const p = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 10));
      await daemon.stopChat(chatId);
      resolveGate();
      await p;
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
      expect(events.some((e) => e.type === 'chat.stopped')).toBe(true);
      expect(events.some((e) => e.type === 'chat.error')).toBe(false);
    });

    it('refuses the query and emits daemon.unauthenticated when the OAuth resolver reports not-ok', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-oauth-bad-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-oauth-bad-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const events: WireEvent[] = [];
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: createMockSdkBackend(),
        resolveOAuth: () => ({ ok: false, reason: 'no credential' }),
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'oauth-bad-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      expect(
        events.some(
          (e) =>
            e.type === 'daemon.unauthenticated' &&
            (e as { reason: string }).reason === 'no credential',
        ),
      ).toBe(true);
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    });
  });

  describe('runQuery: SDK option pass-through', () => {
    it('passes model + permissionMode through to the SDK when set on the chat', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      await daemon.spawnChat({ folder, prompt: 'go', model: 'claude-x', permissionMode: 'plan' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.model).toBe('claude-x');
      expect(sdk.lastOptions()?.permissionMode).toBe('plan');
    });

    // patch/todo.md — "allow the user to turn them on and off": the surface's
    // per-chat Tools panel sends the current OFF set on chat.input; the host
    // stores it on chat state and hands it to the SDK for the turn.
    it('carries chat.input disabledTools onto chat state + into the SDK options', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      const chatId = await daemon.spawnChat({ folder });
      await daemon.sendInput({
        chatId,
        message: 'go',
        localId: 'L-off',
        disabledTools: ['Bash', 'WebSearch'],
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.disabledTools).toEqual(['Bash', 'WebSearch']);
      expect(sdk.lastOptions()?.disabledTools).toEqual(['Bash', 'WebSearch']);
    });

    it('a later chat.input with no disabledTools clears the per-chat OFF set (tools back on)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      const chatId = await daemon.spawnChat({ folder });
      await daemon.sendInput({ chatId, message: 'a', localId: 'L1', disabledTools: ['Bash'] });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.disabledTools).toEqual(['Bash']);
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'b', localId: 'L2' });
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.disabledTools).toBeUndefined();
      expect(sdk.lastOptions()?.disabledTools).toBeUndefined();
    });

    it('passes harnessConfig.systemPrompt through to the SDK when set (Task 3)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({ systemPrompt: 'You are a gardening assistant.' });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.systemPrompt).toBe('You are a gardening assistant.');
    });

    it('passes harnessConfig.skills through to the SDK when set (Task 3)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({ skills: ['pdf', 'docx'] });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.skills).toEqual(['pdf', 'docx']);
    });

    it('passes skills: "all" through to the SDK (Task 3)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({ skills: 'all' });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.skills).toBe('all');
    });

    it('no systemPrompt or skills in SDK options when harnessConfig is empty (Task 3)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      // No setHarnessConfig call.
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.systemPrompt).toBeUndefined();
      expect(sdk.lastOptions()?.skills).toBeUndefined();
    });

    it('passes harnessConfig.memoryEnabled through as settings.autoMemoryEnabled (spec/14 § Agent behavior — Memory toggle)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({ memoryEnabled: false });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.settings).toEqual({ autoMemoryEnabled: false });
    });

    it('memoryEnabled: true is stated explicitly too, not just omitted (Memory toggle)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({ memoryEnabled: true });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.settings).toEqual({ autoMemoryEnabled: true });
    });

    it('passes harnessConfig.claudeMdExcludePaths through as settings.claudeMdExcludes (CLAUDE.md toggle, off)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({
        claudeMdExcludePaths: ['/home/x/.patch/threads/manager/CLAUDE.md'],
      });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.settings).toEqual({
        claudeMdExcludes: ['/home/x/.patch/threads/manager/CLAUDE.md'],
      });
    });

    it('memoryEnabled and claudeMdExcludePaths merge into ONE settings object when both are set', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      daemon.setHarnessConfig({
        memoryEnabled: false,
        claudeMdExcludePaths: ['/home/x/.patch/threads/speakers/CLAUDE.md'],
      });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.settings).toEqual({
        autoMemoryEnabled: false,
        claudeMdExcludes: ['/home/x/.patch/threads/speakers/CLAUDE.md'],
      });
    });

    it("passes harnessConfig.mcpServers through to the SDK as the turn's extra MCP servers (Settings → MCP)", async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      const servers = [
        { name: 'my-tools', command: '/opt/tools', args: ['--x'], env: {}, enabled: true },
      ];
      daemon.setHarnessConfig({ mcpServers: servers });
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.extraMcpServers).toEqual(servers);
    });

    it('no settings and no extra MCP servers in SDK options when harnessConfig is empty (Agent behavior toggles default off)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      // No setHarnessConfig call.
      await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 20));
      expect(sdk.lastOptions()?.settings).toBeUndefined();
      expect(sdk.lastOptions()?.extraMcpServers).toEqual([]);
    });
  });

  // The "unknown chatId" race between two queued turns (a chat deleted in the
  // gap between one queued turn committing and the next starting) is covered
  // deterministically in test/queue.test.ts, which already owns the
  // gated-backend harness for exercising queue-drain timing precisely.

  describe('bumpSeq: envelope processing for a chat deleted mid-stream', () => {
    it('throws loudly rather than silently dropping the event', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-bumpseq-race-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-bumpseq-race-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let releaseGate: (() => void) | undefined;
      const backend: SdkBackend = {
        async *run() {
          yield { type: 'assistant', content: 'first' };
          await new Promise<void>((r) => {
            releaseGate = r;
          });
          yield { type: 'assistant', content: 'second-after-delete' };
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'bump-race-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      const p = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 15));
      daemon.chatState.delete(chatId);
      releaseGate?.();
      await expect(p).rejects.toThrow(/unknown chatId|bumpSeq/);
    });
  });

  describe('handleEnvelope: skip branches', () => {
    it('skips empty assistant content, missing tool_use.tool, missing tool_result.toolResult; tracks isError; error envelope with/without a message', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        { type: 'assistant', content: '' },
        { type: 'tool_use' },
        { type: 'tool_result' },
        { type: 'tool_use', tool: { name: 'Bash', args: { cmd: 'ls' }, callId: 'c-err' } },
        {
          type: 'tool_result',
          toolResult: { name: 'Bash', callId: 'c-err', result: 'boom', isError: true },
        },
        { type: 'error' },
        { type: 'error', errorMessage: 'a specific failure' },
        { type: 'assistant', content: 'final' },
        { type: 'result', sessionId: 'sess-skip' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));

      const chatEvents = (t: string) =>
        events.filter((e) => e.type === t && (e as { chatId?: string }).chatId === chatId);
      const msgs = chatEvents('chat.message') as unknown as Array<{ content: string }>;
      expect(msgs).toHaveLength(2);
      expect(msgs[0]?.content).toBe('go'); // the user turn
      expect(msgs[1]?.content).toBe('final');
      expect(chatEvents('chat.tool_call')).toHaveLength(1); // the malformed one was skipped
      const results = chatEvents('chat.tool_result') as unknown as Array<{ isError?: boolean }>;
      expect(results).toHaveLength(1); // the malformed one was skipped
      expect(results[0]?.isError).toBe(true);
      const errs = chatEvents('chat.error') as unknown as Array<{
        error: { message: string };
      }>;
      expect(errs).toHaveLength(2);
      expect(errs[0]?.error.message).toBe('unknown sdk error');
      expect(errs[1]?.error.message).toBe('a specific failure');
    });
  });

  describe('permission envelopes: computeEditInfo / dirtyFilePaths / substituteEditedNewString', () => {
    it('a non-edit tool (Bash) carries no proposedDiff and is not tracked as a dirty file', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: { requestId: 'p-bash', tool: 'Bash', args: undefined, description: 'run ls' },
        },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const permEv = events.find((e) => e.type === 'chat.permission_request') as
        | { request: { proposedDiff?: string } }
        | undefined;
      expect(permEv?.request.proposedDiff).toBeUndefined();
      expect(daemon.dirtyFilePaths(chatId).size).toBe(0);
      // Still resolvable via the pendingPermissionEvents-only path, and the
      // chat stays awaiting-permission until then (hasPendingPermission's
      // second loop).
      expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
      daemon.submitPermissionResponse({ requestId: 'p-bash', decision: 'deny' });
      expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
    });

    it('Edit tool: tracks the dirty file path; approve_with_edits substitutes new_string via the real flow', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-edit',
            tool: 'Edit',
            args: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
            description: 'edit a.ts',
          },
        },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const dirty = daemon.dirtyFilePaths(chatId);
      expect(dirty.size).toBe(1);
      expect([...dirty][0]).toContain('src/a.ts');
      events.length = 0;
      daemon.submitPermissionResponse({
        requestId: 'p-edit',
        decision: 'approve_with_edits',
        editedNewString: 'z',
      });
      const synthetic = events.find((e) => e.type === 'chat.tool_call') as
        | { args: { new_string?: string } }
        | undefined;
      expect(synthetic?.args.new_string).toBe('z');
      expect(daemon.dirtyFilePaths(chatId).size).toBe(0);
    });

    // spec/03 § Answering with content: an empty `editedNewString` is a real
    // answer — the edit deletes the content — so it must survive the whole
    // substitution path and land as `new_string: ''`. A truthiness check
    // anywhere downstream would silently drop it and approve the agent's
    // ORIGINAL new_string instead, which is the opposite of what was approved.
    it('Edit tool: an EMPTY editedNewString substitutes an empty new_string (an edit that deletes)', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-edit-empty',
            tool: 'Edit',
            args: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
            description: 'edit a.ts',
          },
        },
      ]);
      await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      events.length = 0;
      daemon.submitPermissionResponse({
        requestId: 'p-edit-empty',
        decision: 'approve_with_edits',
        editedNewString: '',
      });
      const synthetic = events.find((e) => e.type === 'chat.tool_call') as
        | { args: { new_string?: string } }
        | undefined;
      expect(synthetic?.args.new_string).toBe('');
    });

    it('Edit tool: a plain "approve" (no edits) does not synthesize a tool_call', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-edit-plain',
            tool: 'Edit',
            args: { file_path: 'src/b.ts', old_string: 'x', new_string: 'y' },
            description: 'edit b.ts',
          },
        },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      events.length = 0;
      daemon.submitPermissionResponse({ requestId: 'p-edit-plain', decision: 'approve' });
      expect(events.some((e) => e.type === 'chat.tool_call')).toBe(false);
      expect(daemon.dirtyFilePaths(chatId).size).toBe(0);
    });

    it('Write tool: computes a diff and substitutes content via approve_with_edits', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-write',
            tool: 'Write',
            args: { file_path: 'note.txt', content: 'orig' },
            description: 'write note',
          },
        },
      ]);
      await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const permEv = events.find((e) => e.type === 'chat.permission_request') as
        | { request: { proposedDiff?: string } }
        | undefined;
      expect(permEv?.request.proposedDiff).toContain('+orig');
      events.length = 0;
      daemon.submitPermissionResponse({
        requestId: 'p-write',
        decision: 'approve_with_edits',
        editedNewString: 'new content',
      });
      const synthetic = events.find((e) => e.type === 'chat.tool_call') as
        | { args: { content?: string } }
        | undefined;
      expect(synthetic?.args.content).toBe('new content');
    });

    it('NotebookEdit tool: computes a diff and substitutes new_source via approve_with_edits', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-nb',
            tool: 'NotebookEdit',
            args: { notebook_path: 'nb.ipynb', old_source: 'a=1', new_source: 'a=2' },
            description: 'edit notebook',
          },
        },
      ]);
      await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const permEv = events.find((e) => e.type === 'chat.permission_request') as
        | { request: { proposedDiff?: string } }
        | undefined;
      expect(permEv?.request.proposedDiff).toContain('+a=2');
      events.length = 0;
      daemon.submitPermissionResponse({
        requestId: 'p-nb',
        decision: 'approve_with_edits',
        editedNewString: 'a=3',
      });
      const synthetic = events.find((e) => e.type === 'chat.tool_call') as
        | { args: { new_source?: string } }
        | undefined;
      expect(synthetic?.args.new_source).toBe('a=3');
    });

    it('Edit tool with an absolute file_path is used as-is (no join with the chat folder)', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-abs',
            tool: 'Edit',
            args: { file_path: '/tmp/abs-file.ts', old_string: 'x', new_string: 'y' },
            description: 'edit abs',
          },
        },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const dirty = [...daemon.dirtyFilePaths(chatId)];
      expect(dirty).toEqual(['/tmp/abs-file.ts']);
    });

    it('computeEditInfo tolerates missing old/new string args (defaults to empty strings)', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-edit-min',
            tool: 'Edit',
            args: { file_path: 'x.ts' },
            description: 'edit',
          },
        },
      ]);
      await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const permEv = events.find((e) => e.type === 'chat.permission_request') as
        | { request: { proposedDiff?: string } }
        | undefined;
      expect(permEv?.request.proposedDiff).toContain('--- a/x.ts');
      expect(permEv?.request.proposedDiff).toContain('@@ -1,0 +1,0 @@');
    });
  });

  describe('submitPermissionResponse: not-found branch', () => {
    it('warns and no-ops for a requestId that is not tracked anywhere', () => {
      const { daemon } = setup();
      expect(() =>
        daemon.submitPermissionResponse({ requestId: 'never-existed', decision: 'approve' }),
      ).not.toThrow();
    });
  });

  describe('getRecentEvents / lastQueryDiagnostics', () => {
    it('returns the tail and flags truncated when limited below the ring size', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([
        { type: 'assistant', content: 'a' },
        { type: 'assistant', content: 'b' },
        { type: 'assistant', content: 'c' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));
      const full = daemon.getRecentEvents(chatId, 200);
      expect(full.truncated).toBe(false);
      const limited = daemon.getRecentEvents(chatId, 1);
      expect(limited.truncated).toBe(true);
      expect(limited.events).toHaveLength(1);
    });

    it('caps the ring at 200 events per chat and marks it truncated', async () => {
      const { daemon, sdk, folder } = setup();
      const script: Array<{ type: 'assistant'; content: string }> = [];
      for (let i = 0; i < 205; i++) script.push({ type: 'assistant', content: `msg-${i}` });
      sdk.enqueue([...script, { type: 'result', sessionId: 'sess-cap' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 300));
      const { events, truncated } = daemon.getRecentEvents(chatId, 200);
      expect(truncated).toBe(true);
      expect(events).toHaveLength(200);
      expect((events[events.length - 1] as { content?: string }).content).toBe('msg-204');
    });

    it('lastQueryDiagnostics: undefined before any query, then records the resume argument used', async () => {
      const { daemon, sdk, folder } = setup();
      expect(daemon.lastQueryDiagnostics('no-such-chat')).toBeUndefined();
      sdk.enqueue([{ type: 'result', sessionId: 'sess-diag' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const diag = daemon.lastQueryDiagnostics(chatId);
      expect(diag?.resumeSessionId).toBeUndefined();
      expect(typeof diag?.at).toBe('number');
    });
  });

  describe('isClaudeSessionInvalidError classification (via a real failing turn)', () => {
    function throwingBackend(err: unknown): SdkBackend {
      return {
        async *run() {
          throw err;
        },
      };
    }

    const cases: Array<{ label: string; err: unknown; expectInvalid: boolean }> = [
      {
        label: 'SessionNotFoundError name',
        err: Object.assign(new Error('x'), { name: 'SessionNotFoundError' }),
        expectInvalid: true,
      },
      {
        label: 'SessionExpiredError name',
        err: Object.assign(new Error('x'), { name: 'SessionExpiredError' }),
        expectInvalid: true,
      },
      {
        label: 'session not found message',
        err: new Error('Session Not Found'),
        expectInvalid: true,
      },
      {
        label: 'session expired message',
        err: new Error('the session expired'),
        expectInvalid: true,
      },
      {
        label: 'invalid session message',
        err: new Error('invalid session id'),
        expectInvalid: true,
      },
      {
        label: 'unknown session id message',
        err: new Error('unknown session id'),
        expectInvalid: true,
      },
      { label: 'no such session message', err: new Error('no such session'), expectInvalid: true },
      {
        label: '--resume requires a valid session',
        err: new Error('--resume requires a valid session'),
        expectInvalid: true,
      },
      {
        label: 'is not a uuid + session title',
        err: new Error('foo is not a uuid, expected a session title'),
        expectInvalid: true,
      },
      {
        label: 'is not a uuid WITHOUT session title (generic)',
        err: new Error('foo is not a uuid'),
        expectInvalid: false,
      },
      {
        label: 'does not match any session',
        err: new Error('does not match any session'),
        expectInvalid: true,
      },
      {
        label: 'no conversation found',
        err: new Error('No conversation found with session ID: abc'),
        expectInvalid: true,
      },
      {
        label: 'generic unrelated error',
        err: new Error('boom, totally unrelated'),
        expectInvalid: false,
      },
      { label: 'a non-Error thrown value', err: 'just a string', expectInvalid: false },
    ];

    for (const c of cases) {
      it(`${c.label} -> ${c.expectInvalid ? 'claude_session_invalid' : 'sdk_error'}`, async () => {
        const home = mkdtempSync(join(tmpdir(), 'patch-invalid-sess-'));
        const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-invalid-sess-folder-')));
        mkdirSync(folder, { recursive: true });
        const metaStore = createMetaStore(home);
        const events: WireEvent[] = [];
        const daemon = new Daemon({
          daemonId: 'd1',
          metaStore,
          sdkBackend: throwingBackend(c.err),
          oauthAccessToken: 'tok',
          emit: (e) => events.push(e),
          logger: silent,
          now: () => 1_700_000_000_000,
          generateChatId: () => `invalid-sess-${Math.random().toString(36).slice(2)}`,
        });
        const chatId = await daemon.spawnChat({ folder });
        await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
        const errEv = events.find((e) => e.type === 'chat.error') as
          | { error: { code: string }; causeSeq?: number }
          | undefined;
        expect(errEv?.error.code).toBe(c.expectInvalid ? 'claude_session_invalid' : 'sdk_error');
        // The failing turn's own persisted-message seq (NOT its localId, which
        // the surface has already cleared by the time this error can arrive —
        // see events.ts's ChatErrorEvent.causeSeq doc) rides on the error so a
        // surface can attach it to the message that failed instead of a
        // standalone row (spec/12). "go" is the chat's first and only turn, so
        // its persisted chat.message took seq 0.
        expect(errEv?.causeSeq).toBe(0);
      });
    }
  });

  describe('makePreviewSnippet edge branches', () => {
    it('an entirely-control-token message with no attachment block previews as null', () => {
      expect(makePreviewSnippet('[[edit]]')).toBeNull();
    });

    it('an attachment block whose line does not match the expected shape previews as null', () => {
      expect(makePreviewSnippet('[Attachments]\nnot-a-valid-line')).toBeNull();
    });

    it('an image attachment with a real distinctive name previews as that name', () => {
      const withName =
        '[Attachments]\n- image: /x/.patch/attachments/01A-vacation.jpg (vacation.jpg)';
      expect(makePreviewSnippet(withName)).toBe('vacation.jpg');
    });

    it('a file attachment with an empty display name previews as "Attachment"', () => {
      const emptyName = '[Attachments]\n- file: /x/.patch/attachments/01A-doc ()';
      expect(makePreviewSnippet(emptyName)).toBe('Attachment');
    });

    it('truncates a long preview with an ellipsis', () => {
      const long = 'x'.repeat(150);
      const snippet = makePreviewSnippet(long);
      expect(snippet?.endsWith('…')).toBe(true);
      expect(snippet?.length).toBe(120);
    });
  });

  describe('self-wake (spec/02 § Self-wake)', () => {
    it('scheduleWake validates: chat must exist, message required, exactly one of in/at, valid timestamps', async () => {
      const { daemon, folder } = setup();
      expect(() => daemon.scheduleWake('no-such-chat', { in: '10s', message: 'hi' })).toThrow(
        /chat not found/i,
      );
      const chatId = await daemon.spawnChat({ folder });
      expect(() => daemon.scheduleWake(chatId, { in: '10s', message: '   ' })).toThrow(
        /message is required/,
      );
      expect(() => daemon.scheduleWake(chatId, { message: 'hi' })).toThrow(/exactly one of/);
      expect(() =>
        daemon.scheduleWake(chatId, {
          in: '10s',
          at: '2026-01-01T00:00:00Z',
          message: 'hi',
        }),
      ).toThrow(/exactly one of/);
      expect(() => daemon.scheduleWake(chatId, { at: 'not-a-date', message: 'hi' })).toThrow(
        /invalid 'at' timestamp/,
      );
      expect(() =>
        daemon.scheduleWake(chatId, { in: '10s', notAfter: 'not-a-date', message: 'hi' }),
      ).toThrow(/invalid 'notAfter'/);
    });

    it('scheduleWake with `in` resolves fireAt relative to now(); peekWake reflects it; cancelWake removes it', async () => {
      const { daemon, folder } = setup(); // now() is fixed at 1_700_000_000_000
      const chatId = await daemon.spawnChat({ folder });
      const { fireAt } = daemon.scheduleWake(chatId, { in: '10s', message: 'check on it' });
      expect(fireAt).toBe(1_700_000_000_000 + 10_000);
      const rec = daemon.peekWake(chatId);
      expect(rec?.message).toBe('check on it');
      expect(daemon.cancelWake(chatId)).toBe(true);
      expect(daemon.peekWake(chatId)).toBeNull();
      expect(daemon.cancelWake(chatId)).toBe(false); // already gone
    });

    it('scheduleWake with `at` + a valid notAfter resolves fireAt from the ISO timestamp', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      const at = new Date(1_700_000_100_000).toISOString();
      const notAfter = new Date(1_700_000_200_000).toISOString();
      const { fireAt } = daemon.scheduleWake(chatId, { at, message: 'timed', notAfter });
      expect(fireAt).toBe(1_700_000_100_000);
      daemon.cancelWake(chatId);
    });

    it('deliverWake: fires and re-invokes the SAME chat with the [wake]-prefixed message', async () => {
      const { daemon, sdk, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'ack' }]);
      daemon.scheduleWake(chatId, { in: '0', message: 'ping' });
      await new Promise((r) => setTimeout(r, 60));
      const prompt = sdk.lastOptions()?.prompt ?? '';
      expect(prompt).toContain('[wake] ping');
    });

    it('deliverWake: drops silently when the chat has been deleted entirely (in-memory and on disk)', async () => {
      const { daemon, metaStore, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      daemon.scheduleWake(chatId, { in: '0', message: 'ping' });
      // Delete the chat's in-memory state AND its meta.json (but leave the
      // meta dir + wake.json alone, so the wake timer still fires).
      daemon.chatState.delete(chatId);
      rmSync(metaStore.pathFor(chatId), { force: true });
      await new Promise((r) => setTimeout(r, 60));
      expect(daemon.chatState.get(chatId)).toBeUndefined();
    });

    it('deliverWake: lazy-hydrates a chat that is on disk but not yet in memory', async () => {
      const { daemon, sdk, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      daemon.scheduleWake(chatId, { in: '0', message: 'ping' });
      // Drop the in-memory state only — the persisted meta + wake.json remain.
      daemon.chatState.delete(chatId);
      sdk.enqueue([{ type: 'assistant', content: 'woke up' }]);
      await new Promise((r) => setTimeout(r, 60));
      expect(daemon.chatState.get(chatId)).toBeDefined();
      expect(sdk.lastOptions()?.prompt ?? '').toContain('[wake] ping');
    });
  });

  describe('A1-14 canonical per-chat seq (spec/03 § Goals, spec/12 § Replay vs history cursors)', () => {
    /**
     * A host whose mock backend persists a Claude-Code-shaped transcript, so
     * the live stream and the persisted store can be compared directly — the
     * whole point of the canonical seq.
     */
    function setupPersisting() {
      const home = mkdtempSync(join(tmpdir(), 'patch-canonseq-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-canonseq-folder-')));
      mkdirSync(folder, { recursive: true });
      const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-canonseq-projects-'));
      const events: WireEvent[] = [];
      const sdk = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
      const metaStore = createMetaStore(home);
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
        oauthAccessToken: 'fake-token',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'canon-chat',
      });
      return { daemon, sdk, events, home, folder, projectsRoot, metaStore };
    }

    const seqOf = (e: WireEvent): number => (e as unknown as { seq: number }).seq;
    const msgs = (evs: WireEvent[]) =>
      evs
        .filter((e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message')
        .map((e) => `${e.role}:${e.content}@${e.seq}`);

    it('a message replays and history-fetches under the SAME seq it was emitted live at, even when non-transcript events consume seqs', async () => {
      const { daemon, sdk, events, folder } = setupPersisting();
      // Turn 1 — plain exchange.
      sdk.enqueue([{ type: 'assistant', content: 'first reply' }, { type: 'result' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'first question' });
      await new Promise((r) => setTimeout(r, 30));
      // Turn 2 — an `error` envelope takes a canonical seq but is NEVER written
      // to the transcript. Under the old line-index numbering everything after
      // it shifted, which is what made replay re-deliver an already-seen reply.
      sdk.enqueue([
        { type: 'error', errorMessage: 'transient blip' },
        { type: 'assistant', content: 'second reply' },
        { type: 'result' },
      ]);
      await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
      await new Promise((r) => setTimeout(r, 30));

      const liveMessages = msgs(events);
      expect(liveMessages).toEqual([
        'user:first question@0',
        'assistant:first reply@1',
        'user:second question@2',
        // seq 3 is the chat.error — a canonical seq with no transcript line.
        'assistant:second reply@4',
      ]);
      // The mid-stream `error` envelope (handleEnvelope's 'error' case, not
      // the outer try/catch) still carries the seq of the persisted "second
      // question" message it belongs to, so a surface can attach the failure
      // to that message instead of a standalone error row (spec/12).
      const errEv = events.find((e) => e.type === 'chat.error') as
        | { causeSeq?: number }
        | undefined;
      expect(errEv?.causeSeq).toBe(2);

      // HTTP `history?since=0` (inclusive) — the same four messages, same seqs.
      expect(msgs(daemon.readHistory({ chatId, fromSeq: 0, limit: 200 }).events)).toEqual(
        liveMessages,
      );

      // WS `chat.replay {fromSeq: -1}` (exclusive, -1 = everything) — likewise.
      const full: WireEvent[] = [];
      daemon.replayChat(chatId, -1, (e) => full.push(e));
      expect(msgs(full)).toEqual(liveMessages);

      // THE DEFECT: a surface reconnecting with the highest seq it saw live
      // must get back NOTHING it has already rendered.
      const highestLive = Math.max(
        ...events.map(seqOf).filter((n): n is number => typeof n === 'number'),
      );
      expect(highestLive).toBe(4);
      const tail: WireEvent[] = [];
      daemon.replayChat(chatId, highestLive, (e) => tail.push(e));
      expect(msgs(tail)).toEqual([]);

      // And a surface that saw only the first exchange gets exactly the rest.
      const partial: WireEvent[] = [];
      daemon.replayChat(chatId, 1, (e) => partial.push(e));
      expect(msgs(partial)).toEqual(['user:second question@2', 'assistant:second reply@4']);
    });

    // Todoist: "Chat transcript re-renders the triggering job prompt below the
    // final answer (looks like the job ran twice)". A job with a `skill` sends
    // its first turn as `/<skill>\n\n<body>` (server: dispatcher.renderPrompt),
    // and Claude Code persists that as a <command-*> wrapper whose args are
    // TRIMMED — so the transcript hands back `/<skill> <body>`. When the live
    // event was emitted with the raw text instead, the two forms hash to
    // different payload identities and the canonical-seq sidecar misses: the
    // FIRST transcript entry looks like one this host never emitted, gets a
    // brand-new seq off the tail, and re-renders below the final answer. The
    // ring/transcript identity merge misses for the same reason, so the turn
    // also replays TWICE while the chat is still in the ring.
    it('a slash-command first turn replays ONCE, at the seq it was emitted live at', async () => {
      const { daemon, sdk, events, folder } = setupPersisting();
      sdk.enqueue([{ type: 'assistant', content: 'claimed the task' }, { type: 'result' }]);
      // Exactly what a skill-backed job dispatches, trailing space included: a
      // mustache placeholder that renders empty leaves one behind.
      const chatId = await daemon.spawnChat({
        folder,
        prompt: '/ha-update\n\nHome Automation Todoist event — item:added\n\nDescription: ',
      });
      await new Promise((r) => setTimeout(r, 30));

      // The live event already carries the form the transcript will yield.
      const liveMessages = msgs(events);
      expect(liveMessages).toEqual([
        'user:/ha-update Home Automation Todoist event — item:added\n\nDescription:@0',
        'assistant:claimed the task@1',
      ]);

      // Replay: the prompt is at seq 0 — above the reply, not below it — and
      // appears exactly once even though the ring still holds its live copy.
      const full: WireEvent[] = [];
      daemon.replayChat(chatId, -1, (e) => full.push(e));
      expect(msgs(full)).toEqual(liveMessages);
      const userSeqs = full
        .filter((e) => e.type === 'chat.message' && (e as { role: string }).role === 'user')
        .map(seqOf);
      expect(userSeqs).toEqual([0]);

      // …and the HTTP history pipe agrees.
      expect(msgs(daemon.readHistory({ chatId, fromSeq: 0, limit: 200 }).events)).toEqual(
        liveMessages,
      );

      // A surface reconnecting with the highest seq it saw live gets nothing
      // back — no re-delivered prompt at an invented tail seq.
      const highestLive = Math.max(
        ...events.map(seqOf).filter((n): n is number => typeof n === 'number'),
      );
      const tail: WireEvent[] = [];
      daemon.replayChat(chatId, highestLive, (e) => tail.push(e));
      expect(msgs(tail)).toEqual([]);
    });

    it('chat.message_delta.messageSeq equals the seq its finalising chat.message replays under', async () => {
      const { daemon, sdk, events, folder } = setupPersisting();
      sdk.enqueue([
        { type: 'assistant_delta', content: 'strea' },
        { type: 'assistant_delta', content: 'med' },
        { type: 'assistant', content: 'streamed' },
        { type: 'result' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));

      const deltaSeqs = [
        ...new Set(
          events
            .filter((e) => e.type === 'chat.message_delta')
            .map((e) => (e as unknown as { messageSeq: number }).messageSeq),
        ),
      ];
      expect(deltaSeqs).toEqual([1]);
      const persisted = daemon.readHistory({ chatId, fromSeq: 0, limit: 200 }).events;
      const reply = persisted.find(
        (e) => e.type === 'chat.message' && (e as { role: string }).role === 'assistant',
      );
      // The accumulator key IS the durable message's seq, in both stores.
      expect(seqOf(reply as WireEvent)).toBe(1);
    });

    it('live-only events carry no seq and are never persisted or replayed', async () => {
      const { daemon, sdk, events, folder } = setupPersisting();
      sdk.enqueue([
        { type: 'assistant_delta', content: 'hi' },
        { type: 'assistant', content: 'hi' },
        { type: 'result' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 30));

      const liveOnly = new Set([
        'chat.message_delta',
        'chat.queued',
        'chat.dequeued',
        'chat.input_ack',
      ]);
      const emittedLiveOnly = events.filter((e) => liveOnly.has(e.type));
      expect(emittedLiveOnly.length).toBeGreaterThan(0);
      for (const e of emittedLiveOnly) expect((e as { seq?: number }).seq).toBeUndefined();

      const replayed: WireEvent[] = [];
      daemon.replayChat(chatId, -1, (e) => replayed.push(e));
      for (const e of [...replayed, ...daemon.readHistory({ chatId, fromSeq: 0 }).events]) {
        expect(liveOnly.has(e.type)).toBe(false);
      }
    });

    it('the canonical seq survives a host restart — it is on disk, not in the ring', async () => {
      const { daemon, sdk, folder, home, projectsRoot, events } = setupPersisting();
      sdk.enqueue([{ type: 'assistant', content: 'persisted reply' }, { type: 'result' }]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'ask me' });
      await new Promise((r) => setTimeout(r, 30));
      const before = msgs(events);
      daemon.shutdown();

      // Fresh process: nothing in memory, everything from ~/.patch + transcript.
      const restarted = new Daemon({
        daemonId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: createMockSdkBackend({ claudeProjectsRoot: projectsRoot }),
        historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
        oauthAccessToken: 'fake-token',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
      });
      restarted.hydrate();
      const replayed: WireEvent[] = [];
      restarted.replayChat(chatId, -1, (e) => replayed.push(e));
      expect(msgs(replayed)).toEqual(before);
      restarted.shutdown();
    });
  });

  describe('attachmentFileName', () => {
    it('sanitizes unsafe characters and falls back to "file" when nothing safe remains', () => {
      expect(attachmentFileName('id1', 'a b/c.png')).toBe('id1-c.png');
      // An empty name sanitizes to an empty string, falling back to 'file'.
      expect(attachmentFileName('id2', '')).toBe('id2-file');
      expect(attachmentFileName('id3', '...')).toBe('id3-_');
    });
  });

  describe("firstUserPreviewFromHistory loop branches (via a chat's own log)", () => {
    // The log is fully schema-validated on every read (`LogRecord.safeParse`),
    // so a genuinely malformed record (e.g. non-string content) can't reach
    // this loop at all — only the type/role skips below are reachable with
    // real, well-typed log content. Writing them straight to disk drives
    // those branches through the real public path (hydrate -> readHistory ->
    // readTrack) without needing a stub reader the log-based path no longer
    // consults.
    it('skips a non-chat.message event and a non-user-role message, landing on the first usable one', () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-preview-loop-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-preview-loop-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const chatId = 'preview-loop-chat';
      const branchId = `${chatId}-b0`;
      metaStore.write({
        chatId,
        folder,
        name: null,
        claudeSessionId: 'sess-loop',
        nextSeq: 3,
        createdAt: 1,
        updatedAt: 2,
      });
      const logDir = join(home, 'chats', chatId);
      mkdirSync(logDir, { recursive: true });
      const records = [
        { v: 1, seq: 0, at: 1, branchId, rec: { k: 'log.start', legacyUpTo: 0 } },
        // Not a chat.message at all -> the `ev.type !== 'chat.message'` continue.
        {
          v: 1,
          seq: 0,
          at: 1,
          branchId,
          rec: {
            k: 'event',
            event: { type: 'chat.tool_call', chatId, tool: 'Read', args: {}, callId: 'c1', seq: 0 },
          },
        },
        // chat.message but role !== 'user' -> skipped.
        {
          v: 1,
          seq: 1,
          at: 1,
          branchId,
          rec: {
            k: 'event',
            event: { type: 'chat.message', chatId, role: 'assistant', content: 'not it', seq: 1 },
          },
        },
        // Finally, a normal usable user text line.
        {
          v: 1,
          seq: 2,
          at: 1,
          branchId,
          rec: {
            k: 'event',
            event: {
              type: 'chat.message',
              chatId,
              role: 'user',
              content: 'the real preview text',
              seq: 2,
            },
          },
        },
      ];
      writeFileSync(
        join(logDir, 'events.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: createMockSdkBackend(),
        historyReader: createHistoryReader({ claudeProjectsRoot: folder }),
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'unused',
      });
      daemon.hydrate();
      expect(daemon.chatState.get(chatId)?.preview).toBe('the real preview text');
    });
  });

  describe('resumeChat / replayChat / readHistory / sendInput: not-found and validation branches', () => {
    it('resumeChat throws ChatNotFoundError for a chat unknown both in-memory and on disk', async () => {
      const { daemon } = setup();
      await expect(daemon.resumeChat('totally-unknown')).rejects.toThrow(/chat not found/);
    });

    it('resumeChat throws ChatNotFoundError when the persisted meta hydrates under a different chatId (data-integrity guard)', async () => {
      const fakeMetaStore: MetaStore = {
        pathFor: () => '/dev/null/unused',
        list: () => [],
        read: (id) =>
          id === 'requested-id'
            ? {
                chatId: 'a-completely-different-id',
                folder: '/tmp',
                name: null,
                nextSeq: 0,
                createdAt: 1,
                updatedAt: 2,
              }
            : undefined,
        write: () => undefined,
        update: (_id, mut) =>
          mut({ chatId: _id, folder: '/tmp', name: null, nextSeq: 0, createdAt: 1, updatedAt: 2 }),
        writeSeq: () => undefined,
        readSeq: () => undefined,
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore: fakeMetaStore,
        sdkBackend: createMockSdkBackend(),
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'unused',
      });
      await expect(daemon.resumeChat('requested-id')).rejects.toThrow(/chat not found/);
    });

    it('replayChat throws ChatNotFoundError for an unknown chat', () => {
      const { daemon } = setup();
      expect(() => daemon.replayChat('totally-unknown', -1, () => undefined)).toThrow(
        /chat not found/,
      );
    });

    it('readHistory throws ChatNotFoundError for an unknown chat', () => {
      const { daemon } = setup();
      expect(() => daemon.readHistory({ chatId: 'totally-unknown' })).toThrow(/chat not found/);
    });

    it('sendInput throws ChatNotFoundError for an unknown chat', async () => {
      const { daemon } = setup();
      await expect(
        daemon.sendInput({ chatId: 'totally-unknown', message: 'hi', localId: 'L1' }),
      ).rejects.toThrow(/chat not found/);
    });

    it('sendInput prepends voicePrefix to the message when supplied', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([{ type: 'result', sessionId: 's1' }]);
      const chatId = await daemon.spawnChat({ folder });
      await daemon.sendInput({
        chatId,
        message: 'is the door locked?',
        localId: 'L1',
        voicePrefix: '[voice] ',
      });
      expect(sdk.lastOptions()?.prompt).toBe('[voice] is the door locked?');
    });
  });

  describe('setPinned / setArchived: the un-set (false) ternary branches', () => {
    it('unpinning sets pinnedAt back to null', async () => {
      const { daemon, folder, metaStore } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await daemon.setPinned(chatId, true);
      expect(daemon.chatState.get(chatId)?.pinnedAt).not.toBeNull();
      await daemon.setPinned(chatId, false);
      expect(daemon.chatState.get(chatId)?.pinnedAt).toBeNull();
      expect(metaStore.read(chatId)?.pinnedAt ?? null).toBeNull();
    });

    it('unarchiving sets archivedAt back to null', async () => {
      const { daemon, folder, metaStore } = setup();
      const chatId = await daemon.spawnChat({ folder });
      await daemon.setArchived(chatId, true);
      expect(daemon.chatState.get(chatId)?.archivedAt).not.toBeNull();
      await daemon.setArchived(chatId, false);
      expect(daemon.chatState.get(chatId)?.archivedAt).toBeNull();
      expect(metaStore.read(chatId)?.archivedAt ?? null).toBeNull();
    });
  });

  describe('drainQueue: a queued turn that fails does not fire onTurnCommitted', () => {
    it('a queued turn erroring settles without calling onTurnCommitted for it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-queue-fail-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-queue-fail-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const committed: string[] = [];
      const failing: SdkBackend = {
        async *run() {
          throw new Error('second turn blew up');
        },
      };
      // A backend whose FIRST turn succeeds instantly and whose SECOND turn
      // throws — lets a real turn queue behind the first via a small delay.
      let call = 0;
      const backend: SdkBackend = {
        async *run(opts) {
          call += 1;
          if (call === 1) {
            await new Promise((r) => setTimeout(r, 30));
            yield { type: 'assistant', content: 'ok', sessionId: 's1' };
            return;
          }
          // Triggers failing.run's synchronous throw on the first .next().
          await failing.run(opts).next();
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'queue-fail-1',
        onTurnCommitted: (chatId) => committed.push(chatId),
      });
      const chatId = await daemon.spawnChat({ folder });
      const p1 = daemon.sendInput({ chatId, message: 'a', localId: 'A' });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = daemon.sendInput({ chatId, message: 'b', localId: 'B' }); // queues behind A
      await Promise.all([p1, p2]);
      expect(committed).toEqual([chatId]); // only turn A committed; B errored
      expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    });

    it('a queued turn that SUCCEEDS with no onTurnCommitted hook configured is a safe no-op', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-queue-nohook-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-queue-nohook-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const backend: SdkBackend = {
        async *run(opts) {
          await new Promise((r) => setTimeout(r, 20));
          yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 's1' };
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'queue-nohook-1',
        // onTurnCommitted intentionally left undefined.
      });
      const chatId = await daemon.spawnChat({ folder });
      const p1 = daemon.sendInput({ chatId, message: 'a', localId: 'A' });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = daemon.sendInput({ chatId, message: 'b', localId: 'B' }); // queues behind A, then succeeds via drainQueue
      await expect(Promise.all([p1, p2])).resolves.toBeDefined();
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    });

    it('a queued turn that SUCCEEDS calls a configured onTurnCommitted hook (drainQueue path)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-queue-hook-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-queue-hook-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const backend: SdkBackend = {
        async *run(opts) {
          await new Promise((r) => setTimeout(r, 20));
          yield { type: 'assistant', content: `reply:${opts.prompt}`, sessionId: 's1' };
        },
      };
      const committed: string[] = [];
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'queue-hook-1',
        onTurnCommitted: (chatId) => committed.push(chatId),
      });
      const chatId = await daemon.spawnChat({ folder });
      const p1 = daemon.sendInput({ chatId, message: 'a', localId: 'A' });
      await new Promise((r) => setTimeout(r, 5));
      const p2 = daemon.sendInput({ chatId, message: 'b', localId: 'B' }); // queues behind A, then succeeds via drainQueue
      await Promise.all([p1, p2]);
      // Turn A commits via the run-now path, turn B via drainQueue — both call
      // the hook.
      expect(committed).toEqual([chatId, chatId]);
    });
  });

  describe('maybeGenerateTitle: remaining branches', () => {
    function setupTitle(
      generateTitle: (input: {
        chatId: string;
        firstUserMessage: string;
        folder: string;
      }) => Promise<string | null>,
    ) {
      const home = mkdtempSync(join(tmpdir(), 'patch-title2-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-title2-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const events: WireEvent[] = [];
      const sdk = createMockSdkBackend();
      let id = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'tok',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-t2-${++id}`,
        generateTitle,
        // Real default is 3s between retry attempts; keep these tests fast.
        titleGenRetryDelayMs: 1,
      });
      return { daemon, sdk, events, folder, metaStore };
    }

    it('does not regenerate when the chat already has a name (state.name !== null)', async () => {
      let calls = 0;
      const { daemon, sdk, folder } = setupTitle(async () => {
        calls += 1;
        return 'Should Not Be Used';
      });
      const chatId = await daemon.spawnChat({ folder });
      // Give it a name BEFORE the first turn commits (e.g. a user-set title).
      const state = daemon.chatState.get(chatId)!;
      state.name = 'User Chosen Name';
      sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(0);
      expect(daemon.chatState.get(chatId)?.name).toBe('User Chosen Name');
    });

    it('never generates a title for a reserved special thread', async () => {
      let calls = 0;
      const { daemon, sdk, metaStore, folder } = setupTitle(async () => {
        calls += 1;
        return 'nope';
      });
      metaStore.write({
        chatId: 'thread_manager',
        folder,
        name: null,
        nextSeq: 0,
        createdAt: 1,
        updatedAt: 2,
      });
      daemon.hydrate();
      sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
      await daemon.sendInput({ chatId: 'thread_manager', message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(0);
      expect(daemon.chatState.get('thread_manager')?.name).toBeNull();
    });

    it('generates a title from a tool-only turn (no assistant text needed — title never waits on it)', async () => {
      const calls: string[] = [];
      const { daemon, sdk, folder } = setupTitle(async (input) => {
        calls.push(input.firstUserMessage);
        return 'Tool Turn Title';
      });
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([
        { type: 'tool_use', tool: { name: 'Read', args: { file_path: 'a.ts' }, callId: 'c1' } },
        { type: 'tool_result', toolResult: { name: 'Read', callId: 'c1', result: 'x' } },
        { type: 'result', sessionId: 's1' },
      ]);
      await daemon.sendInput({ chatId, message: 'read the file', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toEqual(['read the file']);
      expect(daemon.chatState.get(chatId)?.name).toBe('Tool Turn Title');
    });

    it('firstUserMessage keeps typed text ahead of a REAL attachment block (true branch of the ternary)', async () => {
      const calls: string[] = [];
      const { daemon, sdk, folder } = setupTitle(async (input) => {
        calls.push(input.firstUserMessage);
        return 'Titled';
      });
      const chatId = await daemon.spawnChat({ folder });
      daemon.storeAttachment({
        chatId,
        id: '01TITLE',
        name: 'shot.png',
        mimeType: 'image/png',
        kind: 'image',
        bytes: Buffer.from([1, 2, 3]),
      });
      sdk.enqueue([{ type: 'assistant', content: 'sure', sessionId: 's1' }]);
      await daemon.sendInput({
        chatId,
        message: 'look at this',
        localId: 'L1',
        attachments: [{ id: '01TITLE', name: 'shot.png', mimeType: 'image/png', kind: 'image' }],
      });
      await new Promise((r) => setTimeout(r, 30));
      // The typed text survives (block stripped), NOT the '(image attachment)' fallback.
      expect(calls[0]).toBe('look at this');
    });

    it('a name set concurrently while generateTitle is in flight is never clobbered', async () => {
      let resolveGen!: (title: string) => void;
      const { daemon, sdk, folder } = setupTitle(
        () => new Promise<string | null>((r) => (resolveGen = r)),
      );
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 20));
      // Something else names the chat WHILE generateTitle is still pending.
      const state = daemon.chatState.get(chatId)!;
      state.name = 'Set Elsewhere';
      resolveGen('Generated Title');
      await new Promise((r) => setTimeout(r, 20));
      expect(daemon.chatState.get(chatId)?.name).toBe('Set Elsewhere');
    });

    it('a generateTitle rejection is caught and leaves the name null once every retry is spent', async () => {
      const { daemon, sdk, folder } = setupTitle(async () => {
        throw new Error('title service down');
      });
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(daemon.chatState.get(chatId)?.name).toBeNull();
    });

    it('a title that fails its first attempts keeps retrying with backoff until it lands', async () => {
      let calls = 0;
      const { daemon, sdk, folder } = setupTitle(async () => {
        calls += 1;
        if (calls <= 3) throw new Error('aborted (host busy)');
        return 'Late Title';
      });
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'done', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'midnight deploy', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 60));
      expect(calls).toBe(4);
      expect(daemon.chatState.get(chatId)?.name).toBe('Late Title');
    });

    it('retries once after a transient failure and still names a job-spawned, single-message chat', async () => {
      // The exact shape a `spawn`-action job chat is in: ONE user message,
      // ever, so this single trigger is the only chance the chat ever gets.
      let calls = 0;
      const { daemon, sdk, folder } = setupTitle(async () => {
        calls += 1;
        if (calls === 1) throw new Error('title service down (transient)');
        return 'Recovered Title';
      });
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'daily report', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'run the report', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(2);
      expect(daemon.chatState.get(chatId)?.name).toBe('Recovered Title');
    });

    it('retries once after an empty first reply, not just a thrown error', async () => {
      let calls = 0;
      const { daemon, sdk, folder } = setupTitle(async () => {
        calls += 1;
        return calls === 1 ? null : 'Second Try Title';
      });
      const chatId = await daemon.spawnChat({ folder });
      sdk.enqueue([{ type: 'assistant', content: 'hi', sessionId: 's1' }]);
      await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(2);
      expect(daemon.chatState.get(chatId)?.name).toBe('Second Try Title');
    });
  });

  describe('chatNameInterval: periodic title regeneration', () => {
    function setupInterval(
      generateTitle: (input: {
        chatId: string;
        firstUserMessage: string;
        folder: string;
      }) => Promise<string | null>,
      chatNameInterval: number,
    ) {
      const home = mkdtempSync(join(tmpdir(), 'patch-interval-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-interval-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      const events: WireEvent[] = [];
      const sdk = createMockSdkBackend();
      let id = 0;
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'tok',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-iv-${++id}`,
        generateTitle,
        chatNameInterval,
      });
      return { daemon, sdk, events, folder, metaStore };
    }

    // Per-test message counter: each test resets it before calling sendMessages
    // so messages are named 'msg 0', 'msg 1' … globally within that test, and
    // localIds are never reused (avoiding the host's (chatId, localId) dedup
    // guard, which would silently swallow a message and shift all counter-based
    // regen assertions).
    let msgCounter = 0;

    function resetMsgCounter() {
      msgCounter = 0;
    }

    async function sendMessages(
      daemon: ReturnType<typeof setupInterval>['daemon'],
      sdk: ReturnType<typeof setupInterval>['sdk'],
      chatId: string,
      n: number,
    ) {
      for (let i = 0; i < n; i++) {
        const seq = msgCounter++;
        sdk.enqueue([{ type: 'assistant', content: `reply ${seq}`, sessionId: `s${seq}` }]);
        await daemon.sendInput({ chatId, message: `msg ${seq}`, localId: `L${seq}` });
        await new Promise((r) => setTimeout(r, 30));
      }
    }

    it('with interval=0 title is only generated once (first message), never regenerated', async () => {
      resetMsgCounter();
      const calls: string[] = [];
      const { daemon, sdk, folder } = setupInterval(async (input) => {
        calls.push(input.firstUserMessage);
        return `Title for: ${input.firstUserMessage}`;
      }, 0);
      const chatId = await daemon.spawnChat({ folder });
      // Send 5 messages — only the first should trigger title generation.
      await sendMessages(daemon, sdk, chatId, 5);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe('msg 0');
    });

    it('with interval=3 title regenerates every 3 messages after the first title', async () => {
      resetMsgCounter();
      const calls: string[] = [];
      let titleNum = 0;
      const { daemon, sdk, folder } = setupInterval(async (input) => {
        calls.push(input.firstUserMessage);
        return `Title ${++titleNum}`;
      }, 3);
      const chatId = await daemon.spawnChat({ folder });
      // Send 7 messages:
      //  msg 0 → first title (call 1)
      //  msg 1, msg 2 → no regen
      //  msg 3 → periodic regen (count=3, 3%3=0) (call 2)
      //  msg 4, msg 5 → no regen
      //  msg 6 → periodic regen (count=3 again after reset) (call 3)
      await sendMessages(daemon, sdk, chatId, 7);
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe('msg 0');
      // The periodic regen uses the triggering message as the prompt.
      expect(calls[1]).toBe('msg 3');
      expect(calls[2]).toBe('msg 6');
      // Final name is from the last regen.
      expect(daemon.chatState.get(chatId)?.name).toBe('Title 3');
    });

    it('periodic regen always overwrites the name even when a user had set one', async () => {
      resetMsgCounter();
      let titleNum = 0;
      const { daemon, sdk, folder } = setupInterval(async () => {
        return `Regen ${++titleNum}`;
      }, 2);
      const chatId = await daemon.spawnChat({ folder });
      await sendMessages(daemon, sdk, chatId, 1); // msg 0 → first title "Regen 1"
      // User overrides the name.
      const state = daemon.chatState.get(chatId)!;
      state.name = 'User Name';
      await sendMessages(daemon, sdk, chatId, 2); // msg 1 (no regen), msg 2 (count=2, 2%2=0 → regen)
      // Periodic regen overwrites user name.
      expect(daemon.chatState.get(chatId)?.name).toBe('Regen 2');
    });

    it('setChatNameInterval updates the interval live — subsequent messages use the new value', async () => {
      resetMsgCounter();
      const calls: string[] = [];
      const { daemon, sdk, folder } = setupInterval(async (input) => {
        calls.push(input.firstUserMessage);
        return `Title for ${input.firstUserMessage}`;
      }, 0);
      const chatId = await daemon.spawnChat({ folder });
      await sendMessages(daemon, sdk, chatId, 3); // msg 0 (first title), msg 1, msg 2 — no regen with interval=0
      expect(calls).toHaveLength(1);
      // Now switch to interval=2. Counter reset after first title, so next
      // regen fires 2 messages later.
      daemon.setChatNameInterval(2);
      await sendMessages(daemon, sdk, chatId, 2); // msg 3, msg 4 → count=2, 2%2=0 → regen
      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe('msg 4');
    });

    it('interval=1 regenerates on every message after the first title', async () => {
      resetMsgCounter();
      const calls: string[] = [];
      let n = 0;
      const { daemon, sdk, folder } = setupInterval(async (input) => {
        calls.push(input.firstUserMessage);
        return `T${++n}`;
      }, 1);
      const chatId = await daemon.spawnChat({ folder });
      await sendMessages(daemon, sdk, chatId, 4);
      // msg 0 → first title; msg 1, 2, 3 → each triggers regen.
      expect(calls).toHaveLength(4);
    });
  });

  describe('handleEnvelope: a bare permission-typed envelope with no permission payload is a no-op', () => {
    it('does not emit chat.permission_request', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        { type: 'permission' },
        { type: 'assistant', content: 'final', sessionId: 's1' },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      expect(
        events.some(
          (e) =>
            e.type === 'chat.permission_request' && (e as { chatId: string }).chatId === chatId,
        ),
      ).toBe(false);
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    });
  });

  describe('permission handling: mid-stream chat-state deletion', () => {
    it('a permission envelope for a chat deleted mid-stream fails loudly (bumpSeq guards it before any folder resolution)', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-perm-race-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-race-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let releaseGate: (() => void) | undefined;
      const backend: SdkBackend = {
        async *run() {
          yield { type: 'assistant', content: 'starting' };
          await new Promise<void>((r) => {
            releaseGate = r;
          });
          yield {
            type: 'permission',
            permission: {
              requestId: 'p-race',
              tool: 'Edit',
              args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
              description: 'edit',
            },
          };
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'race-perm-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      const p = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 15));
      daemon.chatState.delete(chatId); // simulate the chat vanishing mid-stream
      releaseGate?.();
      await expect(p).rejects.toThrow(/unknown chatId|bumpSeq/);
    });
  });

  describe('submitPermissionResponse: settles to "running" when the SDK query is still in flight', () => {
    it('a non-edit permission resolved while still running settles to running, not idle', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-perm-running-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-running-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let releaseGate: (() => void) | undefined;
      const backend: SdkBackend = {
        async *run() {
          yield {
            type: 'permission',
            permission: {
              requestId: 'p-run',
              tool: 'Bash',
              args: { command: 'ls' },
              description: 'ls',
            },
          };
          await new Promise<void>((r) => {
            releaseGate = r;
          });
          yield { type: 'assistant', content: 'done', sessionId: 's1' };
          yield { type: 'result', sessionId: 's1' };
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'perm-running-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      const p = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 15));
      daemon.submitPermissionResponse({ requestId: 'p-run', decision: 'approve' });
      // The SDK iterator is still parked on the gate -> the query is still running.
      expect(daemon.chatState.get(chatId)?.activity).toBe('running');
      releaseGate?.();
      await p;
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    });

    it('an edit permission resolved while still running settles to running, not idle', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-perm-running-edit-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-running-edit-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let releaseGate: (() => void) | undefined;
      const backend: SdkBackend = {
        async *run() {
          yield {
            type: 'permission',
            permission: {
              requestId: 'p-run-edit',
              tool: 'Edit',
              args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
              description: 'edit',
            },
          };
          await new Promise<void>((r) => {
            releaseGate = r;
          });
          yield { type: 'assistant', content: 'done', sessionId: 's1' };
          yield { type: 'result', sessionId: 's1' };
        },
      };
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'perm-running-edit-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      const p = daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 15));
      daemon.submitPermissionResponse({ requestId: 'p-run-edit', decision: 'approve' });
      expect(daemon.chatState.get(chatId)?.activity).toBe('running');
      releaseGate?.();
      await p;
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    });
  });

  describe('injectPermissionRequest: unknown chatId', () => {
    it('returns undefined and does not emit anything for an unknown chat', () => {
      const { daemon, events } = setup();
      const requestId = daemon.injectPermissionRequest('no-such-chat', 'Bash', 'rm -rf');
      expect(requestId).toBeUndefined();
      expect(events).toHaveLength(0);
    });
  });

  describe('getRecentEvents: an empty ring (chat with no events yet)', () => {
    it('returns an empty, non-truncated slice', async () => {
      const { daemon, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      const { events, truncated } = daemon.getRecentEvents(chatId, 50);
      expect(events).toEqual([]);
      expect(truncated).toBe(false);
    });
  });

  describe('computeEditInfo: Write/NotebookEdit tolerate missing args', () => {
    it('Write tool with no content arg defaults to empty', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-write-min',
            tool: 'Write',
            args: { file_path: 'x.txt' },
            description: 'write',
          },
        },
      ]);
      await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const permEv = events.find((e) => e.type === 'chat.permission_request') as
        | { request: { proposedDiff?: string } }
        | undefined;
      expect(permEv?.request.proposedDiff).toContain('@@ -1,0 +1,0 @@');
    });

    it('NotebookEdit tool with no old/new source args defaults to empty', async () => {
      const { daemon, sdk, events, folder } = setup();
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-nb-min',
            tool: 'NotebookEdit',
            args: { notebook_path: 'nb.ipynb' },
            description: 'edit nb',
          },
        },
      ]);
      await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));
      const permEv = events.find((e) => e.type === 'chat.permission_request') as
        | { request: { proposedDiff?: string } }
        | undefined;
      expect(permEv?.request.proposedDiff).toContain('@@ -1,0 +1,0 @@');
    });
  });

  describe('resolveAbsForChat: a chat folder stored with a trailing slash', () => {
    it('joins without doubling the slash', async () => {
      const { daemon, sdk, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder });
      // Force the chat's stored folder to carry a trailing slash.
      const state = daemon.chatState.get(chatId)!;
      state.folder = `${folder}/`;
      sdk.enqueue([
        {
          type: 'permission',
          permission: {
            requestId: 'p-trail',
            tool: 'Edit',
            args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
            description: 'edit',
          },
        },
      ]);
      await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
      await new Promise((r) => setTimeout(r, 20));
      void events;
      const dirty = [...daemon.dirtyFilePaths(chatId)];
      expect(dirty).toEqual([`${folder}/a.ts`]);
      expect(dirty[0]).not.toContain('//a.ts');
    });
  });

  describe('rate-limit envelopes (spec/10 § Surface in Settings — Usage)', () => {
    it('reports session/week windows via onRateLimit and drops the envelope as chat-invisible', async () => {
      const reports: Array<[string, string, unknown]> = [];
      const { daemon, sdk, events, folder } = setup({
        onRateLimit: (chatId, scope, window) => reports.push([chatId, scope, window]),
      });
      sdk.enqueue([
        {
          type: 'system',
          rateLimit: {
            scope: 'session',
            window: { status: 'allowed_warning', utilization: 0.82, resetsAt: 1_800_000_000_000 },
          },
        },
        {
          type: 'system',
          rateLimit: { scope: 'week', window: { status: 'allowed', utilization: 0.1 } },
        },
      ]);
      const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 20));

      // spec/10 § Backend credentials — multiple accounts: `onRateLimit` now
      // names WHICH chat's turn saw the reading, so the caller can attribute
      // usage to that chat's pinned account rather than always the active one.
      expect(reports).toEqual([
        [
          chatId,
          'session',
          { status: 'allowed_warning', utilization: 0.82, resetsAt: 1_800_000_000_000 },
        ],
        [chatId, 'week', { status: 'allowed', utilization: 0.1 }],
      ]);
      // No chat.message / chat.message_delta fell out of either envelope — a
      // rate-limit report is not chat content.
      const chatMessages = events.filter(
        (e) => e.type === 'chat.message' && (e as { chatId: string }).chatId === chatId,
      );
      expect(chatMessages).toHaveLength(1); // the user's own "go" turn only
    });

    it('is a no-op when the host was not given an onRateLimit hook', async () => {
      const { daemon, sdk, folder } = setup();
      sdk.enqueue([
        { type: 'system', rateLimit: { scope: 'session', window: { status: 'allowed' } } },
      ]);
      await expect(daemon.spawnChat({ folder, prompt: 'go' })).resolves.toBeTruthy();
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  describe('auto-resume on rate-limit error (Task 1)', () => {
    /**
     * Build a fake SdkBackend whose first run() throws a rate-limit error;
     * subsequent runs succeed with the provided envelopes. This lets us test
     * the auto-resume path without touching the real Anthropic API.
     */
    function makeThrowingBackend(
      errMsg: string,
      successEnvelopes: import('../src/sdkBackend.js').SdkEnvelope[],
    ): SdkBackend {
      let callCount = 0;
      return {
        async *run() {
          callCount++;
          if (callCount === 1) {
            throw new Error(errMsg);
          }
          // Subsequent run: yield the success script.
          for (const ev of successEnvelopes) {
            yield ev;
          }
        },
      };
    }

    it('when disabled (default): a rate-limit throw leaves the chat errored', async () => {
      const { home, folder, metaStore, events } = setup();
      const backend = makeThrowingBackend('API Error: 429 (too many requests)', []);
      let id = 0;
      const daemon = new Daemon({
        daemonId: 'd-rl',
        metaStore,
        sdkBackend: backend,
        oauthAccessToken: 'fake',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-rl-${++id}`,
      });
      void home;
      const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
      await new Promise((r) => setTimeout(r, 40));
      daemon.shutdown();

      // Chat should be in the errored activity state when auto-resume is off.
      // (status='active' since setActivity('errored') sets activity, not status)
      const state = daemon.chatState.get(chatId);
      expect(state?.activity).toBe('errored');
      // No rateLimitResumingAt emitted on chat.state (auto-resume was never armed).
      const stateEvents = events.filter(
        (e) => e.type === 'chat.state' && (e as { chatId: string }).chatId === chatId,
      );
      const lastState = stateEvents[stateEvents.length - 1] as
        | { rateLimitResumingAt?: number | null }
        | undefined;
      expect(lastState?.rateLimitResumingAt ?? null).toBeNull();
    });

    it('when enabled: a rate-limit throw arms an auto-resume timer and emits rateLimitResumingAt on chat.state', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-rl-'));
      const folder2 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rl-f-')));
      mkdirSync(folder2, { recursive: true });
      const metaStore2 = createMetaStore(home);
      const events2: WireEvent[] = [];

      const NOW = 1_700_000_000_000;
      // Succeed on second run so the timer-fired re-send lands cleanly.
      const backend2 = makeThrowingBackend('API Error: 429 (too many requests)', [
        { type: 'assistant', content: 'retried ok' },
        { type: 'result', sessionId: 'sess-retry' },
      ]);

      let id2 = 0;
      const daemon2 = new Daemon({
        daemonId: 'd-rl2',
        metaStore: metaStore2,
        sdkBackend: backend2,
        oauthAccessToken: 'fake',
        emit: (e) => events2.push(e),
        logger: silent,
        now: () => NOW,
        generateChatId: () => `chat-rl2-${++id2}`,
      });
      daemon2.setAutoResumeRateLimit(true);

      const chatId2 = await daemon2.spawnChat({ folder: folder2, prompt: 'try me' });
      // Let the initial failing turn run.
      await new Promise((r) => setTimeout(r, 40));

      // chat.state should carry a non-null rateLimitResumingAt (fallback = NOW + 60s).
      const stateEvents2 = events2.filter(
        (e) => e.type === 'chat.state' && (e as { chatId: string }).chatId === chatId2,
      );
      const pausedState = stateEvents2.find(
        (e) =>
          (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt !== null &&
          (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt !== undefined,
      ) as { rateLimitResumingAt: number } | undefined;
      expect(pausedState?.rateLimitResumingAt).toBeGreaterThan(NOW);

      // Parked, but a usage limit is a failed turn: errored (triangle), not idle (green tick).
      const state2 = daemon2.chatState.get(chatId2);
      expect(state2?.activity).toBe('errored');
      expect(state2?.status).not.toBe('errored');

      daemon2.shutdown();
    });

    it('when enabled: the resetsAt from a prior rate-limit (non-overload) window envelope is used as the resume time', async () => {
      const home3 = mkdtempSync(join(tmpdir(), 'patch-rl3-'));
      const folder3 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rl3-f-')));
      mkdirSync(folder3, { recursive: true });
      const metaStore3 = createMetaStore(home3);
      const events3: WireEvent[] = [];

      const NOW = 1_700_000_000_000;
      const RESETS_AT = NOW + 3_600_000; // 1 hour ahead — should be used as resume time.

      // First run: emit a rate-limit envelope (session scope), then throw a
      // usage-limit error (NOT a 529/overload). The host should schedule
      // the resume at RESETS_AT from the session window (Task 1 fix).
      let callCount3 = 0;
      const backend3: SdkBackend = {
        async *run() {
          callCount3++;
          if (callCount3 === 1) {
            // Yield the rate-limit system envelope first so lastResetsAtByScope is stored.
            yield {
              type: 'system' as const,
              rateLimit: {
                scope: 'session' as const,
                window: { status: 'rejected' as const, utilization: 1, resetsAt: RESETS_AT },
              },
            };
            throw new Error('usage_limit_exceeded');
          }
          // Second run (timer fires): succeed.
          yield { type: 'assistant' as const, content: 'ok' };
          yield { type: 'result' as const, sessionId: 'sess-3' };
        },
      };

      let id3 = 0;
      const daemon3 = new Daemon({
        daemonId: 'd-rl3',
        metaStore: metaStore3,
        sdkBackend: backend3,
        oauthAccessToken: 'fake',
        emit: (e) => events3.push(e),
        logger: silent,
        now: () => NOW,
        generateChatId: () => `chat-rl3-${++id3}`,
        onRateLimit: () => {},
      });
      daemon3.setAutoResumeRateLimit(true);

      const chatId3 = await daemon3.spawnChat({ folder: folder3, prompt: 'test' });
      await new Promise((r) => setTimeout(r, 40));

      // The scheduled resume time should equal RESETS_AT (not a fallback).
      const stateEvents3 = events3.filter(
        (e) => e.type === 'chat.state' && (e as { chatId: string }).chatId === chatId3,
      );
      const pausedState3 = stateEvents3.find(
        (e) => (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt != null,
      ) as { rateLimitResumingAt: number } | undefined;
      expect(pausedState3?.rateLimitResumingAt).toBe(RESETS_AT);

      daemon3.shutdown();
    });

    it('when enabled: 529/overloaded uses exponential backoff (Task 2), not the session resetsAt', async () => {
      const home3b = mkdtempSync(join(tmpdir(), 'patch-rl3b-'));
      const folder3b = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rl3b-f-')));
      mkdirSync(folder3b, { recursive: true });
      const metaStore3b = createMetaStore(home3b);
      const events3b: WireEvent[] = [];

      const NOW = 1_700_000_000_000;
      const RESETS_AT_FUTURE = NOW + 3_600_000; // 1 hour — should NOT be used for overload.

      // Run emits a session resetsAt then throws a 529 overload.
      let callCount3b = 0;
      const backend3b: SdkBackend = {
        async *run() {
          callCount3b++;
          if (callCount3b === 1) {
            yield {
              type: 'system' as const,
              rateLimit: {
                scope: 'session' as const,
                window: { status: 'rejected' as const, utilization: 1, resetsAt: RESETS_AT_FUTURE },
              },
            };
            throw new Error('API Error: 529 (overloaded_error)');
          }
          yield { type: 'assistant' as const, content: 'ok' };
          yield { type: 'result' as const, sessionId: 'sess-3b' };
        },
      };

      let id3b = 0;
      const daemon3b = new Daemon({
        daemonId: 'd-rl3b',
        metaStore: metaStore3b,
        sdkBackend: backend3b,
        oauthAccessToken: 'fake',
        emit: (e) => events3b.push(e),
        logger: silent,
        now: () => NOW,
        generateChatId: () => `chat-rl3b-${++id3b}`,
        onRateLimit: () => {},
      });
      daemon3b.setAutoResumeRateLimit(true);

      await daemon3b.spawnChat({ folder: folder3b, prompt: 'test' });
      await new Promise((r) => setTimeout(r, 40));

      // For a 529/overload the resume should use 5s backoff (first retry),
      // NOT the session's RESETS_AT_FUTURE (1 hour away).
      const stateEvents3b = events3b.filter((e) => e.type === 'chat.state');
      const pausedState3b = stateEvents3b.find(
        (e) => (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt != null,
      ) as { rateLimitResumingAt: number; resumeKind?: string } | undefined;
      // 5s backoff: NOW + 5000
      expect(pausedState3b?.rateLimitResumingAt).toBe(NOW + 5_000);
      expect(pausedState3b?.resumeKind).toBe('overloaded');

      daemon3b.shutdown();
    });

    it('when both session and week resetsAt are known, picks the soonest scope (Task 1)', async () => {
      const home3c = mkdtempSync(join(tmpdir(), 'patch-rl3c-'));
      const folder3c = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rl3c-f-')));
      mkdirSync(folder3c, { recursive: true });
      const metaStore3c = createMetaStore(home3c);
      const events3c: WireEvent[] = [];

      const NOW = 1_700_000_000_000;
      // Session resets in 1 hour; week resets in 3 days.
      const SESSION_RESETS_AT = NOW + 3_600_000;
      const WEEK_RESETS_AT = NOW + 3 * 24 * 3_600_000;

      let callCount3c = 0;
      const backend3c: SdkBackend = {
        async *run() {
          callCount3c++;
          if (callCount3c === 1) {
            // Emit both session and week envelopes — week arrives second.
            yield {
              type: 'system' as const,
              rateLimit: {
                scope: 'session' as const,
                window: {
                  status: 'rejected' as const,
                  utilization: 1,
                  resetsAt: SESSION_RESETS_AT,
                },
              },
            };
            yield {
              type: 'system' as const,
              rateLimit: {
                scope: 'week' as const,
                window: { status: 'allowed' as const, utilization: 0.2, resetsAt: WEEK_RESETS_AT },
              },
            };
            throw new Error('usage_limit_exceeded');
          }
          yield { type: 'assistant' as const, content: 'ok' };
          yield { type: 'result' as const, sessionId: 'sess-3c' };
        },
      };

      let id3c = 0;
      const daemon3c = new Daemon({
        daemonId: 'd-rl3c',
        metaStore: metaStore3c,
        sdkBackend: backend3c,
        oauthAccessToken: 'fake',
        emit: (e) => events3c.push(e),
        logger: silent,
        now: () => NOW,
        generateChatId: () => `chat-rl3c-${++id3c}`,
        onRateLimit: () => {},
      });
      daemon3c.setAutoResumeRateLimit(true);

      await daemon3c.spawnChat({ folder: folder3c, prompt: 'test' });
      await new Promise((r) => setTimeout(r, 40));

      // Should pick SESSION_RESETS_AT (1 hour), not WEEK_RESETS_AT (3 days).
      const pausedState3c = events3c
        .filter((e) => e.type === 'chat.state')
        .find((e) => (e as { rateLimitResumingAt?: number | null }).rateLimitResumingAt != null) as
        | { rateLimitResumingAt: number; resumeKind?: string }
        | undefined;
      expect(pausedState3c?.rateLimitResumingAt).toBe(SESSION_RESETS_AT);
      expect(pausedState3c?.resumeKind).toBe('rate_limit');

      daemon3c.shutdown();
    });

    it('setAutoResumeRateLimit toggle: enabling mid-session arms subsequent rate-limit errors', async () => {
      const home4 = mkdtempSync(join(tmpdir(), 'patch-rl4-'));
      const metaStore4 = createMetaStore(home4);
      const events4: WireEvent[] = [];
      const folder4 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rl4-f-')));
      mkdirSync(folder4, { recursive: true });

      const backend4 = makeThrowingBackend('usage_limit_exceeded', []);
      let id4 = 0;
      const daemon4 = new Daemon({
        daemonId: 'd-rl4',
        metaStore: metaStore4,
        sdkBackend: backend4,
        oauthAccessToken: 'fake',
        emit: (e) => events4.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-rl4-${++id4}`,
      });
      // Off by default.
      expect(daemon4['autoResumeRateLimitEnabled']).toBe(false);
      // Toggle on.
      daemon4.setAutoResumeRateLimit(true);
      expect(daemon4['autoResumeRateLimitEnabled']).toBe(true);

      const chatId4 = await daemon4.spawnChat({ folder: folder4, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 40));

      // Timer armed, and shown as errored (a usage limit is a failure, not a finish).
      const state4 = daemon4.chatState.get(chatId4);
      expect(state4?.activity).toBe('errored');
      expect(state4?.status).not.toBe('errored');

      daemon4.shutdown();
    });

    it('shutdown clears pending rate-limit timers (no dangling callbacks)', async () => {
      const home5 = mkdtempSync(join(tmpdir(), 'patch-rl5-'));
      const metaStore5 = createMetaStore(home5);
      const events5: WireEvent[] = [];
      const folder5 = realpathSync(mkdtempSync(join(tmpdir(), 'patch-rl5-f-')));
      mkdirSync(folder5, { recursive: true });

      // The second run would fail hard if it ever fires — shutdown should prevent it.
      let secondRunFired = false;
      const backend5: SdkBackend = {
        async *run() {
          if (!secondRunFired) {
            secondRunFired = false; // first run
            throw new Error('rate_limit_error');
          }
          secondRunFired = true;
          yield { type: 'assistant' as const, content: 'should not happen' };
        },
      };

      let id5 = 0;
      const daemon5 = new Daemon({
        daemonId: 'd-rl5',
        metaStore: metaStore5,
        sdkBackend: backend5,
        oauthAccessToken: 'fake',
        emit: (e) => events5.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-rl5-${++id5}`,
      });
      daemon5.setAutoResumeRateLimit(true);

      await daemon5.spawnChat({ folder: folder5, prompt: 'go' });
      await new Promise((r) => setTimeout(r, 40));

      // Timer is now pending. Shut down — should clear it.
      daemon5.shutdown();
      expect(daemon5['rateLimitTimers'].size).toBe(0);
      expect(daemon5['rateLimitPendingTurns'].size).toBe(0);
      void events5;
      void secondRunFired;
    });
  });

  describe('spec/14 § Sidebar ordering — lastUserActivity', () => {
    it('stamps lastUserActivity on a real user send (fromUser: true), both in memory and persisted', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-lua-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-lua-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let clock = 1_700_000_000_000;
      const sdk = createMockSdkBackend();
      sdk.enqueue([{ type: 'result', sessionId: 'sess-lua' }]);
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => clock,
        generateChatId: () => 'lua-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      expect(daemon.chatState.get(chatId)?.lastUserActivity).toBe(clock);
      expect(metaStore.read(chatId)?.lastUserActivity).toBe(clock);

      // Time passes, then the user sends another message.
      clock += 60_000;
      sdk.enqueue([{ type: 'result', sessionId: 'sess-lua' }]);
      await daemon.sendInput({ chatId, message: 'hi again', localId: 'L1', fromUser: true });
      expect(daemon.chatState.get(chatId)?.lastUserActivity).toBe(clock);
      expect(metaStore.read(chatId)?.lastUserActivity).toBe(clock);
    });

    it('a machine turn (self-wake, job tick, patch_send_to — origin: machine, no fromUser) never bumps lastUserActivity', async () => {
      const home = mkdtempSync(join(tmpdir(), 'patch-lua-machine-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-lua-machine-folder-')));
      mkdirSync(folder, { recursive: true });
      const metaStore = createMetaStore(home);
      let clock = 1_700_000_000_000;
      const sdk = createMockSdkBackend();
      sdk.enqueue([{ type: 'result', sessionId: 'sess-lua-m' }]);
      const daemon = new Daemon({
        daemonId: 'd1',
        metaStore,
        sdkBackend: sdk,
        oauthAccessToken: 'tok',
        emit: () => undefined,
        logger: silent,
        now: () => clock,
        generateChatId: () => 'lua-m-1',
      });
      const chatId = await daemon.spawnChat({ folder });
      const spawnedAt = daemon.chatState.get(chatId)?.lastUserActivity;
      expect(spawnedAt).toBe(clock);

      // Agent activity, status changes and finished turns all advance the
      // clock and `lastUpdated`, but none of them is a user send.
      clock += 60_000;
      sdk.enqueue([{ type: 'result', sessionId: 'sess-lua-m' }]);
      await daemon.sendInput({ chatId, message: 'machine tick', localId: 'L1', origin: 'machine' });
      expect(daemon.chatState.get(chatId)?.lastUpdated).not.toBe(spawnedAt);
      expect(daemon.chatState.get(chatId)?.lastUserActivity).toBe(spawnedAt);
      expect(metaStore.read(chatId)?.lastUserActivity).toBe(spawnedAt);
    });
  });
});
