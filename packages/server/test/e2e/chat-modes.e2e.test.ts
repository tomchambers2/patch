// End-to-end chat-mode suite — the safety net that would have caught the
// production "stuck with no response and no error" hangs.
//
// Every test boots the REAL server + REAL host over a REAL WebSocket link
// (see harness.ts) and drives one chat mode through the full round trip. Every
// "await a reply" is timeout-bounded via `waitReplyOrError` / `expectReply`: a
// silent hang (no reply AND no visible error) REJECTS and FAILS the test. That
// is the whole point — a turn that never completes must be loud, not invisible.
//
// The ONLY mock is the SDK backend (deterministic scripted replies, no
// Anthropic). Auth, transport, server hub, host serverLink, and the Host
// itself are all real.

import { describe, it, expect, afterEach } from 'vitest';
import {
  startHarness,
  expectReply,
  waitReplyOrError,
  record,
  until,
  type E2EHarness,
} from './harness.js';

/** Minimal PNG magic bytes — enough for an image/png attachment. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a multipart body the way attachments.test.ts does (fastify inject). */
function multipart(
  field: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
  extraFields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----patche2eboundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(extraFields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

/** Spawn a chat via the REAL REST route; return the server-allocated chatId. */
async function spawnChat(harness: E2EHarness, jwt: string, folder: string): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { daemonId: harness.daemonId, folder },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { chatId: string }).chatId;
}

describe('e2e chat modes: every turn replies or errors, never hangs', () => {
  // ---- Mode 1: new-chat spawn + first message ----
  it('mode 1 — new-chat spawn then first message replies; chat.spawned + chat.state seen', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-1');
    const client = await h.connectSurface('srf-1b');
    const stateEvents = record(client, ['chat.spawned', 'chat.state']);

    const chatId = await spawnChat(h, jwt, h.folder);
    await until(
      () => stateEvents.some((e) => e.type === 'chat.spawned' && e.chatId === chatId),
      3000,
      'chat.spawned fanned out',
    );
    await until(
      () => stateEvents.some((e) => e.type === 'chat.state' && e.chatId === chatId),
      3000,
      'chat.state fanned out',
    );

    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'hello world', localId: 'L1' });
    const reply = await expectReply(client, chatId, 'mode 1');
    expect(reply.content).toContain('hello world');
    await client.close();
  });

  // ---- Mode 2: existing-chat message ----
  it('mode 2 — a second message to an existing chat replies', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-2');
    const client = await h.connectSurface('srf-2b');
    const chatId = await spawnChat(h, jwt, h.folder);

    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'first', localId: 'L1' });
    await expectReply(client, chatId, 'mode 2 (first turn)');

    client.sendInput({ chatId, message: 'second existing-chat turn', localId: 'L2' });
    const reply = await expectReply(client, chatId, 'mode 2 (second turn)');
    expect(reply.content).toContain('second existing-chat turn');
    await client.close();
  });

  // ---- Mode 3: text-only turn ----
  it('mode 3 — a plain text-only turn replies', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-3');
    const client = await h.connectSurface('srf-3b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'just text', localId: 'L1' });
    const reply = await expectReply(client, chatId, 'mode 3');
    expect(reply.role).toBe('assistant');
    await client.close();
  });

  // ---- Mode 4: attachment / image turn (the production breakage) ----
  it('mode 4 — image attachment turn replies; ref present; replay strips [Attachments] + rebuilds ref', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-4');
    const client = await h.connectSurface('srf-4b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    // (a) Upload the image over the REAL multipart route → server stores + round
    //     trips the bytes to the host over the real WS link.
    const mp = multipart('file', 'shot.png', 'image/png', PNG);
    const up = await h.built.app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/attachment`,
      headers: { authorization: `Bearer ${jwt}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(up.statusCode).toBe(200);
    const ref = (up.json() as { ref: { id: string; name: string; mimeType: string; kind: string } })
      .ref;
    expect(ref.kind).toBe('image');

    // (b) Image-ONLY turn (no typed text) still produces a reply. The
    //     WireTestClient.sendInput helper can't carry attachments, so send the
    //     raw chat.input. AttachmentRef is strict — pass exactly its 4 fields.
    //     (The host does not echo a live user chat.message — the user turn's
    //     ref is asserted on replay below, where it is reconstructed.)
    client.send({
      type: 'chat.input',
      chatId,
      message: '',
      localId: 'L1img',
      attachments: [{ id: ref.id, name: ref.name, mimeType: ref.mimeType, kind: 'image' }],
    });
    const reply = await expectReply(client, chatId, 'mode 4 (image-only)');
    expect(reply.role).toBe('assistant');

    // (c) Fresh surface replays → the user message's image ref is reconstructed
    //     (hydrateReplayAttachments) and the [Attachments] block is stripped.
    await client.close();
    const client2 = await h.connectSurface('srf-4c');
    const replayMsgs = record(client2, ['chat.message']);
    client2.replay(chatId, -1);
    await until(
      () =>
        replayMsgs.some(
          (e) =>
            e.type === 'chat.message' &&
            e.role === 'user' &&
            (e as { attachments?: { id: string }[] }).attachments?.some((a) => a.id === ref.id) ===
              true,
        ),
      3000,
      'replay rebuilds the image ref',
    );
    const replayedUser = replayMsgs.find(
      (e) =>
        e.type === 'chat.message' &&
        e.role === 'user' &&
        (e as { attachments?: { id: string }[] }).attachments?.some((a) => a.id === ref.id),
    ) as { content: string } | undefined;
    expect(replayedUser?.content ?? '').not.toContain('[Attachments]');
    await client2.close();
  });

  // ---- Mode 5: voice-note turn ----
  it('mode 5 — voice-note upload transcribes → turn → reply (Whisper stubbed, route real)', async () => {
    h = await startHarness({ transcribe: async () => 'turn the lights on' });
    const jwt = await h.mintSurface('srf-5');
    const client = await h.connectSurface('srf-5b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });
    // Let the focus subscription land before the injected turn streams back.
    await new Promise((r) => setTimeout(r, 30));

    const mp = multipart('audio', 'note.m4a', 'audio/mp4', Buffer.from('fake-m4a-bytes'), {
      chatId,
    });
    const res = await h.built.app.inject({
      method: 'POST',
      url: '/api/voice/note',
      headers: { authorization: `Bearer ${jwt}`, ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { transcript: string }).transcript).toBe('turn the lights on');

    const reply = await expectReply(client, chatId, 'mode 5');
    // The host prepends `[voice • mobile]` to the transcript; the mock echoes it.
    expect(reply.content).toContain('turn the lights on');
    await client.close();
  });

  // ---- Mode 6: special thread (manager) ----
  it('mode 6 — the manager special thread replies to a message', async () => {
    h = await startHarness({ specialThreads: true });
    const client = await h.connectSurface('srf-6');
    // thread_manager was bootstrapped + replayed on link auth; wait for the
    // server to learn it, then message it.
    const chatId = 'thread_manager';
    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'manager, status?', localId: 'L1' });
    const reply = await expectReply(client, chatId, 'mode 6 (manager thread)');
    expect(reply.role).toBe('assistant');
    await client.close();
  });

  // ---- Mode 7: message queueing ----
  it('mode 7 — turn B queued behind running turn A; both reply in order', async () => {
    h = await startHarness({ turnDelayMs: 400 });
    const jwt = await h.mintSurface('srf-7');
    const client = await h.connectSurface('srf-7b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const replies: string[] = [];
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') replies.push(e.content);
    });
    const queued = record(client, ['chat.queued']);

    client.sendInput({ chatId, message: 'turn-A', localId: 'A' });
    // Send B while A is still holding its working window.
    await new Promise((r) => setTimeout(r, 50));
    client.sendInput({ chatId, message: 'turn-B', localId: 'B' });

    // B is queued behind A.
    await until(
      () => queued.some((e) => e.type === 'chat.queued' && e.localId === 'B'),
      3000,
      'turn B queued',
    );
    // Both drain, A before B.
    await until(() => replies.length >= 2, 5000, 'both turns replied');
    expect(replies[0]).toContain('turn-A');
    expect(replies[1]).toContain('turn-B');
    await client.close();
  });

  // ---- Mode 8: stop / interrupt ----
  it('mode 8 — a running turn is stopped and settles to idle (no hang)', async () => {
    h = await startHarness({ turnDelayMs: 1500 });
    const jwt = await h.mintSurface('srf-8');
    const client = await h.connectSurface('srf-8b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const states = record(client, ['chat.state', 'chat.stopped']);
    // Wait until the chat is actually running before stopping.
    client.sendInput({ chatId, message: 'long turn', localId: 'A' });
    await until(
      () =>
        states.some(
          (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'running',
        ),
      3000,
      'turn running',
    );
    client.send({ type: 'chat.stop_request', chatId });

    await until(
      () => states.some((e) => e.type === 'chat.stopped' && e.chatId === chatId),
      3000,
      'chat.stopped received',
    );
    await until(
      () =>
        states.some((e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'idle'),
      3000,
      'chat settled to idle after stop',
    );
    await client.close();
  });

  // ---- Mode 9: streaming deltas ----
  it('mode 9 — assistant_delta chunks fan out then ONE final chat.message at the reserved seq', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-9');
    const client = await h.connectSurface('srf-9b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const deltas = record(client, ['chat.message_delta']);
    const finals: { seq: number; content: string }[] = [];
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant')
        finals.push({ seq: e.seq, content: e.content });
    });

    client.sendInput({ chatId, message: 'stream me a reply', localId: 'L1' });
    const reply = await expectReply(client, chatId, 'mode 9');

    // At least one delta streamed, and exactly one final assistant message.
    expect(deltas.length).toBeGreaterThan(0);
    expect(finals.length).toBe(1);
    // The final message's seq equals the messageSeq the deltas reserved.
    const messageSeqs = new Set(
      deltas
        .filter((d) => d.type === 'chat.message_delta' && d.chatId === chatId)
        .map((d) => (d as { messageSeq: number }).messageSeq),
    );
    expect(messageSeqs.has(reply.seq)).toBe(true);
    // Concatenated deltas reconstruct the final text.
    const concat = deltas
      .filter((d) => d.type === 'chat.message_delta' && d.chatId === chatId)
      .map((d) => (d as { delta: string }).delta)
      .join('');
    expect(concat).toBe(reply.content);
    await client.close();
  });

  // ---- Mode 10: replay / reconnect ----
  it('mode 10 — reconnecting surface replays chat history seq-correctly', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-10');
    const client = await h.connectSurface('srf-10b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'remember this', localId: 'L1' });
    const original = await expectReply(client, chatId, 'mode 10 (live)');
    await client.close();

    // Fresh surface reconnects and replays from scratch.
    const client2 = await h.connectSurface('srf-10c');
    const replayMsgs: { role: string; content: string; seq: number }[] = [];
    client2.on('chat.message', (e) => {
      if (e.chatId === chatId) replayMsgs.push({ role: e.role, content: e.content, seq: e.seq });
    });
    client2.replay(chatId, -1);
    await until(
      () => replayMsgs.some((m) => m.role === 'assistant' && m.content === original.content),
      3000,
      'replay reconstructs the assistant reply',
    );
    // History includes the user turn too, seq-ordered.
    await until(() => replayMsgs.some((m) => m.role === 'user'), 3000, 'replay includes user turn');
    const seqs = replayMsgs.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    await client2.close();
  });

  // ---- Mode 11: RELIABILITY — host drops mid-turn ----
  it('mode 11 — host link dropped mid-turn errors the chat LOUDLY (not a silent hang)', async () => {
    h = await startHarness({ turnDelayMs: 2000 });
    const jwt = await h.mintSurface('srf-11');
    const client = await h.connectSurface('srf-11b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const states = record(client, ['chat.state']);
    client.sendInput({ chatId, message: 'long-running turn', localId: 'A' });
    await until(
      () =>
        states.some(
          (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'running',
        ),
      3000,
      'turn running',
    );

    // Drop the host's server-link socket mid-turn.
    expect(h.dropDaemonLink()).toBe(true);

    // The chat must resolve to a VISIBLE error + errored state — NOT hang.
    const outcome = await waitReplyOrError(client, chatId, 'mode 11', 4000);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.event.error.code).toBe('daemon_unavailable');
    }
    await until(
      () =>
        states.some(
          (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity === 'errored',
        ),
      3000,
      'chat.state flips to errored',
    );
    await client.close();
  });

  // ---- Mode 12: RELIABILITY — turn submitted while the host link is DOWN ----
  it('mode 12 — a turn submitted while the host link is down is delivered on reconnect (no forever-pending)', async () => {
    // A deterministic ~250ms offline window so the "submit while down" step
    // reliably lands during the offline period (not racing a fast reconnect).
    h = await startHarness({ daemonBackoffMs: [250, 250] });
    const jwt = await h.mintSurface('srf-12');
    const client = await h.connectSurface('srf-12b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    // Bring the host link down and wait until the SERVER observes it offline,
    // so the input is buffered (not written to a dying socket).
    expect(h.dropDaemonLink()).toBe(true);
    await h.waitDaemonOffline();

    // Submit a turn while down. Correct behaviour: buffered + delivered on
    // reconnect (a), OR a prompt chat.error (b). A silent forever-pending FAILS.
    client.sendInput({ chatId, message: 'submitted while offline', localId: 'A' });

    // The host serverLink auto-reconnects (short backoff); the buffered input
    // must then run and reply — or the surface must get a visible error.
    const outcome = await waitReplyOrError(client, chatId, 'mode 12', 6000);
    if (outcome.kind === 'reply') {
      expect(outcome.event.content).toContain('submitted while offline');
    } else {
      // (b) is also acceptable — a loud, actionable error.
      expect(outcome.event.error.code).toBeTruthy();
    }
    await client.close();
  });

  // ---- Mode 13: AI title generation ----
  it('mode 13 — chat.state carries the AI name from the first message; not regenerated on turn 2', async () => {
    h = await startHarness({ generateTitle: async () => 'Generated Title' });
    const jwt = await h.mintSurface('srf-13');
    const client = await h.connectSurface('srf-13b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const states = record(client, ['chat.state']);
    client.sendInput({ chatId, message: 'first', localId: 'L1' });
    await expectReply(client, chatId, 'mode 13 (turn 1)');
    await until(
      () =>
        states.some(
          (e) => e.type === 'chat.state' && e.chatId === chatId && e.name === 'Generated Title',
        ),
      3000,
      'chat.state carries the AI name',
    );
    expect(h.titleCalls()).toBe(1);

    // Second turn must NOT regenerate the title.
    client.sendInput({ chatId, message: 'second', localId: 'L2' });
    await expectReply(client, chatId, 'mode 13 (turn 2)');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.titleCalls()).toBe(1);
    await client.close();
  });

  // ---- Mode 14: tool call + tool result ----
  it('mode 14 — tool_call and tool_result events reach the surface', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-14');
    const client = await h.connectSurface('srf-14b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const toolCalls = record(client, ['chat.tool_call', 'chat.tool_result']);
    const assistantContents: string[] = [];
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') assistantContents.push(e.content);
    });
    // Script a tool_use + tool_result turn deterministically.
    h.sdk.enqueue([
      { type: 'assistant', content: 'let me read a file' },
      { type: 'tool_use', tool: { name: 'Read', args: { file_path: 'a.ts' }, callId: 'call-1' } },
      { type: 'tool_result', toolResult: { name: 'Read', callId: 'call-1', result: 'contents' } },
      { type: 'assistant', content: 'done reading' },
      { type: 'result', sessionId: 'sess-14' },
    ]);
    client.sendInput({ chatId, message: 'use a tool', localId: 'L1' });
    // The turn completes (reply or error — never a hang) and both assistant
    // messages arrive.
    await expectReply(client, chatId, 'mode 14');
    await until(
      () => assistantContents.includes('done reading'),
      3000,
      'final assistant message arrived',
    );

    await until(
      () =>
        toolCalls.some(
          (e) => e.type === 'chat.tool_call' && (e as { tool: string }).tool === 'Read',
        ),
      3000,
      'chat.tool_call reached the surface',
    );
    await until(
      () =>
        toolCalls.some(
          (e) => e.type === 'chat.tool_result' && (e as { callId: string }).callId === 'call-1',
        ),
      3000,
      'chat.tool_result reached the surface',
    );
    await client.close();
  });

  // ---- Mode 15: RELIABILITY — link FLAP loses the input in transit ----
  // The production bug: a chat.input handed to a host socket that dies a beat
  // later is gone with NO error and NO reply — it was never buffered (the server
  // thought the host was online at send time). spec/12 § Guaranteed input
  // delivery closes it: the surface holds the input pending and its
  // pending-timeout REDELIVERY (same localId) heals it; the host dedups so the
  // eventual delivery runs exactly once. FAILS pre-fix: the server used to DROP
  // the duplicate localId, so the retry never reached the host → forever hang.
  it('mode 15 — FLAP: an input lost to a dying socket is redelivered by the surface retry → exactly ONE reply', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-15');
    const client = await h.connectSurface('srf-15b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const replies: string[] = [];
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') replies.push(e.content);
    });
    const acks = record(client, ['chat.input_ack']);

    // Host is ONLINE, but the first delivery of this input is lost in transit.
    h.dropNextInput('flap-1');
    client.sendInput({ chatId, message: 'flappy turn', localId: 'flap-1' });

    // The lost send produces nothing — no reply, no receipt (the host never
    // saw it). This is precisely the silent-hang state the surface must not sit
    // in forever.
    await new Promise((r) => setTimeout(r, 300));
    expect(replies.length).toBe(0);
    expect(acks.length).toBe(0);

    // The surface's pending-timeout redelivery (same localId). The server must
    // FORWARD it despite having already observed the localId — the host is the
    // dedup authority — so the host runs it fresh → one receipt + one reply.
    client.sendInput({ chatId, message: 'flappy turn', localId: 'flap-1' });
    const reply = await expectReply(client, chatId, 'mode 15');
    expect(reply.content).toContain('flappy turn');

    // A further redelivery is a safe no-op (host dedups) — still ONE reply.
    client.sendInput({ chatId, message: 'flappy turn', localId: 'flap-1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(replies.length).toBe(1);
    expect(
      acks.some(
        (e) => e.type === 'chat.input_ack' && (e as { localId: string }).localId === 'flap-1',
      ),
    ).toBe(true);
    await client.close();
  });

  // ---- Mode 16: RELIABILITY — SERVER-RESTART-STYLE loss of a buffered input ----
  // The server→host buffer is in-memory, so a server restart drops it. The
  // surface still holds the un-acked input; its pending-timeout redelivery
  // delivers it once the link is back (spec/12 — "the surface is the source of
  // truth until it sees an ack"). Modelled by losing the buffered copy's flush.
  it('mode 16 — SERVER-RESTART-STYLE: a buffered input lost across a restart is redelivered on reconnect → ONE reply', async () => {
    h = await startHarness({ daemonBackoffMs: [150, 150] });
    const jwt = await h.mintSurface('srf-16');
    const client = await h.connectSurface('srf-16b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const replies: string[] = [];
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') replies.push(e.content);
    });

    // Host link down: the submit buffers server-side.
    expect(h.dropDaemonLink()).toBe(true);
    await h.waitDaemonOffline();

    // Model the restart losing the in-memory buffer: the buffered copy's flush
    // to the host on reconnect is swallowed, so it never runs.
    h.dropNextInput('restart-1');
    client.sendInput({ chatId, message: 'survives a restart', localId: 'restart-1' });

    // Link recovers; the buffer flushes but is lost — so no reply yet.
    await h.waitDaemonOnline();
    await new Promise((r) => setTimeout(r, 250));
    expect(replies.length).toBe(0);

    // The surface's pending-timeout redelivery (same localId) delivers it now
    // that the link is back → exactly one reply.
    client.sendInput({ chatId, message: 'survives a restart', localId: 'restart-1' });
    const reply = await expectReply(client, chatId, 'mode 16');
    expect(reply.content).toContain('survives a restart');
    expect(replies.length).toBe(1);
    await client.close();
  });

  // ---- Mode 17: the delivery receipt (chat.input_ack) ----
  it('mode 17 — a normal turn emits chat.input_ack (delivery receipt) no later than the reply', async () => {
    h = await startHarness({ turnDelayMs: 150 });
    const jwt = await h.mintSurface('srf-17');
    const client = await h.connectSurface('srf-17b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    let ackAt: number | null = null;
    let replyAt: number | null = null;
    client.on('chat.input_ack', (e) => {
      if (e.chatId === chatId && e.localId === 'L1' && ackAt === null) ackAt = Date.now();
    });
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant' && replyAt === null) replyAt = Date.now();
    });

    client.sendInput({ chatId, message: 'ack me', localId: 'L1' });
    await expectReply(client, chatId, 'mode 17');
    // The receipt arrived, and no later than the reply — so a surface tracking
    // this localId retires its pending state on the ack, before any output.
    expect(ackAt).not.toBeNull();
    expect(replyAt).not.toBeNull();
    expect(ackAt!).toBeLessThanOrEqual(replyAt!);
    await client.close();
  });

  // ---- Mode 18: dedup under retry — one user message, one turn ----
  it('mode 18 — redelivering the same localId never produces two user messages or two turns', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-18');
    const client = await h.connectSurface('srf-18b');
    const chatId = await spawnChat(h, jwt, h.folder);
    client.send({ type: 'chat.focus_change', chatId });

    const replies: string[] = [];
    client.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'assistant') replies.push(e.content);
    });
    const acks = record(client, ['chat.input_ack']);

    // Deliver, then redeliver the SAME localId (as a jittery retry loop would).
    // The host dedups: one turn, one reply — but every redelivery still gets a
    // receipt so a surface's retry always resolves rather than spinning.
    client.sendInput({ chatId, message: 'only once', localId: 'once-1' });
    await expectReply(client, chatId, 'mode 18');
    client.sendInput({ chatId, message: 'only once', localId: 'once-1' });
    client.sendInput({ chatId, message: 'only once', localId: 'once-1' });
    await new Promise((r) => setTimeout(r, 250));
    expect(replies.length).toBe(1);
    expect(
      acks.filter(
        (e) => e.type === 'chat.input_ack' && (e as { localId: string }).localId === 'once-1',
      ).length,
    ).toBeGreaterThanOrEqual(3);

    // On replay, exactly ONE user turn for this input — no duplicate user message.
    await client.close();
    const client2 = await h.connectSurface('srf-18c');
    const userMsgs: string[] = [];
    client2.on('chat.message', (e) => {
      if (e.chatId === chatId && e.role === 'user') userMsgs.push(e.content);
    });
    client2.replay(chatId, -1);
    await until(() => userMsgs.length >= 1, 3000, 'user turn replays');
    await new Promise((r) => setTimeout(r, 150));
    expect(userMsgs.filter((c) => c.includes('only once')).length).toBe(1);
    await client2.close();
  });
});
