// In-memory device presence registry (group 23.5, B-24-5).
//
// Tracks which devices have an active control-WSS connection right now,
// their muted state, and when they were last used. Backs the
// `patch_list_devices` MCP tool and the host's outbound-routing logic.
//
// Lives in process memory only — on host restart every device shows
// `online: false` until it reconnects. That's correct: presence cannot
// outlive the WS connection that proves it.

import type { DeviceRecord } from './registry.js';

export interface DevicePresence {
  deviceId: string;
  name: string;
  online: boolean;
  muted: boolean;
  /** ms-since-epoch — last frame received (or session_end). 0 if never seen. */
  lastUsedAt: number;
  /** Firmware version reported in the most recent `hello`. */
  fwVersion?: string;
}

interface ActiveEntry {
  muted: boolean;
  lastUsedAt: number;
  fwVersion?: string;
  /** Send a control frame to this device. Bound to the live socket. */
  send: (frame: Record<string, unknown>) => void;
  /** Tear the WS down (used by revoke or admin). */
  close: () => void;
}

export class PresenceRegistry {
  private readonly active = new Map<string, ActiveEntry>();
  /** Device IDs we've seen at least once but are not currently online. */
  private readonly lastSeen = new Map<string, { muted: boolean; lastUsedAt: number }>();

  attach(deviceId: string, entry: ActiveEntry): void {
    // Defensive: if the same deviceId reconnects, evict the stale socket.
    const prior = this.active.get(deviceId);
    if (prior) {
      try {
        prior.close();
      } catch {
        // ignore — we're replacing it anyway
      }
    }
    this.active.set(deviceId, entry);
  }

  detach(deviceId: string): void {
    const cur = this.active.get(deviceId);
    if (!cur) return;
    this.lastSeen.set(deviceId, { muted: cur.muted, lastUsedAt: cur.lastUsedAt });
    this.active.delete(deviceId);
  }

  isOnline(deviceId: string): boolean {
    return this.active.has(deviceId);
  }

  isMuted(deviceId: string): boolean {
    const a = this.active.get(deviceId);
    if (a) return a.muted;
    return this.lastSeen.get(deviceId)?.muted ?? false;
  }

  setMuted(deviceId: string, muted: boolean, nowMs: number): void {
    const a = this.active.get(deviceId);
    if (!a) return;
    a.muted = muted;
    a.lastUsedAt = nowMs;
  }

  touch(deviceId: string, nowMs: number): void {
    const a = this.active.get(deviceId);
    if (!a) return;
    a.lastUsedAt = nowMs;
  }

  /**
   * Send a frame to the named device. Returns false if the device is
   * offline; callers typically fall through to the next routing
   * candidate (or push notification) per spec/16 §Outbound routing.
   */
  send(deviceId: string, frame: Record<string, unknown>): boolean {
    const a = this.active.get(deviceId);
    if (!a) return false;
    a.send(frame);
    return true;
  }

  /**
   * Combine the persistent registry with live presence to produce the
   * `patch_list_devices` payload.
   */
  enumerate(records: DeviceRecord[]): DevicePresence[] {
    return records
      .filter((r) => r.revoked !== true)
      .map((r) => {
        const live = this.active.get(r.deviceId);
        const seen = this.lastSeen.get(r.deviceId);
        const lastUsedAt = live?.lastUsedAt ?? seen?.lastUsedAt ?? 0;
        const muted = live ? live.muted : (seen?.muted ?? false);
        const out: DevicePresence = {
          deviceId: r.deviceId,
          name: r.name,
          online: !!live,
          muted,
          lastUsedAt,
        };
        if (live?.fwVersion !== undefined) {
          out.fwVersion = live.fwVersion;
        }
        return out;
      });
  }

  /** Diagnostic / test helper. */
  activeCount(): number {
    return this.active.size;
  }

  /** Test helper: forcibly close all live sockets. */
  closeAll(): void {
    for (const [, entry] of this.active) {
      try {
        entry.close();
      } catch {
        // ignore
      }
    }
    this.active.clear();
  }
}
