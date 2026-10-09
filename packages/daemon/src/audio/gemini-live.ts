// Native voice tier: Gemini Live (group: native voice tier).
//
// spec/07-voice-app.md § Light layer / heavy layer split. The native tier
// replaces Whisper→agent→Kokoro with ONE hosted speech-to-speech session: the
// host relays mic PCM straight through to Gemini Live and plays back
// whatever audio it returns, with no local STT/TTS stage at all. Gemini Live
// IS the light layer — "a capable but generic assistant" with no access to
// Patch's data — and dispatches to the real heavy agent (the SAME
// `submitUserTurn` callback `VoiceSession` uses, so a dispatched turn lands in
// the real chat exactly as it does on the fallback tier) via ONE function tool,
// `dispatch_to_patch`, declared NON_BLOCKING so the model can speak a bridge
// phrase itself while the dispatch is in flight rather than going silent.
//
// Model: `gemini-2.5-flash-native-audio-preview-12-2025` (see
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025,
// confirmed as the documented Live API native-audio model, 2026-09-16 — Google
// versions these frequently; override with GEMINI_LIVE_MODEL if it moves).
// Endpoint + message shapes (setup / realtimeInput / serverContent / toolCall /
// toolResponse / clientContent) confirmed against
// https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket and
// .../live-api/tools and .../live-api/capabilities the same day.
//
// Scope: this class only ever backs a `role: 'voice-call'` session on a
// non-device surface — hands-free or call (audio/server.ts only constructs it
// for those). `layer` picks the model (`geminiLiveModelFor`): `heavy` runs the
// Live API's extended-thinking model, `light` — and `direct`, which has no
// meaning on a hosted backend — the default. DICTATION on `gemini` does not use
// a Live session at all: dictation is bounded by a gesture, not by Gemini's own
// turn-taking, and is STT only, so it runs the ordinary `VoiceSession` with a
// Gemini transcriber in Whisper's place (hosted-stt.ts). `finalizeNote()` below
// exists only to satisfy `VoiceSessionLike`. The physical device is a separate
// scope cut: its 16kHz-mic/48kHz-speaker resampling path is specific to
// `VoiceSession`'s device branch, so `device` on `gemini` is refused at
// connection time (`voice_config_not_implemented`) until that path is built.
// Hands-free's address gating is NOT enforced on this tier: Gemini Live has no
// "transcribe but don't answer" switch (OpenAI Realtime's `create_response:
// false`, which openai-realtime.ts uses), so Gemini answers every utterance it
// hears in either mode. spec/07 says so.
//
// One conversation with the chat (spec/07 § Keeping voice and text as one
// conversation): the session opens with the chat's most recent messages as
// prior turns, takes anything that lands in the chat mid-call through
// `pushContext`, and writes every exchange back through `deps.timeline` — the
// user's words once the model starts answering, its reply streamed as the
// output transcription arrives. A hand-off's answer is already in the chat as
// the agent's own message; what the model says of it is written too, as its own.

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent, AudioSessionMode, VoiceHandoff } from '@patch/wire/audio';
import type { SessionInit, SessionDeps, VoiceTurnSource, SessionState } from './session.js';
import type { VoiceSessionLike, VoiceReplyWriter, VoiceTimeline } from './voice-session-like.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { addTokens, ZERO_TOKENS, type EngineCosting, type EngineTokens } from './voiceCost.js';
import { chatBriefing, withBriefing } from './chatBriefing.js';

/** The documented Gemini Live native-audio model as of 2026-09-16. */
export const DEFAULT_GEMINI_LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

/**
 * The `layer: heavy` model — the Live API's high-reasoning variant, documented
 * 2026-09-24 (ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking:
 * Live API supported, function calling async-only — which is exactly how
 * `dispatch_to_patch` is declared, NON_BLOCKING). `light` (and `direct`, which
 * has no hosted meaning) stays on {@link DEFAULT_GEMINI_LIVE_MODEL}.
 */
export const DEFAULT_GEMINI_LIVE_HEAVY_MODEL = 'models/gemini-3.8-live-extended-thinking';

/** The model a Gemini layer runs. */
export function geminiLiveModelFor(
  layer: import('@patch/wire/audio').VoiceLayer,
  overrides: { light?: string | undefined; heavy?: string | undefined } = {},
): string {
  if (layer === 'heavy') return overrides.heavy ?? DEFAULT_GEMINI_LIVE_HEAVY_MODEL;
  return overrides.light ?? DEFAULT_GEMINI_LIVE_MODEL;
}

/** The one tool Gemini Live is given (spec/07 § Light layer / heavy layer split). */
export const DISPATCH_TOOL_NAME = 'dispatch_to_patch';

function bidiGenerateContentUrl(apiKey: string): string {
  return (
    'wss://generativelanguage.googleapis.com/ws/' +
    `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`
  );
}

/** One turn of prior chat history fed to Gemini Live as context at session start. */
export interface GeminiContextTurn {
  role: 'user' | 'model';
  text: string;
}

export interface GeminiLiveDeps {
  logger: Logger;
  sendAudio: (ev: AudioEvent) => void;
  sendBinary: (pcm: Int16Array) => void;
  submitUserTurn: SessionDeps['submitUserTurn'];
  /** Where this session's spoken exchanges are written into the chat. */
  timeline: VoiceTimeline;
  /** GEMINI_API_KEY. Required — the caller must have already refused to construct this class without one (NO FALLBACK). */
  apiKey: string;
  /** Defaults to {@link DEFAULT_GEMINI_LIVE_MODEL}. */
  model?: string;
  /** Who does the work (spec/07 § The fast voice and the chat's agent). Defaults to `auto`. */
  handoff?: VoiceHandoff;
  /**
   * One-time context snapshot (spec/07 § Keeping voice and text as one
   * conversation): the target chat's recent history, fetched once at session
   * start and fed to Gemini Live as prior `clientContent` turns before the mic
   * opens. Omitted (or an empty result) opens the session with no prior
   * context — not an error, just an unseeded conversation.
   */
  getChatContext?: (chatId: string) => Promise<GeminiContextTurn[]> | GeminiContextTurn[];
  /**
   * The Gemini side is gone for good (never opened, or closed under us). The
   * audio server ends the surface session, so the surface stops streaming into
   * a dead engine and shows the failure instead of "Listening".
   */
  onFatal?: (message: string) => void;
  /** Test seam: substitute the WebSocket constructor (mirrors persistent-ws.ts). */
  wsCtor?: new (url: string) => WsSocket;
  /** Test seam: override the connect URL entirely (skips the real Google endpoint). */
  wsUrl?: string;
}

/** The Gemini Live wire shapes this module actually sends/reads. Not exhaustive — Gemini's schema has far more fields than we use. */
interface GeminiSetupMessage {
  setup: {
    model: string;
    generationConfig: { responseModalities: ['AUDIO'] };
    systemInstruction: { parts: [{ text: string }] };
    tools?: [{ functionDeclarations: [GeminiFunctionDeclaration] }];
    inputAudioTranscription: Record<string, never>;
    outputAudioTranscription: Record<string, never>;
  };
}
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  behavior: 'NON_BLOCKING';
}
interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    turnComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  usageMetadata?: GeminiUsageMetadata;
  toolCall?: {
    functionCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
  };
  toolCallCancellation?: { ids?: string[] };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  responseTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/** One Gemini usage report, by kind. */
export function geminiUsageTokens(u: GeminiUsageMetadata): EngineTokens {
  const by = (details: GeminiUsageMetadata['promptTokensDetails'], modality: string): number =>
    (details ?? [])
      .filter((d) => d.modality === modality)
      .reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  return {
    textIn: by(u.promptTokensDetails, 'TEXT'),
    audioIn: by(u.promptTokensDetails, 'AUDIO'),
    cachedIn: u.cachedContentTokenCount ?? 0,
    textOut: by(u.responseTokensDetails, 'TEXT'),
    audioOut: by(u.responseTokensDetails, 'AUDIO'),
  };
}

const VOICE_PREAMBLE =
  'You are the voice of this conversation: the user is talking, out loud, to the same chat they ' +
  'have been typing in. Everything said in it so far is above as prior turns, and anything that ' +
  'lands in it while you talk is added as it arrives. Speak the way a person would on a phone ' +
  'call: concise, warm, direct. Use the conversation — never answer as though you know nothing ' +
  'about what has been discussed.\n\n';

const WAIT_RULE =
  `Say at most one brief acknowledgement out loud ("one sec") before or as you call ` +
  `${DISPATCH_TOOL_NAME}, then stay completely silent until the result returns: never repeat ` +
  'filler such as "still working on it" or "waiting", and do not speak again until you have the ' +
  'result. Then speak the result naturally.\n\n';

/** The async variant: the call is answered at once and the result arrives later as a message. */
const ASYNC_WAIT_RULE =
  `${DISPATCH_TOOL_NAME} answers at once with "started": the agent is working in the background. ` +
  'Say once, in a few words, that you have passed it on, then carry on the conversation normally — ' +
  'answer anything else the user says. Never say "still working on it", "waiting" or anything ' +
  'like it unless the user asks how it is going. When the agent finishes, its result arrives as a ' +
  'message from the agent: tell the user it then, naturally, in your own words. Several ' +
  'requests can be running at once.\n\n';

const NEVER_GUESS =
  'Never guess. Anything about their files, folders, tasks, calendar, devices or any other ' +
  "real data must come from the agent's result — never make up file names, contents or " +
  'facts, and never answer such a question from imagination while the agent is still working.';

/**
 * The fast voice's instructions for a hand-off mode (spec/07 § The fast voice
 * and the chat's agent). `auto` answers what it can and hands off the rest;
 * `always` only speaks, with every request going to the agent; `never` has no
 * agent and answers everything itself.
 */
export function hostedVoiceInstruction(handoff: VoiceHandoff, asyncResult = false): string {
  if (handoff === 'never') {
    return (
      VOICE_PREAMBLE +
      'You have no agent and no tools: answer everything yourself, from the conversation and ' +
      'your own knowledge. If the user asks for something that needs their files, data or an ' +
      'action, say plainly that you cannot do that from here — never pretend, and never make up ' +
      'file names, contents or facts.'
    );
  }
  const agent =
    "The chat has an agent working on it, with its tools, files and the user's own data. ";
  if (handoff === 'always') {
    return (
      VOICE_PREAMBLE +
      agent +
      `You do not answer anything yourself. Whatever the user asks or says, call ${DISPATCH_TOOL_NAME} ` +
      'with a clear description of what they said and what they want, then speak only what the ' +
      'agent returns. ' +
      (asyncResult ? ASYNC_WAIT_RULE : WAIT_RULE) +
      NEVER_GUESS
    );
  }
  return (
    VOICE_PREAMBLE +
    agent +
    'Answer yourself from the conversation and your own knowledge when you can. When the user ' +
    'needs something only the agent has — their data, files, a tool, an action, or real work — ' +
    `call ${DISPATCH_TOOL_NAME} with a clear description of what is needed. ` +
    (asyncResult ? ASYNC_WAIT_RULE : WAIT_RULE) +
    NEVER_GUESS
  );
}

export const HOSTED_VOICE_INSTRUCTION = hostedVoiceInstruction('auto');

/** The dispatch tool's description for a hand-off mode (`never` has no tool). */
export const DISPATCH_TOOL_DESCRIPTION =
  "Call this for ANYTHING needing the user's actual data, tasks, calendar, smart " +
  'home, or any action — you have no access to any of that yourself. Say at most one ' +
  'brief acknowledgement, then stay silent until the result returns; never ' +
  'answer from a guess.';

/** The same, for a session where the call is answered at once and the result comes later. */
export const ASYNC_DISPATCH_TOOL_DESCRIPTION =
  "Call this for ANYTHING needing the user's actual data, tasks, calendar, smart " +
  'home, or any action — you have no access to any of that yourself. It answers "started" ' +
  'at once and the result arrives later as a message; meanwhile keep talking normally. ' +
  'Never answer from a guess.';

function buildSetupMessage(
  model: string,
  handoff: VoiceHandoff,
  briefing: string,
): GeminiSetupMessage {
  return {
    setup: {
      model,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: {
        parts: [{ text: withBriefing(hostedVoiceInstruction(handoff, true), briefing) }],
      },
      // `never` has no agent, so no tool to call.
      ...(handoff === 'never'
        ? {}
        : {
            tools: [
              {
                functionDeclarations: [
                  {
                    name: DISPATCH_TOOL_NAME,
                    description: ASYNC_DISPATCH_TOOL_DESCRIPTION,
                    parameters: {
                      type: 'OBJECT',
                      properties: {
                        request: {
                          type: 'STRING',
                          description: 'What Patch should do or look up, in plain language.',
                        },
                      },
                      required: ['request'],
                    },
                    behavior: 'NON_BLOCKING',
                  },
                ],
              },
            ],
          }),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

/**
 * A hosted Gemini Live session standing in for `VoiceSession` on the native
 * tier. See the module doc above for what is and isn't implemented.
 */
export class GeminiLiveSession implements VoiceSessionLike {
  private readonly init: SessionInit;
  private readonly deps: GeminiLiveDeps;
  private state: SessionState = 'connecting';
  private currentChatId: string;
  private mode: AudioSessionMode;
  private ws?: WsSocket;
  private setupDone = false;
  /** Base64 PCM16 chunks captured before the WS handshake finished. */
  private micQueue: string[] = [];
  private closed = false;
  private fatal = false;
  private setupCompleteWaiters: Array<() => void> = [];
  // --- what actually happened on this session, for the closing summary (mirrors VoiceSession.stats()) ---
  private micFrames = 0;
  private micSamples = 0;
  private turns = 0;
  private turnHadInput = false;
  private turnHadAudioOut = false;
  private inputTranscriptBuf = '';
  // --- the chat timeline (spec/07 § Keeping voice and text as one conversation) ---
  /** The current utterance has been written into the chat. */
  private userWritten = false;
  /** The reply being spoken now, streaming into the chat. */
  private reply?: VoiceReplyWriter;
  /** Hand-offs to the chat's agent not yet answered. */
  private handoffsInFlight = 0;
  /** Agent results waiting for a gap in the conversation, in the order they finished. */
  private resultQueue: Array<{ callId: string; request: string; reply: string; readyAt: number }> =
    [];
  /** The turn that carried a dispatch call is still open: its speech is the acknowledgement. */
  private dispatchTurnOpen = false;
  /** Turns of unprompted speech still allowed: one acknowledgement per dispatch. */
  private unpromptedBudget = 0;
  private turnUnpromptedOutput = false;
  /** What the filler guard threw away this turn, for the log. */
  private droppedText = '';
  private droppedChunks = 0;
  // --- the log (what the model and the host did, in order, on this call) ---
  private readonly startedAt = Date.now();
  private turnStartedAt = 0;
  private turnModelText = '';
  private turnAudioChunks = 0;
  private turnSeq = 0;
  private lastWaitLogged = '';
  /** The model is speaking an agent's answer (a result sent as a message), not answering the user. */
  private relaying = false;
  private relayHadOutput = false;
  // --- usage (spec/07 § Call cost) ---
  private turnUsage?: EngineTokens;
  private tokens: EngineTokens = ZERO_TOKENS;

  constructor(init: SessionInit, deps: GeminiLiveDeps) {
    this.init = init;
    this.deps = deps;
    this.currentChatId = init.chatId;
    this.mode = init.mode ?? 'call';
  }

  getMode(): AudioSessionMode {
    return this.mode;
  }

  /**
   * spec/07 § Session modes — flip the open session's mode. NOTE: unlike
   * `VoiceSession`, the native tier does not yet enforce hands-free's
   * address-word gating (see module doc — Gemini decides turn boundaries and
   * starts generating before we could know an utterance was unaddressed).
   * Stored faithfully so the wire contract holds; the gating itself is a TODO.
   */
  setMode(next: AudioSessionMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, mode: next },
      'gemini-live: mode changed (address-word gating not yet applied on native tier)',
    );
  }

  getState(): SessionState {
    return this.state;
  }

  getCurrentChatId(): string {
    return this.currentChatId;
  }

  setFocus(chatId: string): void {
    this.currentChatId = chatId;
    this.deps.logger.debug({ sessionId: this.init.sessionId, chatId }, 'gemini-live: focus follow');
  }

  private readonly micLevel = new MicLevelWatch();

  stats(): {
    micFrames: number;
    micSeconds: number;
    vadEvents: number;
    turns: number;
    micPeakDbfs: number;
  } {
    return {
      micFrames: this.micFrames,
      micSeconds: Number((this.micSamples / 16000).toFixed(1)),
      // Gemini's VAD runs server-side and is invisible to the host — there
      // is no local event to count (unlike VoiceSession's Silero VAD).
      vadEvents: 0,
      turns: this.turns,
      micPeakDbfs: this.micLevel.peakDbfs(),
    };
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.init.sessionId, state: next });
  }

  /** First wire event after WS upgrade. Kicks off the async connect. */
  onSessionStart(): void {
    if (this.state !== 'connecting') {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, state: this.state },
        'gemini-live: duplicate session_start',
      );
      return;
    }
    void this.connect().catch((err: Error) => {
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: err.message },
        'gemini-live: failed to open native session',
      );
      this.die(`native voice session failed to open: ${err.message}`);
    });
  }

  /** Report a failure the session cannot recover from and end the surface session. */
  private die(message: string): void {
    if (this.fatal || this.closed) return;
    this.fatal = true;
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'gemini_unavailable',
      message,
      sessionId: this.init.sessionId,
    });
    this.deps.onFatal?.(message);
  }

  private async connect(): Promise<void> {
    const url = this.deps.wsUrl ?? bidiGenerateContentUrl(this.deps.apiKey);
    const Ctor = this.deps.wsCtor ?? (WsImpl as unknown as new (url: string) => WsSocket);
    const ws = new Ctor(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => resolve();
      const onError = (err: Error): void => reject(err);
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
    ws.on('message', (data: Buffer | string, _isBinary: boolean) => this.onWsMessage(data));
    ws.on('close', (code: number, reason: Buffer | string) => this.onWsClose(code, reason));
    ws.on('error', (err: Error) => {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: err.message },
        'gemini-live: ws error',
      );
    });
    // spec/07 § Keeping voice and text as one conversation — what the chat is, how it began and
    // what has just been said, as a briefing in the instructions, in scope for the very first
    // utterance. A chat whose history cannot be read fails the session loudly.
    const context = (await this.deps.getChatContext?.(this.currentChatId)) ?? [];
    const briefing = chatBriefing(context);
    // The full text, so what the voice was told about the chat can be read back from the log.
    this.log('chat briefing', {
      messages: context.length,
      chars: briefing.length,
      briefing,
    });
    ws.send(
      JSON.stringify(
        buildSetupMessage(this.getEngineModel(), this.deps.handoff ?? 'auto', briefing),
      ),
    );
    await new Promise<void>((resolve) => this.setupCompleteWaiters.push(resolve));
    // Gemini closed the socket instead of completing setup (a rejected model
    // or key): onWsClose has already reported it.
    if (this.fatal) return;
    if (this.closed) return;
    this.setupDone = true;
    this.setState('listening');
    const queued = this.micQueue;
    this.micQueue = [];
    for (const b64 of queued) this.sendAudioChunk(b64);
  }

  private sendAudioChunk(b64: string): void {
    if (!this.ws) return;
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } },
        }),
      );
    } catch (err) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'gemini-live: mic send failed',
      );
    }
  }

  /** Feed one mic PCM frame (16 kHz mono). Forwarded straight to Gemini Live — no local VAD/STT. */
  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed) return;
    this.micFrames += 1;
    this.micSamples += pcm.length;
    // spec/07 — a mic sending only digital silence is a failure to report.
    if (this.micLevel.feed(pcm)) {
      this.deps.logger.error(
        { sessionId: this.init.sessionId },
        'voice: the microphone is sending only digital silence',
      );
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'mic_silent',
        message: micSilentMessage(this.init.surfaceKind),
        sessionId: this.init.sessionId,
      });
    }
    // Base64-encode SYNCHRONOUSLY, before any await — `pcm` is a caller-owned
    // view (server.ts: sometimes a zero-copy slice of a pooled WS receive
    // buffer) that must not be retained past this call (same contract
    // VoiceSession.onMicFrame documents).
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    if (!this.setupDone || !this.ws) {
      this.micQueue.push(b64);
      return;
    }
    this.sendAudioChunk(b64);
  }

  /** One line of the call's log: what happened, how long into the call, and the state around it. */
  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.deps.logger.info(
      {
        sessionId: this.init.sessionId,
        t: Date.now() - this.startedAt,
        state: this.state,
        inFlight: this.handoffsInFlight,
        queued: this.resultQueue.length,
        ...fields,
      },
      `gemini-live: ${event}`,
    );
  }

  private onWsMessage(data: Buffer | string): void {
    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(
        typeof data === 'string' ? data : data.toString('utf8'),
      ) as GeminiServerMessage;
    } catch (err) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'gemini-live: bad json from server',
      );
      return;
    }
    if (msg.setupComplete) {
      this.log('setup complete');
      const waiters = this.setupCompleteWaiters;
      this.setupCompleteWaiters = [];
      for (const w of waiters) w();
      return;
    }
    // Anything the host has no handling for is still worth seeing (goAway, session resumption…).
    const unhandled = Object.keys(msg).filter(
      (k) => !['serverContent', 'usageMetadata', 'toolCall', 'toolCallCancellation'].includes(k),
    );
    if (unhandled.length > 0) this.log('server message', { keys: unhandled });
    if (msg.usageMetadata) this.turnUsage = geminiUsageTokens(msg.usageMetadata);
    if (msg.toolCall?.functionCalls) {
      this.log('tool call', {
        calls: msg.toolCall.functionCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      for (const call of msg.toolCall.functionCalls) {
        if (call.name === DISPATCH_TOOL_NAME) void this.handleDispatch(call.id, call.args);
      }
    }
    if (msg.toolCallCancellation) {
      // Gemini says these calls should not have run. The hand-off is answered at once,
      // so nothing waits on Gemini here: the agent's result is still delivered as a message.
      this.deps.logger.warn(
        {
          sessionId: this.init.sessionId,
          t: Date.now() - this.startedAt,
          ids: msg.toolCallCancellation.ids,
          inFlight: this.handoffsInFlight,
        },
        'gemini-live: tool call cancelled by the server',
      );
    }
    if (msg.serverContent) this.onServerContent(msg.serverContent);
  }

  private onServerContent(sc: NonNullable<GeminiServerMessage['serverContent']>): void {
    const signals = Object.keys(sc).filter(
      (k) => !['modelTurn', 'inputTranscription', 'outputTranscription'].includes(k),
    );
    if (signals.length > 0) {
      this.log('server content', { signals, relaying: this.relaying });
    }
    if (sc.inputTranscription?.text) {
      if (!this.turnHadInput) this.log('user speaking');
      this.inputTranscriptBuf += sc.inputTranscription.text;
      this.turnHadInput = true;
      // The words so far, live — the call bar shows them while the user talks.
      if (this.state === 'listening') this.setState('transcribing');
      this.deps.sendAudio({
        type: 'audio.transcript_partial',
        sessionId: this.init.sessionId,
        text: this.inputTranscriptBuf.trim(),
      });
    }
    if (sc.interrupted) {
      // Barge-in: the user spoke over Gemini's own reply (spec/07 § Barge-in —
      // Gemini's server-side VAD does this for us; there is no local VAD to
      // drive on the native tier).
      this.deps.sendAudio({
        type: 'audio.barge_in',
        sessionId: this.init.sessionId,
        at: Date.now(),
      });
      this.deps.sendAudio({
        type: 'audio.tts_end',
        sessionId: this.init.sessionId,
        bargedIn: true,
      });
      this.turnHadAudioOut = false;
      this.finishReply();
      this.setState('listening');
    }
    const parts = sc.modelTurn?.parts ?? [];
    const hasAudio = parts.some((p) => p.inlineData?.data);
    const outText = sc.outputTranscription?.text;
    if ((hasAudio || outText) && this.turnStartedAt === 0) {
      this.turnStartedAt = Date.now();
      this.log('model speaking', {
        prompted: this.turnHadInput,
        relaying: this.relaying,
        dispatchTurn: this.dispatchTurnOpen,
      });
    }
    if (outText) this.turnModelText += outText;
    if (
      (hasAudio || outText) &&
      this.handoffsInFlight > 0 &&
      !this.turnHadInput &&
      !this.relaying
    ) {
      // The model is talking on its own while the agent works. One acknowledgement per
      // hand-off is wanted; more is the "still working on it" loop, which no prompt has
      // stopped. Replies to what the user says are never touched.
      if (this.dispatchTurnOpen || this.unpromptedBudget > 0) {
        this.turnUnpromptedOutput = true;
      } else {
        this.droppedChunks += 1;
        if (outText) this.droppedText += outText;
        if (sc.turnComplete) this.endTurn();
        return;
      }
    }
    // The model has started answering, so the utterance is finished: it goes
    // into the chat ahead of the reply.
    if (hasAudio || outText) this.commitUserWords();
    if (this.relaying && (hasAudio || outText)) this.relayHadOutput = true;
    // Everything the voice says is written into the chat, including its words about an
    // agent's answer: the answer is already there as the agent's own message, and what the
    // voice made of it is a separate thing the user heard and should be able to read.
    if (outText) {
      this.reply ??= this.deps.timeline.beginReply(this.currentChatId);
      this.reply.append(outText);
    }
    for (const part of parts) {
      const inline = part.inlineData;
      if (!inline?.data) continue;
      // Native tier only ever backs web/desktop/mobile (audio/server.ts scopes
      // it away from `surfaceKind: 'device'`), which decode native 24 kHz PCM
      // directly — same rate Kokoro emits, so no resample is needed here
      // (unlike VoiceSession's device branch).
      const buf = Buffer.from(inline.data, 'base64');
      const pcm = new Int16Array(buf.byteLength >>> 1);
      const bytes = new Uint8Array(pcm.buffer);
      bytes.set(buf);
      if (this.state !== 'speaking') this.setState('speaking');
      this.turnHadAudioOut = true;
      this.turnAudioChunks += 1;
      this.deps.sendAudio({
        type: 'audio.tts_chunk',
        sessionId: this.init.sessionId,
        samples: pcm.length,
      });
      this.deps.sendBinary(pcm);
    }
    if (sc.turnComplete) this.endTurn();
  }

  /** The model finished a turn: close it out for the chat, the surface and the usage count. */
  private endTurn(): void {
    this.turnSeq += 1;
    this.log('turn', {
      seq: this.turnSeq,
      user: this.inputTranscriptBuf.trim(),
      model: this.turnModelText.trim(),
      audioChunks: this.turnAudioChunks,
      speakingMs: this.turnStartedAt === 0 ? 0 : Date.now() - this.turnStartedAt,
      prompted: this.turnHadInput,
      relaying: this.relaying,
      dispatchTurn: this.dispatchTurnOpen,
      unprompted: this.turnUnpromptedOutput,
      droppedChunks: this.droppedChunks,
      droppedText: this.droppedText.trim(),
    });
    if (this.droppedChunks > 0) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, text: this.droppedText.trim() },
        'gemini-live: dropped the model talking on its own while a hand-off ran',
      );
    }
    // The acknowledgement budget: the turn that carried the dispatch is free; the next
    // unprompted turn that spoke uses up the one allowed for each hand-off.
    if (this.dispatchTurnOpen) this.dispatchTurnOpen = false;
    else if (this.turnUnpromptedOutput && this.unpromptedBudget > 0) this.unpromptedBudget -= 1;
    this.commitUserWords();
    if (this.turnHadInput) this.turns += 1;
    this.finishReply();
    if (this.turnUsage) {
      this.tokens = addTokens(this.tokens, this.turnUsage);
      this.turnUsage = undefined;
    }
    if (this.relaying) {
      // This turn was the model speaking an agent result. If it said nothing, the
      // result was lost between the host and the speaker — say so, loudly.
      if (!this.relayHadOutput) {
        const message = 'the model did not speak the hand-off result';
        this.deps.logger.error({ sessionId: this.init.sessionId }, `gemini-live: ${message}`);
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'gemini_unavailable',
          message,
          sessionId: this.init.sessionId,
        });
      }
      this.relaying = false;
    }
    // NO SILENT FAILURES (CLAUDE.md): a turn that had audible user input but
    // produced no TTS audio has lost its reply somewhere — say so, mirroring
    // VoiceSession.endStream's identical guard. A turn that handed off to the
    // agent is waiting on it, not lost.
    if (this.turnHadInput && !this.turnHadAudioOut && this.handoffsInFlight === 0) {
      const message = 'native voice turn produced no TTS audio for the surface';
      this.deps.logger.error({ sessionId: this.init.sessionId }, message);
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'gemini_unavailable',
        message,
        sessionId: this.init.sessionId,
      });
    }
    this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
    this.inputTranscriptBuf = '';
    this.turnHadInput = false;
    this.turnHadAudioOut = false;
    this.userWritten = false;
    this.turnStartedAt = 0;
    this.turnModelText = '';
    this.turnAudioChunks = 0;
    this.turnUnpromptedOutput = false;
    this.droppedText = '';
    this.droppedChunks = 0;
    this.setState(this.handoffsInFlight > 0 ? 'thinking' : 'listening');
    this.flushResults('turn ended');
  }

  /** Write the finished utterance into the chat, once, and tell the surface it is final. */
  private commitUserWords(): void {
    if (!this.turnHadInput || this.userWritten) return;
    this.userWritten = true;
    const text = this.inputTranscriptBuf.trim();
    if (text.length === 0) return;
    this.deps.timeline.userSaid(this.currentChatId, text);
    this.deps.sendAudio({ type: 'audio.transcript_final', sessionId: this.init.sessionId, text });
  }

  private finishReply(): void {
    const reply = this.reply;
    this.reply = undefined;
    reply?.finish();
  }

  getEngineModel(): string {
    return this.deps.model ?? DEFAULT_GEMINI_LIVE_MODEL;
  }

  engineCosting(): EngineCosting {
    const tokens = this.turnUsage ? addTokens(this.tokens, this.turnUsage) : this.tokens;
    return { backend: 'gemini', model: this.getEngineModel(), tokens, stt: null };
  }

  isAwaitingHandoff(): boolean {
    return this.handoffsInFlight > 0 || this.resultQueue.length > 0;
  }

  pushContext(role: 'user' | 'assistant', text: string): void {
    if (this.closed || !this.setupDone || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: role === 'assistant' ? 'model' : 'user', parts: [{ text }] }],
          turnComplete: false,
        },
      }),
    );
  }

  private async handleDispatch(
    callId: string,
    args: Record<string, unknown> | undefined,
  ): Promise<void> {
    const request = typeof args?.['request'] === 'string' ? (args['request'] as string) : '';
    this.log('dispatching to the chat agent', { callId, request });
    // The chat reads in order: what the user said, the bridge, then the hand-off.
    this.commitUserWords();
    this.finishReply();
    this.handoffsInFlight += 1;
    this.dispatchTurnOpen = true;
    this.unpromptedBudget += 1;
    this.setState('thinking');
    // Answer the call at once: it stays open for nothing, so there is nothing for
    // Gemini to cancel and the conversation carries on while the agent works. The
    // result comes later, as a message (flushResults).
    this.sendFrame(
      {
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name: DISPATCH_TOOL_NAME,
              response: {
                result: 'started',
                note:
                  'The agent is working on it in the background. Tell the user once, in a few ' +
                  'words, that you have passed it on, then carry on the conversation. Its result ' +
                  'will arrive as a message; do not wait for it or keep mentioning it.',
                scheduling: 'WHEN_IDLE',
              },
            },
          ],
        },
      },
      'tool response (started)',
      { callId, scheduling: 'WHEN_IDLE' },
    );
    const source: VoiceTurnSource = {
      kind: 'voice-app',
      surfaceKind: this.init.surfaceKind as 'web' | 'desktop' | 'mobile',
      sessionId: this.init.sessionId,
    };
    const askedAt = Date.now();
    let replyText: string;
    try {
      replyText = await this.deps.submitUserTurn({
        chatId: this.currentChatId,
        message: request,
        source,
        handoff: true,
      });
    } catch (err) {
      replyText = `That failed: ${(err as Error).message}`;
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'gemini-live: dispatch failed',
      );
    }
    this.log('chat agent answered', {
      callId,
      ms: Date.now() - askedAt,
      chars: replyText.length,
    });
    // Keep it counted as a hand-off until it is queued, so the chat's own copy of the
    // answer is not also pushed into the voice as context.
    this.resultQueue.push({ callId, request, reply: replyText, readyAt: Date.now() });
    this.handoffsInFlight -= 1;
    if (this.handoffsInFlight === 0) {
      this.unpromptedBudget = 0;
      this.dispatchTurnOpen = false;
    }
    if (this.closed || !this.ws) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, callId },
        'gemini-live: the session ended before the hand-off result could be spoken',
      );
      return;
    }
    this.flushResults('agent answered');
  }

  /** Nobody is talking and no result is being spoken: a result can be said without cutting anyone off. */
  private isIdleForResult(): boolean {
    return (
      !this.closed &&
      this.setupDone &&
      this.ws !== undefined &&
      !this.relaying &&
      !this.turnHadInput &&
      !this.turnHadAudioOut &&
      this.inputTranscriptBuf === ''
    );
  }

  /**
   * Say the oldest finished hand-off result, if there is a gap for it. A message to
   * Gemini interrupts whatever it is saying, so a result waits for the user and the
   * model to stop; it is tried again at the end of every turn.
   */
  private flushResults(reason: string): void {
    const next = this.resultQueue[0];
    if (!next) return;
    if (!this.isIdleForResult()) {
      const why = this.relaying
        ? 'a result is being spoken'
        : this.turnHadInput
          ? 'the user is talking'
          : 'the model is talking';
      if (this.lastWaitLogged !== why + next.callId) {
        this.lastWaitLogged = why + next.callId;
        this.log('hand-off result waiting for a gap', { callId: next.callId, why, reason });
      }
      return;
    }
    this.resultQueue.shift();
    this.lastWaitLogged = '';
    this.relaying = true;
    this.relayHadOutput = false;
    this.sendFrame(
      {
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    `The agent has finished what you handed off ("${next.request}"). ` +
                    `Its result, to tell the user now, in your own words: ${next.reply}`,
                },
              ],
            },
          ],
          turnComplete: true,
        },
      },
      'hand-off result delivered as a message',
      { callId: next.callId, waitedMs: Date.now() - next.readyAt, reason },
    );
  }

  /** Send one JSON frame to Gemini, logging what it was. */
  private sendFrame(frame: unknown, what: string, fields: Record<string, unknown> = {}): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(frame));
      this.log(`sent: ${what}`, fields);
    } catch (err) {
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message, what },
        'gemini-live: failed to send a frame to Gemini',
      );
    }
  }

  private onWsClose(code?: number, reason?: Buffer | string): void {
    if (this.closed) return;
    const why = typeof reason === 'string' ? reason : reason?.toString('utf8');
    this.deps.logger.warn({ sessionId: this.init.sessionId, code, why }, 'gemini-live: ws closed');
    // NO SILENT FAILURES: Gemini hanging up on an open call used to be only a
    // log line, leaving the surface on "Listening" over a dead engine.
    this.die(`Gemini Live closed the session (code ${code ?? 'unknown'}${why ? `: ${why}` : ''})`);
    const waiters = this.setupCompleteWaiters;
    this.setupCompleteWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Not implemented — native tier only ever backs `role: 'voice-call'`
   * sessions (see module doc). Present to satisfy `VoiceSessionLike`.
   */
  async finalizeNote(): Promise<boolean> {
    this.deps.logger.warn(
      { sessionId: this.init.sessionId },
      'gemini-live: finalizeNote called on a native session — voice notes are fallback-tier only, this is a no-op',
    );
    return false;
  }

  /**
   * DEV/TEST seam, and a genuine capability of the wire protocol: Gemini Live
   * accepts a text turn via `clientContent` exactly like a spoken one, so this
   * drives a REAL turn through the model (including a possible dispatch) —
   * not a synthetic echo.
   */
  async injectTranscript(text: string): Promise<void> {
    if (this.closed || !this.setupDone || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      }),
    );
  }

  /**
   * Approximation (see module doc): Gemini Live has no raw "say exactly this"
   * primitive short of its separate TTS-only models, which is out of scope
   * here. Instructing the live conversational model to speak the text
   * verbatim gets audibly close for the one thing this is used for — a short
   * agent-initiated interrupt spoken into an ALREADY-open call (spec/07
   * § Which surface it reaches) — without guaranteeing byte-identical prosody
   * the way Kokoro's direct synthesis does.
   */
  async speak(text: string): Promise<void> {
    if (this.closed || !this.setupDone || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                { text: `Say exactly the following out loud, verbatim, and nothing else: ${text}` },
              ],
            },
          ],
          turnComplete: true,
        },
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.resultQueue.length > 0 || this.handoffsInFlight > 0) {
      this.deps.logger.warn(
        {
          sessionId: this.init.sessionId,
          queued: this.resultQueue.map((r) => r.request),
          inFlight: this.handoffsInFlight,
        },
        'gemini-live: closing with hand-off results not yet spoken',
      );
    }
    this.log('closing');
    this.finishReply();
    this.closed = true;
    const waiters = this.setupCompleteWaiters;
    this.setupCompleteWaiters = [];
    for (const w of waiters) w();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
