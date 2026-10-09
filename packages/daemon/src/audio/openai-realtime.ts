// Hosted voice tier: OpenAI Realtime (spec/07 § Voice — a config matrix,
// `backend: openai`). The OpenAI counterpart of gemini-live.ts, and built the
// same way: the HOST relays the surface's mic PCM to one hosted
// speech-to-speech session over a server-side WebSocket and streams the
// returned audio back down the surface's existing audio WSS. No surface talks
// to OpenAI itself and no surface holds a key or an ephemeral token — a phone
// on `openai` sends exactly the frames it sends on `local`, which is why this
// backend needs no WebRTC or other native module on Android.
//
// The model IS the light layer and dispatches to the heavy agent through the
// one `dispatch_to_patch` function tool (the same `submitUserTurn` callback
// `VoiceSession` and `GeminiLiveSession` use, so a dispatched turn lands in the
// real chat). `layer` picks the model: `light` → the mini realtime model,
// `heavy` → the flagship (`DEFAULT_OPENAI_REALTIME_MODELS`, overridable per
// host). `direct` has no meaning on a hosted backend — the hosted model always
// fronts Manager — and runs as `light` (the same rule the Gemini tier has
// always applied; Settings says so).
//
// Protocol: the GA Realtime API over WebSocket
// (developers.openai.com/api/docs/guides/realtime-websocket, checked
// 2026-09-24): `wss://api.openai.com/v1/realtime?model=<m>` with
// `Authorization: Bearer`, configured by `session.update`
// (`session.type: 'realtime'`, `audio.input/output.format` PCM16 @ 24 kHz),
// mic in as `input_audio_buffer.append`, audio out as
// `response.output_audio.delta`, the user's words as
// `conversation.item.input_audio_transcription.delta/.completed`, tool calls as
// `response.function_call_arguments.done`, answered with a
// `function_call_output` item + `response.create`.
//
// The API only takes 24 kHz PCM, and surfaces send 16 kHz, so every mic frame
// is upsampled 2:3 here before it is appended. Output is already 24 kHz — the
// rate the surfaces' TTS sinks play — so it is forwarded untouched.
//
// Hands-free (spec/07 § Session modes) IS enforced on this tier, unlike Gemini:
// in `hands-free` the server VAD is told not to answer by itself
// (`create_response: false`) or to cut its own reply off when somebody else in
// the room talks (`interrupt_response: false`). Each finished transcript is
// then run through the same `isAddressed` rule the local tier uses: addressed
// → `response.create`; not addressed → reported as heard-but-not-sent
// (`addressed: false`) and the item deleted from the conversation so it never
// becomes context either.
//
// NO SILENT FALLBACK. A connect failure, an `error` event, a failed response,
// a failed transcription, or the provider closing the socket is reported to
// the surface as `audio.error {code: 'openai_unavailable'}`; a closed or
// never-opened provider socket is fatal and ends the surface session
// (`onFatal`) rather than leaving a call bar that says "Listening" over a dead
// engine.

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent, AudioSessionMode, VoiceHandoff, VoiceLayer } from '@patch/wire/audio';
import { modeRequiresAddress } from '@patch/wire/audio';
import type { VoiceReplyWriter, VoiceTimeline } from './voice-session-like.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { addTokens, ZERO_TOKENS, type EngineCosting, type EngineTokens } from './voiceCost.js';
import {
  DEFAULT_ADDRESS_WORD,
  isAddressed,
  type SessionInit,
  type SessionDeps,
  type SessionState,
  type VoiceTurnSource,
} from './session.js';
import type { VoiceSessionLike } from './voice-session-like.js';
import { chatBriefing, withBriefing } from './chatBriefing.js';
import {
  DISPATCH_TOOL_DESCRIPTION,
  DISPATCH_TOOL_NAME,
  hostedVoiceInstruction,
  type GeminiContextTurn,
} from './gemini-live.js';

/** Realtime models per layer, as documented 2026-09-24 (developers.openai.com/api/docs/models). */
export const DEFAULT_OPENAI_REALTIME_MODELS = {
  light: 'gpt-realtime-2.1-mini',
  heavy: 'gpt-realtime-2.1',
} as const;

/** Input transcription model the Realtime session uses to show the user's words. */
export const DEFAULT_OPENAI_REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_OPENAI_REALTIME_VOICE = 'marin';

/** The model a hosted layer runs. `direct` has no hosted meaning and runs as `light`. */
export function openaiRealtimeModelFor(
  layer: VoiceLayer,
  overrides: { light?: string | undefined; heavy?: string | undefined } = {},
): string {
  if (layer === 'heavy') return overrides.heavy ?? DEFAULT_OPENAI_REALTIME_MODELS.heavy;
  return overrides.light ?? DEFAULT_OPENAI_REALTIME_MODELS.light;
}

function realtimeUrl(model: string): string {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

export type OpenAIWsCtor = new (url: string, opts: { headers: Record<string, string> }) => WsSocket;

export interface OpenAIRealtimeDeps {
  logger: Logger;
  sendAudio: (ev: AudioEvent) => void;
  sendBinary: (pcm: Int16Array) => void;
  submitUserTurn: SessionDeps['submitUserTurn'];
  /** Where this session's spoken exchanges are written into the chat. */
  timeline: VoiceTimeline;
  /** OPENAI_REALTIME_API_KEY. The caller refuses to construct this class without one. */
  apiKey: string;
  /** Realtime model — resolved from the layer by the caller (`openaiRealtimeModelFor`). */
  model: string;
  /** Who does the work (spec/07 § The fast voice and the chat's agent). Defaults to `auto`. */
  handoff?: VoiceHandoff;
  transcribeModel?: string;
  voice?: string;
  getChatContext?: (chatId: string) => Promise<GeminiContextTurn[]> | GeminiContextTurn[];
  /**
   * The provider side is gone for good (never opened, or closed under us). The
   * audio server ends the surface session so the surface stops streaming into
   * a dead engine and shows the failure.
   */
  onFatal?: (message: string) => void;
  /** Test seam: substitute the WebSocket constructor. */
  wsCtor?: OpenAIWsCtor;
  /** Test seam: override the connect URL. */
  wsUrl?: string;
}

interface RealtimeUsage {
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/**
 * One response's usage, by kind. Cached input is reported inside the text and
 * audio input counts; it is taken out of them so it is priced once, at the
 * cached rate.
 */
export function realtimeUsageTokens(u: RealtimeUsage): EngineTokens {
  const i = u.input_token_details ?? {};
  const cached = i.cached_tokens ?? 0;
  const cachedText = i.cached_tokens_details?.text_tokens ?? 0;
  const cachedAudio = i.cached_tokens_details?.audio_tokens ?? cached - cachedText;
  return {
    textIn: (i.text_tokens ?? 0) - cachedText,
    audioIn: (i.audio_tokens ?? 0) - cachedAudio,
    cachedIn: cached,
    textOut: u.output_token_details?.text_tokens ?? 0,
    audioOut: u.output_token_details?.audio_tokens ?? 0,
  };
}

interface RealtimeServerEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string; code?: string; type?: string };
  response?: {
    status?: string;
    status_details?: { error?: { message?: string; code?: string }; reason?: string } | null;
    output?: Array<{ type?: string }>;
    usage?: RealtimeUsage;
  };
}

/**
 * Upsample 16 kHz PCM16 to 24 kHz (ratio 3:2) by linear interpolation. Output
 * sample j sits at input position 2j/3; the last fractional position of a
 * frame holds its final sample (the next frame isn't here yet).
 */
export function upsample16kTo24k(pcm: Int16Array): Int16Array {
  const outLen = Math.floor((pcm.length * 3) / 2);
  const out = new Int16Array(outLen);
  const last = pcm.length - 1;
  for (let j = 0; j < outLen; j++) {
    const pos = (j * 2) / 3;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = pcm[i]!;
    const b = pcm[Math.min(i + 1, last)]!;
    out[j] = Math.round(a + (b - a) * frac);
  }
  return out;
}

export class OpenAIRealtimeSession implements VoiceSessionLike {
  private readonly init: SessionInit;
  private readonly deps: OpenAIRealtimeDeps;
  private state: SessionState = 'connecting';
  private currentChatId: string;
  private mode: AudioSessionMode;
  private ws?: WsSocket;
  private setupDone = false;
  private closed = false;
  private fatal = false;
  private micQueue: string[] = [];
  private setupWaiter?: { resolve: () => void; reject: (err: Error) => void };
  private lastSpokeAt?: number;
  private partialByItem = new Map<string, string>();
  // Per-response bookkeeping, reset on every response.done.
  private responseHadAudio = false;
  private responseHadToolCall = false;
  private dispatchesInFlight = 0;
  // --- the chat timeline (spec/07 § Keeping voice and text as one conversation) ---
  /** The user is mid-utterance or its transcript has not landed yet. */
  private awaitingUserWords = false;
  /** Reply text that arrived before the user's words were written. */
  private heldReply = '';
  private reply?: VoiceReplyWriter;
  /** What the chat is about, from the chat's own history; in the instructions. */
  private briefing = '';
  private tokens: EngineTokens = ZERO_TOKENS;
  // Stats.
  private micFrames = 0;
  private micSamples = 0;
  private turns = 0;

  constructor(init: SessionInit, deps: OpenAIRealtimeDeps) {
    this.init = init;
    this.deps = deps;
    this.currentChatId = init.chatId;
    this.mode = init.mode ?? 'call';
  }

  getMode(): AudioSessionMode {
    return this.mode;
  }

  setMode(next: AudioSessionMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, mode: next },
      'openai-realtime: mode changed',
    );
    if (this.setupDone)
      this.sendJson({
        type: 'session.update',
        session: { type: 'realtime', audio: { input: { turn_detection: this.turnDetection() } } },
      });
  }

  getState(): SessionState {
    return this.state;
  }

  getCurrentChatId(): string {
    return this.currentChatId;
  }

  setFocus(chatId: string): void {
    this.currentChatId = chatId;
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
      // Server-side VAD — nothing local to count.
      vadEvents: 0,
      turns: this.turns,
      micPeakDbfs: this.micLevel.peakDbfs(),
    };
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    if (this.state === 'speaking') this.lastSpokeAt = Date.now();
    this.state = next;
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.init.sessionId, state: next });
  }

  private reportError(message: string): void {
    this.deps.logger.error({ sessionId: this.init.sessionId, message }, 'openai-realtime: error');
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'openai_unavailable',
      message,
      sessionId: this.init.sessionId,
    });
  }

  private die(message: string): void {
    if (this.fatal || this.closed) return;
    this.fatal = true;
    this.reportError(message);
    this.deps.onFatal?.(message);
  }

  private turnDetection(): Record<string, unknown> {
    const answersEverything = !modeRequiresAddress(this.mode);
    return {
      type: 'server_vad',
      create_response: answersEverything,
      interrupt_response: answersEverything,
    };
  }

  private sessionConfig(): Record<string, unknown> {
    const handoff = this.deps.handoff ?? 'auto';
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: withBriefing(hostedVoiceInstruction(handoff), this.briefing),
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: {
              model: this.deps.transcribeModel ?? DEFAULT_OPENAI_REALTIME_TRANSCRIBE_MODEL,
              language: 'en',
            },
            turn_detection: this.turnDetection(),
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: this.deps.voice ?? DEFAULT_OPENAI_REALTIME_VOICE,
          },
        },
        tools:
          handoff === 'never'
            ? []
            : [
                {
                  type: 'function',
                  name: DISPATCH_TOOL_NAME,
                  description: DISPATCH_TOOL_DESCRIPTION,
                  parameters: {
                    type: 'object',
                    properties: {
                      request: {
                        type: 'string',
                        description: 'What Patch should do or look up, in plain language.',
                      },
                    },
                    required: ['request'],
                  },
                },
              ],
        tool_choice: handoff === 'always' ? 'required' : 'auto',
      },
    };
  }

  private sendJson(msg: unknown): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.reportError(`send to OpenAI Realtime failed: ${(err as Error).message}`);
    }
  }

  onSessionStart(): void {
    if (this.state !== 'connecting') return;
    void this.connect().catch((err: Error) => {
      this.die(`OpenAI Realtime session failed to open: ${err.message}`);
    });
  }

  private async connect(): Promise<void> {
    const url = this.deps.wsUrl ?? realtimeUrl(this.deps.model);
    const Ctor = this.deps.wsCtor ?? (WsImpl as unknown as OpenAIWsCtor);
    const ws = new Ctor(url, { headers: { Authorization: `Bearer ${this.deps.apiKey}` } });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    ws.on('message', (data: Buffer | string) => this.onWsMessage(data));
    ws.on('close', (code: number, reason: Buffer | string) => this.onWsClose(code, reason));
    ws.on('error', (err: Error) => {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: err.message },
        'openai-realtime: ws error',
      );
    });
    const configured = new Promise<void>((resolve, reject) => {
      this.setupWaiter = { resolve, reject };
    });
    // spec/07 § Keeping voice and text as one conversation — what the chat is, how it
    // began and what has just been said, as a briefing in the instructions. A chat whose
    // history cannot be read fails the session loudly.
    const context = (await this.deps.getChatContext?.(this.currentChatId)) ?? [];
    this.briefing = chatBriefing(context);
    // The full text, so what the voice was told about the chat can be read back from the log.
    this.deps.logger.info(
      {
        sessionId: this.init.sessionId,
        messages: context.length,
        chars: this.briefing.length,
        briefing: this.briefing,
      },
      'openai-realtime: chat briefing',
    );
    if (this.closed) return;
    this.sendJson(this.sessionConfig());
    await configured;
    if (this.closed) return;
    this.setupDone = true;
    this.setState('listening');
    const queued = this.micQueue;
    this.micQueue = [];
    for (const b64 of queued) this.sendJson({ type: 'input_audio_buffer.append', audio: b64 });
  }

  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed || this.fatal) return;
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
    if (pcm.length === 0) return;
    // Convert synchronously — `pcm` may be a view onto a pooled buffer.
    const up = upsample16kTo24k(pcm);
    const b64 = Buffer.from(up.buffer, up.byteOffset, up.byteLength).toString('base64');
    if (!this.setupDone) {
      this.micQueue.push(b64);
      return;
    }
    this.sendJson({ type: 'input_audio_buffer.append', audio: b64 });
  }

  private onWsMessage(data: Buffer | string): void {
    let ev: RealtimeServerEvent;
    try {
      ev = JSON.parse(
        typeof data === 'string' ? data : data.toString('utf8'),
      ) as RealtimeServerEvent;
    } catch (err) {
      this.reportError(`unparseable frame from OpenAI Realtime: ${(err as Error).message}`);
      return;
    }
    switch (ev.type) {
      case 'session.updated': {
        const w = this.setupWaiter;
        this.setupWaiter = undefined;
        w?.resolve();
        return;
      }
      case 'error': {
        const message = `OpenAI Realtime error${ev.error?.code ? ` (${ev.error.code})` : ''}: ${ev.error?.message ?? 'unknown'}`;
        if (this.setupWaiter) {
          const w = this.setupWaiter;
          this.setupWaiter = undefined;
          w.reject(new Error(message));
          return;
        }
        this.reportError(message);
        return;
      }
      case 'input_audio_buffer.speech_started':
        this.awaitingUserWords = true;
        if (this.state === 'speaking' && !modeRequiresAddress(this.mode)) {
          // Barge-in — the server has already cancelled its reply
          // (interrupt_response); stop what the surface is still playing.
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
          this.setState('listening');
        }
        return;
      case 'conversation.item.input_audio_transcription.delta': {
        const id = ev.item_id ?? '';
        const text = (this.partialByItem.get(id) ?? '') + (ev.delta ?? '');
        this.partialByItem.set(id, text);
        if (this.state === 'listening') this.setState('transcribing');
        this.deps.sendAudio({
          type: 'audio.transcript_partial',
          sessionId: this.init.sessionId,
          text,
        });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.onTranscript(ev.item_id ?? '', (ev.transcript ?? '').trim());
        return;
      case 'conversation.item.input_audio_transcription.failed':
        this.partialByItem.delete(ev.item_id ?? '');
        this.reportError(
          `OpenAI Realtime could not transcribe what was said: ${ev.error?.message ?? 'unknown'}`,
        );
        if (this.state === 'transcribing') this.setState('listening');
        return;
      case 'response.created':
        if (this.state !== 'speaking') this.setState('thinking');
        return;
      case 'response.output_audio_transcript.delta':
        if (ev.delta) this.onReplyText(ev.delta);
        return;
      case 'response.output_audio.delta': {
        if (!ev.delta) return;
        const buf = Buffer.from(ev.delta, 'base64');
        const pcm = new Int16Array(buf.byteLength >>> 1);
        new Uint8Array(pcm.buffer).set(buf.subarray(0, pcm.byteLength));
        if (pcm.length === 0) return;
        this.responseHadAudio = true;
        if (this.state !== 'speaking') this.setState('speaking');
        this.deps.sendAudio({
          type: 'audio.tts_chunk',
          sessionId: this.init.sessionId,
          samples: pcm.length,
        });
        this.deps.sendBinary(pcm);
        return;
      }
      case 'response.function_call_arguments.done':
        if (ev.name === DISPATCH_TOOL_NAME && ev.call_id) {
          this.responseHadToolCall = true;
          void this.handleDispatch(ev.call_id, ev.arguments ?? '{}');
        }
        return;
      case 'response.done':
        this.onResponseDone(ev.response ?? {});
        return;
      default:
        return;
    }
  }

  private onReplyText(delta: string): void {
    // The voice's words about an agent's answer are written too: the answer is already in
    // the chat as the agent's own message, and what the voice said of it is a separate
    // thing the user heard and should be able to read.
    if (this.awaitingUserWords) {
      this.heldReply += delta;
      return;
    }
    this.reply ??= this.deps.timeline.beginReply(this.currentChatId);
    this.reply.append(delta);
  }

  private finishReply(): void {
    const reply = this.reply;
    this.reply = undefined;
    reply?.finish();
  }

  /** The user's words are settled (written, or dropped): release any held reply. */
  private releaseHeldReply(): void {
    this.awaitingUserWords = false;
    const held = this.heldReply;
    this.heldReply = '';
    if (held) this.onReplyText(held);
  }

  engineCosting(): EngineCosting {
    return { backend: 'openai', model: this.deps.model, tokens: this.tokens, stt: null };
  }

  isAwaitingHandoff(): boolean {
    return this.dispatchesInFlight > 0;
  }

  pushContext(role: 'user' | 'assistant', text: string): void {
    if (this.closed || !this.setupDone) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    });
  }

  private onTranscript(itemId: string, text: string): void {
    this.partialByItem.delete(itemId);
    const addressed =
      !modeRequiresAddress(this.mode) ||
      text.length === 0 ||
      isAddressed(
        text,
        this.init.addressWord ?? DEFAULT_ADDRESS_WORD,
        this.lastSpokeAt === undefined ? undefined : Date.now() - this.lastSpokeAt,
      );
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.init.sessionId,
      text,
      ...(addressed ? {} : { addressed: false }),
    });
    if (text.length === 0) {
      this.releaseHeldReply();
      if (this.state === 'transcribing') this.setState('listening');
      return;
    }
    if (!addressed) {
      // Heard, not for us: never a turn, and never context either.
      this.heldReply = '';
      this.awaitingUserWords = false;
      this.sendJson({ type: 'conversation.item.delete', item_id: itemId });
      if (this.state === 'transcribing') this.setState('listening');
      return;
    }
    this.turns += 1;
    this.deps.timeline.userSaid(this.currentChatId, text);
    this.releaseHeldReply();
    if (modeRequiresAddress(this.mode)) {
      // hands-free: the server VAD was told not to answer on its own.
      this.sendJson({ type: 'response.create' });
    }
    if (this.state === 'transcribing') this.setState('thinking');
  }

  private onResponseDone(response: NonNullable<RealtimeServerEvent['response']>): void {
    const hadAudio = this.responseHadAudio;
    const hadTool =
      this.responseHadToolCall || (response.output ?? []).some((o) => o.type === 'function_call');
    this.responseHadAudio = false;
    this.responseHadToolCall = false;
    if (response.usage) this.tokens = addTokens(this.tokens, realtimeUsageTokens(response.usage));
    // Reply text still held for words that never settled is written anyway,
    // rather than lost.
    if (!this.awaitingUserWords) this.finishReply();
    if (response.status === 'failed') {
      const detail =
        response.status_details?.error?.message ?? response.status_details?.reason ?? 'no detail';
      this.reportError(`OpenAI Realtime reply failed: ${detail}`);
    } else if (response.status === 'completed' && !hadAudio && !hadTool) {
      // NO SILENT FAILURES: a reply the user can't hear is a lost reply.
      this.reportError('OpenAI Realtime reply produced no audio for the surface');
    } else if (response.status === 'incomplete') {
      this.reportError(
        `OpenAI Realtime reply cut short: ${response.status_details?.reason ?? 'no detail'}`,
      );
    }
    // A cancelled response was barged in on — tts_end already went out.
    if (hadAudio && response.status !== 'cancelled') {
      this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
    }
    this.setState(this.dispatchesInFlight > 0 ? 'thinking' : 'listening');
  }

  private async handleDispatch(callId: string, rawArgs: string): Promise<void> {
    let request = '';
    try {
      const args = JSON.parse(rawArgs) as { request?: unknown };
      if (typeof args.request === 'string') request = args.request;
    } catch {
      request = rawArgs;
    }
    // The chat reads in order: what the user said, the bridge, then the hand-off.
    this.finishReply();
    this.dispatchesInFlight += 1;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, chatId: this.currentChatId, request },
      'openai-realtime: dispatching to the heavy agent',
    );
    const source: VoiceTurnSource = {
      kind: 'voice-app',
      surfaceKind: this.init.surfaceKind as 'web' | 'desktop' | 'mobile',
      sessionId: this.init.sessionId,
    };
    let result: string;
    try {
      result = await this.deps.submitUserTurn({
        chatId: this.currentChatId,
        message: request,
        source,
        handoff: true,
      });
    } catch (err) {
      result = `That failed: ${(err as Error).message}`;
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'openai-realtime: dispatch failed',
      );
    } finally {
      this.dispatchesInFlight -= 1;
    }
    if (this.closed || this.fatal) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ result }) },
    });
    // The response this asks for speaks the agent's answer.
    this.sendJson({ type: 'response.create' });
  }

  private onWsClose(code: number, reason: Buffer | string): void {
    if (this.closed) return;
    const why = typeof reason === 'string' ? reason : reason?.toString('utf8');
    const message = `OpenAI Realtime closed the session (code ${code}${why ? `: ${why}` : ''})`;
    if (this.setupWaiter) {
      const w = this.setupWaiter;
      this.setupWaiter = undefined;
      w.reject(new Error(message));
      return;
    }
    this.die(message);
  }

  /** Not a note engine — this class only backs `role: 'voice-call'` (audio/server.ts). */
  async finalizeNote(): Promise<boolean> {
    return false;
  }

  async injectTranscript(text: string): Promise<void> {
    if (this.closed || !this.setupDone) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.sendJson({ type: 'response.create' });
  }

  /** An out-of-band reply that reads `text` out and is not kept as conversation. */
  async speak(text: string): Promise<void> {
    if (this.closed || !this.setupDone) return;
    this.sendJson({
      type: 'response.create',
      response: {
        conversation: 'none',
        instructions: `Say exactly the following out loud, verbatim, and nothing else: ${text}`,
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.releaseHeldReply();
    this.finishReply();
    this.closed = true;
    const w = this.setupWaiter;
    this.setupWaiter = undefined;
    w?.reject(new Error('session closed'));
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}
