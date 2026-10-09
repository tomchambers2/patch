// Voice-session concurrency arbiter (spec/16 §Concurrency with phone Manager
// call, spec/07 §Concurrency on the host).
//
// Priority order (highest first):
//   phone-active-call > device-active-session > idle devices > push notification
//
// A phone Manager call takes priority over EVERY device: while one is active
// the host must NOT open a device session (spec/16 — that would create two
// parallel voice sessions outranking the call). Queued events replay when the
// call ends.
//
// Device sessions themselves run concurrently UP TO `cap` (spec/07 §Concurrency
// on the host: "Multiple voice surfaces can have audio sessions open at the
// same time … CCX22 has headroom for ~3 concurrent sessions"). `cap` is the
// configured whisper concurrency cap (3 for local-whisper, 4 for Groq). A new
// device event is admitted immediately while the active count is below `cap`;
// once the cap is reached further events QUEUE (not dropped) and replay as
// running sessions end. A second event for an ALREADY-active device is rejected
// (a device does not queue work for itself).
//
// This is a small, pure state machine so it can be exercised deterministically
// with concurrent events. It holds no sockets — it only decides admit/queue and
// hands queued work back to the caller. The caller passes `isEligible` so the
// arbiter never admits a queued event whose device has since disconnected
// (spec/16 — a gone device must not be minted a session or leak a slot).

export type VoiceEventKind = 'device-ring' | 'device-wake';

export interface QueuedVoiceEvent {
  kind: VoiceEventKind;
  deviceId: string;
  /** Replayed verbatim when the event is finally admitted. */
  run: () => void;
}

export type AdmitDecision =
  /** Start now. */
  | { decision: 'admit' }
  /** Queued behind the active session/phone call; will run on release. */
  | { decision: 'queued'; reason: 'phone-call-active' | 'device-session-active' }
  /** Dropped because the SAME device already has a session (no self-queue). */
  | { decision: 'rejected'; reason: 'device-already-active' };

export class VoiceConcurrencyArbiter {
  /** deviceIds with a live audio session right now. */
  private readonly activeDevices = new Set<string>();
  /** FIFO of events waiting for a device/phone slot. */
  private readonly queue: QueuedVoiceEvent[] = [];
  private readonly isPhoneCallActive: () => boolean;
  /** Max concurrent device sessions (spec/07 whisper concurrency cap). */
  private readonly cap: number;
  /**
   * A queued event is only replayed if its device is still eligible (control
   * socket still connected). Defaults to always-eligible for pure unit use.
   */
  private readonly isEligible: (deviceId: string) => boolean;

  constructor(deps: {
    isPhoneCallActive: () => boolean;
    /** Concurrent device-session cap (spec/07). Defaults to 1 if unset. */
    cap?: number;
    isEligible?: (deviceId: string) => boolean;
  }) {
    this.isPhoneCallActive = deps.isPhoneCallActive;
    this.cap = deps.cap ?? 1;
    this.isEligible = deps.isEligible ?? (() => true);
  }

  /**
   * Decide whether `deviceId` may open a session now. A phone call beats every
   * device. Below the concurrency cap a new device event is admitted (devices
   * run in parallel up to the cap, spec/07). At the cap a new event queues. A
   * second event for an already-active device is rejected (it doesn't queue
   * work for itself).
   */
  admit(event: QueuedVoiceEvent): AdmitDecision {
    if (this.activeDevices.has(event.deviceId)) {
      return { decision: 'rejected', reason: 'device-already-active' };
    }
    if (this.isPhoneCallActive()) {
      this.queue.push(event);
      return { decision: 'queued', reason: 'phone-call-active' };
    }
    if (this.activeDevices.size >= this.cap) {
      this.queue.push(event);
      return { decision: 'queued', reason: 'device-session-active' };
    }
    return { decision: 'admit' };
  }

  /** Mark a device session as started (after `admit` returned 'admit'). */
  markActive(deviceId: string): void {
    this.activeDevices.add(deviceId);
  }

  /**
   * Mark a device session ended and drain the queue: if no phone call and no
   * other device session blocks it, admit the oldest queued event whose device
   * is now free and run it. Returns the event that was released (if any).
   */
  release(deviceId: string): QueuedVoiceEvent | undefined {
    this.activeDevices.delete(deviceId);
    return this.drain();
  }

  /** A phone call ended → try to release the head of the queue. */
  onPhoneCallEnded(): QueuedVoiceEvent | undefined {
    return this.drain();
  }

  private drain(): QueuedVoiceEvent | undefined {
    if (this.isPhoneCallActive()) return undefined;
    while (this.activeDevices.size < this.cap) {
      const next = this.queue.shift();
      if (!next) return undefined;
      // Re-validate at drain time: a device whose control socket dropped while
      // queued must NOT be minted a session or hold a slot (spec/16). Drop it
      // silently and try the next queued event.
      if (!this.isEligible(next.deviceId) || this.activeDevices.has(next.deviceId)) {
        continue;
      }
      this.markActive(next.deviceId);
      next.run();
      return next;
    }
    return undefined;
  }

  // --- diagnostics / tests ---
  isActive(deviceId: string): boolean {
    return this.activeDevices.has(deviceId);
  }
  activeCount(): number {
    return this.activeDevices.size;
  }
  queueDepth(): number {
    return this.queue.length;
  }
}
