// Group 9B: dispatcher — mustache substitution, host online vs offline,
// pending buffer + flush, cap enforcement.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { JobLogs } from '../src/jobs/logs.js';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '../src/jobs/types.js';
import type { Job } from '../src/jobs/types.js';

/** Every fire prefaces its first user-turn with the job's autonomy prompt
 * (spec/08 § Autonomy prompt) — `DEFAULT_JOB_AUTONOMY_PROMPT` unless the job
 * overrides it. Tests that assert an exact rendered prompt/message wrap the
 * body in this to say so. */
function withDefaultAutonomyPrompt(body: string): string {
  return `${DEFAULT_JOB_AUTONOMY_PROMPT}\n\n${body}`;
}

// Paths that the mocked fs calls below should fail for — set per-test,
// cleared in afterEach. Everything else delegates to the real fs module.
// This lets us deterministically exercise the fs-error catch branches in
// dispatcher.ts (readFileSync/rmSync failures on the pending-buffer files)
// without racy real-world filesystem tricks.
const failReadFileFor = new Set<string>();
const failRmFor = new Set<string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      if (failReadFileFor.has(path)) throw new Error(`mocked read failure: ${path}`);
      return actual.readFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = String(args[0]);
      if (failRmFor.has(path)) throw new Error(`mocked rm failure: ${path}`);
      return actual.rmSync(...args);
    },
  };
});

// Imported AFTER vi.mock so the dispatcher module picks up the mocked fs
// bindings (vi.mock is hoisted above imports by vitest regardless of
// declaration order, but importing dynamically here keeps intent explicit).
const { JobDispatcher } = await import('../src/jobs/dispatcher.js');

const silentLogger = pino({ level: 'silent' });

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j_00000000000000000000000012',
    name: 'test',
    enabled: true,
    trigger: { type: 'cron', expression: '* * * * *' },
    filter: null,
    action: { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('JobDispatcher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-disp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mustache-substitutes prompt with payload values', () => {
    const out = JobDispatcher.renderPrompt(
      {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/x',
        prompt: 'PR by {{payload.user.login}} merged: {{payload.title}}',
      },
      { payload: { user: { login: 'tom' }, title: 'My PR' } },
      'webhook',
    );
    expect(out).toContain('PR by tom merged: My PR');
  });

  it('always appends the whole event payload, even fields the prompt never templates', () => {
    const payload = {
      payload: { event_data: { content: '', file_attachment: { file_url: 'https://x/p.jpg' } } },
    };
    const out = JobDispatcher.renderPrompt(
      {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/x',
        prompt: 'comment: {{payload.event_data.content}}',
      },
      payload,
      'todoist',
    ) as string;
    expect(out.startsWith('comment: \n\nTrigger event:')).toBe(true);
    expect(out).toContain('"file_url": "https://x/p.jpg"');
    const json = out.slice(out.indexOf('```json\n') + 8, out.lastIndexOf('\n```'));
    expect(JSON.parse(json)).toEqual(payload);
  });

  it('skill action turns into /skill\\n\\n<json-payload>', () => {
    const out = JobDispatcher.renderPrompt(
      { type: 'spawn', daemonId: 'd1', folder: '/x', skill: 'todoist-handler' },
      { payload: { task: { id: 1 } } },
      'todoist',
    );
    expect(out).toContain('/todoist-handler');
    expect(out).toContain('"payload"');
    expect(out).toContain('"task"');
  });

  it('skill + prompt → /skill\\n\\n<rendered prompt> (prompt is the skill body, payload via mustache)', () => {
    const out = JobDispatcher.renderPrompt(
      {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/x',
        skill: 'forage-podcast',
        prompt: 'Focus on {{season}} near home.',
      },
      { season: 'autumn' },
      'webhook',
    );
    expect(out).toContain('/forage-podcast\n\nFocus on autumn near home.');
    // The raw JSON payload follows the rendered prompt.
    expect(out).toContain('"season": "autumn"');
  });

  describe('renderPrompt trigger event block', () => {
    const spawn = { type: 'spawn', daemonId: 'd1', folder: '/x' } as const;
    const payload = { payload: { event_data: { id: 7 } } };
    const block = (out: string): unknown =>
      JSON.parse(out.slice(out.indexOf('```json\n') + 8, out.lastIndexOf('\n```')));

    it.each(['todoist', 'webhook'] as const)(
      '%s + prompt appends the event under Trigger event:',
      (t) => {
        const out = JobDispatcher.renderPrompt(
          { ...spawn, prompt: 'task {{payload.event_data.id}}' },
          payload,
          t,
        ) as string;
        expect(out.startsWith('task 7\n\nTrigger event:\n```json\n')).toBe(true);
        expect(out.endsWith('\n```')).toBe(true);
        expect(block(out)).toEqual(payload);
      },
    );

    it.each(['cron', 'recurrence'] as const)('%s + prompt appends nothing', (t) => {
      const out = JobDispatcher.renderPrompt({ ...spawn, prompt: 'go' }, { firedAt: 1 }, t);
      expect(out).toBe('go');
    });

    it('skill + prompt on cron appends nothing', () => {
      expect(
        JobDispatcher.renderPrompt({ ...spawn, skill: 's', prompt: 'go' }, { firedAt: 1 }, 'cron'),
      ).toBe('/s\n\ngo');
    });

    it('skill-only carries the payload once, not twice', () => {
      const out = JobDispatcher.renderPrompt(
        { ...spawn, skill: 's' },
        payload,
        'todoist',
      ) as string;
      expect(out).not.toContain('Trigger event:');
      expect(out.match(/"event_data"/g)).toHaveLength(1);
    });

    it('skill + prompt on todoist appends the event after the prompt', () => {
      const out = JobDispatcher.renderPrompt(
        { ...spawn, skill: 's', prompt: 'go' },
        payload,
        'todoist',
      ) as string;
      expect(out.startsWith('/s\n\ngo\n\nTrigger event:')).toBe(true);
    });

    it('a script action renders nothing', () => {
      const script = { type: 'script', daemonId: 'd1', folder: '/x', command: 'true' } as const;
      expect(JobDispatcher.renderPrompt(script, payload, 'todoist')).toBeUndefined();
    });

    it('includePayload: false opts out; true and absent both append', () => {
      const off = JobDispatcher.renderPrompt(
        { ...spawn, prompt: 'go', includePayload: false },
        payload,
        'webhook',
      );
      expect(off).toBe('go');
      for (const includePayload of [true, undefined]) {
        const on = JobDispatcher.renderPrompt(
          { ...spawn, prompt: 'go', includePayload },
          payload,
          'webhook',
        ) as string;
        expect(on).toContain('Trigger event:');
      }
    });

    it('applies to message and continue actions too', () => {
      const msg = { type: 'message', chatId: 'c1', prompt: 'go' } as const;
      const cont = { ...spawn, type: 'continue', prompt: 'go' } as const;
      for (const a of [msg, cont]) {
        expect(JobDispatcher.renderPrompt(a, payload, 'todoist')).toContain('Trigger event:');
        expect(
          JobDispatcher.renderPrompt({ ...a, includePayload: false }, payload, 'todoist'),
        ).toBe('go');
      }
    });

    it('a gated job includes the gate output in the block', () => {
      const gated = { gateOutput: 'two new items', gateStdout: 'two new items' };
      const out = JobDispatcher.renderPrompt(
        { ...spawn, prompt: 'go' },
        payload,
        'todoist',
        gated,
      ) as string;
      expect(JSON.stringify(block(out))).toContain('two new items');
    });

    it('the autonomy prompt still comes first', () => {
      const action = { ...spawn, prompt: 'go' } as const;
      const rendered = JobDispatcher.renderPrompt(action, payload, 'todoist') as string;
      const full = JobDispatcher.withAutonomyPrompt(
        action,
        rendered,
        { autonomyPrompt: 'AUTONOMY' },
        'acct',
      );
      expect(full.startsWith('AUTONOMY\n\ngo')).toBe(true);
      expect(full.indexOf('Trigger event:')).toBeGreaterThan(full.indexOf('go'));
    });
  });

  it('spawn → daemon-link send when online', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    const result = disp.dispatch(makeJob(), { firedAt: '2026-01-01' }, 'cron');
    expect(result.status).toBe('sent');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request') {
      expect(sent.event.folder).toBe('/work');
      expect(sent.event.prompt).toContain(withDefaultAutonomyPrompt('go'));
      expect(sent.event.localId).toBe('job-j_00000000000000000000000012-fixed1');
      // spec/08 ## Action: a job-spawned chat opens in the ACTIVE inbox unless
      // its action opts into `hidden` — a run that stops on a question has to
      // be visible to be answerable.
      expect(sent.event.hidden).toBe(false);
    }
    disp.close();
  });

  it('a todoist fire delivers the event after the autonomy prompt; includePayload:false drops it', () => {
    const payload = { payload: { event_data: { id: 'abc' } } };
    const sentPrompt = (action: Job['action']): string => {
      const link = new InProcessDaemonLink();
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fixed1',
      });
      disp.dispatch(makeJob({ trigger: { type: 'todoist' }, action }), payload, 'todoist');
      const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
      disp.close();
      if (!sent || sent.event.type !== 'chat.spawn_request') throw new Error('no spawn sent');
      return sent.event.prompt as string;
    };
    const on = sentPrompt({ type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' });
    expect(on).toContain('go\n\nTrigger event:\n```json');
    expect(on).toContain('"id": "abc"');
    expect(on.indexOf(withDefaultAutonomyPrompt('go').split('go')[0]!)).toBe(0);
    const off = sentPrompt({
      type: 'spawn',
      daemonId: 'd1',
      folder: '/work',
      prompt: 'go',
      includePayload: false,
    });
    expect(off).toBe(withDefaultAutonomyPrompt('go'));
  });

  it('spawn with action.startHidden spawns into Hidden (spec/08 ## Action)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    const action = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '/work',
      prompt: 'go',
      startHidden: true,
    };
    disp.dispatch(makeJob({ action }), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request') expect(sent.event.hidden).toBe(true);
    disp.close();
  });

  it('spawn with action.goal forwards it on the chat.spawn_request (spec/04 § Goals, spec/08 ## Action)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    const action = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '/work',
      prompt: 'go',
      goal: 'Ship the release by Friday',
    };
    disp.dispatch(makeJob({ action }), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request') {
      expect(sent.event.goal).toBe('Ship the release by Friday');
    }
    disp.close();
  });

  it('spawn with no action.goal sends no goal field at all', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    disp.dispatch(makeJob(), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request') {
      expect(sent.event.goal).toBeUndefined();
    }
    disp.close();
  });

  // spec/08 ## Action — `notifyOnComplete` is read SERVER-SIDE, by
  // `ChatCompletionNotifier` when the chat settles. It must therefore NOT reach
  // the host: nothing about it changes how the turn runs, and the actions the
  // host parses are `.strict()`, so a host on an older host would reject a
  // frame carrying an unknown key. Pinned so nobody later "plumbs it through".
  it('spawn with action.notifyOnComplete sends a frame identical to one without it', () => {
    function frameFor(action: Record<string, unknown>): unknown {
      const link = new InProcessDaemonLink();
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fixed1',
      });
      disp.dispatch(makeJob({ action }), { firedAt: '2026-01-01' }, 'cron');
      const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
      disp.close();
      expect(sent).toBeDefined();
      return sent?.event;
    }
    const base = { type: 'spawn', daemonId: 'd1', folder: '/work', prompt: 'go' };
    const plain = frameFor(base);
    for (const value of [false, true]) {
      const withFlag = frameFor({ ...base, notifyOnComplete: value });
      expect(withFlag).toEqual(plain);
      expect(withFlag && 'notifyOnComplete' in (withFlag as object)).toBe(false);
    }
  });

  it('a continue action keeps the flag off the wire on both the spawn and the input', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
    });
    const job = makeJob({
      id: 'j_00000000000000000000notify',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/persist',
        prompt: 'tick',
        notifyOnComplete: false,
      },
    });
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    for (const s of link.sent) {
      expect('notifyOnComplete' in s.event).toBe(false);
    }
    // And the placement it DOES carry is untouched by the new flag.
    const spawn = link.sent.find((s) => s.event.type === 'chat.spawn_request')?.event;
    if (spawn && spawn.type === 'chat.spawn_request') expect(spawn.hidden).toBe(false);
    disp.close();
  });

  // The gate the notifier reads hangs off the chatId → jobId link, so a job
  // that silences its doorbell must still RECORD that link — otherwise the
  // option would be unreadable at settle time (and the chat would drop out of
  // `▸ Automations` too).
  it('a silenced job still records its chatId → jobId link', () => {
    const link = new InProcessDaemonLink();
    const recorded: Array<[string, string]> = [];
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'chat-silenced',
      chatLinks: { get: () => null, record: (chatId, jobId) => recorded.push([chatId, jobId]) },
    });
    const job = makeJob({
      id: 'j_0000000000000000000silent',
      action: {
        type: 'spawn',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'go',
        notifyOnComplete: false,
      },
    });
    disp.dispatch(job, {}, 'cron');
    expect(recorded).toEqual([['chat-silenced', 'j_0000000000000000000silent']]);
    disp.close();
  });

  // spec/08 § Action: a job's permission mode is decided by the job, not by
  // whichever host the fire lands on. Unlike `model` — where omitting the field
  // IS the setting — the mode is always sent, so raising a host's default to a
  // blocking mode for the person sitting at it cannot silently stall every
  // unattended job running there.
  it('spawn without action.permissionMode sends auto (spec/08 § Action)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    disp.dispatch(makeJob(), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request')
      expect(sent.event.permissionMode).toBe('auto');
    disp.close();
  });

  it('spawn forwards action.permissionMode onto the spawn request (spec/08 § Action)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    const action = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '/work',
      prompt: 'go',
      permissionMode: 'plan',
    };
    disp.dispatch(makeJob({ action }), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request')
      expect(sent.event.permissionMode).toBe('plan');
    disp.close();
  });

  // spec/08 § Action: an action may store the model its chat runs on. The wire
  // event's `model` is optional at every spawn site, and OMITTING it is what
  // selects the host's last-used model — so an action without one must send no
  // field at all rather than a null/empty placeholder.
  it('spawn forwards action.model onto the spawn request (spec/08 § Action)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    const action = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '/work',
      prompt: 'go',
      model: 'claude-opus-5',
    };
    disp.dispatch(makeJob({ action }), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request')
      expect(sent.event.model).toBe('claude-opus-5');
    disp.close();
  });

  it('spawn with no action.model omits the field entirely (host last-used wins)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
    });
    disp.dispatch(makeJob(), { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.spawn_request') {
      expect(sent.event.model).toBeUndefined();
      expect('model' in sent.event).toBe(false);
    }
    disp.close();
  });

  it('ensure forwards action.model on the fire that CREATES the durable chat', () => {
    const link = new InProcessDaemonLink();
    let n = 0;
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => `fid${++n}`,
    });
    const job = makeJob({
      id: 'j_00000000000000000000000009',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/persist',
        prompt: 'tick',
        model: 'claude-haiku-4-5',
      },
    });
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    const spawns = link.sent.filter((s) => s.event.type === 'chat.spawn_request');
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]?.event;
    if (spawn && spawn.type === 'chat.spawn_request') expect(spawn.model).toBe('claude-haiku-4-5');
    // The later fire is a plain input into the chat that already exists — a
    // chat's model is fixed for its life, so there is nothing to carry.
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0] && 'model' in inputs[0].event).toBe(false);
    disp.close();
  });

  it('spawn action records the chatId → jobId link (sidebar Automations group, spec/08 § Action)', () => {
    const link = new InProcessDaemonLink();
    const recorded: Array<[string, string]> = [];
    const chatLinks = { record: (chatId: string, jobId: string) => recorded.push([chatId, jobId]) };
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
      chatLinks,
    });
    disp.dispatch(makeJob(), { firedAt: '2026-01-01' }, 'cron');
    expect(recorded).toEqual([['fixed1', 'j_00000000000000000000000012']]);
    disp.close();
  });

  it('message action does NOT record a chat link (delivers into a chat the user already owns)', () => {
    const link = new InProcessDaemonLink();
    const recorded: Array<[string, string]> = [];
    const chatLinks = { record: (chatId: string, jobId: string) => recorded.push([chatId, jobId]) };
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
      chatLinks,
    });
    disp.dispatch(
      makeJob({ action: { type: 'message', chatId: 'c_abc', prompt: 'hi' } }),
      {},
      'cron',
    );
    expect(recorded).toEqual([]);
    disp.close();
  });

  // This used to assert the OPPOSITE — that an ensure chat records no link,
  // "a durable chat the user is meant to find and follow, not background
  // automation". That reasoning stopped holding when `ensure` gained `hidden`
  // (spec/08 ## Action): a hidden ensure chat is out of the inbox, so without a
  // link it would be in Archived and in no Automations row either — invisible
  // in a way a hidden SPAWN never is.
  it('ensure action records the chatId → jobId link on every fire, so a hidden ensure chat is still watchable in Automations', () => {
    const link = new InProcessDaemonLink();
    const recorded: Array<[string, string]> = [];
    const chatLinks = { record: (chatId: string, jobId: string) => recorded.push([chatId, jobId]) };
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
      chatLinks,
    });
    const job = makeJob({
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/persist',
        prompt: 'tick',
        startHidden: true,
      },
    });
    disp.dispatch(job, {}, 'cron');
    // Re-asserted on the delivering fires too: a chat created before this
    // existed would otherwise never gain its tag. `record` is idempotent.
    disp.dispatch(job, {}, 'cron');
    const chatId = 'jobchat-j_00000000000000000000000012';
    expect(recorded).toEqual([
      [chatId, 'j_00000000000000000000000012'],
      [chatId, 'j_00000000000000000000000012'],
    ]);
    disp.close();
  });

  // spec/08 ## Action — `hidden` on `ensure` places the chat the fire CREATES,
  // which is the only fire that places anything; every later fire is a
  // `chat.input` into a chat that already has a home.
  it('ensure with action.startHidden creates its durable chat in Hidden', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
    });
    const job = makeJob({
      id: 'j_0000000000000000000000hide',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/persist',
        prompt: 'tick',
        startHidden: true,
      },
    });
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    const spawns = link.sent.filter((s) => s.event.type === 'chat.spawn_request');
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]?.event;
    if (spawn && spawn.type === 'chat.spawn_request') expect(spawn.hidden).toBe(true);
    // The second fire is a plain input — it carries no placement at all.
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0] && 'hidden' in inputs[0].event).toBe(false);
    disp.close();
  });

  // spec/04 § Goals, spec/08 ## Action — same creation-only rule as `hidden`.
  it('continue with action.goal sets it on the durable chat it creates, never on a later input', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
    });
    const job = makeJob({
      id: 'j_0000000000000000000000goal',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/persist',
        prompt: 'tick',
        goal: 'Keep the queue empty',
      },
    });
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    const spawns = link.sent.filter((s) => s.event.type === 'chat.spawn_request');
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]?.event;
    if (spawn && spawn.type === 'chat.spawn_request')
      expect(spawn.goal).toBe('Keep the queue empty');
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0] && 'goal' in inputs[0].event).toBe(false);
    disp.close();
  });

  // A KEYED ensure is the case `hidden` was actually asked for: one durable
  // chat per Todoist task is one inbox row per task.
  it('a keyed ensure hides each subject chat it creates', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
    });
    const job = makeJob({
      id: 'j_00000000000000000000000key',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/persist',
        prompt: 'build {{task}}',
        key: '{{task}}',
        startHidden: true,
      },
    });
    disp.dispatch(job, { task: 'alpha' }, 'webhook');
    disp.dispatch(job, { task: 'beta' }, 'webhook');
    const spawns = link.sent.filter((s) => s.event.type === 'chat.spawn_request');
    expect(spawns).toHaveLength(2);
    for (const s of spawns) {
      if (s.event.type === 'chat.spawn_request') expect(s.event.hidden).toBe(true);
    }
    disp.close();
  });

  // The default is unchanged: an ensure job nobody has ticked the box on still
  // creates its chat in the active inbox.
  it('ensure without hidden still creates its chat in the active inbox', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
    });
    disp.dispatch(
      makeJob({
        id: 'j_000000000000000000000shown',
        action: { type: 'continue', daemonId: 'd1', folder: '/persist', prompt: 'tick' },
      }),
      {},
      'cron',
    );
    const spawn = link.sent.find((s) => s.event.type === 'chat.spawn_request')?.event;
    expect(spawn).toBeDefined();
    if (spawn && spawn.type === 'chat.spawn_request') expect(spawn.hidden).toBe(false);
    disp.close();
  });

  it('message action → chat.input event', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fid',
    });
    disp.dispatch(
      makeJob({ action: { type: 'message', chatId: 'c_abc', prompt: 'hi {{name}}' } }),
      { name: 'world' },
      'cron',
    );
    const sent = link.sent.find((s) => s.event.type === 'chat.input');
    expect(sent).toBeDefined();
    if (sent && sent.event.type === 'chat.input') {
      expect(sent.event.chatId).toBe('c_abc');
      expect(sent.event.message).toContain(withDefaultAutonomyPrompt('hi world'));
      expect(sent.event.localId).toBe('job-j_00000000000000000000000012-fid');
      // spec/04 § Hidden — marked as a job's, so it cannot un-hide the chat.
      expect(sent.event.source).toEqual({ kind: 'job', jobId: 'j_00000000000000000000000012' });
    }
    disp.close();
  });

  it('ensure action: first fire SPAWNS the durable chat, later fires MESSAGE the same chat', () => {
    const link = new InProcessDaemonLink();
    let n = 0;
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => `fid${++n}`,
    });
    const job = makeJob({
      id: 'j_00000000000000000000000008',
      action: { type: 'continue', daemonId: 'd1', folder: '/persist', prompt: 'tick' },
    });
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    const spawns = link.sent.filter((s) => s.event.type === 'chat.spawn_request');
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    // Exactly one spawn (the first fire); the rest message the same chat.
    expect(spawns).toHaveLength(1);
    expect(inputs).toHaveLength(2);
    const spawn = spawns[0]?.event;
    if (spawn && spawn.type === 'chat.spawn_request') {
      expect(spawn.chatId).toBe('jobchat-j_00000000000000000000000008');
      expect(spawn.folder).toBe('/persist');
      // The persistent chat is meant to be found/followed — NOT archived.
      expect(spawn.hidden).toBe(false);
    }
    for (const i of inputs) {
      if (i.event.type === 'chat.input')
        expect(i.event.chatId).toBe('jobchat-j_00000000000000000000000008');
    }
    disp.close();
  });

  it('ensure action: a chat already in the registry is messaged, never re-spawned', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'x',
      // Simulate the persistent chat already existing (e.g. after a restart).
      chatExists: (id) => id === 'jobchat-j_00000000000000000000000014',
    });
    disp.dispatch(
      makeJob({
        id: 'j_00000000000000000000000014',
        action: { type: 'continue', daemonId: 'd1', folder: '/p', prompt: 'go' },
      }),
      {},
      'cron',
    );
    expect(link.sent.filter((s) => s.event.type === 'chat.spawn_request')).toHaveLength(0);
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    if (inputs[0]?.event.type === 'chat.input') {
      expect(inputs[0].event.chatId).toBe('jobchat-j_00000000000000000000000014');
    }
    disp.close();
  });

  it('buffers when host offline, flushes on reconnect', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
    });
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000003' }), { firedAt: 'a' }, 'cron');
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000003' }), { firedAt: 'b' }, 'cron');
    expect(link.sent).toHaveLength(0);
    expect(readdirSync(join(dir, 'pending')).filter((n) => n.endsWith('.jsonl'))).toHaveLength(2);

    // Flip online — flush should fire.
    link.setStatus('online');
    expect(link.sent.length).toBe(2);
    expect(readdirSync(join(dir, 'pending')).filter((n) => n.endsWith('.jsonl'))).toHaveLength(0);
    disp.close();
  });

  it('caps pending per job, drops oldest', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    let counter = 0;
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      pendingCapPerJob: 2,
      idGenerator: () => `id${++counter}`,
    });
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000013' }), { firedAt: 'a' }, 'cron');
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000013' }), { firedAt: 'b' }, 'cron');
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000013' }), { firedAt: 'c' }, 'cron');
    const remaining = readdirSync(join(dir, 'pending'))
      .filter((n) => n.startsWith('j_00000000000000000000000013-'))
      .sort();
    expect(remaining.length).toBe(2);
    // Oldest (id1) should be gone; id2 + id3 remain.
    expect(remaining.find((n) => n.includes('id1'))).toBeUndefined();
    disp.close();
  });

  it('an action with neither skill nor prompt renders no prompt at all (spawn)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'noop1',
    });
    // Bypasses the REST/RPC-level "must carry a skill, a prompt, or both"
    // gate (jobs/types.ts JobAction refinement) — a direct dispatcher call
    // still has to behave sanely if it's ever reached this way.
    const job = makeJob({ action: { type: 'spawn', daemonId: 'd1', folder: '/x' } });
    const result = disp.dispatch(job, {}, 'cron');
    expect(result.event.type).toBe('chat.spawn_request');
    if (result.event.type === 'chat.spawn_request') {
      expect(result.event.prompt).toBeUndefined();
    }
    disp.close();
  });

  it('an action with neither skill nor prompt renders no prompt at all (ensure)', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'noop2',
    });
    const job = makeJob({
      id: 'j_00000000000000000000000002',
      action: { type: 'continue', daemonId: 'd1', folder: '/x' },
    });
    const result = disp.dispatch(job, {}, 'cron');
    expect(result.event.type).toBe('chat.spawn_request');
    if (result.event.type === 'chat.spawn_request') {
      expect(result.event.prompt).toBeUndefined();
    }
    disp.close();
  });

  it('keyed ensure: different subjects get their own durable chats', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'k',
    });
    const job = makeJob({
      id: 'j_00000000000000000000000020',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'task {{payload.event_data.id}}',
        key: '{{payload.event_data.id}}',
      },
    });
    disp.dispatch(job, { payload: { event_data: { id: 'taskA' } } }, 'todoist');
    disp.dispatch(job, { payload: { event_data: { id: 'taskB' } } }, 'todoist');
    const spawns = link.sent.filter((s) => s.event.type === 'chat.spawn_request');
    // Two subjects → two chats. Unkeyed, this would have been one chat with a
    // second message appended, mixing two unrelated tasks together.
    expect(spawns).toHaveLength(2);
    expect(
      spawns.map((s) => (s.event.type === 'chat.spawn_request' ? s.event.chatId : '')),
    ).toEqual([
      'jobchat-j_00000000000000000000000020-taskA',
      'jobchat-j_00000000000000000000000020-taskB',
    ]);
    disp.close();
  });

  it('keyed ensure: a second fire for the SAME subject messages that subject’s chat', () => {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'k',
    });
    const job = makeJob({
      id: 'j_00000000000000000000000021',
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'edit: {{payload.event_data.content}}',
        key: '{{payload.event_data.id}}',
      },
    });
    disp.dispatch(
      job,
      { payload: { event_data: { id: 'taskA', content: 'build it' } } },
      'todoist',
    );
    disp.dispatch(
      job,
      { payload: { event_data: { id: 'taskA', content: 'no, blue' } } },
      'todoist',
    );
    expect(link.sent.filter((s) => s.event.type === 'chat.spawn_request')).toHaveLength(1);
    const inputs = link.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    if (inputs[0]?.event.type === 'chat.input') {
      expect(inputs[0].event.chatId).toBe('jobchat-j_00000000000000000000000021-taskA');
      expect(inputs[0].event.message).toContain(withDefaultAutonomyPrompt('edit: no, blue'));
    }
    disp.close();
  });

  it('keyed ensure: a key that renders empty is REFUSED, never collapsed onto the job-wide chat', () => {
    const link = new InProcessDaemonLink();
    const logs = new JobLogs(dir);
    const disp = new JobDispatcher({
      dataDir: dir,
      logs,
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'k',
    });
    const jobId = 'j_00000000000000000000000022';
    const job = makeJob({
      id: jobId,
      action: {
        type: 'continue',
        daemonId: 'd1',
        folder: '/work',
        prompt: 'go',
        key: '{{payload.event_data.id}}',
      },
    });
    // A manual run's payload carries only `firedAt` — no subject at all.
    const result = disp.dispatch(job, { payload: { firedAt: 'now' } }, 'manual');
    expect(result.status).toBe('rejected');
    // Nothing was sent anywhere: no spawn onto `jobchat-<jobId>`, no message.
    expect(link.sent).toHaveLength(0);
    // And the refusal is visible where the user looks.
    const runs = readFileSync(join(dir, 'runs', `${jobId}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { status: string; error?: string });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('dispatch-error');
    expect(runs[0]?.error).toContain('rendered empty');
    disp.close();
  });

  it('flush() called directly while offline is a no-op (public API guard)', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    const disp = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    expect(disp.flush()).toEqual({ flushed: 0 });
    disp.close();
  });

  it('listPendingForJob skips an empty pending file (no non-blank first line)', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    let counter = 0;
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      pendingCapPerJob: 5,
      idGenerator: () => `id${++counter}`,
    });
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000010' }), { firedAt: 'a' }, 'cron');
    writeFileSync(join(dir, 'pending', 'j_00000000000000000000000010-id1.jsonl'), '', 'utf8');
    // A second dispatch re-triggers enforceCap -> listPendingForJob, which
    // must skip the now-empty file rather than throwing.
    expect(() =>
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000010' }), { firedAt: 'b' }, 'cron'),
    ).not.toThrow();
    disp.close();
  });

  it('flush skips a non-.jsonl stray file and an empty .jsonl file in the pending dir', () => {
    const link = new InProcessDaemonLink();
    link.setStatus('offline');
    const disp = new JobDispatcher({
      dataDir: dir,
      daemonLink: link,
      logger: silentLogger,
      logs: new JobLogs(dir),
    });
    disp.dispatch(makeJob({ id: 'j_00000000000000000000000011' }), { firedAt: 'a' }, 'cron');
    writeFileSync(join(dir, 'pending', '.DS_Store'), 'not jsonl at all', 'utf8');
    writeFileSync(join(dir, 'pending', 'j_00000000000000000000000011-empty.jsonl'), '', 'utf8');
    link.setStatus('online');
    // The real entry still flushed; the stray + empty files didn't crash it.
    expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(true);
    disp.close();
  });

  describe('fs error resilience (mocked fs failures)', () => {
    afterEach(() => {
      failReadFileFor.clear();
      failRmFor.clear();
    });

    it('enforceCap logs and continues when removing the overflowed entry fails', () => {
      const link = new InProcessDaemonLink();
      link.setStatus('offline');
      let counter = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        pendingCapPerJob: 1,
        idGenerator: () => `id${++counter}`,
      });
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000009' }), { firedAt: 'a' }, 'cron');
      const oldestPath = join(dir, 'pending', 'j_00000000000000000000000009-id1.jsonl');
      failRmFor.add(oldestPath);
      // Second dispatch pushes entries.length (2) past cap (1), triggering
      // enforceCap's rmSync of the oldest — which we've made fail.
      expect(() =>
        disp.dispatch(makeJob({ id: 'j_00000000000000000000000009' }), { firedAt: 'b' }, 'cron'),
      ).not.toThrow();
      // The (now-unremovable) oldest file is still on disk.
      expect(
        readdirSync(join(dir, 'pending')).filter((n) =>
          n.startsWith('j_00000000000000000000000009-'),
        ),
      ).toContain('j_00000000000000000000000009-id1.jsonl');
      disp.close();
    });

    it('listPendingForJob skips an entry it cannot read (does not throw, cap still enforced on the rest)', () => {
      const link = new InProcessDaemonLink();
      link.setStatus('offline');
      let counter = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        pendingCapPerJob: 5,
        idGenerator: () => `id${++counter}`,
      });
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000006' }), { firedAt: 'a' }, 'cron');
      const unreadablePath = join(dir, 'pending', 'j_00000000000000000000000006-id1.jsonl');
      failReadFileFor.add(unreadablePath);
      expect(() =>
        disp.dispatch(makeJob({ id: 'j_00000000000000000000000006' }), { firedAt: 'b' }, 'cron'),
      ).not.toThrow();
      disp.close();
    });

    it('listPendingForJob skips a malformed (non-JSON) pending entry without throwing', () => {
      const link = new InProcessDaemonLink();
      link.setStatus('offline');
      let counter = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        pendingCapPerJob: 5,
        idGenerator: () => `id${++counter}`,
      });
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000004' }), { firedAt: 'a' }, 'cron');
      // Overwrite the just-written entry with garbage — simulates a
      // corrupted pending file (e.g. truncated write from a crash).
      writeFileSync(
        join(dir, 'pending', 'j_00000000000000000000000004-id1.jsonl'),
        'not json at all\n',
        'utf8',
      );
      expect(() =>
        disp.dispatch(makeJob({ id: 'j_00000000000000000000000004' }), { firedAt: 'b' }, 'cron'),
      ).not.toThrow();
      disp.close();
    });

    it('flush logs and continues when removing a flushed entry fails', () => {
      const link = new InProcessDaemonLink();
      link.setStatus('offline');
      const disp = new JobDispatcher({
        dataDir: dir,
        daemonLink: link,
        logger: silentLogger,
        logs: new JobLogs(dir),
      });
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000007' }), { firedAt: 'a' }, 'cron');
      const files = readdirSync(join(dir, 'pending')).filter((n) =>
        n.startsWith('j_00000000000000000000000007-'),
      );
      expect(files).toHaveLength(1);
      failRmFor.add(join(dir, 'pending', files[0]!));
      link.setStatus('online');
      // The flush triggered by the online transition should not throw even
      // though removing the just-flushed file fails.
      expect(link.sent.some((s) => s.event.type === 'chat.spawn_request')).toBe(true);
      disp.close();
    });

    it('flush skips an entry it cannot read, and a malformed entry, without throwing', () => {
      const link = new InProcessDaemonLink();
      link.setStatus('offline');
      let counter = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        logs: new JobLogs(dir),
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => `id${++counter}`,
      });
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000005' }), { firedAt: 'a' }, 'cron');
      disp.dispatch(makeJob({ id: 'j_00000000000000000000000001' }), { firedAt: 'b' }, 'cron');
      failReadFileFor.add(join(dir, 'pending', 'j_00000000000000000000000005-id1.jsonl'));
      writeFileSync(
        join(dir, 'pending', 'j_00000000000000000000000001-id2.jsonl'),
        'not json at all\n',
        'utf8',
      );
      // flush() no-ops unless the host is online — flipping status here
      // triggers the real flush path (same as production's reconnect flow).
      expect(() => link.setStatus('online')).not.toThrow();
      disp.close();
    });
  });
  // ---------------------------------------------------------------------
  // Run outcomes — spec/08 ## Execution model step 6 + ## Logs. The run is
  // written from what the HOST reports back, never at dispatch time.
  describe('run outcomes come from the host', () => {
    const JOB_ID = 'j_00000000000000000000000099';

    function setup(opts: { offline?: boolean } = {}) {
      const link = new InProcessDaemonLink();
      if (opts.offline) link.setStatus('offline');
      const logs = new JobLogs(dir);
      const disp = new JobDispatcher({
        dataDir: dir,
        logs,
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fire1',
        ackTimeoutMs: 50,
      });
      return { link, logs, disp };
    }

    it('writes NOTHING at dispatch time — the fire is not ok until the host says so', () => {
      const { logs, disp } = setup();
      disp.dispatch(makeJob({ id: JOB_ID }), {}, 'webhook');
      expect(logs.readRuns(JOB_ID)).toHaveLength(0);
      disp.close();
    });

    it('chat.spawned → ok carrying the chatId the host confirmed', () => {
      const { link, logs, disp } = setup();
      const result = disp.dispatch(makeJob({ id: JOB_ID }), {}, 'webhook');
      const chatId = result.event.chatId as string;
      link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });
      const runs = logs.readRuns(JOB_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('ok');
      expect(runs[0]?.action?.chatId).toBe(chatId);
      expect(runs[0]?.action?.daemonId).toBe('d1');
      disp.close();
    });

    it("the host's own error → dispatch-error naming the host, with NO chatId", () => {
      const { link, logs, disp } = setup();
      const result = disp.dispatch(makeJob({ id: JOB_ID }), {}, 'webhook');
      const chatId = result.event.chatId as string;
      link.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'folder_not_found', message: 'folder does not exist: /work' },
        seq: -1,
      });
      const runs = logs.readRuns(JOB_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('dispatch-error');
      expect(runs[0]?.error).toContain('d1');
      expect(runs[0]?.error).toContain('folder_not_found');
      expect(runs[0]?.error).toContain('folder does not exist: /work');
      // A fire that never landed must not offer a chat link that 404s.
      expect(runs[0]?.action?.chatId).toBeUndefined();
      expect(runs[0]?.action?.daemonId).toBe('d1');
      disp.close();
    });

    it('a host that answers nothing at all → dispatch-error naming it (never a silent ok)', async () => {
      const { logs, disp } = setup();
      disp.dispatch(makeJob({ id: JOB_ID }), {}, 'webhook');
      await new Promise((r) => setTimeout(r, 120));
      const runs = logs.readRuns(JOB_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('dispatch-error');
      expect(runs[0]?.error).toContain('d1');
      disp.close();
    });

    // An `ensure` chat is durable: its Claude session can be gone (host
    // restart, pruned transcript, a run the spend limit killed) while the chat
    // still holds turns. The host refuses to resume into a fresh contextless
    // session and marks the chat `errored` — which is exactly the state its own
    // pre-flight lets the NEXT turn start fresh from. A person supplies that
    // next turn by typing again; a job has nobody to type, so the dispatcher
    // does it. Without this, 20 Todoist tasks sat untouched for days with the
    // failure only in a run log nobody reads.
    it('an ensure fire whose chat lost its session is retried once, and starts fresh', () => {
      const { link, logs, disp } = setup();
      const job = makeJob({
        id: JOB_ID,
        concurrency: 1,
        action: { type: 'continue', daemonId: 'd1', folder: '/work', prompt: 'go' },
      });
      // First fire creates the durable chat.
      const first = disp.dispatch(job, {}, 'todoist');
      const chatId = first.event.chatId as string;
      link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });
      // Second fire appends to it — this is the one that can hit the guard.
      const second = disp.dispatch(job, {}, 'todoist');
      const inputsBefore = link.sent.filter((x) => x.event.type === 'chat.input').length;
      expect(inputsBefore).toBe(1);
      // The host ACCEPTS the input, so the fire settles `ok`. The session is
      // only found missing when the turn actually runs, a moment later — which
      // is why this arrives as a chat error and not as the fire's own failure.
      link.emit({
        type: 'chat.input_ack',
        chatId,
        localId: (second.event as { localId: string }).localId,
      });

      link.emit({
        type: 'chat.error',
        chatId,
        error: {
          code: 'claude_session_missing',
          message:
            'chat has no claudeSessionId to resume; refusing to start a fresh contextless session',
        },
        seq: 4,
      });

      // The work is re-sent rather than dropped.
      const inputs = link.sent.filter((x) => x.event.type === 'chat.input');
      expect(inputs).toHaveLength(2);
      // A fresh localId, because the host dedupes on it and the refused
      // delivery already consumed the original.
      const ids = inputs.map((x) => (x.event.type === 'chat.input' ? x.event.localId : ''));
      expect(new Set(ids).size).toBe(2);
      // The run log says the failure happened AND that it is being retried —
      // a silent recovery would be as hard to diagnose as a silent failure.
      const err = logs.readRuns(JOB_ID).find((r) => r.status === 'chat-error');
      expect(err?.error).toContain('claude_session_missing');
      expect(err?.error).toContain('retried once');
      disp.close();
    });

    it('a chat that stays session-less is retried once and then left alone', () => {
      const { link, disp } = setup();
      const job = makeJob({
        id: JOB_ID,
        action: { type: 'continue', daemonId: 'd1', folder: '/work', prompt: 'go' },
      });
      const first = disp.dispatch(job, {}, 'todoist');
      const chatId = first.event.chatId as string;
      link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });
      const second = disp.dispatch(job, {}, 'todoist');
      link.emit({
        type: 'chat.input_ack',
        chatId,
        localId: (second.event as { localId: string }).localId,
      });

      const fail = (): void =>
        link.emit({
          type: 'chat.error',
          chatId,
          error: { code: 'claude_session_missing', message: 'no session' },
          seq: 4,
        });
      fail();
      fail();
      fail();
      // Exactly one retry: the original delivery plus one resend. A chat that
      // is broken for some other reason must not be hammered forever.
      expect(link.sent.filter((x) => x.event.type === 'chat.input')).toHaveLength(2);
      disp.close();
    });

    it('a spawn-action chat error is never retried — a spawn creates its own chat', () => {
      const { link, disp } = setup();
      const result = disp.dispatch(makeJob({ id: JOB_ID }), {}, 'todoist');
      const chatId = result.event.chatId as string;
      link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });
      link.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'claude_session_missing', message: 'no session' },
        seq: 3,
      });
      // Nothing to resend: a spawn creates its own chat, so it cannot be the
      // fire that found one with a dead session.
      expect(link.sent.filter((x) => x.event.type === 'chat.input')).toHaveLength(0);
      disp.close();
    });

    it('a chat that lands and THEN dies is recorded against its job (chat-error)', () => {
      // The 2026-08-26 failure: nine spawns landed fine and every chat died on
      // its first turn to a usage limit. Each fire read `ok` forever, so the
      // run log showed nine healthy fires and no one looked again for two days.
      const { link, logs, disp } = setup();
      const result = disp.dispatch(makeJob({ id: JOB_ID, concurrency: 1 }), {}, 'todoist');
      const chatId = result.event.chatId as string;
      link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });
      expect(logs.readRuns(JOB_ID)).toHaveLength(1);

      // Same chat, later: its first turn throws.
      link.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'sdk_error', message: "You've hit your limit \u00b7 resets 5pm (UTC)" },
        seq: 3,
      });

      // readRuns is newest-first: the ok stands, and the failure is added.
      const runs = logs.readRuns(JOB_ID);
      expect(runs).toHaveLength(2);
      expect(runs[0]?.status).toBe('chat-error');
      expect(runs[0]?.error).toContain(chatId);
      expect(runs[0]?.error).toContain('hit your limit');
      expect(runs[0]?.action?.chatId).toBe(chatId);
      expect(runs[1]?.status).toBe('ok');
      disp.close();
    });

    it('attributes a failed chat through the job link when the job holds no slot', () => {
      // No concurrency limit means no slot (acquireSlot), so the link store is
      // the only thing that still knows whose chat this was.
      const links = new Map<string, string>();
      const link = new InProcessDaemonLink();
      const logs = new JobLogs(dir);
      const disp = new JobDispatcher({
        dataDir: dir,
        logs,
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fire1',
        ackTimeoutMs: 50,
        chatLinks: {
          record: (chatId: string, jobId: string) => links.set(chatId, jobId),
          get: (chatId: string) => links.get(chatId) ?? null,
        },
      });
      const result = disp.dispatch(makeJob({ id: JOB_ID }), {}, 'todoist');
      const chatId = result.event.chatId as string;
      link.emit({ type: 'chat.spawned', chatId, daemonId: 'd1', folder: '/work' });
      link.emit({
        type: 'chat.error',
        chatId,
        error: { code: 'sdk_error', message: 'socket hang up' },
        seq: 3,
      });
      const runs = logs.readRuns(JOB_ID);
      expect(runs[0]?.status).toBe('chat-error');
      expect(runs[0]?.error).toContain('socket hang up');
      disp.close();
    });

    it('chat.input_ack settles a message fire as ok', () => {
      const { link, logs, disp } = setup();
      disp.dispatch(
        makeJob({ id: JOB_ID, action: { type: 'message', chatId: 'c_abc', prompt: 'hi' } }),
        {},
        'todoist',
      );
      link.emit({ type: 'chat.input_ack', chatId: 'c_abc', localId: `job-${JOB_ID}-fire1` });
      const runs = logs.readRuns(JOB_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('ok');
      expect(runs[0]?.action?.chatId).toBe('c_abc');
      disp.close();
    });

    it('an offline host is buffered against THAT host and logged as pending against it', () => {
      const { logs, disp } = setup({ offline: true });
      disp.dispatch(makeJob({ id: JOB_ID }), {}, 'cron');
      const runs = logs.readRuns(JOB_ID);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('buffered');
      expect(runs[0]?.action?.daemonId).toBe('d1');
      // Nothing landed, so nothing to link to.
      expect(runs[0]?.action?.chatId).toBeUndefined();
      disp.close();
    });

    it('a fire queued for host X is NOT released because host Y came online', () => {
      const link = new InProcessDaemonLink();
      link.setDaemonId('other-host');
      const logs = new JobLogs(dir);
      const disp = new JobDispatcher({
        dataDir: dir,
        logs,
        daemonLink: link,
        logger: silentLogger,
        idGenerator: () => 'fire2',
        ackTimeoutMs: 50,
      });
      // 'd1' (the action's host) is NOT the machine on this link.
      const res = disp.dispatch(makeJob({ id: JOB_ID }), {}, 'cron');
      expect(res.status).toBe('buffered');
      expect(disp.flush()).toEqual({ flushed: 0 });
      expect(link.sent).toHaveLength(0);
      disp.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Job model (spec/08 § Action)
//
// A job that names no model used to send no `model` field at all, which
// resolved through the HOST's `lastUsedModel` — the model the last chat on that
// machine happened to pick. So one throwaway cheap-model chat silently moved
// every unattended job onto it, and it stayed there across deploys, purchases
// and feature work until someone happened to pick something else. The model a
// job runs on is now sent explicitly on every fire.
// ---------------------------------------------------------------------------
describe('JobDispatcher — the model a job runs on', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-disp-model-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function spawnFrom(job: Job, defaultModel?: () => string | undefined) {
    const link = new InProcessDaemonLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => 'fixed1',
      ...(defaultModel ? { defaultModel } : {}),
    });
    disp.dispatch(job, { firedAt: '2026-01-01' }, 'cron');
    const sent = link.sent.find((s) => s.event.type === 'chat.spawn_request');
    disp.close();
    return sent?.event.type === 'chat.spawn_request' ? sent.event : undefined;
  }

  it('sends the account default when the job pins no model of its own', () => {
    const event = spawnFrom(makeJob(), () => 'claude-opus-5');
    expect(event?.model).toBe('claude-opus-5');
  });

  it("keeps the job's OWN model — the account default never overrides a pinned one", () => {
    const event = spawnFrom(
      makeJob({
        action: {
          type: 'spawn',
          daemonId: 'd1',
          folder: '/work',
          prompt: 'go',
          model: 'claude-haiku-4-5-20251001',
        },
      }),
      () => 'claude-opus-5',
    );
    expect(event?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('sends the account default for an `ensure` action too — the same drift applied there', () => {
    const event = spawnFrom(
      makeJob({ action: { type: 'continue', daemonId: 'd1', folder: '/work', prompt: 'go' } }),
      () => 'claude-opus-5',
    );
    expect(event?.model).toBe('claude-opus-5');
  });

  it('sends NO model field with no settings store wired, rather than inventing an id', () => {
    const event = spawnFrom(makeJob());
    expect(event).toBeDefined();
    expect(event && 'model' in event).toBe(false);
  });
});

// 2026-09-29: the chat mirror is empty after a server restart until each host
// re-announces its chats. An `ensure` firing in that window read its durable
// chat as missing and sent a spawn for an id the host already had — which the
// host refuses as a duplicate, losing the fire. A miss on a host that has not
// reported is "unknown": the fire waits, and is decided once the host reports.
describe('JobDispatcher — ensure before its host has reported', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-jobs-ensure-sync-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const job = makeJob({
    id: 'j_0000000000000000000000ENSR',
    action: { type: 'continue', daemonId: 'd1', folder: '/persist', prompt: 'tick' },
  });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function setup(state: { reported: boolean; exists: boolean }, link = new InProcessDaemonLink()) {
    let n = 0;
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      daemonLink: link,
      logger: silentLogger,
      idGenerator: () => `fid${++n}`,
      chatExists: () => state.exists,
      hostReported: (id) => id === 'd1' && state.reported,
    });
    const types = (): string[] => link.sent.map((s) => s.event.type);
    return { link, disp, types };
  }

  it('holds the fire, then delivers INTO the chat the host reports — no spawn', async () => {
    const state = { reported: false, exists: false };
    const { link, disp, types } = setup(state);
    const result = disp.dispatch(job, {}, 'cron');
    expect(result.status).toBe('buffered');
    expect(types()).toEqual([]);

    // The host re-announces its chats; the durable one is among them.
    state.reported = true;
    state.exists = true;
    link.emit({ type: 'folders.list', daemonId: 'd1', roots: [], recent: [] });
    await tick();
    expect(types()).toEqual(['chat.input']);
    const input = link.sent[0]!.event;
    expect(input.type === 'chat.input' && input.message).toContain(
      withDefaultAutonomyPrompt('tick'),
    );
    disp.close();
  });

  it('spawns once when the host reports and the chat really is not there', async () => {
    const state = { reported: false, exists: false };
    const { link, disp, types } = setup(state);
    disp.dispatch(job, {}, 'cron');
    disp.dispatch(job, {}, 'cron');
    expect(types()).toEqual([]);

    state.reported = true;
    link.emit({ type: 'folders.list', daemonId: 'd1', roots: [], recent: [] });
    await tick();
    // The first held fire creates the chat; the second goes into it.
    expect(types()).toEqual(['chat.spawn_request', 'chat.input']);
    disp.close();
  });

  it('another host reporting does not release a fire held for this one', async () => {
    const state = { reported: false, exists: false };
    const { link, disp, types } = setup(state);
    disp.dispatch(job, {}, 'cron');
    link.emit({ type: 'folders.list', daemonId: 'd2', roots: [], recent: [] });
    await tick();
    expect(types()).toEqual([]);
    disp.close();
  });

  it('a host that has reported is decided at once, as before', () => {
    const { disp, types } = setup({ reported: true, exists: false });
    expect(disp.dispatch(job, {}, 'cron').status).toBe('sent');
    disp.dispatch(job, {}, 'cron');
    expect(types()).toEqual(['chat.spawn_request', 'chat.input']);
    disp.close();
  });

  it('a held fire survives a server restart and is still decided by the report', async () => {
    const state = { reported: false, exists: false };
    const first = setup(state);
    first.disp.dispatch(job, {}, 'cron');
    // Let the first process's own startup flush run (and find nothing it may
    // release) before it is gone.
    await tick();
    first.disp.close();
    expect(first.types()).toEqual([]);

    // A new process: fresh in-memory state, same pending buffer on disk.
    const second = setup(state);
    state.reported = true;
    state.exists = true;
    second.link.emit({ type: 'folders.list', daemonId: 'd1', roots: [], recent: [] });
    await tick();
    expect(second.types()).toEqual(['chat.input']);
    second.disp.close();
  });
});
