// spec/02 § Questions are not approvals — `AskUserQuestion` reaches the
// permission gate under every mode, and the user's SELECTIONS have to travel
// back into the tool's `answers` argument before it runs. Approving without
// them is not a no-op: the tool runs and hands the agent an empty answer, so
// the agent proceeds on a decision the user never made.
//
// Exercised through the host's public API against the mock backend's
// `[[ask-user-question]]` trigger, which — like the real SDK's `canUseTool` —
// awaits `onPermissionRequest` and then runs the `updatedInput` it hands back.
// The interesting part is the ROUTE: `AskUserQuestion` is not a file edit, so
// it is never tracked in the edit-specific `pendingPermissions` map and is
// resolved through the `pendingPermissionEvents` fallback branch instead —
// the branch that used to resolve the gate with a bare `{approve}` and drop
// every answer on the floor.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { QUESTION_EXPIRY_SECONDS_DEFAULT } from '@patch/wire';
import {
  Daemon,
  APPROVAL_ANSWER_TIMEOUT_MS,
  questionExpiredMessage,
  QUESTION_CANCELLED_MESSAGE,
} from '../src/chatRunner.js';

/** The default question window in ms — the setting's default, not a constant. */
const QUESTION_ANSWER_TIMEOUT_MS = QUESTION_EXPIRY_SECONDS_DEFAULT * 1000;
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(opts: { permissionModeDefault?: 'default' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-askq-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-askq-folder-')));
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
    ...(opts.permissionModeDefault !== undefined
      ? { permissionModeDefault: opts.permissionModeDefault }
      : {}),
  });
  return { daemon, events, folder };
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function permissionRequest(events: WireEvent[]): {
  requestId: string;
  request: { tool: string; args: unknown };
} {
  const req = events.find((e) => e.type === 'chat.permission_request');
  expect(req).toBeDefined();
  return req as unknown as { requestId: string; request: { tool: string; args: unknown } };
}

function askToolCall(events: WireEvent[]): { args: Record<string, unknown> } | undefined {
  return events.find((e) => e.type === 'chat.tool_call' && e.tool === 'AskUserQuestion') as
    | { args: Record<string, unknown> }
    | undefined;
}

const QUESTION = 'Which date library should we use?';

describe('AskUserQuestion: the question reaches the surface', () => {
  it('gates under the default mode and carries the questions/options in the request args', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();

    const req = permissionRequest(events);
    expect(req.request.tool).toBe('AskUserQuestion');
    const args = req.request.args as {
      questions: Array<{
        header: string;
        question: string;
        multiSelect: boolean;
        options: Array<{ label: string; description: string }>;
      }>;
    };
    expect(args.questions).toHaveLength(1);
    expect(args.questions[0]?.question).toBe(QUESTION);
    expect(args.questions[0]?.header).toBe('Library');
    expect(args.questions[0]?.options.map((o) => o.label)).toEqual(['date-fns', 'Luxon']);
    // Parked on the human, and the tool has NOT run.
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(askToolCall(events)).toBeUndefined();
    // Not a file edit, so nothing is marked dirty and nothing sits in the
    // edit-specific pending map — this is the fallback-branch route.
    expect(daemon.dirtyFilePaths(chatId).size).toBe(0);
  });
});

describe('AskUserQuestion: answers reach updatedInput via the non-edit branch', () => {
  it('a single-select answer lands on the tool input as answers[question]', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'date-fns' }),
    });
    await tick();

    const call = askToolCall(events);
    expect(call).toBeDefined();
    expect(call?.args['answers']).toEqual({ [QUESTION]: 'date-fns' });
    // The agent's own questions survive alongside the answers — the host
    // merges, it does not replace the tool input.
    expect(call?.args['questions']).toBeDefined();
    // And the tool result the agent sees actually carries the choice.
    const result = events.find(
      (e) => e.type === 'chat.tool_result' && e.tool === 'AskUserQuestion',
    ) as { result: unknown } | undefined;
    expect(String(result?.result)).toContain('date-fns');
  });

  it('a multiSelect answer rides through as one comma-joined string', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'date-fns, Luxon' }),
    });
    await tick();

    expect(askToolCall(events)?.args['answers']).toEqual({ [QUESTION]: 'date-fns, Luxon' });
  });

  it('a free-text "Other" answer rides through unchanged (it is not matched against the options)', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'Temporal, once it ships' }),
    });
    await tick();

    expect(askToolCall(events)?.args['answers']).toEqual({ [QUESTION]: 'Temporal, once it ships' });
  });

  it('settles the chat and echoes the resolution so every surface drops the card', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'Luxon' }),
    });
    await tick();

    const echo = events.find(
      (e) => e.type === 'chat.permission_response' && e.requestId === req.requestId,
    ) as { approve: boolean; decision?: string; chatId?: string; answers?: unknown } | undefined;
    expect(echo).toMatchObject({ approve: true, decision: 'approve_with_edits', chatId });
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  // spec/14 § Main chat panel — Question prompts. The echo used to carry only
  // `approve`/`decision`, so a surface that did not originate the resolution
  // (a second tab, a reconnect, the voice yes/no path) had no way to show what
  // was actually picked — a resolved card that read "Answered" with every
  // option blank.
  it('carries the picked answers on the echo, so a surface that did not send the response can still show them', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'Luxon' }),
    });
    await tick();

    const echo = events.find(
      (e) => e.type === 'chat.permission_response' && e.requestId === req.requestId,
    ) as { answers?: Record<string, string> } | undefined;
    expect(echo?.answers).toEqual({ [QUESTION]: 'Luxon' });
  });

  it('carries no answers on the echo for a plain deny — there is nothing picked to show', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'deny' });
    await tick();

    const echo = events.find(
      (e) => e.type === 'chat.permission_response' && e.requestId === req.requestId,
    ) as { answers?: Record<string, string> } | undefined;
    expect(echo?.answers).toBeUndefined();
  });
});

describe('AskUserQuestion: cancelling is a real deny', () => {
  it('a deny stops the tool running and reports the denial', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'deny' });
    await tick();

    expect(askToolCall(events)).toBeUndefined();
    expect(
      events.some(
        (e) => e.type === 'chat.permission_response' && e.requestId === req.requestId && !e.approve,
      ),
    ).toBe(true);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('tells the AGENT a cancel is not a refusal of the turn, and to carry on using its own judgement (Todoist: "patch cancelled user question generally just stops")', async () => {
    // A bare `decision: 'deny'` with no `denyMessage` is exactly what a Cancel
    // click on the question card sends (ChatRoute.tsx `handleQuestionCancel`).
    // Left unhandled, `sdkBackend.ts` falls back to the generic 'Permission
    // denied by user', which reads to the agent as the user refusing the plan
    // behind the question rather than just declining to answer it — so the
    // agent stops the whole turn instead of carrying on with what it can still
    // decide for itself.
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
    await tick();
    const req = permissionRequest(events);

    daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'deny' });
    await tick();

    const result = events.find(
      (e) => e.type === 'chat.tool_result' && e.tool === 'AskUserQuestion',
    ) as { result: unknown } | undefined;
    expect(result).toBeDefined();
    expect(String(result?.result)).toBe(QUESTION_CANCELLED_MESSAGE);
    expect(String(result?.result)).not.toBe('Permission denied by user');
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });
});

describe('AskUserQuestion: an unusable answer denies loudly, it never approves empty', () => {
  const bad: Array<[string, string]> = [
    ['answers that are not JSON at all', 'date-fns'],
    ['a JSON array instead of an object', '["date-fns"]'],
    ['a non-string answer value', '{"q":123}'],
    ['an empty-string answer value', '{"q":""}'],
    ['an empty answers object', '{}'],
  ];

  for (const [label, payload] of bad) {
    it(`denies and raises chat.error for ${label}`, async () => {
      const { daemon, events, folder } = setup();
      const chatId = await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await tick();
      const req = permissionRequest(events);

      daemon.submitPermissionResponse({
        requestId: req.requestId,
        decision: 'approve_with_edits',
        editedNewString: payload,
      });
      await tick();

      // The tool did NOT run with an empty answer.
      expect(askToolCall(events)).toBeUndefined();
      const err = events.find((e) => e.type === 'chat.error') as
        | { error: { code: string; message: string } }
        | undefined;
      expect(err?.error.code).toBe('invalid_frame');
      expect(err?.error.message).toContain('AskUserQuestion');
      // An unusable answer is a validation failure, not a cancel — it must not
      // be relabelled with QUESTION_CANCELLED_MESSAGE, which would tell the
      // agent to carry on rather than that its answer could not be read.
      const result = events.find(
        (e) => e.type === 'chat.tool_result' && e.tool === 'AskUserQuestion',
      ) as { result: unknown } | undefined;
      expect(String(result?.result)).not.toBe(QUESTION_CANCELLED_MESSAGE);
      // The echo says deny, so the surface's card settles as declined rather
      // than claiming an approval that never happened.
      const echo = events.find(
        (e) => e.type === 'chat.permission_response' && e.requestId === req.requestId,
      ) as { approve: boolean; decision?: string } | undefined;
      expect(echo).toMatchObject({ approve: false, decision: 'deny' });
      expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    });
  }

  it('an approve_with_edits naming a tool with no editable argument is refused, not downgraded', async () => {
    const { daemon, events, folder } = setup({ permissionModeDefault: 'default' });
    const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    const req = permissionRequest(events);
    expect(req.request.tool).toBe('Bash');

    daemon.submitPermissionResponse({
      requestId: req.requestId,
      decision: 'approve_with_edits',
      editedNewString: 'rm -rf /',
    });
    await tick();

    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Bash')).toBe(false);
    const err = events.find((e) => e.type === 'chat.error') as
      | { error: { code: string; message: string } }
      | undefined;
    expect(err?.error.code).toBe('invalid_frame');
    expect(err?.error.message).toContain('Bash');
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });
});

describe('AskUserQuestion: an unanswered question expires', () => {
  it('expires the question instead of holding the turn open forever', async () => {
    // Tom: "ask user question should have a timeout instead of just waiting
    // forever". A question is the one permission the user cannot leave — the
    // turn cannot proceed without it — so one asked while the phone is in a
    // pocket parks the chat indefinitely.
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);
      const req = permissionRequest(events);
      expect(daemon.chatState.get('chat-1')?.activity).toBe('awaiting-permission');

      // Just short of the deadline it is still waiting — the timer is real,
      // not an immediate give-up.
      await vi.advanceTimersByTimeAsync(QUESTION_ANSWER_TIMEOUT_MS - 1000);
      expect(events.some((e) => e.type === 'chat.permission_response')).toBe(false);

      await vi.advanceTimersByTimeAsync(2000);

      const resp = events.find((e) => e.type === 'chat.permission_response') as
        | { requestId: string; approve: boolean; decision: string }
        | undefined;
      // Deny is what the existing frame can say — no invented enum value that
      // a surface running behind would drop.
      expect(resp?.requestId).toBe(req.requestId);
      expect(resp?.approve).toBe(false);
      expect(resp?.decision).toBe('deny');

      // The AGENT is told the truth: nobody answered, this was not a refusal.
      const result = events.find(
        (e) => e.type === 'chat.tool_result' && e.tool === 'AskUserQuestion',
      ) as { result: string } | undefined;
      expect(result?.result).toBe(questionExpiredMessage(QUESTION_EXPIRY_SECONDS_DEFAULT));
      expect(result?.result).toContain('did not refuse');
      // And the tool never ran with an empty answer.
      expect(askToolCall(events)).toBeUndefined();
      expect(daemon.chatState.get('chat-1')?.activity).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answered question never expires', async () => {
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup();
      await daemon.spawnChat({ folder, prompt: '[[ask-user-question]]' });
      await vi.advanceTimersByTimeAsync(50);
      const req = permissionRequest(events);

      daemon.submitPermissionResponse({
        requestId: req.requestId,
        decision: 'approve_with_edits',
        editedNewString: JSON.stringify({ [QUESTION]: 'date-fns' }),
      });
      await vi.advanceTimersByTimeAsync(QUESTION_ANSWER_TIMEOUT_MS * 2);

      // Exactly one resolution, and it is the user's answer.
      const responses = events.filter((e) => e.type === 'chat.permission_response');
      expect(responses).toHaveLength(1);
      expect((responses[0] as { approve: boolean }).approve).toBe(true);
      expect(askToolCall(events)?.args['answers']).toEqual({ [QUESTION]: 'date-fns' });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds an ordinary tool approval past a question's window — it expires later, not never", async () => {
    // This used to assert that an approval NEVER expires, on the reasoning that
    // a paused approval is a turn paused on purpose. That holds for a chat
    // someone is sitting in front of and fails for a job fire, which is
    // unattended by construction — so an approval now expires too, just on a
    // longer fuse. The window itself is covered in
    // test/permission-expiry.test.ts; what matters here is that a question's
    // deadline passing does not take an approval with it.
    vi.useFakeTimers();
    try {
      const { daemon, events, folder } = setup({ permissionModeDefault: 'default' });
      await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);
      expect(permissionRequest(events).request.tool).toBe('Bash');

      // Past the question deadline, and still short of the approval one.
      expect(APPROVAL_ANSWER_TIMEOUT_MS).toBeGreaterThan(QUESTION_ANSWER_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(APPROVAL_ANSWER_TIMEOUT_MS - 1000);

      expect(events.some((e) => e.type === 'chat.permission_response')).toBe(false);
      expect(daemon.chatState.get('chat-1')?.activity).toBe('awaiting-permission');
    } finally {
      vi.useRealTimers();
    }
  });
});
