// Deciding, at launch, what the window will show (spec/05 § Desktop first run).
// With a connection remembered, the window goes straight to it — bringing up
// whatever it needs on this Mac first (the local server, or the bridge a
// relayed server is reached through). With none, the first run asks, and keeps
// asking until an answer works: the question is never answered by guessing.

import { RelayConnection, type WebSocketCtor } from '@patch/relay';
import { startBridge, type Bridge } from '@patch/relay/bridge';
import WebSocket from 'ws';
import { appUrl, originOf, readSaved, writeSaved, type SavedConnection } from './connection.js';
import { joinServer } from './join.js';
import type { LocalServer } from './local-server.js';

/** What the first-run page lets the user choose between. */
export type Choice = { kind: 'local' } | { kind: 'remote'; input: string };

/** The first-run page, as the launch sees it. */
export interface SetupUi {
  /** Show the choice; resolves with what the user picked. */
  choose(): Promise<Choice>;
  progress(message: string): void;
  /** Say why that did not work; `choose` is called again. */
  fail(message: string): void;
}

export interface Launch {
  /** The page for the window to load. */
  appUrl: string;
  /** Everything started for it, stopped. */
  stop(): Promise<void>;
}

export interface LaunchOptions {
  /** Where the remembered connection lives. */
  file: string;
  ui: SetupUi;
  /** What the server calls this app in its list of devices. */
  label: string;
  /** Bring up the local server and host; `existing` is what was remembered, if anything. */
  startLocal(
    existing: SavedConnection | null,
    progress: (message: string) => void,
  ): Promise<{ saved: SavedConnection; server: LocalServer }>;
}

async function bridgeFor(
  saved: SavedConnection & { connection: { mode: 'relay' } },
): Promise<Bridge> {
  const relay = saved.connection.relay;
  const connection = RelayConnection.to(relay, {
    WebSocket: WebSocket as unknown as WebSocketCtor,
  });
  return startBridge({ connect: () => connection.session(), port: saved.connection.port });
}

/** Everything a remembered connection needs running on this Mac, and the page it leads to. */
async function resume(saved: SavedConnection, opts: LaunchOptions): Promise<Launch> {
  const { connection } = saved;
  if (connection.mode === 'local') {
    const { server } = await opts.startLocal(saved, () => undefined);
    return { appUrl: appUrl(server.origin, saved.credential), stop: () => server.stop() };
  }
  if (connection.mode === 'relay') {
    const bridge = await bridgeFor(saved as SavedConnection & { connection: { mode: 'relay' } });
    return { appUrl: appUrl(bridge.origin, saved.credential), stop: () => bridge.close() };
  }
  return { appUrl: appUrl(originOf(connection), saved.credential), stop: async () => undefined };
}

export async function launchPatch(opts: LaunchOptions): Promise<Launch> {
  const saved = readSaved(opts.file);
  if (saved !== null) return resume(saved, opts);

  for (;;) {
    const choice = await opts.ui.choose();
    try {
      if (choice.kind === 'local') {
        // What an earlier attempt got as far as saving is carried into this one.
        const { saved: made, server } = await opts.startLocal(readSaved(opts.file), (m) =>
          opts.ui.progress(m),
        );
        writeSaved(opts.file, made);
        return { appUrl: appUrl(server.origin, made.credential), stop: () => server.stop() };
      }
      opts.ui.progress('Pairing with your server…');
      const joined = await joinServer(choice.input, { label: opts.label });
      writeSaved(opts.file, joined);
      return resume(joined, opts);
    } catch (e) {
      opts.ui.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
