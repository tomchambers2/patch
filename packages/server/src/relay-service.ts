// This server, reachable through a relay (spec/10 § Relay). Holds the server's
// relay identity — the key a pairing code pins and the channel it names — and
// the host half of the tunnel (`@patch/relay/host`), which ends each device's
// encrypted session on this server's own loopback address.
//
// Off unless a relay address is configured: a server with a public address has
// no use for one.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  channelFor,
  fromBase64Url,
  generateServerIdentity,
  identityFromSecret,
  toBase64Url,
  type ServerIdentity,
} from '@patch/relay';
import { RelayHost, type RelayHostLogger, type RelayHostStatus } from '@patch/relay/host';
import type { PairingRelay } from '@patch/wire';

export interface RelayServiceOptions {
  dataDir: string;
  /** The relay's `ws(s)://` address. */
  url: string;
  logger?: RelayHostLogger;
}

const KEY_FILE = 'relay.key';

/** The identity in `<data>/relay.key`, made 0600 the first time; a file that is not a key is an error. */
function loadIdentity(dataDir: string): ServerIdentity {
  const path = join(dataDir, KEY_FILE);
  if (!existsSync(path)) {
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(path, toBase64Url(generateServerIdentity().secretKey), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    chmodSync(path, 0o600);
  }
  const secretKey = fromBase64Url(readFileSync(path, 'utf8').trim());
  if (secretKey.length !== 32) {
    throw new Error(
      `${path} is not a relay key (${secretKey.length} bytes, need 32). Delete it to make a new identity — every device paired through the relay must then pair again.`,
    );
  }
  return identityFromSecret(secretKey);
}

export class RelayService {
  private readonly identity: ServerIdentity;
  private host: RelayHost | null = null;

  constructor(private readonly opts: RelayServiceOptions) {
    if (!/^wss?:\/\//.test(opts.url)) {
      throw new Error(`PATCH_RELAY_URL must be a ws:// or wss:// address, got ${opts.url}`);
    }
    this.identity = loadIdentity(opts.dataDir);
  }

  /** What a pairing code carries so a device can reach, and recognise, this server. */
  info(): PairingRelay {
    return {
      url: this.opts.url.replace(/\/+$/, ''),
      channel: channelFor(this.identity.publicKey),
      serverKey: toBase64Url(this.identity.publicKey),
    };
  }

  status(): RelayHostStatus {
    return this.host?.status() ?? { connected: false, sessions: 0, lastError: null };
  }

  /** Begin holding the channel. `target` is where this server listens, as this machine reaches it. */
  start(target: string): void {
    if (this.host) return;
    this.host = new RelayHost({
      relayUrl: this.opts.url,
      identity: this.identity,
      target,
      ...(this.opts.logger ? { logger: this.opts.logger } : {}),
    });
    this.host.start();
  }

  stop(): void {
    this.host?.stop();
    this.host = null;
  }
}
