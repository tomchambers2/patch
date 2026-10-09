// Cross-host `patch_peek` / `patch_history` / `patch_send_to` (spec/03 §
// Cross-chat tools, spec/06 § Cross-chat toolset).
//
// The defect this file locks down: an agent's `patch_peek`/`patch_history`/
// `patch_send_to` only ever looked at the CALLING host's own local chats.
// `patch_list_chats` already told the agent a chat lives on another
// registered host, but asking about it any other way 404'd — even though the
// wire protocol relays `patch.spawn` to a named host just fine. These three
// tools take only a chatId, never a host, so the server resolves the owning
// machine from the chat mirror and relays there, the same way it already
// does for `patch.spawn`.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { registerCrossHostBridge } from '../src/cross-host.js';
import type { DaemonLink } from '../src/daemon-link.js';
import type { ChatRegistry } from '../src/chat-registry.js';
import type { Registry } from '../src/registry.js';

const logger = pino({ level: 'silent' });

interface Sent {
  daemonId: string;
  surfaceId: string;
  event: WireEvent;
}

function harness(opts: { owners?: Record<string, string>; online?: string[] } = {}) {
  const owners = opts.owners ?? { 'chat-remote': 'host-b' };
  const online = new Set(opts.online ?? ['host-a', 'host-b']);
  const sent: Sent[] = [];
  let handler: ((e: WireEvent, from: string | null) => void) | undefined;

  const daemonLink = {
    sendTo: (daemonId: string, surfaceId: string, event: WireEvent) => {
      sent.push({ daemonId, surfaceId, event });
    },
    isOnline: (id: string) => online.has(id),
    onEvent: (h: (e: WireEvent, from: string | null) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  } as unknown as DaemonLink;

  const chatRegistry = {
    list: () => [],
    get: (chatId: string) => {
      const daemonId = owners[chatId];
      return daemonId ? { chatId, daemonId } : undefined;
    },
  } as unknown as ChatRegistry;
  const registry = { isRegisteredDaemon: () => true } as unknown as Registry;

  const dispose = registerCrossHostBridge({ logger, daemonLink, chatRegistry, registry });
  return {
    sent,
    dispose,
    feed: (event: WireEvent, from: string | null) => handler?.(event, from),
  };
}

describe('cross-host patch.peek.request — relayed to the owning machine', () => {
  it('relays to the machine the chat mirror says owns the chat', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.peek.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        requestId: 'req-1',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-b');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.peek.request', requestId: 'req-1' });
    h.dispose();
  });

  it("routes the owning machine's response back to the caller", () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.peek.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        requestId: 'req-1',
      } as WireEvent,
      'host-a',
    );
    h.sent.length = 0;
    h.feed(
      {
        type: 'patch.peek.response',
        requestId: 'req-1',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        ok: true,
        result: { chat_state: { chatId: 'chat-remote' }, events: [], truncated: false },
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.peek.response', ok: true });
    h.dispose();
  });

  it('refuses a chatId no machine has ever reported, naming chat_not_found', () => {
    const h = harness({ owners: {} });
    h.feed(
      {
        type: 'patch.peek.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-ghost',
        requestId: 'req-1',
      } as WireEvent,
      'host-a',
    );
    const resp = h.sent.find((s) => s.event.type === 'patch.peek.response');
    expect(resp?.daemonId).toBe('host-a');
    expect(resp?.event).toMatchObject({
      ok: false,
      requestId: 'req-1',
      error: { code: 'chat_not_found' },
    });
    h.dispose();
  });

  it('refuses when the owning machine is offline, naming it', () => {
    const h = harness({ online: ['host-a'] });
    h.feed(
      {
        type: 'patch.peek.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        requestId: 'req-1',
      } as WireEvent,
      'host-a',
    );
    const resp = h.sent.find((s) => s.event.type === 'patch.peek.response');
    expect(resp?.event).toMatchObject({ ok: false });
    expect((resp?.event as { error: { message: string } }).error.message).toContain('host-b');
    h.dispose();
  });

  it('does not relay a same-host request with no requestId (already an audit record)', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.peek.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-local',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('drops (loudly) a response for a peek it never relayed', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.peek.response',
        requestId: 'never-seen',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        ok: true,
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('forgets a relayed peek once its TTL expires', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.feed(
        {
          type: 'patch.peek.request',
          sourceChatId: 'chat-src',
          targetChatId: 'chat-remote',
          requestId: 'req-1',
        } as WireEvent,
        'host-a',
      );
      h.sent.length = 0;
      vi.advanceTimersByTime(60_001);
      h.feed(
        {
          type: 'patch.peek.response',
          requestId: 'req-1',
          sourceChatId: 'chat-src',
          targetChatId: 'chat-remote',
          ok: true,
        } as WireEvent,
        'host-b',
      );
      expect(h.sent).toHaveLength(0);
      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cross-host patch.history.request — relayed the same way', () => {
  it('relays to the owning machine and routes the response back', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.history.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        requestId: 'req-2',
        limit: 50,
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toEqual([
      {
        daemonId: 'host-b',
        surfaceId: 'cross-host-bridge',
        event: expect.objectContaining({ type: 'patch.history.request' }),
      },
    ]);
    h.sent.length = 0;
    h.feed(
      {
        type: 'patch.history.response',
        requestId: 'req-2',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        ok: true,
        result: { events: [], nextFromSeq: undefined },
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-a');
    h.dispose();
  });

  it('refuses an unreachable chat with chat_not_found', () => {
    const h = harness({ owners: {} });
    h.feed(
      {
        type: 'patch.history.request',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-ghost',
        requestId: 'req-2',
      } as WireEvent,
      'host-a',
    );
    const resp = h.sent.find((s) => s.event.type === 'patch.history.response');
    expect(resp?.event).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
    h.dispose();
  });
});

describe('cross-host patch.send_to — relayed and acknowledged', () => {
  it('relays to the owning machine, carrying the requestId', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        message: 'do the thing',
        requestId: 'req-3',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-b');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.send_to', requestId: 'req-3' });
    h.dispose();
  });

  it("routes the owning machine's ack back to the caller", () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        message: 'do the thing',
        requestId: 'req-3',
      } as WireEvent,
      'host-a',
    );
    h.sent.length = 0;
    h.feed(
      {
        type: 'patch.send_to.response',
        requestId: 'req-3',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        ok: true,
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toEqual([
      {
        daemonId: 'host-a',
        surfaceId: 'cross-host-bridge',
        event: {
          type: 'patch.send_to.response',
          requestId: 'req-3',
          sourceChatId: 'chat-src',
          targetChatId: 'chat-remote',
          ok: true,
        },
      },
    ]);
    h.dispose();
  });

  it('does not relay a same-host / surface send with no requestId', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-local',
        message: 'hi',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('refuses a chat_not_found target with an error the caller can act on', () => {
    const h = harness({ owners: {} });
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-ghost',
        message: 'hi',
        requestId: 'req-3',
      } as WireEvent,
      'host-a',
    );
    const resp = h.sent.find((s) => s.event.type === 'patch.send_to.response');
    expect(resp?.event).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
    const chatError = h.sent.find((s) => s.event.type === 'chat.error');
    expect(chatError).toBeDefined();
    h.dispose();
  });
});
