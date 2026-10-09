// Permission gating (spec/02 § Permission mode): `default`, `acceptEdits` and
// `plan` must actually BLOCK a tool call on a human decision, not just emit a
// wire event alongside a call that already ran. This exercises the real
// round-trip end to end via the host's public API — spawnChat/sendInput to
// start a turn whose tool call needs a decision (the mock's
// `[[bash-permission]]` dev trigger awaits `onPermissionRequest` exactly like
// the real SDK's `canUseTool` would), asserting the chat.permission_request
// event + `awaiting-permission` activity land BEFORE the tool runs, and that
// submitPermissionResponse is what unblocks it — not a mock backend
// implementation, so the same coverage is representative of the real SDK's
// canUseTool wiring proven separately in sdkBackend-real.test.ts.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(
  opts: {
    permissionModeDefault?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-permgate-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-permgate-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    ...(opts.permissionModeDefault !== undefined
      ? { permissionModeDefault: opts.permissionModeDefault }
      : {}),
  });
  return { daemon, sdk, events, folder };
}

async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('permission gating: blocking modes actually hold the tool call', () => {
  it('under "plan" the Bash tool does not run until a permission_request is answered', async () => {
    const { daemon, events, folder } = setup({ permissionModeDefault: 'plan' });
    const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();

    // The request landed and the chat is parked awaiting a decision — the
    // tool must NOT have run yet.
    const req = events.find((e) => e.type === 'chat.permission_request');
    expect(req).toBeDefined();
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Bash')).toBe(false);

    const requestId = (req as { requestId: string }).requestId;
    daemon.submitPermissionResponse({ requestId, decision: 'approve' });
    await tick();

    // Now the tool actually ran, and the chat settled back to idle.
    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Bash')).toBe(true);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('denying the request under "default" stops the tool from ever running', async () => {
    const { daemon, events, folder } = setup({ permissionModeDefault: 'default' });
    const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();

    const req = events.find((e) => e.type === 'chat.permission_request') as
      | { requestId: string }
      | undefined;
    expect(req).toBeDefined();
    daemon.submitPermissionResponse({ requestId: req!.requestId, decision: 'deny' });
    await tick();

    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Bash')).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === 'chat.permission_response' && e.requestId === req!.requestId && !e.approve,
      ),
    ).toBe(true);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('under "acceptEdits" a Bash call still needs a decision (only file edits are pre-approved)', async () => {
    const { daemon, events, folder } = setup({ permissionModeDefault: 'acceptEdits' });
    await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(true);
  });
});

describe('permission gating: non-blocking modes never gate an ordinary tool call', () => {
  it('under "auto" the Bash tool runs immediately with no permission_request', async () => {
    const { daemon, events, folder } = setup();
    await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(false);
    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Bash')).toBe(true);
  });

  it('under "bypassPermissions" the Bash tool runs immediately with no permission_request', async () => {
    const { daemon, events, folder } = setup({ permissionModeDefault: 'bypassPermissions' });
    await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
    await tick();
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(false);
    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Bash')).toBe(true);
  });
});

describe('permission gating: the SDK can still escalate a safety check even under a non-blocking mode', () => {
  it('under "bypassPermissions" a sensitive-file write still produces a permission_request and parks the chat', async () => {
    const { daemon, events, folder } = setup({ permissionModeDefault: 'bypassPermissions' });
    const chatId = await daemon.spawnChat({ folder, prompt: '[[sensitive-file-permission]]' });
    await tick();

    const req = events.find((e) => e.type === 'chat.permission_request');
    expect(req).toBeDefined();
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Write')).toBe(false);

    const requestId = (req as { requestId: string }).requestId;
    daemon.submitPermissionResponse({ requestId, decision: 'approve' });
    await tick();

    expect(events.some((e) => e.type === 'chat.tool_call' && e.tool === 'Write')).toBe(true);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('under "auto" a sensitive-file write still produces a permission_request and parks the chat', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: '[[sensitive-file-permission]]' });
    await tick();

    const req = events.find((e) => e.type === 'chat.permission_request');
    expect(req).toBeDefined();
    expect(daemon.chatState.get(chatId)?.activity).toBe('awaiting-permission');
  });
});
