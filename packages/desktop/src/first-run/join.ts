// "On my server" (spec/05 § Desktop first run): the user gives the pairing code
// their server printed (`patch-server pair`) and this turns it into a credential
// for this app on that server, and the connection to remember — the server's own
// address, or a relay with the loopback port its bridge will listen on.

import { generateUserKeypair } from '@patch/auth';
import { RelayClient, type WebSocketCtor } from '@patch/relay';
import { parsePairingUri } from '@patch/wire';
import WebSocket from 'ws';
import type { Connection } from './connection.js';
import { freePort } from './local-server.js';

export interface JoinOptions {
  /** What the server shows for this app in its list of devices. */
  label: string;
  /** A loopback port for a relayed server's bridge; chosen once and kept for good. */
  bridgePort?: () => Promise<number>;
}

export interface Joined {
  connection: Connection;
  credential: string;
}

interface PairCompleteBody {
  credential?: string;
  error?: string;
}

export async function joinServer(input: string, opts: JoinOptions): Promise<Joined> {
  const code = parsePairingUri(input);
  const body = {
    nonce: code.nonce,
    devicePublicKey: generateUserKeypair().publicKey,
    clientType: 'surface-desktop',
    label: opts.label,
  };

  let status: number;
  let answer: PairCompleteBody;
  if (code.relay) {
    const client = await RelayClient.connect(code.relay, {
      WebSocket: WebSocket as unknown as WebSocketCtor,
    });
    try {
      const res = await client.fetch('/api/auth/pair/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = res.status;
      answer = JSON.parse(new TextDecoder().decode(res.body)) as PairCompleteBody;
    } finally {
      client.close();
    }
  } else {
    const server = code.server as string;
    try {
      const res = await fetch(`${server}/api/auth/pair/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = res.status;
      answer = (await res.json()) as PairCompleteBody;
    } catch (e) {
      throw new Error(`Could not reach ${server}: ${(e as Error).message}`);
    }
  }

  if (status !== 200)
    throw new Error(answer.error ?? `The server refused the code (HTTP ${status})`);
  if (!answer.credential) throw new Error('The server accepted the code but sent no credential');
  const connection: Connection = code.relay
    ? { mode: 'relay', relay: code.relay, port: await (opts.bridgePort ?? freePort)() }
    : { mode: 'remote', server: code.server as string };
  return { connection, credential: answer.credential };
}
