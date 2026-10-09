// Speakers-channel device-resolution cascade (spec/09-notifications.md
// § `### speakers`, spec/16-voice-device.md § Outbound routing + Mute switch).
//
// When `patch_speak` fires the host must decide
// which physical voice device to ring. Resolution order:
//
//   1. Explicit `deviceId` → ring it (if online & not muted).
//   2. Most-recently-active online+unmuted device (per presence `lastUsedAt`).
//   3. All online+unmuted devices at low volume → general announcement.
//   4. Cascade exhausted (nothing online+unmuted) → `push` fallback carrying
//      the text + deep-link. If there is no push target the failure is logged
//      to undelivered.jsonl.
//
// Muted devices are ALWAYS skipped, at every step. This module is pure: it
// composes the presence primitives passed in `Deps` and reports what it did,
// so it can be exercised end-to-end through the notify handler with mock
// devices. The real-firmware specifics (Kokoro synth, audio WSS) are F2.

/** The subset of `PresenceRegistry` the cascade depends on. */
export interface SpeakerPresence {
  /** Every registered device with current presence, used to pick candidates. */
  enumerate: () => { deviceId: string; online: boolean; muted: boolean; lastUsedAt: number }[];
  isOnline: (deviceId: string) => boolean;
  isMuted: (deviceId: string) => boolean;
  /** Send a control frame to a device; false when the device is offline. */
  send: (deviceId: string, frame: Record<string, unknown>) => boolean;
}

/**
 * How recent a device's last session must be to count as "recently active"
 * for step 2 (spec: "if it had a session in the last few minutes").
 */
export const RECENT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export interface SpeakerCascadeInput {
  /** Source chat firing the notify — carried in the ring frame + deep-link. */
  chatId: string;
  message: string;
  /** Optional explicit target from `patch_notify({ deviceId })`. */
  deviceId?: string;
  /** ms-since-epoch — drives the recency window for step 2. */
  now: number;
  /**
   * Ring kind (spec/16 § Two flows: notification vs conversation).
   *   - `false` (default): `patch_notify(channel:'speakers')` — a one-way
   *     speak-and-end announcement, no listening window.
   *   - `true`: `patch_call` escalation targeting a physical device — a
   *     conversational ring; on `ring_accepted` the host opens a session
   *     that stays open for the user's spoken reply.
   */
  conversational?: boolean;
}

export type SpeakerCascadeOutcome =
  /** Step 1/2: rang exactly one device. */
  | { kind: 'device'; deviceId: string }
  /** Step 3: low-volume general announcement to every reachable device. */
  | { kind: 'all'; deviceIds: string[] }
  /** Step 4: cascade exhausted; handed off to the push fallback. */
  | { kind: 'push' };

export interface SpeakerCascadeDeps {
  presence: SpeakerPresence;
  /**
   * Push fallback for step 4 (spec: "fall back to push with the text and a
   * deep-link"). This IS the spec-defined fallback, not an error-hiding one.
   */
  pushFallback: (input: { chatId: string; message: string }) => void;
}

/**
 * Build the ring frame for a speakers resolution. `conversational` controls
 * whether this is a one-way notify ring (false — speak-and-end, no listening
 * window) or a call ring (true — the session stays open for a reply after the
 * initial TTS). spec/16 § Two flows: notification vs conversation.
 */
function ringFrame(
  chatId: string,
  message: string,
  conversational: boolean,
): Record<string, unknown> {
  return { type: 'ring', chatId, message, conversational };
}

/** A device is a valid ring candidate only if online AND not muted. */
function reachable(presence: SpeakerPresence, deviceId: string): boolean {
  return presence.isOnline(deviceId) && !presence.isMuted(deviceId);
}

/**
 * Run the 4-step resolution cascade. Returns what it did so the caller (notify
 * handler) can record it; rings happen as a side effect via `presence.send`.
 */
export function resolveSpeakers(
  input: SpeakerCascadeInput,
  deps: SpeakerCascadeDeps,
): SpeakerCascadeOutcome {
  const { presence } = deps;
  const { chatId, message, deviceId, now } = input;
  const conversational = input.conversational ?? false;
  const frame = ringFrame(chatId, message, conversational);

  // Step 1: explicit deviceId. Ring it only if reachable; otherwise fall
  // through the rest of the cascade (a muted/offline explicit target is not
  // an error — it degrades to the next candidate).
  if (deviceId !== undefined && reachable(presence, deviceId)) {
    if (presence.send(deviceId, frame)) {
      return { kind: 'device', deviceId };
    }
  }

  // Candidate pool for steps 2/3: online AND unmuted only. Muted devices are
  // ALWAYS skipped.
  const candidates = presence.enumerate().filter((d) => d.online && !d.muted);

  // Step 2: most-recently-active device, if its last session is within the
  // recency window.
  const mostRecent = candidates
    .filter((d) => now - d.lastUsedAt <= RECENT_ACTIVE_WINDOW_MS)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
  if (mostRecent && presence.send(mostRecent.deviceId, frame)) {
    return { kind: 'device', deviceId: mostRecent.deviceId };
  }

  // Step 3: nothing recently active but devices are reachable → low-volume
  // general announcement to all of them.
  if (candidates.length > 0) {
    const lowVolumeFrame = { ...frame, lowVolume: true };
    const rung: string[] = [];
    for (const d of candidates) {
      if (presence.send(d.deviceId, lowVolumeFrame)) rung.push(d.deviceId);
    }
    if (rung.length > 0) {
      return { kind: 'all', deviceIds: rung };
    }
  }

  // Step 4: cascade exhausted (no reachable device) → push fallback.
  deps.pushFallback({ chatId, message });
  return { kind: 'push' };
}
