// Voice-device control-plane WSS handler (spec/16-voice-device.md). This is
// the host side of the persistent `wss://<host>/device/control` link the
// firmware (and the Python mock harness) dial. It is the missing control plane
// that B-23-2 flagged: device registration/presence, mute tracking, outbound
// ring flow, wake-word sessions, and the phone>device>idle>push concurrency
// arbiter all live here.
//
// Connection lifecycle:
//   1. WS upgrade carries `Authorization: Bearer <device EdDSA-JWT>`. We verify
//      it against the account public key, require surface_kind === 'voice-device'
//      and a matching registered (non-revoked) device, else reject the upgrade.
//   2. First frame MUST be `hello {deviceId,fwVersion,muted}` → presence.attach
//      (online) with a live `send` bound to this socket.
//   3. `mute_changed` updates presence; a muted device is never a ring target.
//   4. `wake_detected` → mint a voice token + send `session_start`
//      (conversational) so the device opens the audio WSS.
//   5. `ring_accepted` → mint a voice token + send `session_start` for the
//      pending ring (conversational iff the ring was a call).
//   6. `ring_dismissed`/`session_end` → clear ring/session state; release the
//      concurrency slot and drain the queue.
//   7. socket close → presence.detach (offline) + release slot.
//
// NO FALLBACKS: a bad token, unknown device, or malformed frame closes the
// socket loudly (spec/principles.md).

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import {
  decodeDeviceControl,
  encodeDeviceControl,
  type DeviceControlOutbound,
  type DeviceRingFrame,
} from '@patch/wire/device-control';
import { mintVoiceToken } from '../audio/token-verifier.js';
import { VoiceConcurrencyArbiter } from './concurrency.js';
import type { DeviceRegistry } from './registry.js';
import type { PresenceRegistry } from './presence.js';

export const DEVICE_CONTROL_PATH = '/device/control';

export interface DeviceControlDeps {
  registry: DeviceRegistry;
  /**
   * The five-minute adoption window (spec/16). Optional so existing callers
   * keep working; when unset an unknown device is refused, which is the safe
   * direction — a machine with no adoption support must not admit strangers.
   */
  adoption?: { announce(deviceId: string): { adopted: boolean; reason?: string } };
  presence: PresenceRegistry;
  /** Account public key (base64url) — daemon.key `sub`. Verifies device JWTs. */
  accountPublicKey: string;
  accountId: string;
  /** Shared HMAC secret (PATCH_INTERNAL_TOKEN) used to mint voice tokens. */
  internalToken: string;
  /** Chat the voice-device conversation routes to (spec/06 Speakers thread). */
  voiceDeviceChatId: string;
  /** True while a phone Manager call holds the voice focus (spec/16 concurrency). */
  isPhoneCallActive: () => boolean;
  /**
   * Max concurrent device voice sessions (spec/07 §Concurrency on the host).
   * Matches the whisper concurrency cap (config.audio.maxConcurrentSessions:
   * 3 for local-whisper, 4 for Groq). Devices run in parallel up to this cap;
   * events beyond it queue.
   */
  maxConcurrentSessions: number;
  logger: Logger;
  nowMs?: () => number;
}

/** A daemon-minted ring waiting for the device's accept/dismiss. */
interface PendingRing {
  chatId: string;
  message?: string;
  conversational: boolean;
}

/** Per-connection state for one device's control socket. */
class DeviceConn {
  deviceId?: string;
  pendingRing?: PendingRing;
  sessionId?: string;
  constructor(readonly ws: WebSocket) {}

  send(frame: DeviceControlOutbound): void {
    this.ws.send(encodeDeviceControl(frame));
  }
}

export class DeviceControlServer {
  private readonly deps: DeviceControlDeps;
  private readonly arbiter: VoiceConcurrencyArbiter;
  private readonly now: () => number;
  /** deviceId → live connection, so a ring can find the socket. */
  private readonly conns = new Map<string, DeviceConn>();

  constructor(deps: DeviceControlDeps) {
    this.deps = deps;
    this.now = deps.nowMs ?? Date.now;
    this.arbiter = new VoiceConcurrencyArbiter({
      isPhoneCallActive: deps.isPhoneCallActive,
      cap: deps.maxConcurrentSessions,
      // A queued event must only replay if the device's control socket is still
      // live. `conns` holds exactly the connected (helloed) devices, so its
      // membership is the connection-liveness check the drain re-validates with
      // (spec/16 — a gone device must not be minted a session or leak a slot).
      isEligible: (deviceId) => this.conns.has(deviceId),
    });
  }

  /** Test/diagnostics: how many concurrent device sessions are live. */
  activeSessionCount(): number {
    return this.arbiter.activeCount();
  }
  queueDepth(): number {
    return this.arbiter.queueDepth();
  }

  /**
   * Authenticate the WS upgrade. Returns the verified deviceId, or throws.
   * Exposed so the audio HTTP server's `upgrade` listener can gate the
   * handshake BEFORE completing it.
   */
  async authenticateUpgrade(req: IncomingMessage): Promise<string> {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new ControlAuthError('missing bearer token');
    }
    const jwt = header.slice('Bearer '.length).trim();
    const claims = await verifySurfaceCredential(jwt, {
      userPublicKey: this.deps.accountPublicKey,
      expectedSurfaceKind: 'voice-device',
      // voice-device surface JWTs are exp-less by design (jwt.ts §103/169).
      expectAnyExp: true,
      now: Math.floor(this.now() / 1000),
    });
    let record = this.deps.registry.get(claims.surface_id);
    if (!record) {
      // A device this machine has never seen. It joins ONLY through an open
      // adoption window — which is what `patch hosts pair-device` opens
      // (spec/16 § Adoption). Until this, the window was opened and nothing
      // consulted it: an unknown device was refused unconditionally, so the
      // command was ceremony and a device could never be adopted at all.
      const outcome = this.deps.adoption?.announce(claims.surface_id);
      if (!outcome?.adopted) {
        throw new ControlAuthError(
          outcome?.reason ?? `device not registered: ${claims.surface_id}`,
        );
      }
      // The credential is account-signed and carries the device's own key, so
      // the record is built from what was actually proven, not from the frame.
      record = this.deps.registry.register({
        deviceId: claims.surface_id,
        name: claims.label || claims.surface_id,
        accountId: this.deps.accountId,
        publicKey: claims.surface_pubkey ?? '',
        registeredAt: this.now(),
      });
      this.deps.logger.info(
        { deviceId: claims.surface_id },
        'device-control: adopted inside the open window',
      );
    }
    if (record.revoked === true) {
      throw new ControlAuthError(`device revoked: ${claims.surface_id}`);
    }
    return claims.surface_id;
  }

  /** Complete the WS upgrade and wire up frame handling for `deviceId`. */
  handleConnection(ws: WebSocket, deviceId: string): void {
    const conn = new DeviceConn(ws);
    const log = this.deps.logger;

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        // The control WSS is JSON-only; PCM lives on the audio WSS.
        log.warn({ deviceId }, 'device-control: unexpected binary frame; ignoring');
        return;
      }
      let frame;
      try {
        frame = decodeDeviceControl(data as string | Buffer);
      } catch (err) {
        log.warn({ deviceId, err: (err as Error).message }, 'device-control: bad frame');
        conn.send({ type: 'error', message: 'malformed control frame' });
        return;
      }
      try {
        this.onFrame(conn, deviceId, frame);
      } catch (err) {
        log.error({ deviceId, err: (err as Error).message }, 'device-control: frame handler threw');
      }
    });

    ws.on('close', () => {
      this.onClose(conn, deviceId);
    });
    ws.on('error', (err: Error) => {
      log.warn({ deviceId, err: err.message }, 'device-control: socket error');
    });
  }

  private onFrame(
    conn: DeviceConn,
    deviceId: string,
    frame: import('@patch/wire/device-control').DeviceControlInbound,
  ): void {
    const log = this.deps.logger;
    switch (frame.type) {
      case 'hello': {
        if (frame.deviceId !== deviceId) {
          // The hello deviceId must match the authenticated surface id; a
          // mismatch is a spoof attempt — close loudly.
          log.warn(
            { authDeviceId: deviceId, helloDeviceId: frame.deviceId },
            'device-control: hello deviceId mismatch',
          );
          conn.send({ type: 'error', message: 'hello deviceId mismatch' });
          conn.ws.close();
          return;
        }
        conn.deviceId = deviceId;
        const record = this.deps.registry.get(deviceId);
        const name = record?.name ?? deviceId;
        // Reconnect slot-leak guard (spec/16 §Concurrency). When a device reboots
        // or its Wi-Fi blips, it dials a FRESH control socket and re-sends hello
        // BEFORE the old socket's `close` event fires. `onClose` then suppresses
        // the stale close (identity guard below), so the prior session's
        // concurrency slot is never released — every subsequent `wake_detected`
        // is rejected `device-already-active` forever and the device can never
        // start a session again. A fresh hello means the device has no in-flight
        // session (it just announced a clean presence), so release any leaked
        // slot it still holds in the arbiter before re-registering.
        if (this.arbiter.isActive(deviceId)) {
          this.arbiter.release(deviceId);
          log.info({ deviceId }, 'device-control: released stale session slot on reconnect hello');
        }
        this.conns.set(deviceId, conn);
        this.deps.presence.attach(deviceId, {
          muted: frame.muted,
          lastUsedAt: this.now(),
          fwVersion: frame.fwVersion,
          send: (f) => conn.send(f as DeviceControlOutbound),
          close: () => conn.ws.close(),
        });
        log.info({ deviceId, name, muted: frame.muted }, 'device-control: device online');
        return;
      }
      case 'mute_changed': {
        this.deps.presence.setMuted(deviceId, frame.muted, this.now());
        log.info({ deviceId, muted: frame.muted }, 'device-control: mute changed');
        if (frame.muted) {
          // A device muted mid-ring drops the pending ring (it can no longer
          // be a target; spec/16 §Mute switch). The cascade re-runs on the
          // next notify and falls through to another candidate.
          conn.pendingRing = undefined;
        }
        return;
      }
      case 'wake_detected': {
        // Hello-gate (spec/16 § Connection lifecycle: hello MUST be the first
        // frame, establishing presence). A wake from a socket that never
        // helloed is from a device with no established presence — reject it; it
        // must not be granted a voice session.
        if (conn.deviceId === undefined) {
          log.warn(
            { deviceId },
            'device-control: wake_detected before hello; rejecting (no presence)',
          );
          conn.send({ type: 'error', message: 'wake_detected before hello' });
          return;
        }
        this.startSession(conn, deviceId, {
          chatId: this.deps.voiceDeviceChatId,
          conversational: true,
        });
        return;
      }
      case 'ring_accepted': {
        if (conn.deviceId === undefined) {
          log.warn(
            { deviceId },
            'device-control: ring_accepted before hello; rejecting (no presence)',
          );
          conn.send({ type: 'error', message: 'ring_accepted before hello' });
          return;
        }
        const ring = conn.pendingRing;
        if (!ring) {
          log.warn({ deviceId }, 'device-control: ring_accepted with no pending ring');
          return;
        }
        conn.pendingRing = undefined;
        this.startSession(conn, deviceId, {
          chatId: ring.chatId,
          conversational: ring.conversational,
        });
        return;
      }
      case 'ring_dismissed': {
        conn.pendingRing = undefined;
        log.info({ deviceId }, 'device-control: ring dismissed');
        return;
      }
      case 'session_end': {
        this.endSession(conn, deviceId, frame.reason);
        return;
      }
    }
  }

  /**
   * Mint a voice token + send `session_start`, gated by the concurrency
   * arbiter. The device then opens the audio WSS using the token.
   */
  private startSession(
    conn: DeviceConn,
    deviceId: string,
    opts: { chatId: string; conversational: boolean },
  ): void {
    const log = this.deps.logger;
    const decision = this.arbiter.admit({
      kind: 'device-wake',
      deviceId,
      run: () => this.openSession(conn, deviceId, opts),
    });
    if (decision.decision === 'admit') {
      this.arbiter.markActive(deviceId);
      this.openSession(conn, deviceId, opts);
      return;
    }
    if (decision.decision === 'queued') {
      log.info({ deviceId, reason: decision.reason }, 'device-control: voice event queued');
      return;
    }
    // rejected: device already active — ignore the duplicate.
    log.warn({ deviceId, reason: decision.reason }, 'device-control: session request rejected');
  }

  private openSession(
    conn: DeviceConn,
    deviceId: string,
    opts: { chatId: string; conversational: boolean },
  ): void {
    const sessionId = randomUUID();
    const { token } = mintVoiceToken({
      secret: this.deps.internalToken,
      accountId: this.deps.accountId,
      surfaceId: deviceId,
      sessionId,
      chatId: opts.chatId,
      nowMs: this.now(),
    });
    conn.sessionId = sessionId;
    this.deps.presence.touch(deviceId, this.now());
    conn.send({
      type: 'session_start',
      sessionId,
      voiceToken: token,
      // The device declares this accountId on audio.session_start so its
      // identity matches the token's claims (the audio server rejects a
      // mismatch). The device never decodes the token itself.
      accountId: this.deps.accountId,
      chatId: opts.chatId,
      conversational: opts.conversational,
    });
    this.deps.logger.info(
      { deviceId, sessionId, chatId: opts.chatId, conversational: opts.conversational },
      'device-control: session_start sent',
    );
  }

  private endSession(conn: DeviceConn, deviceId: string, reason: string): void {
    conn.sessionId = undefined;
    this.deps.presence.touch(deviceId, this.now());
    const released = this.arbiter.release(deviceId);
    this.deps.logger.info(
      { deviceId, reason, released: released?.deviceId },
      'device-control: session ended',
    );
  }

  private onClose(conn: DeviceConn, deviceId: string): void {
    // Only tear down presence if THIS connection is still the live one for the
    // device. A device that reconnects (e.g. after a reboot or Wi-Fi blip)
    // opens a fresh socket + helloes — registering the new conn in `this.conns`
    // — before the old socket's `close` event finally fires. Without this guard
    // the stale close would wipe the presence the new connection just
    // established, producing a spurious offline flap. Compare identity so a
    // superseded socket's close is a no-op.
    const current = this.conns.get(deviceId);
    if (current !== undefined && current !== conn) {
      this.deps.logger.info(
        { deviceId },
        'device-control: stale socket closed; live connection retained',
      );
      return;
    }
    if (conn.deviceId !== undefined) {
      this.deps.presence.detach(deviceId);
      this.conns.delete(deviceId);
    }
    // A dropped socket also frees the concurrency slot + drains the queue.
    this.arbiter.release(deviceId);
    this.deps.logger.info({ deviceId }, 'device-control: device offline');
  }

  /**
   * Called when a phone Manager call ends — drain any queued device events.
   */
  onPhoneCallEnded(): void {
    this.arbiter.onPhoneCallEnded();
  }

  /** Close every live device control socket (graceful shutdown / test teardown). */
  closeAll(): void {
    for (const [, conn] of this.conns) {
      try {
        conn.ws.close();
      } catch {
        // ignore — we're tearing down
      }
    }
    this.conns.clear();
  }

  /**
   * Send a `ring` frame to a device (called by the speakers cascade's
   * `presence.send`). Records the pending ring so the eventual `ring_accepted`
   * can open the session for the right chat. Returns false if the device is
   * not connected. Conversational rings (calls) leave the WSS open after TTS;
   * notification rings (`conversational: false`) are one-way speak-and-end.
   */
  ring(deviceId: string, frame: DeviceRingFrame): boolean {
    const conn = this.conns.get(deviceId);
    if (!conn) return false;
    conn.pendingRing = {
      chatId: frame.chatId,
      ...(frame.message !== undefined ? { message: frame.message } : {}),
      conversational: frame.conversational,
    };
    conn.send(frame);
    return true;
  }
}

export class ControlAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlAuthError';
  }
}

/**
 * Mount the `/device/control` upgrade path on an existing HTTP upgrade flow.
 * The audio server owns the `http.Server`; this returns an upgrade handler it
 * delegates to for `DEVICE_CONTROL_PATH`. Auth runs BEFORE `handleUpgrade`
 * completes so a bad token never becomes an open socket.
 */
export function mountDeviceControlUpgrade(args: {
  server: DeviceControlServer;
  wss: WebSocketServer;
  logger: Logger;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    args.server
      .authenticateUpgrade(req)
      .then((deviceId) => {
        args.wss.handleUpgrade(req, socket, head, (ws) => {
          args.server.handleConnection(ws, deviceId);
        });
      })
      .catch((err: Error) => {
        // Every rejection here — bad/missing bearer, unknown/revoked device, or
        // a JWT verification failure from @patch/auth — is an auth failure, so
        // it is always 401. (This used to branch on `err instanceof
        // ControlAuthError` but both arms produced the same 401, which was
        // dead/misleading code; simplified to what it actually does.)
        args.logger.warn({ err: err.message }, 'device-control: upgrade rejected');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  };
}
