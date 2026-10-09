import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  MeetingManager,
  MeetingError,
  type AnalyseInput,
  type MeetingAnalysis,
} from '../src/meeting.js';
import {
  buildMeetingPrompt,
  makeMeetingAnalyser,
  MEETING_MODEL,
  parseMeetingAnalysis,
} from '../src/meetingGen.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { handleServerEvent } from '../src/index.js';

const logger = pino({ level: 'silent' });

const analysis = (over: Partial<MeetingAnalysis> = {}): MeetingAnalysis => ({
  now: { headline: 'Ledger split timing', bullets: ['Black Friday risk'], who: 'Dev' },
  topics: [
    { id: null, title: 'Points ledger', points: ['Own service'], decided: true, atSeconds: 5 },
  ],
  actions: [{ title: "Top up Sam's sandbox", why: 'Sam: tests fail', atSeconds: 7 }],
  summary: null,
  ...over,
});

describe('MeetingManager', () => {
  let dir: string;
  let clock: number;
  let events: WireEvent[];
  let analyse: ReturnType<typeof vi.fn<(i: AnalyseInput) => Promise<MeetingAnalysis>>>;
  let transcribe: ReturnType<typeof vi.fn<(b: Buffer) => Promise<string>>>;
  let runAction: ReturnType<typeof vi.fn<(c: string, m: string) => Promise<void>>>;
  let ticks: (() => void)[];
  let n: number;

  const make = (): MeetingManager =>
    new MeetingManager({
      dir,
      transcribe,
      analyse,
      runAction,
      logger,
      emit: (e) => events.push(e),
      now: () => clock,
      newId: () => `id${++n}`,
      setInterval: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearInterval: () => {
        ticks = [];
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meeting-'));
    clock = 1_000_000;
    events = [];
    ticks = [];
    n = 0;
    analyse = vi.fn(async () => analysis());
    transcribe = vi.fn(async () => 'hello there');
    runAction = vi.fn(async () => undefined);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('start publishes a live meeting and refuses a second', () => {
    const m = make();
    m.start('c1');
    expect(m.get('c1')?.status).toBe('live');
    expect(events.at(-1)).toMatchObject({ type: 'meeting.state', chatId: 'c1' });
    expect(() => m.start('c1')).toThrow(MeetingError);
  });

  it('transcribes clips in order, labelling mic as you and system as them', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    clock += 5000;
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    clock += 5000;
    await m.ingestAudio('c1', 'system', Buffer.from('b'));
    expect(m.get('c1')?.transcript).toEqual([
      { at: 5000, speaker: 'you', text: 'first' },
      { at: 10000, speaker: 'them', text: 'second' },
    ]);
  });

  it('drops silent clips instead of adding empty lines', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockResolvedValueOnce('   ');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.transcript).toEqual([]);
  });

  it('puts a transcription failure on state.error and clears it on the next success', async () => {
    const m = make();
    m.start('c1');
    transcribe.mockRejectedValueOnce(new Error('sidecar down'));
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.error).toContain('sidecar down');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')?.error).toBeNull();
  });

  it('tick analyses only new lines and merges topics and actions once', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    const s = m.get('c1')!;
    expect(s.now?.headline).toBe('Ledger split timing');
    expect(s.topics).toEqual([
      { id: 'id1', at: 5000, title: 'Points ledger', points: ['Own service'], decided: true },
    ]);
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0]).toMatchObject({
      title: "Top up Sam's sandbox",
      status: 'pending',
      at: 7000,
    });

    await m.tick('c1'); // nothing new → no second model call
    expect(analyse).toHaveBeenCalledTimes(1);

    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({
        topics: [
          { id: 'id1', title: 'Points ledger', points: ['Own service', 'November'], decided: true },
        ],
        actions: [{ title: "top up  Sam's SANDBOX", why: 'again' }],
      }),
    );
    await m.tick('c1');
    const s2 = m.get('c1')!;
    expect(s2.topics).toHaveLength(1);
    expect(s2.topics[0]!.points).toEqual(['Own service', 'November']);
    expect(s2.actions).toHaveLength(1); // duplicate title ignored
    expect(analyse.mock.calls[1]![0].newLines).toHaveLength(1);
  });

  it('the interval timer drives analysis', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    ticks[0]!();
    await vi.waitFor(() => expect(m.get('c1')?.now).not.toBeNull());
  });

  it('an analysis failure is surfaced, and the same lines are retried next pass', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockRejectedValueOnce(new Error('no credit'));
    await m.tick('c1');
    expect(m.get('c1')?.error).toContain('no credit');
    await m.tick('c1');
    expect(m.get('c1')?.error).toBeNull();
    expect(analyse.mock.calls[1]![0].newLines).toHaveLength(1);
  });

  it('a malformed analysis is an error, not a silent empty update', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce({ nope: true } as unknown as MeetingAnalysis);
    await m.tick('c1');
    expect(m.get('c1')?.error).toContain('analysis failed');
    expect(m.get('c1')?.now).toBeNull();
  });

  it('pause stops the clock and the timer, resume restarts both', async () => {
    const m = make();
    m.start('c1');
    clock += 60_000;
    m.pause('c1');
    expect(m.get('c1')).toMatchObject({ status: 'paused', elapsedBaseMs: 60_000 });
    expect(ticks).toHaveLength(0);
    clock += 600_000;
    m.resume('c1');
    clock += 1000;
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    expect(m.get('c1')!.transcript[0]!.at).toBe(61_000);
    expect(ticks).toHaveLength(1);
    expect(() => m.resume('c1')).toThrow(MeetingError);
  });

  it('end runs a final pass that writes the summary and then rejects audio', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({ summary: { headline: 'Split in November', bullets: ['1 decision'] } }),
    );
    clock += 52 * 60_000;
    await m.end('c1');
    const s = m.get('c1')!;
    expect(s.status).toBe('ended');
    expect(s.summary?.headline).toBe('Split in November');
    expect(s.elapsedBaseMs).toBe(52 * 60_000);
    expect(analyse.mock.calls[0]![0].final).toBe(true);
    expect(() => m.ingestAudio('c1', 'mic', Buffer.from('a'))).toThrow(/ended/);
    expect(() => m.start('c1')).not.toThrow(); // a new meeting may follow
  });

  it('a final pass with no summary is an error on the state', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.end('c1'); // default analysis() has summary null
    expect(m.get('c1')?.error).toContain('no summary');
  });

  it('Do it dispatches through the chat and marks the card done; dismiss just drops it', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    analyse.mockResolvedValueOnce(
      analysis({
        actions: [
          { title: 'A one', why: 'w' },
          { title: 'B two', why: 'w' },
        ],
      }),
    );
    await m.tick('c1');
    const [a, b] = m.get('c1')!.actions;
    clock += 1;
    await m.decide('c1', a!.id, 'do');
    expect(runAction).toHaveBeenCalledWith('c1', expect.stringContaining('A one'));
    await m.decide('c1', b!.id, 'dismiss');
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(m.get('c1')!.actions.map((x) => x.status)).toEqual(['done', 'dismissed']);
    await expect(m.decide('c1', a!.id, 'do')).rejects.toThrow(/already done/);
    await expect(m.decide('c1', 'zzz', 'do')).rejects.toThrow(/no action/);
  });

  it('keeps the card pending when the chat refuses the action', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    await m.tick('c1');
    runAction.mockRejectedValueOnce(new Error('chat busy'));
    await expect(m.decide('c1', m.get('c1')!.actions[0]!.id, 'do')).rejects.toThrow('chat busy');
    expect(m.get('c1')!.actions[0]!.status).toBe('pending');
  });

  it('contextFor hands the chat the panel and only unseen transcript, once', async () => {
    const m = make();
    expect(m.contextFor('c1')).toBeUndefined();
    m.start('c1');
    transcribe.mockResolvedValueOnce('we ship monday');
    await m.ingestAudio('c1', 'system', Buffer.from('a'));
    await m.tick('c1');
    const first = m.contextFor('c1')!;
    expect(first).toContain('<system-reminder>');
    expect(first).toContain('we ship monday');
    expect(first).toContain('Ledger split timing');
    expect(first).toContain("Top up Sam's sandbox");
    const second = m.contextFor('c1')!;
    expect(second).not.toContain('we ship monday');
  });

  it('survives a host restart: reloads from disk, parked as paused, atomic file only', async () => {
    const m = make();
    m.start('c1');
    await m.ingestAudio('c1', 'mic', Buffer.from('a'));
    clock += 30_000;
    const m2 = make();
    const s = m2.get('c1')!;
    expect(s.status).toBe('paused');
    expect(s.elapsedBaseMs).toBe(30_000);
    expect(s.transcript).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a corrupt meeting file throws rather than reading as empty', () => {
    const m = make();
    m.start('c1');
    const m2 = make();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(join(dir, 'c1.json'), '{not json');
    expect(() => m2.get('c1')).toThrow();
  });
});

describe('meetingGen', () => {
  it('parses JSON wrapped in prose or fences', () => {
    const body = JSON.stringify(analysis());
    expect(parseMeetingAnalysis('Here you go:\n```json\n' + body + '\n```').now.headline).toBe(
      'Ledger split timing',
    );
  });

  it('rejects a reply with no JSON or the wrong shape', () => {
    expect(() => parseMeetingAnalysis('sorry')).toThrow(/no JSON/);
    expect(() => parseMeetingAnalysis('{"now":1}')).toThrow();
  });

  it('asks for a summary only on the final pass', () => {
    const base: AnalyseInput = {
      chatId: 'c',
      previous: { now: null, topics: [], actions: [] },
      newLines: [{ clock: '00:05', speaker: 'You', text: 'hi' }],
      final: false,
      elapsedMs: 5000,
    };
    expect(buildMeetingPrompt(base)).toContain('"summary":null');
    expect(buildMeetingPrompt({ ...base, final: true })).toContain('one-line outcome');
    expect(buildMeetingPrompt(base)).toContain('[00:05 You] hi');
  });
});

describe('makeMeetingAnalyser', () => {
  const input: AnalyseInput = {
    chatId: 'c',
    previous: { now: null, topics: [], actions: [] },
    newLines: [{ clock: '00:05', speaker: 'Them', text: 'ship monday' }],
    final: false,
    elapsedMs: 5000,
  };

  it('runs the cheap model with the transcript and parses the reply', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: JSON.stringify(analysis()) },
      { type: 'result', sessionId: 's' },
    ]);
    const gen = makeMeetingAnalyser({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_l, run) => run('tok'),
      cwd: '/home/x',
    });
    const out = await gen(input);
    expect(out.now.headline).toBe('Ledger split timing');
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(MEETING_MODEL);
    expect(opts?.oauthAccessToken).toBe('tok');
    expect(opts?.prompt).toContain('ship monday');
  });

  it('throws when no account can run it, instead of returning an empty update', async () => {
    const gen = makeMeetingAnalyser({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: async () => null,
      cwd: '/home/x',
    });
    await expect(gen(input)).rejects.toThrow(/no account/);
  });

  it('throws on a model reply that is not the notes JSON', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'I cannot do that' },
      { type: 'result', sessionId: 's' },
    ]);
    const gen = makeMeetingAnalyser({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_l, run) => run('tok'),
      cwd: '/home/x',
    });
    await expect(gen(input)).rejects.toThrow(/no JSON/);
  });
});

describe('meeting events on the host link', () => {
  it('routes control, audio, action and get events to the manager', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-ev-'));
    const sent: WireEvent[] = [];
    const m = new MeetingManager({
      dir,
      transcribe: async () => 'hi',
      analyse: async () => analysis({ summary: { headline: 'h', bullets: [] } }),
      runAction: async () => undefined,
      logger,
      emit: (e) => sent.push(e),
    });
    const send = (e: WireEvent): Promise<void> =>
      handleServerEvent(e, {} as never, (x) => sent.push(x), logger, { meetings: m } as never);
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'start' });
    await send({
      type: 'meeting.audio',
      chatId: 'c',
      source: 'mic',
      audioBase64: Buffer.from('x').toString('base64'),
    });
    expect(m.get('c')?.transcript).toHaveLength(1);
    await m.tick('c');
    await send({
      type: 'meeting.action_request',
      chatId: 'c',
      actionId: m.get('c')!.actions[0]!.id,
      decision: 'dismiss',
    });
    expect(m.get('c')!.actions[0]!.status).toBe('dismissed');
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'pause' });
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'resume' });
    await send({ type: 'meeting.control_request', chatId: 'c', action: 'end' });
    expect(m.get('c')?.status).toBe('ended');
    sent.length = 0;
    await send({ type: 'meeting.get_request', chatId: 'c' });
    expect(sent[0]).toMatchObject({ type: 'meeting.state', chatId: 'c' });
    m.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a chat error when a meeting op is refused, and when the host has no meeting support', async () => {
    const sent: WireEvent[] = [];
    const daemon = { allocErrorSeq: () => 1 } as never;
    await handleServerEvent(
      { type: 'meeting.control_request', chatId: 'c', action: 'start' },
      daemon,
      (x) => sent.push(x),
      logger,
      {} as never,
    );
    expect(sent[0]).toMatchObject({ type: 'chat.error', chatId: 'c' });
  });
});
