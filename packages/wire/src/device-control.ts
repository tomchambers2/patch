// Voice-device control-plane WSS frames (spec/16-voice-device.md §Wire
// protocol). The persistent control WSS terminates at the host
// (`wss://<host>/device/control`); the per-session audio WSS uses the
// separate `@patch/wire/audio` frames.
//
// These mirror the firmware's hand-rolled C encoder/decoder in
// `packages/voice-firmware/components/.../patch_control_frames.{h,c}` and the
// Python mock harness in `packages/voice-firmware/mock`. The host is the
// authoritative implementation of the other side, so the shapes here must
// match the firmware exactly — any drift fails loudly (zod `.strict()`), never
// silently coerces (spec/principles.md "No fallbacks").
//
// Kept in a subpath (`@patch/wire/device-control`) like `./audio` so the
// surface-facing wire union stays lean — only the host's control-WSS handler
// imports this.

import { z } from 'zod';

// --- device → host -------------------------------------------------------

/** First frame after the control WSS upgrade. */
export const DeviceHelloFrame = z
  .object({
    type: z.literal('hello'),
    deviceId: z.string().min(1),
    fwVersion: z.string().min(1),
    muted: z.boolean(),
  })
  .strict();
export type DeviceHelloFrame = z.infer<typeof DeviceHelloFrame>;

/** Wake-word fired on-device → host prepares an audio session. */
export const DeviceWakeDetectedFrame = z.object({ type: z.literal('wake_detected') }).strict();
export type DeviceWakeDetectedFrame = z.infer<typeof DeviceWakeDetectedFrame>;

/** Session-end reasons, verbatim from spec/16 §Wire protocol. */
export const DeviceSessionEndReason = z.enum(['vad-timeout', 'user-button', 'agent-finished']);
export type DeviceSessionEndReason = z.infer<typeof DeviceSessionEndReason>;

export const DeviceSessionEndFrame = z
  .object({
    type: z.literal('session_end'),
    reason: DeviceSessionEndReason,
  })
  .strict();
export type DeviceSessionEndFrame = z.infer<typeof DeviceSessionEndFrame>;

/** Reply to a `ring` frame — user accepted. */
export const DeviceRingAcceptedFrame = z.object({ type: z.literal('ring_accepted') }).strict();
export type DeviceRingAcceptedFrame = z.infer<typeof DeviceRingAcceptedFrame>;

/** Reply to a `ring` frame — user dismissed (or 30s timeout on-device). */
export const DeviceRingDismissedFrame = z.object({ type: z.literal('ring_dismissed') }).strict();
export type DeviceRingDismissedFrame = z.infer<typeof DeviceRingDismissedFrame>;

/** Hardware mute switch flipped. */
export const DeviceMuteChangedFrame = z
  .object({
    type: z.literal('mute_changed'),
    muted: z.boolean(),
  })
  .strict();
export type DeviceMuteChangedFrame = z.infer<typeof DeviceMuteChangedFrame>;

export const DeviceControlInbound = z.discriminatedUnion('type', [
  DeviceHelloFrame,
  DeviceWakeDetectedFrame,
  DeviceSessionEndFrame,
  DeviceRingAcceptedFrame,
  DeviceRingDismissedFrame,
  DeviceMuteChangedFrame,
]);
export type DeviceControlInbound = z.infer<typeof DeviceControlInbound>;

// --- host → device -------------------------------------------------------

/**
 * Host tells the device to open an audio WSS. Carries the daemon-minted
 * per-session HMAC voice token (spec/16 §Wire protocol "Voice-token
 * delivery"): the device never calls the server's mint endpoint itself.
 * `chatId` is included so a conversational session knows its target chat.
 * `accountId` is included so the device can declare the identity the audio WSS
 * expects on `audio.session_start` WITHOUT decoding the (opaque) voice token:
 * the host mints the token bound to {accountId, surfaceId=deviceId, chatId}
 * and the audio server rejects a session whose declared accountId/chatId don't
 * match the token's claims. The device only ever talks to its paired host,
 * so the host hands it the accountId rather than the device knowing it.
 */
export const DeviceSessionStartFrame = z
  .object({
    type: z.literal('session_start'),
    sessionId: z.string().min(1),
    voiceToken: z.string().min(1),
    accountId: z.string().min(1),
    chatId: z.string().min(1),
    /** True for a ring-initiated call; false for a one-way speakers notify. */
    conversational: z.boolean(),
  })
  .strict();
export type DeviceSessionStartFrame = z.infer<typeof DeviceSessionStartFrame>;

/** Host wants this device to ring (notification or call). */
export const DeviceRingFrame = z
  .object({
    type: z.literal('ring'),
    chatId: z.string().min(1),
    message: z.string().optional(),
    conversational: z.boolean(),
    /** Step-3 low-volume general announcement (spec/16 §Outbound routing). */
    lowVolume: z.boolean().optional(),
  })
  .strict();
export type DeviceRingFrame = z.infer<typeof DeviceRingFrame>;

export const DeviceLedState = z.enum(['idle', 'listening', 'agent-speaking', 'ringing']);
export type DeviceLedState = z.infer<typeof DeviceLedState>;

/** Optional UI hint — the device may also derive LED state locally. */
export const DeviceLedFrame = z
  .object({
    type: z.literal('led'),
    state: DeviceLedState,
  })
  .strict();
export type DeviceLedFrame = z.infer<typeof DeviceLedFrame>;

/** Host-side error surfaced to the device (e.g. concurrency cap). */
export const DeviceErrorFrame = z
  .object({
    type: z.literal('error'),
    message: z.string(),
  })
  .strict();
export type DeviceErrorFrame = z.infer<typeof DeviceErrorFrame>;

export const DeviceControlOutbound = z.discriminatedUnion('type', [
  DeviceSessionStartFrame,
  DeviceRingFrame,
  DeviceLedFrame,
  DeviceErrorFrame,
]);
export type DeviceControlOutbound = z.infer<typeof DeviceControlOutbound>;

// --- codec -----------------------------------------------------------------

export function encodeDeviceControl(frame: DeviceControlOutbound): string {
  return JSON.stringify(frame);
}

/** Parse a device → host control frame. Throws on any unknown/invalid shape. */
export function decodeDeviceControl(raw: string | Buffer | Uint8Array): DeviceControlInbound {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else text = Buffer.from(raw).toString('utf8');
  const parsed: unknown = JSON.parse(text);
  return DeviceControlInbound.parse(parsed);
}
