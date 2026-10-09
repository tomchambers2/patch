// This host's half of the cross-host audio relay (spec/07-voice-app.md §
// Voice is a per-host capability, spec/03-wire-protocol.md § Audio relay
// over the host link).
//
// The server tunnels a voice session it cannot dial into directly over THIS
// host's existing outbound server link, tagged by `sessionId`
// (`patch.audio_relay.*`, see events.ts for the full lifecycle comment). This
// class is the other end of that tunnel: for each `open`, it dials this
// host's OWN local audio WSS (`ws://127.0.0.1:<audioPort>/audio/:sessionId`)
// — the exact same endpoint a co-located surface would — and pipes bytes
// both ways. `audio/server.ts` runs completely unmodified on that end; it
// cannot tell a tunnelled connection from a direct one.
//
// NO FALLBACK: a local connect failure (voice not installed, or the audio
// WSS refusing the session) is reported once as `patch.audio_relay.error`
// and the bridge is torn down — never retried against a different pipeline.

import type { Logger } from 'pino';
import WebSocket from 'ws';
import type {
  PatchAudioRelayCloseEvent,
  PatchAudioRelayErrorEvent,
  PatchAudioRelayFrameEvent,
  PatchAudioRelayOpenEvent,
  PatchAudioRelayReadyEvent,
} from '@patch/wire';

export type AudioRelayBridgeOutbound =
  | PatchAudioRelayReadyEvent
  | PatchAudioRelayFrameEvent
  | PatchAudioRelayCloseEvent
  | PatchAudioRelayErrorEvent;

export interface AudioRelayBridgeOptions {
  logger: Logger;
  /** This host's own local audio WSS base, e.g. `ws://127.0.0.1:3003` (config.audio.port, NOT config.audio.host — the bridge always reaches it over loopback, same as audio-relay.ts's direct-dial path reaches a genuinely co-located host). */
  localAudioUrl: string;
  /** Push a frame up to the server for this session. */
  sender: (event: AudioRelayBridgeOutbound) => void;
  /** Test seam: substitute the local WebSocket client. */
  wsFactory?: (url: string) => WebSocket;
}

interface Bridge {
  socket: WebSocket;
  open: boolean;
  pending: Array<{ data: Buffer; isBinary: boolean }>;
}

export class AudioRelayBridge {
  private readonly bridges = new Map<string, Bridge>();

  constructor(private readonly opts: AudioRelayBridgeOptions) {}

  /** Is `sessionId` one this bridge is carrying? */
  hasSession(sessionId: string): boolean {
    return this.bridges.has(sessionId);
  }

  handleOpen(event: PatchAudioRelayOpenEvent): void {
    if (this.bridges.has(event.sessionId)) return; // duplicate open — already bridging
    const wsFactory = this.opts.wsFactory ?? ((url: string) => new WebSocket(url));
    const socket = wsFactory(`${this.opts.localAudioUrl}/audio/${event.sessionId}`);
    const bridge: Bridge = { socket, open: false, pending: [] };
    this.bridges.set(event.sessionId, bridge);

    socket.on('open', () => {
      bridge.open = true;
      this.opts.sender({ type: 'patch.audio_relay.ready', sessionId: event.sessionId });
      for (const m of bridge.pending) socket.send(m.isBinary ? m.data : m.data.toString('utf8'));
      bridge.pending.length = 0;
    });
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      this.opts.sender({
        type: 'patch.audio_relay.frame',
        sessionId: event.sessionId,
        data: data.toString('base64'),
        binary: isBinary,
      });
    });
    socket.once('close', () => {
      if (!this.bridges.delete(event.sessionId)) return;
      this.opts.sender({ type: 'patch.audio_relay.close', sessionId: event.sessionId });
    });
    socket.once('error', (err: Error) => {
      if (!this.bridges.delete(event.sessionId)) return;
      this.opts.logger.warn(
        { sessionId: event.sessionId, err: err.message },
        'audio relay bridge: local connection failed',
      );
      this.opts.sender({
        type: 'patch.audio_relay.error',
        sessionId: event.sessionId,
        code: 'connect_failed',
        message: err.message,
      });
    });
  }

  handleFrame(event: PatchAudioRelayFrameEvent): void {
    const bridge = this.bridges.get(event.sessionId);
    if (!bridge) {
      this.opts.logger.warn(
        { sessionId: event.sessionId },
        'audio relay bridge: frame for a session with no open bridge; dropping',
      );
      return;
    }
    const data = Buffer.from(event.data, 'base64');
    if (bridge.open) {
      bridge.socket.send(event.binary ? data : data.toString('utf8'));
    } else {
      bridge.pending.push({ data, isBinary: event.binary });
    }
  }

  handleClose(event: PatchAudioRelayCloseEvent): void {
    const bridge = this.bridges.get(event.sessionId);
    if (!bridge) return;
    this.bridges.delete(event.sessionId);
    bridge.socket.close();
  }

  /** Close every open bridge (host shutdown). */
  dispose(): void {
    for (const bridge of this.bridges.values()) bridge.socket.close();
    this.bridges.clear();
  }
}
