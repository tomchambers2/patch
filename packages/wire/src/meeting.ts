// Meeting mode (a chat that listens to a meeting). The host owns a
// `MeetingState` per chat; surfaces render it and send audio + controls.
// Times are millisecond offsets from the start of the meeting, not wall-clock.

import { z } from 'zod';

export const MeetingStatus = z.enum(['live', 'paused', 'ended']);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

/** `you` is the microphone, `them` is system audio (everyone else on the call). */
export const MeetingSpeaker = z.enum(['you', 'them']);
export type MeetingSpeaker = z.infer<typeof MeetingSpeaker>;

export const MeetingTranscriptLine = z
  .object({ at: z.number(), speaker: MeetingSpeaker, text: z.string() })
  .strict();
export type MeetingTranscriptLine = z.infer<typeof MeetingTranscriptLine>;

export const MeetingNow = z
  .object({
    headline: z.string(),
    bullets: z.array(z.string()),
    /** Who has been speaking, e.g. "Dev, Priya". */
    who: z.string(),
  })
  .strict();
export type MeetingNow = z.infer<typeof MeetingNow>;

export const MeetingSummary = z
  .object({ headline: z.string(), bullets: z.array(z.string()) })
  .strict();
export type MeetingSummary = z.infer<typeof MeetingSummary>;

export const MeetingTopic = z
  .object({
    id: z.string().min(1),
    at: z.number(),
    title: z.string(),
    points: z.array(z.string()),
    decided: z.boolean(),
  })
  .strict();
export type MeetingTopic = z.infer<typeof MeetingTopic>;

export const MeetingActionStatus = z.enum(['pending', 'done', 'dismissed']);
export type MeetingActionStatus = z.infer<typeof MeetingActionStatus>;

export const MeetingAction = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    /** Why it was proposed — usually a quote and who said it. */
    why: z.string(),
    at: z.number(),
    status: MeetingActionStatus,
    /** Wall-clock ms when it was done or dismissed. */
    resolvedAt: z.number().optional(),
  })
  .strict();
export type MeetingAction = z.infer<typeof MeetingAction>;

export const MeetingState = z
  .object({
    status: MeetingStatus,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    /** Running time banked before the current stretch (pauses excluded). */
    elapsedBaseMs: z.number(),
    /** Wall-clock ms the current live stretch began; absent while paused or ended. */
    resumedAt: z.number().optional(),
    now: MeetingNow.nullable(),
    summary: MeetingSummary.nullable(),
    topics: z.array(MeetingTopic),
    actions: z.array(MeetingAction),
    transcript: z.array(MeetingTranscriptLine),
    /** Set when the last analysis or transcription failed; cleared by the next success. */
    error: z.string().nullable(),
  })
  .strict();
export type MeetingState = z.infer<typeof MeetingState>;

/** Total running time of a meeting at wall-clock `nowMs`. */
export function meetingElapsedMs(m: MeetingState, nowMs: number): number {
  return m.elapsedBaseMs + (m.resumedAt !== undefined ? Math.max(0, nowMs - m.resumedAt) : 0);
}

/** mm:ss, or h:mm:ss from an hour. */
export function formatMeetingClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
