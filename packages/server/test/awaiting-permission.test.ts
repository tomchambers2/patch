// Blocked-on-the-user notifications (spec/09 § Waiting on you) — which blocks
// raise a notification, which are skipped, and what each one says.

import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import type { NotifyEvent, WireEvent } from '@patch/wire';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { AwaitingPermissionNotifier } from '../src/notifications/awaiting-permission.js';
import type { NotificationRouter, RouteOptions } from '../src/notifications/router.js';

const logger = pino({ level: 'silent' });

function spawned(chatId: string): WireEvent {
  return {
    type: 'chat.spawned',
    chatId,
    daemonId: 'hetzner',
    folder: '/home/tom/projects/bed-planner',
    seq: 1,
    ts: 0,
  } as WireEvent;
}

function state(chatId: string, over: Partial<Record<string, unknown>> = {}): WireEvent {
  return {
    type: 'chat.state',
    chatId,
    daemonId: 'hetzner',
    activity: 'idle',
    permissionMode: 'auto',
    folder: '/home/tom/projects/bed-planner',
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    ...over,
  } as WireEvent;
}

function permissionRequest(
  chatId: string,
  request: { tool: string; args?: unknown; description?: string },
): WireEvent {
  return {
    type: 'chat.permission_request',
    chatId,
    requestId: `req-${chatId}`,
    request: { args: {}, ...request },
    seq: 3,
    ts: 0,
  } as WireEvent;
}

/** The args an `AskUserQuestion` really carries (packages/web `askUserQuestion.ts`). */
function questionArgs(question: string): unknown {
  return {
    questions: [
      {
        header: 'Auth method',
        question,
        options: [
          { label: 'OAuth', description: '' },
          { label: 'API key', description: '' },
        ],
        multiSelect: false,
      },
    ],
  };
}

interface Routed {
  event: NotifyEvent;
  opts: RouteOptions;
}

describe('AwaitingPermissionNotifier', () => {
  let chats: ChatRegistry;
  let routed: Routed[];
  let now: number;
  let notifier: AwaitingPermissionNotifier;
  let failChannels: Set<string>;

  beforeEach(() => {
    chats = new ChatRegistry({ logger });
    routed = [];
    failChannels = new Set();
    now = 1_000_000;
    const router = {
      route: async (event: NotifyEvent, opts: RouteOptions = {}) => {
        routed.push({ event, opts });
        if (failChannels.has(event.channel)) throw new Error(`${event.channel} is down`);
      },
    } as unknown as NotificationRouter;
    notifier = new AwaitingPermissionNotifier({ chats, router, logger, now: () => now });
  });

  function feed(event: WireEvent): void {
    chats.observe(event);
    notifier.observe(event);
  }

  function seedRunning(chatId: string, over: Record<string, unknown> = {}): void {
    feed(spawned(chatId));
    feed(state(chatId, { activity: 'running', ...over }));
  }

  /**
   * The host's real emit order for a block (chatRunner.ts
   * `handlePermissionEnvelope`): the request frame, then the state frame.
   */
  function blockOn(
    chatId: string,
    request: { tool: string; args?: unknown; description?: string },
    over: Record<string, unknown> = {},
  ): void {
    feed(permissionRequest(chatId, request));
    feed(state(chatId, { activity: 'awaiting-permission', ...over }));
  }

  function channels(): string[] {
    return routed.map((r) => r.event.channel);
  }

  test('a chat blocking on a permission decision notifies desktop and push', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: rm -rf build' });
    expect(channels()).toEqual(['desktop', 'push']);
    expect(routed.every((r) => r.event.chatId === 'c1')).toBe(true);
  });

  test('the push carries the narrowed suppression rule, the desktop toast the focused-surface one', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: rm -rf build' });
    expect(routed.find((r) => r.event.channel === 'push')?.opts.suppressOn).toBe('computer');
    expect(routed.find((r) => r.event.channel === 'desktop')?.opts.suppressOn).toBeUndefined();
    // spec/09 § Waiting on you — delivery mirrors chat-completion exactly,
    // including a surface that already has this chat open getting no toast.
    expect(routed.find((r) => r.event.channel === 'desktop')?.opts.skipDesktopIfFocused).toBe(true);
  });

  // --- What it says -------------------------------------------------------

  test('a tool approval names the chat and what is being approved', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    blockOn('c1', { tool: 'Bash', description: 'Run: rm -rf build' });
    expect(routed[0]?.event.message).toBe('bed planner needs permission: Run: rm -rf build');
  });

  test('a tool approval with no description names the tool', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    blockOn('c1', { tool: 'WebFetch' });
    expect(routed[0]?.event.message).toBe('bed planner needs permission: WebFetch');
  });

  test('an AskUserQuestion reads as the question itself, not as a tool approval', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    blockOn('c1', {
      tool: 'AskUserQuestion',
      args: questionArgs('Which bed should the beans go in?'),
    });
    expect(routed[0]?.event.message).toBe('bed planner asks: Which bed should the beans go in?');
  });

  // Every way the tool's args can fail to be the documented shape. None of them
  // may drop the notification — the user still needs to know they are blocked,
  // even when the question text cannot be read out.
  test.each([
    ['not an object', 'why?'],
    ['no questions array', { questions: 'why?' }],
    ['an empty questions array', { questions: [] }],
    ['a non-object question', { questions: ['why?'] }],
    ['a question with no text', { questions: [{ header: 'Beds' }] }],
    ['a question with empty text', { questions: [{ header: 'Beds', question: '' }] }],
  ])('an AskUserQuestion carrying %s still says a question is waiting', (_label, args) => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    blockOn('c1', { tool: 'AskUserQuestion', args });
    expect(routed[0]?.event.message).toBe('bed planner has a question for you');
  });

  test('an unnamed chat falls back to its preview, then to a placeholder', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', preview: 'plan the veg beds' }));
    blockOn('c1', { tool: 'WebFetch' });
    expect(routed[0]?.event.message).toBe('plan the veg beds needs permission: WebFetch');

    routed.length = 0;
    seedRunning('c2');
    blockOn('c2', { tool: 'WebFetch' });
    expect(routed[0]?.event.message).toBe('unnamed chat needs permission: WebFetch');
  });

  test('a block with no correlated request still rings, naming the chat', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    feed(state('c1', { activity: 'awaiting-permission' }));
    expect(channels()).toEqual(['desktop', 'push']);
    expect(routed[0]?.event.message).toBe('bed planner is waiting on you');
  });

  // --- The edge -----------------------------------------------------------

  test('a repeated awaiting-permission state does not notify again', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' });
    expect(channels()).toEqual(['desktop', 'push']);
    // The run loop re-asserts the state when the turn's iterator returns with
    // the request still outstanding.
    feed(state('c1', { activity: 'awaiting-permission' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  test('resolving the permission and running on again does not notify', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' });
    routed.length = 0;
    feed(state('c1', { activity: 'running' }));
    feed(state('c1', { activity: 'idle' }));
    expect(routed).toEqual([]);
  });

  test('a second question inside one turn notifies again', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' });
    feed(state('c1', { activity: 'running' }));
    blockOn('c1', { tool: 'Bash', description: 'Run: echo bye' });
    expect(channels()).toEqual(['desktop', 'push', 'desktop', 'push']);
    expect(routed[3]?.event.message).toBe('unnamed chat needs permission: Run: echo bye');
  });

  test('a chat already parked when the server starts does not re-ring', () => {
    // No `running` frame was ever seen — this is a replay of held state after a
    // restart or reconnect, not a fresh question.
    feed(spawned('c1'));
    feed(permissionRequest('c1', { tool: 'Bash' }));
    feed(state('c1', { activity: 'awaiting-permission' }));
    expect(routed).toEqual([]);
  });

  test('a settled or errored turn is not a block', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle' }));
    seedRunning('c2');
    feed(state('c2', { activity: 'errored' }));
    expect(routed).toEqual([]);
  });

  // --- Whose turn it was --------------------------------------------------

  // spec/09 § Waiting on you. The INVERSE of the chat-completion rule, and
  // deliberately so: a machine-started run that stops to ask is exactly the run
  // nobody is watching, and it stays stopped until a human answers.
  test('a machine-started turn blocking on the user DOES notify', () => {
    seedRunning('c1', { turnOrigin: 'machine' });
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' }, { turnOrigin: 'machine' });
    expect(channels()).toEqual(['desktop', 'push']);
  });

  test('a user-started turn blocking on the user notifies too', () => {
    seedRunning('c1', { turnOrigin: 'user' });
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' }, { turnOrigin: 'user' });
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // --- Who is skipped -----------------------------------------------------

  test('the special threads are skipped — each already reaches the user', () => {
    for (const chatId of Object.values(SPECIAL_THREAD_IDS)) {
      seedRunning(chatId);
      blockOn(chatId, { tool: 'Bash' });
    }
    expect(routed).toEqual([]);
  });

  test('deleted and snoozed chats are skipped', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash' }, { status: 'deleted' });
    seedRunning('c2');
    blockOn('c2', { tool: 'Bash' }, { snoozedUntil: now + 60_000 });
    expect(routed).toEqual([]);
  });

  test('a lapsed snooze does not skip the chat', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash' }, { snoozedUntil: now - 1 });
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // A chat the mirror has never heard of is treated as an ordinary active chat
  // rather than skipped: being unknown to the registry is not a reason to leave
  // a blocked agent waiting.
  test('a chat missing from the registry still notifies', () => {
    notifier.observe(state('ghost', { activity: 'running' }));
    notifier.observe(permissionRequest('ghost', { tool: 'Bash' }));
    notifier.observe(state('ghost', { activity: 'awaiting-permission' }));
    expect(channels()).toEqual(['desktop', 'push']);
    expect(routed[0]?.event.message).toBe('unnamed chat needs permission: Bash');
  });

  // dd6f113: a hidden job's chat spawns straight into Archived, and unarchives
  // itself the moment it blocks on the user. The host does that BEFORE
  // emitting the state frame, so the frame carrying this edge already says
  // `active` — the status filter must not eat the notification that commit
  // exists to make visible. This test is the guard on that ordering.
  test("a hidden job's archived chat notifies, because the block unarchived it first", () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', status: 'archived', turnOrigin: 'machine' }));
    blockOn(
      'c1',
      { tool: 'AskUserQuestion', args: questionArgs('Ship it?') },
      { status: 'active' },
    );
    expect(channels()).toEqual(['desktop', 'push']);
    expect(routed[0]?.event.message).toBe('unnamed chat asks: Ship it?');
  });

  // --- Robustness ---------------------------------------------------------

  test('a channel that throws does not take the other down or reject', () => {
    failChannels.add('desktop');
    seedRunning('c1');
    expect(() => blockOn('c1', { tool: 'Bash' })).not.toThrow();
    expect(channels()).toEqual(['desktop', 'push']);
  });

  test('an answered request is not reused to describe a later block', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' });
    feed(state('c1', { activity: 'running' }));
    feed(state('c1', { activity: 'idle' }));
    routed.length = 0;
    // A new turn blocks with no request frame reaching the server.
    feed(state('c1', { activity: 'running' }));
    feed(state('c1', { activity: 'awaiting-permission' }));
    expect(routed[0]?.event.message).toBe('unnamed chat is waiting on you');
  });

  // --- Notification actions (spec/09 § Notification actions) -------------

  test('a tool approval carries kind permission + the requestId', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'Bash', description: 'Run: echo hi' });
    expect(routed[0]?.event.actions).toEqual({ kind: 'permission', requestId: 'req-c1' });
    expect(routed[1]?.event.actions).toEqual({ kind: 'permission', requestId: 'req-c1' });
  });

  test('an AskUserQuestion with <=3 single-select options carries them as actions', () => {
    seedRunning('c1');
    blockOn('c1', {
      tool: 'AskUserQuestion',
      args: questionArgs('Which bed should the beans go in?'),
    });
    expect(routed[0]?.event.actions).toEqual({
      kind: 'question',
      requestId: 'req-c1',
      questionText: 'Which bed should the beans go in?',
      options: ['OAuth', 'API key'],
    });
  });

  test('a multi-select question omits options — the surface falls back to Reply', () => {
    seedRunning('c1');
    blockOn('c1', {
      tool: 'AskUserQuestion',
      args: {
        questions: [
          {
            header: 'Toppings',
            question: 'Which toppings?',
            options: [{ label: 'Cheese', description: '' }],
            multiSelect: true,
          },
        ],
      },
    });
    expect(routed[0]?.event.actions).toEqual({
      kind: 'question',
      requestId: 'req-c1',
      questionText: 'Which toppings?',
    });
  });

  test('a question with more than 3 options omits options', () => {
    seedRunning('c1');
    blockOn('c1', {
      tool: 'AskUserQuestion',
      args: {
        questions: [
          {
            header: 'Pick',
            question: 'Pick one',
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
              { label: 'C', description: '' },
              { label: 'D', description: '' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    expect(routed[0]?.event.actions).toEqual({
      kind: 'question',
      requestId: 'req-c1',
      questionText: 'Pick one',
    });
  });

  test('a batch of more than one question omits options but keeps the first question text', () => {
    seedRunning('c1');
    blockOn('c1', {
      tool: 'AskUserQuestion',
      args: {
        questions: [
          {
            header: 'A',
            question: 'First question?',
            options: [{ label: 'X', description: '' }],
            multiSelect: false,
          },
          {
            header: 'B',
            question: 'Second question?',
            options: [{ label: 'Y', description: '' }],
            multiSelect: false,
          },
        ],
      },
    });
    expect(routed[0]?.event.actions).toEqual({
      kind: 'question',
      requestId: 'req-c1',
      questionText: 'First question?',
    });
  });

  test('an AskUserQuestion whose args cannot even name the question carries no actions', () => {
    seedRunning('c1');
    blockOn('c1', { tool: 'AskUserQuestion', args: { questions: [] } });
    expect(routed[0]?.event.actions).toBeUndefined();
  });

  test('a block with no correlated request carries no actions', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    feed(state('c1', { activity: 'awaiting-permission' }));
    expect(routed[0]?.event.actions).toBeUndefined();
  });

  test('every chat that blocks is reported, not just the first', () => {
    seedRunning('c1');
    seedRunning('c2');
    blockOn('c1', { tool: 'Bash' });
    blockOn('c2', { tool: 'Bash' });
    expect(routed.map((r) => `${r.event.chatId}:${r.event.channel}`)).toEqual([
      'c1:desktop',
      'c1:push',
      'c2:desktop',
      'c2:push',
    ]);
  });
});
