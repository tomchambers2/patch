// Boot the TUI from the CLI entry. Wires config + transport + ws into App.

import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../config.js';
import { bearerToken } from '../auth.js';
import { PatchWsClient } from '../transport/ws.js';
import { buildTransport } from '../transport/index.js';
import { App } from './App.js';
import type { ChatBrowserChat } from './ChatBrowser.js';

export interface LaunchOptions {
  folder?: string;
  resume?: string;
  attach?: string;
  hideStatus?: boolean;
  /** SDK model override (CLI `--model` pass-through; spec/13). */
  model?: string;
  /** SDK permission mode (CLI `--dangerously-skip-permissions` pass-through). */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

/** Extra SDK `query()` options threaded into the spawn RPC (spec/13). */
export interface SpawnOverrides {
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

function wsUrl(httpUrl: string): string {
  const u = new URL('/ws', httpUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  return u.toString();
}

async function spawnViaTransport(
  folder: string,
  prompt?: string,
  overrides?: SpawnOverrides,
): Promise<string> {
  const t = buildTransport(loadConfig());
  const body: Record<string, unknown> = { folder };
  if (prompt !== undefined) body['prompt'] = prompt;
  // Flag pass-through (spec/13): translate `--model` / `--dangerously-skip-permissions`
  // into the host spawn RPC's SDK `query()` options.
  if (overrides?.model !== undefined) body['model'] = overrides.model;
  if (overrides?.permissionMode !== undefined) body['permissionMode'] = overrides.permissionMode;
  if (t.kind === 'uds') {
    const res = await t.post<{ chatId: string }>('/internal/spawn', body);
    return res.chatId;
  }
  const res = await t.post<{ chatId: string }>('/api/chats', body);
  return res.chatId;
}

async function listChats(): Promise<ChatBrowserChat[]> {
  const t = buildTransport(loadConfig());
  const path = t.kind === 'uds' ? '/chats' : '/api/chats';
  const res = await t.get<{ chats: ChatBrowserChat[] }>(path);
  return res.chats;
}

/**
 * Recent folders for the picker, sourced from the HOST box (spec/13: "Lists
 * recent folders on the Hetzner box"). Only available over the local UDS; in
 * remote mode we fall through to whatever the caller passes (config default).
 */
async function fetchRecentFolders(): Promise<string[]> {
  const t = buildTransport(loadConfig());
  if (t.kind !== 'uds') return [];
  const res = await t.get<{ recents: string[]; completions: string[] }>('/chats/folders');
  return res.recents;
}

export async function launchTui(opts: LaunchOptions): Promise<void> {
  // Non-TTY guard: emit a single helpful line, no React stack trace.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "patch: TTY required for interactive use; for scripted use, see 'patch --help'\n",
    );
    process.exit(2);
  }
  const config = loadConfig();
  let bearer: string | null = null;
  try {
    bearer = bearerToken();
  } catch (e) {
    // no/expired/corrupt creds — TUI will surface this in the status strip
    // when ws fails to connect. We log to stderr so the user sees it.
    process.stderr.write('[patch] auth: ' + (e as Error).message + '\n');
  }
  const ws = new PatchWsClient({
    url: wsUrl(config.serverUrl),
    bearer,
    clientType: 'surface-cli',
    clientVersion: '0.0.0',
  });
  // Best-effort connect — surface errors to status strip via state listener.
  ws.connect().catch(() => {
    // already reflected in state strip as 'reconnecting'; nothing more to do.
  });

  const initialChatId = opts.resume ?? opts.attach;
  // Recent folders come from the host box (spec/13). Fall back to the local
  // config default only when the host-mediated list is empty/unavailable.
  let recents: string[] = [];
  try {
    recents = await fetchRecentFolders();
  } catch (e) {
    process.stderr.write('[patch] recent-folders: ' + (e as Error).message + '\n');
  }
  if (recents.length === 0 && config.defaultFolder) recents = [config.defaultFolder];
  // Bind launch-time pass-through flags (spec/13) onto every spawn from this
  // TUI session, so the App's (folder, prompt?) calls carry --model /
  // --dangerously-skip-permissions through to the host spawn RPC.
  const overrides: SpawnOverrides = {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
  };
  const spawnChat = (folder: string, prompt?: string): Promise<string> =>
    spawnViaTransport(folder, prompt, overrides);
  const props = {
    config,
    ws,
    recents,
    spawnChat,
    fetchChats: listChats,
    ...(initialChatId !== undefined ? { initialChatId } : {}),
    ...(opts.folder !== undefined ? { initialFolder: opts.folder } : {}),
    ...(opts.hideStatus ? { hideStatus: true } : {}),
  };
  const app = render(<App {...props} />);
  await app.waitUntilExit();
  await ws.close();
}
