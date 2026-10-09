// meetingControl — what the Meeting button, the panel and the action cards do.
// Capture is acquired BEFORE the host is told to start, so a denied mic never
// leaves a live meeting that hears nothing.

import { getActiveWs } from '../api/ws.js';
import { getDesktopBridge, type PatchDesktopBridge } from './desktopBridge.js';
import { useMeetingStore } from '../stores/meetingStore.js';
import { useUiStore } from '../stores/uiStore.js';
import {
  startMeetingCapture,
  type MeetingCapture,
  type MeetingSources,
  type PcmFeed,
} from './meetingCapture.js';

let capture: MeetingCapture | null = null;

function ws(): NonNullable<ReturnType<typeof getActiveWs>> {
  const w = getActiveWs();
  if (!w) throw new Error('Not connected to the server');
  return w;
}

/** Mic always; system audio too on the desktop app, through its native helper. */
export async function acquireSources(): Promise<MeetingSources> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const bridge = getDesktopBridge();
  if (!bridge) return { mic };
  try {
    if (!bridge.startSystemAudio || !bridge.onSystemAudio) {
      throw new Error('this desktop app is too old to hear the call. Update Patch');
    }
    await bridge.startSystemAudio();
    return { mic, system: systemFeed(bridge) };
  } catch (err) {
    for (const t of mic.getTracks()) t.stop();
    throw new Error(`System audio unavailable: ${(err as Error).message}`);
  }
}

/** The shell's PCM bytes as a feed. Stopping it stops the helper. */
function systemFeed(bridge: PatchDesktopBridge): PcmFeed {
  return {
    subscribe(onPcm) {
      const offPcm = bridge.onSystemAudio!((bytes) => {
        // Whole samples only (the shell aligns them); copy so the view is 2-byte aligned.
        const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2));
        onPcm(new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2));
      });
      const offFailed = bridge.onSystemAudioFailed?.(({ message }) => {
        stopCapture();
        useUiStore.getState().pushError(`System audio stopped: ${message}`);
      });
      return () => {
        offPcm();
        offFailed?.();
      };
    },
    stop() {
      bridge.stopSystemAudio?.();
    },
  };
}

async function beginCapture(chatId: string): Promise<void> {
  const sources = await acquireSources();
  try {
    capture = startMeetingCapture(sources, (source, audioBase64) => {
      try {
        ws().send({ type: 'meeting.audio', chatId, source, audioBase64 });
      } catch (err) {
        useUiStore.getState().pushError(`Meeting audio not sent: ${(err as Error).message}`);
      }
    });
  } catch (err) {
    sources.mic?.getTracks().forEach((t) => t.stop());
    sources.system?.stop();
    throw err;
  }
  useMeetingStore.getState().setCapturing(chatId);
}

function report(what: string, err: unknown): void {
  useUiStore.getState().pushError(`${what}: ${(err as Error).message}`);
}

export async function startMeeting(chatId: string): Promise<void> {
  try {
    await beginCapture(chatId);
    ws().send({ type: 'meeting.control_request', chatId, action: 'start' });
  } catch (err) {
    stopCapture();
    report('Could not start the meeting', err);
  }
}

/** Re-attach this surface's audio to a meeting the host still has running. */
export async function listenHere(chatId: string): Promise<void> {
  try {
    await beginCapture(chatId);
  } catch (err) {
    report('Could not listen', err);
  }
}

export function pauseMeeting(chatId: string): void {
  capture?.setPaused(true);
  ws().send({ type: 'meeting.control_request', chatId, action: 'pause' });
}

export function resumeMeeting(chatId: string): void {
  capture?.setPaused(false);
  ws().send({ type: 'meeting.control_request', chatId, action: 'resume' });
}

/** Flushes the last audio first, so it reaches the host ahead of `end`. */
export function endMeeting(chatId: string): void {
  stopCapture();
  ws().send({ type: 'meeting.control_request', chatId, action: 'end' });
}

export function decideAction(chatId: string, actionId: string, decision: 'do' | 'dismiss'): void {
  ws().send({ type: 'meeting.action_request', chatId, actionId, decision });
}

export function requestMeeting(chatId: string): void {
  getActiveWs()?.send({ type: 'meeting.get_request', chatId });
}

function stopCapture(): void {
  capture?.stop();
  capture = null;
  useMeetingStore.getState().setCapturing(null);
}

/** Test seam. */
export function __resetMeetingControlForTests(): void {
  capture = null;
}
