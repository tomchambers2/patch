// Chat-completion notifications (spec/09 § Chat completion) — which turns
// raise a notification, which are skipped, and what each channel is asked for.

import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import type { NotifyEvent, WireEvent } from '@patch/wire';
import type { Job } from '../src/jobs/types.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { ChatCompletionNotifier } from '../src/notifications/chat-complete.js';
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

function stopped(chatId: string): WireEvent {
  return { type: 'chat.stopped', chatId, reason: 'user-stop' } as WireEvent;
}

interface Routed {
  event: NotifyEvent;
  opts: RouteOptions;
}

describe('ChatCompletionNotifier', () => {
  let chats: ChatRegistry;
  let routed: Routed[];
  let now: number;
  let notifier: ChatCompletionNotifier;
  let failChannels: Set<string>;
  /** chatId → jobId, as `jobs/chat-links.ts` records it on every job fire. */
  let links: Map<string, string>;
  /** jobId → stored job, as `JobStore` holds it. */
  let jobs: Map<string, Job>;
  let warnings: unknown[];
  /** spec/14 § Batch mode — chatIds the running batch currently holds. */
  let batchMembers: Set<string>;

  beforeEach(() => {
    chats = new ChatRegistry({ logger });
    routed = [];
    failChannels = new Set();
    links = new Map();
    jobs = new Map();
    warnings = [];
    batchMembers = new Set();
    now = 1_000_000;
    const router = {
      route: async (event: NotifyEvent, opts: RouteOptions = {}) => {
        routed.push({ event, opts });
        if (failChannels.has(event.channel)) throw new Error(`${event.channel} is down`);
      },
    } as unknown as NotificationRouter;
    notifier = new ChatCompletionNotifier({
      chats,
      router,
      logger: {
        info: logger.info.bind(logger),
        warn: (...args: unknown[]) => {
          warnings.push(args[0]);
        },
      },
      now: () => now,
      jobs: {
        jobIdForChat: (chatId) => links.get(chatId) ?? null,
        job: (jobId) => jobs.get(jobId) ?? null,
      },
      batch: { isSuppressedMember: (chatId) => batchMembers.has(chatId) },
    });
  });

  function feed(event: WireEvent): void {
    chats.observe(event);
    notifier.observe(event);
  }

  function seedRunning(chatId: string): void {
    feed(spawned(chatId));
    feed(state(chatId, { activity: 'running' }));
  }

  function channels(): string[] {
    return routed.map((r) => r.event.channel);
  }

  test('a completed turn notifies desktop and push', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle' }));
    expect(channels()).toEqual(['desktop', 'push']);
    expect(routed.every((r) => r.event.chatId === 'c1')).toBe(true);
  });

  // Tom: "shouldn't give finished notification when it's just processing the
  // next message in the queue, otherwise I look for no reason". The host holds
  // `running` across a queue drain (spec/04 § Message queueing), so the stream
  // this sees has no idle edge until the chat has actually finished.
  test('a chat still draining its queue does not ring the doorbell', () => {
    seedRunning('c1');
    // Turn 1 settles, turn 2 is dequeued and started — one continuous `running`.
    feed(state('c1', { activity: 'running' }));
    expect(routed).toEqual([]);

    // Turn 2 settles with the queue empty. NOW the chat has finished.
    feed(state('c1', { activity: 'idle' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // Tom: "sending a completion notification when a turn is ended via
  // interruption of a new message instead of actually getting to the end".
  // Sending a second message while a turn runs queues it, and the promote (the
  // up-arrow, or the head-of-queue auto-interrupt) STOPS the running turn so it
  // can start. That is the host's aborted branch, and it used to settle the
  // chat to `idle` unconditionally — a running -> idle edge this notifier could
  // not tell from a real finish, so it rang the doorbell for a chat that went
  // straight back to `running`. The host now holds `running` across the whole
  // interrupted drain (spec/04 § Activity across a drain), and `chat.stopped`
  // is not a `chat.state` frame, so it must not disturb the tracked activity
  // either.
  test('an interrupted drain rings once at its end, not at the interruption', () => {
    seedRunning('c1');
    // The promote: the interrupted turn is announced stopped, the promoted turn
    // is announced running. No idle in between.
    feed(stopped('c1'));
    feed(state('c1', { activity: 'running' }));
    expect(routed).toEqual([]);

    // The promoted turn settles with the queue empty. NOW the chat has finished.
    feed(state('c1', { activity: 'idle' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // Tom: "stop a chat shouldnt give finished notification". A bare stop — the
  // stop button, `patch stop`, the `patch_stop` tool — aborts the turn with
  // nothing queued behind it, so the host settles the chat straight to `idle`
  // and that edge is shaped exactly like a real finish. What tells them apart is
  // `turnStopped` on the settling frame itself (spec/09 § A turn the user
  // stopped); the `chat.stopped` event cannot, because on this path the host
  // emits it AFTER the idle frame, from a different awaiter of the same run.
  describe('a turn the user stopped', () => {
    test('a stopped turn settling does not ring the doorbell', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'idle', turnStopped: true }));
      feed(stopped('c1'));
      expect(routed).toEqual([]);
    });

    test('a turn that really finished still rings it', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'idle', turnStopped: false }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    // The suppression belongs to the stopped TURN, not to the chat: silencing
    // the chat would leave it mute for good.
    test('a fresh turn after a stop rings when it completes', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'idle', turnStopped: true }));
      feed(stopped('c1'));
      expect(routed).toEqual([]);

      // Tom types again. The host clears the flag as the turn goes running.
      feed(state('c1', { activity: 'running', turnStopped: false }));
      feed(state('c1', { activity: 'idle', turnStopped: false }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    // A promote stops the in-flight turn precisely so a queued one can start,
    // and the chat holds `running` throughout — so the stop arrives BEFORE the
    // only idle edge in the sequence, and that edge belongs to a turn that
    // genuinely finished. An implementation that remembered `chat.stopped` and
    // spent it on the next idle would swallow this one.
    test('a promoted turn that completes after a stop still rings', () => {
      seedRunning('c1');
      feed(stopped('c1'));
      feed(state('c1', { activity: 'running', turnStopped: false }));
      feed(state('c1', { activity: 'idle', turnStopped: false }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    // No fallback to silence: a host whose host predates the field says
    // nothing about stopping, and a chat there keeps the behaviour it had
    // rather than losing notifications for turns that really did complete.
    test('a host too old to send turnStopped still notifies', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });
  });

  test('the push carries the narrowed suppression rule, the desktop toast the focused-surface one', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle' }));
    const push = routed.find((r) => r.event.channel === 'push');
    const desktop = routed.find((r) => r.event.channel === 'desktop');
    expect(push?.opts.suppressOn).toBe('computer');
    expect(push?.opts.skipDesktopIfFocused).toBeUndefined();
    expect(desktop?.opts.suppressOn).toBeUndefined();
    // spec/09 § Chat completion — a surface with this exact chat already open
    // does not get the toast; opted in only for the desktop channel of this
    // system-raised doorbell, never the push and never an agent's own
    // `patch_notify`.
    expect(desktop?.opts.skipDesktopIfFocused).toBe(true);
  });

  test('the message names the chat and carries its status summary', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    feed(state('c1', { activity: 'idle', statusSummary: 'planted the beds' }));
    expect(routed[0]?.event.message).toBe('bed planner finished: planted the beds');
  });

  test('a chat with no summary yet still names itself', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', name: 'bed planner' }));
    feed(state('c1', { activity: 'idle' }));
    expect(routed[0]?.event.message).toBe('bed planner finished');
  });

  // spec/09 § What the message says. Tom: "patch notify needs to take specific
  // text from the agent and use it. not just the starting message". The chat's
  // own closing words are what the turn actually produced; `statusSummary` is a
  // model's after-the-fact reading of the transcript, and it arrives on a LATER
  // frame than this one, so in practice the doorbell used to carry neither.
  describe("the turn's own closing text (spec/09 § What the message says)", () => {
    test('the settling frame’s turnSummary becomes the trailing text', () => {
      feed(spawned('c1'));
      feed(state('c1', { activity: 'running', name: 'bed planner' }));
      feed(
        state('c1', { activity: 'idle', turnSummary: 'Dug over the top bed and sowed rocket.' }),
      );
      expect(routed[0]?.event.message).toBe(
        'bed planner finished: Dug over the top bed and sowed rocket.',
      );
    });

    test('turnSummary beats a status summary the chat already carries', () => {
      feed(spawned('c1'));
      feed(state('c1', { activity: 'running', name: 'bed planner' }));
      feed(
        state('c1', {
          activity: 'idle',
          statusSummary: 'planted the beds',
          turnSummary: 'Dug over the top bed and sowed rocket.',
        }),
      );
      expect(routed[0]?.event.message).toBe(
        'bed planner finished: Dug over the top bed and sowed rocket.',
      );
    });

    // The statusSummary from an EARLIER turn is already on the registry row
    // when this turn settles, so the precedence has to be read per frame and
    // not per chat.
    test('turnSummary on the frame beats a statusSummary left on the registry row', () => {
      feed(spawned('c1'));
      feed(state('c1', { activity: 'running', name: 'bed planner' }));
      feed(state('c1', { activity: 'idle', statusSummary: 'planted the beds' }));
      expect(routed[0]?.event.message).toBe('bed planner finished: planted the beds');

      routed.length = 0;
      feed(state('c1', { activity: 'running' }));
      feed(state('c1', { activity: 'idle', turnSummary: 'Weeded the path.' }));
      expect(routed[0]?.event.message).toBe('bed planner finished: Weeded the path.');
    });

    // NO FALLBACK is being added: a host too old to send the field leaves the
    // message exactly as it is today.
    test('a frame carrying neither reads exactly as it did before', () => {
      feed(spawned('c1'));
      feed(state('c1', { activity: 'running', name: 'bed planner' }));
      feed(state('c1', { activity: 'idle' }));
      expect(routed[0]?.event.message).toBe('bed planner finished');
    });

    // An empty/whitespace closing text is the host's `null` in another guise
    // (a turn that ended on a tool call) and must not produce a dangling colon.
    test('an empty turnSummary is not a summary', () => {
      feed(spawned('c1'));
      feed(state('c1', { activity: 'running', name: 'bed planner' }));
      feed(state('c1', { activity: 'idle', turnSummary: null }));
      expect(routed[0]?.event.message).toBe('bed planner finished');
    });

    // Having something to say is not a reason to say it: every suppression rule
    // still wins over a turnSummary.
    test('a suppressed turn stays silent however good its closing text is', () => {
      const text = { turnSummary: 'Dug over the top bed and sowed rocket.' };

      seedRunning('machine');
      feed(state('machine', { activity: 'idle', turnOrigin: 'machine', ...text }));

      seedRunning('stopped');
      feed(state('stopped', { activity: 'idle', turnStopped: true, ...text }));

      seedRunning('snoozed');
      feed(state('snoozed', { activity: 'idle', snoozedUntil: now + 60_000, ...text }));

      seedRunning('archived');
      feed(state('archived', { activity: 'idle', status: 'archived', ...text }));

      expect(routed).toEqual([]);
    });
  });

  test('an unnamed chat falls back to its preview, then to a placeholder', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'running', preview: 'plan the veg beds' }));
    feed(state('c1', { activity: 'idle' }));
    expect(routed[0]?.event.message).toBe('plan the veg beds finished');

    routed.length = 0;
    seedRunning('c2');
    feed(state('c2', { activity: 'idle' }));
    expect(routed[0]?.event.message).toBe('unnamed chat finished');
  });

  test('the idle a chat spawns in is not a completed turn', () => {
    feed(spawned('c1'));
    feed(state('c1', { activity: 'idle' }));
    expect(routed).toEqual([]);
  });

  test('a repeated idle state does not notify again', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle' }));
    expect(channels()).toEqual(['desktop', 'push']);
    // The async status summary arrives on a later idle → idle frame.
    feed(state('c1', { activity: 'idle', statusSummary: 'done' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  test('a turn that ends in a permission prompt or an error is not a completion', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'awaiting-permission' }));
    seedRunning('c2');
    feed(state('c2', { activity: 'errored' }));
    // The error rings as a failure (§ A turn that failed), never as "finished".
    expect(routed.map((r) => r.event.message)).toEqual([
      'unnamed chat failed',
      'unnamed chat failed',
    ]);
  });

  test('the special threads are skipped — each already reaches the user', () => {
    for (const chatId of Object.values(SPECIAL_THREAD_IDS)) {
      feed(spawned(chatId));
      feed(state(chatId, { activity: 'running' }));
      feed(state(chatId, { activity: 'idle' }));
    }
    expect(routed).toEqual([]);
  });

  test('archived, deleted and snoozed chats are skipped', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle', status: 'archived' }));
    seedRunning('c2');
    feed(state('c2', { activity: 'idle', status: 'deleted' }));
    seedRunning('c3');
    feed(state('c3', { activity: 'idle', snoozedUntil: now + 60_000 }));
    expect(routed).toEqual([]);
  });

  test('a lapsed snooze does not skip the chat', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle', snoozedUntil: now - 1 }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // spec/09 § Whose turn it was — only a turn the user started rings the
  // doorbell. These are the loops Tom flagged: a watcher that wakes itself
  // every few minutes must not push on every tick.
  test('a machine-started turn settling is silent', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle', turnOrigin: 'machine' }));
    expect(routed).toEqual([]);
  });

  test('an explicit user turn notifies', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle', turnOrigin: 'user' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  test('a host too old to send turnOrigin still notifies', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // Origin is a property of the TURN, not of the chat: a chat that has been
  // looping silently all day must still notify the moment Tom types into it.
  test('a user turn in a chat that has been looping silently still notifies', () => {
    seedRunning('c1');
    feed(state('c1', { activity: 'idle', turnOrigin: 'machine' }));
    expect(routed).toEqual([]);
    feed(state('c1', { activity: 'running', turnOrigin: 'user' }));
    feed(state('c1', { activity: 'idle', turnOrigin: 'user' }));
    expect(channels()).toEqual(['desktop', 'push']);
  });

  // spec/08 § Action — `notifyOnComplete`. A job's fire is a `user` turn, so
  // every job's chat reaches this notifier; the option is the per-job opt-out,
  // and it is DEFAULT-ON, so absent means notify.
  describe('a job that has turned its doorbell off (spec/08 § Action)', () => {
    function job(over: Partial<Job['action']> = {}): Job {
      return {
        id: 'j1',
        name: 'five-minute tick',
        enabled: true,
        trigger: { type: 'cron', expression: '*/5 * * * *' },
        action: { type: 'spawn', daemonId: 'hetzner', folder: '/work', prompt: 'go', ...over },
      } as Job;
    }

    function linkTo(chatId: string, stored: Job): void {
      links.set(chatId, stored.id);
      jobs.set(stored.id, stored);
    }

    test('notifyOnComplete: false silences the chats that job created', () => {
      linkTo('c1', job({ notifyOnComplete: false }));
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(routed).toEqual([]);
    });

    test('a job that never set it notifies, exactly as it did before the field', () => {
      linkTo('c1', job());
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    test('an explicit notifyOnComplete: true notifies — it means the same as absent', () => {
      linkTo('c1', job({ notifyOnComplete: true }));
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    test('a continue action carries the flag too', () => {
      const stored = {
        ...job(),
        action: {
          type: 'continue',
          daemonId: 'hetzner',
          folder: '/work',
          prompt: 'go',
          notifyOnComplete: false,
        },
      } as Job;
      linkTo('jobchat-j1', stored);
      seedRunning('jobchat-j1');
      feed(state('jobchat-j1', { activity: 'idle' }));
      expect(routed).toEqual([]);
    });

    // The whole gate hangs off the chatId → jobId link, so a chat nobody's job
    // created must not be able to reach it.
    test('a chat no job created is untouched, even while a silenced job exists', () => {
      linkTo('c1', job({ notifyOnComplete: false }));
      seedRunning('c2');
      feed(state('c2', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    // Suppression follows the CHAT, not the turn. Nothing on the wire tells a
    // fire's turn apart from a person typing into the same chat, so a user turn
    // in a silenced job's chat is silent too — deliberate, and the reason the
    // label names the job rather than the run.
    test("a user turn typed into a silenced job's chat is silent too", () => {
      linkTo('c1', job({ notifyOnComplete: false }));
      seedRunning('c1');
      feed(state('c1', { activity: 'idle', turnOrigin: 'user' }));
      expect(routed).toEqual([]);
    });

    // The machine-origin rule is checked FIRST and is unconditional, so the
    // option never has to re-state it: a job whose chat self-wakes was already
    // silent on that edge with the option left on.
    test('the machine-origin rule still stands on a job chat with the option ON', () => {
      linkTo('c1', job());
      seedRunning('c1');
      feed(state('c1', { activity: 'idle', turnOrigin: 'machine' }));
      expect(routed).toEqual([]);
      // ...and the job's own fire, which is a `user` turn, still rings.
      feed(state('c1', { activity: 'running' }));
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    // NO FALLBACK. A link pointing at a job that is gone cannot be read as a
    // request for silence — the quiet state is the one the user has to have
    // asked for — so it notifies AND says so in the log.
    test('a link whose job has been deleted notifies, and warns', () => {
      links.set('c1', 'j-gone');
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
      expect(warnings).toEqual([{ chatId: 'c1', jobId: 'j-gone' }]);
    });

    // `message` and `script` actions carry no such field at all, so the read
    // must come out as "notify" rather than throwing or refusing.
    test('a job whose action cannot carry the flag notifies', () => {
      const stored = {
        ...job(),
        action: { type: 'message', chatId: 'c1', prompt: 'go' },
      } as Job;
      linkTo('c1', stored);
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
      expect(warnings).toEqual([]);
    });

    // A caller with no jobs subsystem at all (a test injecting a bare
    // registry) must behave exactly as it did before the gate existed.
    test('a notifier wired with no job gate notifies every chat', () => {
      const bare = new ChatCompletionNotifier({
        chats,
        router: {
          route: async (event: NotifyEvent, opts: RouteOptions = {}) => {
            routed.push({ event, opts });
          },
        } as unknown as NotificationRouter,
        logger,
        now: () => now,
      });
      links.set('c1', 'j1');
      jobs.set('j1', job({ notifyOnComplete: false }));
      chats.observe(spawned('c1'));
      bare.observe(spawned('c1'));
      chats.observe(state('c1', { activity: 'running' }));
      bare.observe(state('c1', { activity: 'running' }));
      chats.observe(state('c1', { activity: 'idle' }));
      bare.observe(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });
  });

  test('a channel that throws does not take the other down or reject', () => {
    failChannels.add('desktop');
    seedRunning('c1');
    expect(() => feed(state('c1', { activity: 'idle' }))).not.toThrow();
    expect(channels()).toEqual(['desktop', 'push']);
  });

  test('every chat that finishes is reported, not just the first', () => {
    seedRunning('c1');
    seedRunning('c2');
    feed(state('c1', { activity: 'idle' }));
    feed(state('c2', { activity: 'idle' }));
    expect(routed.map((r) => `${r.event.chatId}:${r.event.channel}`)).toEqual([
      'c1:desktop',
      'c1:push',
      'c2:desktop',
      'c2:push',
    ]);
  });

  describe('a turn that failed (spec/09 § A turn that failed)', () => {
    const err = (message: string, code = 'sdk_error') => ({ code, message, at: 0 });

    function messages(): string[] {
      return routed.map((r) => r.event.message);
    }

    test('a final failure notifies desktop and push with the error', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', lastError: err('API Error: 500 Internal') }));
      expect(channels()).toEqual(['desktop', 'push']);
      expect(messages()[0]).toMatch(/ failed: API Error: 500 Internal$/);
    });

    test('a rung the retry ladder will run again is silent until the ladder ends', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', turnRetrying: true, lastError: err('boom') }));
      feed(state('c1', { activity: 'running' }));
      feed(state('c1', { activity: 'errored', turnRetrying: true, lastError: err('boom') }));
      expect(routed).toHaveLength(0);
      feed(state('c1', { activity: 'running' }));
      feed(state('c1', { activity: 'errored', turnRetrying: false, lastError: err('boom') }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    test('a retry that succeeds says finished, never failed', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', turnRetrying: true, lastError: err('boom') }));
      feed(state('c1', { activity: 'running' }));
      feed(state('c1', { activity: 'idle' }));
      expect(messages()).toHaveLength(2);
      expect(messages().every((m) => m.includes(' finished'))).toBe(true);
    });

    test('the server-invented link-lost error is not a failure', () => {
      seedRunning('c1');
      feed(
        state('c1', {
          activity: 'errored',
          lastError: err('host link lost', 'daemon_unavailable'),
        }),
      );
      expect(routed).toHaveLength(0);
    });

    test('a machine turn failing is silent', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', turnOrigin: 'machine', lastError: err('boom') }));
      expect(routed).toHaveLength(0);
    });

    test('a pre-flight failure from idle notifies', () => {
      feed(spawned('c1'));
      feed(state('c1', { activity: 'idle' }));
      feed(state('c1', { activity: 'errored', lastError: err('folder is gone') }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    test('a re-sent errored frame does not ring again', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', lastError: err('boom') }));
      feed(state('c1', { activity: 'errored', lastError: err('boom') }));
      expect(routed).toHaveLength(2);
    });

    test('a failure that persists the errored status still notifies', () => {
      seedRunning('c1');
      feed(
        state('c1', {
          activity: 'errored',
          status: 'errored',
          lastError: err('session gone', 'claude_session_invalid'),
        }),
      );
      expect(channels()).toEqual(['desktop', 'push']);
    });

    test('archived and hidden chats are skipped', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', status: 'archived', lastError: err('boom') }));
      seedRunning('c2');
      feed(state('c2', { activity: 'errored', hidden: true, lastError: err('boom') }));
      expect(routed).toHaveLength(0);
    });

    test('a long error is cut to one line', () => {
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', lastError: err(`line one\n${'x'.repeat(400)}`) }));
      const reason = messages()[0]!.split(' failed: ')[1]!;
      expect(reason).not.toContain('\n');
      expect(reason.length).toBe(200);
      expect(reason.endsWith('…')).toBe(true);
    });
  });

  // spec/09 § Chat completion — a running batch's member is skipped for both
  // completion and failure (spec/14 § Batch mode): that suppression is the
  // whole feature, and the batch's own check-in notification stands in.
  describe('a running batch member (spec/14 § Batch mode)', () => {
    test('a completed turn is silent for a batch member', () => {
      batchMembers.add('c1');
      seedRunning('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(routed).toEqual([]);
    });

    test('a failed turn is silent for a batch member too', () => {
      batchMembers.add('c1');
      seedRunning('c1');
      feed(state('c1', { activity: 'errored', lastError: { message: 'boom' } }));
      expect(routed).toEqual([]);
    });

    test('a chat that is not a member is untouched by a batch running elsewhere', () => {
      batchMembers.add('c1');
      seedRunning('c2');
      feed(state('c2', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });

    test('once removed from the batch, the chat notifies again', () => {
      batchMembers.add('c1');
      seedRunning('c1');
      batchMembers.delete('c1');
      feed(state('c1', { activity: 'idle' }));
      expect(channels()).toEqual(['desktop', 'push']);
    });
  });
});
