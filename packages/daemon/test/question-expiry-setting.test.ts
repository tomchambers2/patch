// spec/02 § Questions are not approvals — question expiry is a per-host
// SETTING (on/off plus a window in seconds), and the deadline the host armed
// travels on the request so every surface counts down to the same instant.
//
// The two halves matter for different reasons. The setting has to reach the
// timer, or Settings shows one number while the host runs another. The
// deadline has to reach the surfaces, or each one starts a clock of its own
// when it happens to draw the card — and a surface that connected late, or one
// that reconnected and got the request replayed, would show a window that has
// already partly elapsed as if it were whole.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { QUESTION_EXPIRY_SECONDS_DEFAULT } from '@patch/wire';
import { Daemon, questionExpiredMessage, APPROVAL_ANSWER_TIMEOUT_MS } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

function setup(opts: { permissionModeDefault?: 'default' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-qexp-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-qexp-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    // FIXED, so a deadline is an exact number rather than a window to be
    // approximated: `expiry.at` is `now() + window`, and `now()` never moves.
    now: () => NOW,
    generateChatId: () => `chat-${++id}`,
    ...(opts.permissionModeDefault ? { permissionModeDefault: opts.permissionModeDefault } : {}),
  });
  return { daemon, events, folder };
}

function request(events: WireEvent[]): {
  requestId: string;
  expiry?: { at: number; windowMs: number };
  seq: number;
} {
  const req = events.find((e) => e.type === 'chat.permission_request');
  expect(req, 'no chat.permission_request was emitted').toBeDefined();
  return req as unknown as {
    requestId: string;
    expiry?: { at: number; windowMs: number };
    seq: number;
  };
}

function response(events: WireEvent[]): { decision: string } | undefined {
  return events.find((e) => e.type === 'chat.permission_response') as
    | { decision: string }
    | undefined;
}

function askResult(events: WireEvent[]): { result: string } | undefined {
  return events.find((e) => e.type === 'chat.tool_result' && e.tool === 'AskUserQuestion') as
    | { result: string }
    | undefined;
}

describe('the question-expiry setting drives the timer', () => {
  it('puts the default deadline on the request and fires on it', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      // The surface is told the absolute instant AND the whole window — see
      // the wire schema for why a ring needs both.
      expect(request(events).expiry).toEqual({
        at: NOW + QUESTION_EXPIRY_SECONDS_DEFAULT * 1000,
        windowMs: QUESTION_EXPIRY_SECONDS_DEFAULT * 1000,
      });

      await vi.advanceTimersByTimeAsync(QUESTION_EXPIRY_SECONDS_DEFAULT * 1000 + 1000);
      expect(response(events)?.decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a configured window instead of the default, on the wire and on the clock', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      daemon.setQuestionExpiry({ enabled: true, seconds: 10 });
      await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      expect(request(events).expiry).toEqual({ at: NOW + 10_000, windowMs: 10_000 });

      // Just short of the configured window: still waiting.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(response(events)).toBeUndefined();
      expect(daemon.chatState.get('chat-1')?.activity).toBe('awaiting-permission');

      // Past it: expired, well before the 60s default would have fired.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(response(events)?.decision).toBe('deny');
      // And the agent is told the window it actually got, not the default.
      expect(askResult(events)?.result).toBe(questionExpiredMessage(10));
      expect(askResult(events)?.result).toContain('did not refuse');
      expect(daemon.chatState.get('chat-1')?.activity).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turned off: no deadline on the request, and the question waits indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      daemon.setQuestionExpiry({ enabled: false });
      await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);

      // Absent, not zero and not a far-future instant: a surface draws no
      // countdown at all for a question that will never expire.
      expect(request(events).expiry).toBeUndefined();

      // Ten windows is well past any deadline it could have had. Every
      // periodic host timer fires at each step of the fake clock, so a
      // hundred windows took over 5 s on the loaded deploy box and failed the
      // deploy gate while passing on a fast machine.
      await vi.advanceTimersByTimeAsync(QUESTION_EXPIRY_SECONDS_DEFAULT * 1000 * 10);
      expect(response(events)).toBeUndefined();
      expect(daemon.chatState.get('chat-1')?.activity).toBe('awaiting-permission');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turning questions off leaves a tool approval expiring on its own window', async () => {
    // The control the user is offered says "questions". An approval's window is
    // what unwedges an unattended job, so it is not in the same switch.
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup({ permissionModeDefault: 'default' });
      daemon.setQuestionExpiry({ enabled: false });
      await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);

      expect(request(events).expiry).toEqual({
        at: NOW + APPROVAL_ANSWER_TIMEOUT_MS,
        windowMs: APPROVAL_ANSWER_TIMEOUT_MS,
      });
      await vi.advanceTimersByTimeAsync(APPROVAL_ANSWER_TIMEOUT_MS + 1000);
      expect(response(events)?.decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the SAME deadline to a surface that reconnects part-way through', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);
      const original = request(events).expiry;

      await vi.advanceTimersByTimeAsync(30_000);
      const replayed: WireEvent[] = [];
      daemon.replayChat(chatId, 0, (e) => replayed.push(e));

      const req = replayed.find((e) => e.type === 'chat.permission_request') as
        | { expiry?: { at: number; windowMs: number } }
        | undefined;
      expect(req, 'the pending question was not replayed').toBeDefined();
      // Half the window gone, and the reconnecting surface is handed the
      // original instant — not a fresh 60 seconds from reconnect.
      expect(req?.expiry).toEqual(original);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a window outside the wire bounds rather than clamping it', () => {
    const { daemon } = setup();
    // A clamp would leave the host running one number and Settings showing
    // another, with nothing reporting the difference.
    expect(() => daemon.setQuestionExpiry({ seconds: 0 })).toThrow(/between 5 and 3600/);
    expect(() => daemon.setQuestionExpiry({ seconds: 99_999 })).toThrow(/between 5 and 3600/);
    expect(() => daemon.setQuestionExpiry({ seconds: 12.5 })).toThrow(/whole number/);
    expect(daemon.questionExpirySetting()).toEqual({
      enabled: true,
      seconds: QUESTION_EXPIRY_SECONDS_DEFAULT,
    });
  });

  it('keeps the configured window across an off/on cycle', () => {
    // Off is a switch, not an erase: turning it back on must not silently
    // revert a deliberately-chosen window to the default.
    const { daemon } = setup();
    daemon.setQuestionExpiry({ enabled: true, seconds: 300 });
    daemon.setQuestionExpiry({ enabled: false });
    expect(daemon.questionExpirySetting()).toEqual({ enabled: false, seconds: 300 });
    daemon.setQuestionExpiry({ enabled: true });
    expect(daemon.questionExpirySetting()).toEqual({ enabled: true, seconds: 300 });
  });
});
