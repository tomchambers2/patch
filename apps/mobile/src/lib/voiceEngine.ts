// Which voice engine a phone session is on, and how its failures read
// (spec/07 § Voice — a config matrix; spec/15 § Voice states).
//
// The phone never talks to Gemini or OpenAI itself and holds no provider key
// or token: every backend rides the same host audio WSS, and the host picks
// the engine per session from the account's voice config. So nothing here
// chooses an engine — it only names the one the config says a session is on,
// so the call bar can say "Gemini Live · heavy" while the line is paid for,
// and turns a hosted engine's failure into a sentence that says which engine
// failed instead of a bare error code.

import {
  modesShareVoiceEngine,
  voiceCellFor,
  type AudioErrorCode,
  type AudioSessionMode,
  type VoiceBackend,
  type VoiceConfig,
  type VoiceLayer,
} from '@patch/wire/audio';

const ENGINE_NAME: Record<Exclude<VoiceBackend, 'local'>, string> = {
  gemini: 'Gemini Live',
  openai: 'OpenAI Realtime',
};

/**
 * What the call bar names the engine a sustained session in `mode` runs on.
 * Null for `local` — the self-hosted default needs no label — and when the
 * config hasn't loaded (no guess). A hosted `direct` runs as `light`, so it is
 * named that.
 */
export function callEngineLabel(config: VoiceConfig | null, mode: AudioSessionMode): string | null {
  if (config === null) return null;
  const cell = voiceCellFor(config, mode === 'hands-free' ? 'hands-free' : 'call');
  if (cell.backend === 'local') return null;
  const layer: VoiceLayer = cell.layer === 'heavy' ? 'heavy' : 'light';
  return `${ENGINE_NAME[cell.backend]} · ${layer}`;
}

/**
 * Whether flipping an open session from `from` to `to` has to open a fresh
 * session because the two modes are configured onto different engines. With
 * the config unknown the switch is attempted in place, and the host refuses
 * it loudly if it would cross engines.
 */
export function modeSwitchNeedsNewSession(
  config: VoiceConfig | null,
  from: AudioSessionMode,
  to: AudioSessionMode,
): boolean {
  if (config === null || from === to) return false;
  return !modesShareVoiceEngine(config, from, to);
}

/**
 * The sentence an `audio.error` becomes on the call bar. A hosted engine's
 * failure names the engine — it is never answered by quietly running the local
 * pipeline instead, so the user has to be able to tell that the configured
 * engine is what broke.
 */
export function describeVoiceError(code: AudioErrorCode, message: string): string {
  switch (code) {
    case 'gemini_unavailable':
      return `Gemini Live failed — ${message}`;
    case 'openai_unavailable':
      return `OpenAI Realtime failed — ${message}`;
    case 'voice_key_missing':
    case 'mic_silent':
      // Already the whole sentence, with the fix.
      return message;
    case 'voice_config_not_implemented':
      return `Not available with this voice setting — ${message}`;
    default:
      return `${code}: ${message}`;
  }
}
