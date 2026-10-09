// Host addressing: the contract's rejections (spec/03 § Host events,
// spec/04 § Spawn, spec/02 § Permission mode / Optional components / Agent
// backends).
//
// Every case here is one the host or a surface would otherwise have to guess
// at. The whole reason `daemonId` is on the wire is that guessing runs a chat
// on the wrong filesystem, or applies a machine setting to the wrong machine —
// failures that look like nothing happened. So the protocol rejects them with
// the offending value named, and never silently defaults, drops, or routes to
// whichever host happens to be attached.
//
// The companion assertions guard what must NOT have changed: which events carry
// a `seq` at all, and which are live-only.

import { describe, it, expect } from 'vitest';
import { AUDIO_EVENT_SCHEMAS } from '../src/audio.js';
import {
  AuthOkEvent,
  ChatErrorCode,
  ChatInputEvent,
  ChatReplayEvent,
  ChatSpawnRequestEvent,
  ChatSettingsEvent,
  ChatStateEvent,
  ClaudeMemoryEntry,
  DaemonAccountEvent,
  DaemonHostEvent,
  DaemonUnauthenticatedEvent,
  EVENT_SCHEMAS,
  FoldersListEvent,
  HOST_ADDRESSED_SURFACE_EVENTS,
  isHostAddressedSurfaceEvent,
  HostBackendUsageRefreshEvent,
  HostClaudeMemoryDeleteEvent,
  HostClaudeSettingsDiscardEvent,
  HostComponentInstallEvent,
  HostFolderAddEvent,
  HostRenameEvent,
  HostSettingsEvent,
  SharedSettingsPatch,
  PatchChatHistoryRequestEvent,
  PatchFoldersBrowseRequestEvent,
  PatchFoldersBrowseResponseEvent,
  PatchListChatsResponseEvent,
  PatchModelsResponseEvent,
  PatchSpawnEvent,
  PatchTerminalOpenEvent,
  decode,
  encode,
  type WireEvent,
} from '../src/index.js';

/** The zod issue paths a failed parse complains about. */
function issuePaths(res: {
  success: boolean;
  error?: { issues: { path: (string | number)[] }[] };
}) {
  return res.success ? [] : (res.error?.issues ?? []).map((i) => i.path.join('.'));
}

describe('a frame that names no machine is rejected, not defaulted', () => {
  it('rejects a spawn request with no daemonId', () => {
    // spec/04 § Spawn: "the host to run on. Required." The same folder string
    // on two hosts is two different directories, so a spawn without a host has
    // nowhere correct to go.
    const res = ChatSpawnRequestEvent.safeParse({
      type: 'chat.spawn_request',
      folder: '/work/proj',
      prompt: 'go',
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('daemonId');
  });

  it('rejects a cross-chat spawn with no daemonId', () => {
    // An agent spawning a chat is choosing a machine whether it realises it or
    // not. The contract makes it say which.
    const res = PatchSpawnEvent.safeParse({
      type: 'patch.spawn',
      sourceChatId: 'c1',
      folder: '/work/proj',
      prompt: 'go',
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('daemonId');
  });

  it('rejects a terminal-open with no daemonId', () => {
    const res = PatchTerminalOpenEvent.safeParse({
      type: 'patch.terminal.open',
      sessionId: 's1',
      folder: '/work/proj',
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('daemonId');
  });

  it('rejects every host control that names no machine', () => {
    const cases: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, object]> = [
      ['host.rename', HostRenameEvent, { type: 'host.rename', hostName: 'hetzner' }],
      ['host.settings', HostSettingsEvent, { type: 'host.settings' }],
      [
        'host.component_install',
        HostComponentInstallEvent,
        { type: 'host.component_install', componentId: 'kokoro' },
      ],
      ['host.folder_add', HostFolderAddEvent, { type: 'host.folder_add', path: '/work' }],
      [
        'host.claude_settings_discard',
        HostClaudeSettingsDiscardEvent,
        { type: 'host.claude_settings_discard' },
      ],
      [
        'host.backend_usage_refresh',
        HostBackendUsageRefreshEvent,
        { type: 'host.backend_usage_refresh', backendId: 'claude-code' },
      ],
    ];
    for (const [name, schema, payload] of cases) {
      expect(schema.safeParse(payload).success, `${name} must require daemonId`).toBe(false);
    }
  });
});

describe('empty and out-of-set values are named, not coerced', () => {
  it('rejects an empty host name rather than falling back to the hostname', () => {
    // A host that silently renames itself back is indistinguishable from an
    // edit that did not save.
    const res = HostRenameEvent.safeParse({ type: 'host.rename', daemonId: 'd1', hostName: '' });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('hostName');
  });

  it('rejects a folder-registry edit carrying an empty path', () => {
    const res = HostFolderAddEvent.safeParse({
      type: 'host.folder_add',
      daemonId: 'd1',
      path: '',
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('path');
  });

  it('rejects a permission mode outside the set the backend accepts', () => {
    // Patch adds no mode of its own (spec/02 § Permission mode): the four
    // Claude Code modes are taken as they are.
    const res = SharedSettingsPatch.safeParse({ permissionModeDefault: 'yolo' });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('permissionModeDefault');

    const perChat = ChatSettingsEvent.safeParse({
      type: 'chat.settings',
      chatId: 'c1',
      permissionMode: 'yolo',
    });
    expect(perChat.success).toBe(false);
  });

  it('rejects an empty backendId on a credential operation', () => {
    expect(
      HostBackendUsageRefreshEvent.safeParse({
        type: 'host.backend_usage_refresh',
        daemonId: 'd1',
        backendId: '',
      }).success,
    ).toBe(false);
  });

  it('refuses a shared setting sent to one host', () => {
    // spec/01 § Settings: shared settings change on the server, never per host.
    expect(
      HostSettingsEvent.safeParse({
        type: 'host.settings',
        daemonId: 'd1',
        permissionModeDefault: 'plan',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty componentId on a component operation', () => {
    expect(
      HostComponentInstallEvent.safeParse({
        type: 'host.component_install',
        daemonId: 'd1',
        componentId: '',
      }).success,
    ).toBe(false);
  });
});

describe('model is optional at every spawn site', () => {
  // Resolving what a chat actually runs on belongs to the machine, not to the
  // protocol (spec/04 § Spawn). The contract must not oblige any caller to
  // supply one — a surface that has never read a catalogue still has to be
  // able to start a chat.
  it('accepts a surface spawn request with no model', () => {
    const res = ChatSpawnRequestEvent.safeParse({
      type: 'chat.spawn_request',
      daemonId: 'd1',
      folder: '/work/proj',
    });
    expect(res.success).toBe(true);
  });

  it('accepts a cross-chat spawn with no model', () => {
    const res = PatchSpawnEvent.safeParse({
      type: 'patch.spawn',
      daemonId: 'd1',
      sourceChatId: 'c1',
      folder: '/work/proj',
      prompt: 'go',
    });
    expect(res.success).toBe(true);
  });
});

describe('the catalogue reports per-backend outcomes, not one host-wide verdict', () => {
  it('carries models and errors together, so a partial failure keeps the rest selectable', () => {
    const ev = PatchModelsResponseEvent.parse({
      type: 'patch.models.response',
      requestId: 'm1',
      daemonId: 'd1',
      models: [{ id: 'claude-opus-5', label: 'Claude Opus 5', backend: 'claude-code' }],
      errors: [{ backend: 'other', code: 'upstream', message: 'provider returned 503' }],
    });
    expect(ev.models).toHaveLength(1);
    expect(ev.errors[0]?.backend).toBe('other');
  });

  it('requires every returned model to name its backend', () => {
    // A chosen model selects the backend the chat runs on, so an entry that
    // does not say which is unusable.
    const res = PatchModelsResponseEvent.safeParse({
      type: 'patch.models.response',
      requestId: 'm1',
      daemonId: 'd1',
      models: [{ id: 'claude-opus-5', label: 'Claude Opus 5' }],
      errors: [],
    });
    expect(res.success).toBe(false);
  });
});

describe("a host's self-description", () => {
  const base = {
    type: 'daemon.host' as const,
    daemonId: 'd1',
    hostName: 'hetzner',
    platform: 'linux',
    arch: 'x64',
    daemonVersion: '0.1.0',
    updateAvailable: false,
    permissionModeDefault: 'bypassPermissions' as const,
    permissionOverrides: 0,
    isHomeHost: false,
    audioRelayHost: '127.0.0.1:3003',
    backends: [],
    components: [],
  };

  it('omits defaultModel entirely until the account default has reached the host', () => {
    // Absent is MEANINGFUL: a spawn naming no model on a host with none is an
    // error saying so (spec/02 § Agent backends), so this must not be filled
    // in with a plausible-looking default.
    const ev = DaemonHostEvent.parse(base);
    expect('defaultModel' in ev).toBe(false);
    expect(DaemonHostEvent.parse({ ...base, defaultModel: 'claude-opus-5' }).defaultModel).toBe(
      'claude-opus-5',
    );
  });

  it('rejects a component whose state is not one of the four', () => {
    const res = DaemonHostEvent.safeParse({
      ...base,
      components: [{ id: 'kokoro', label: 'Kokoro', bytes: 1, state: 'maybe' }],
    });
    expect(res.success).toBe(false);
  });
});

describe('chat state carries the mode the next turn will actually use', () => {
  it('requires permissionMode — a surface must not have to re-derive it', () => {
    // The host resolves chat override → host default → bypassPermissions.
    // A surface does not hold the host default and would have to guess.
    const res = ChatStateEvent.safeParse({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 1,
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('permissionMode');
  });
});

describe('chat.settings: omitting the field CLEARS the override', () => {
  it('parses with no permissionMode, and that is the clear operation', () => {
    // A frame with nothing to say is not sent at all, so the only reason to
    // send this without the field is to fall back to the host default —
    // which is what gives a surface a way to undo an override.
    const ev = ChatSettingsEvent.parse({ type: 'chat.settings', chatId: 'c1' });
    expect(ev.permissionMode).toBeUndefined();
  });
});

describe('the greeting carries every registered machine', () => {
  // spec/03 § Control — `auth.ok` is `{surfaceId, hosts[], webBundleHash}`:
  // per-host presence plus the server's cached `daemon.host` / `daemon.account`
  // reports, ALONGSIDE the web-bundle hash the frame already carried.
  const host = {
    daemonId: 'host-a',
    hostName: 'studio',
    platform: 'darwin',
    arch: 'arm64',
    daemonVersion: '0.1.0',
    updateAvailable: false,
    permissionModeDefault: 'bypassPermissions' as const,
    permissionOverrides: 2,
    isHomeHost: true,
    audioRelayHost: '127.0.0.1:3003',
    backends: [
      { id: 'claude-code', label: 'Claude Code', version: '2.1.0', state: 'present' as const },
    ],
    components: [{ id: 'kokoro', label: 'Kokoro', bytes: 82_000_000, state: 'installed' as const }],
  };

  it('carries presence, the cached self-description and the per-backend accounts', () => {
    const ev = AuthOkEvent.parse({
      type: 'auth.ok',
      accountId: 'acct-1',
      surfaceId: 'srf-1',
      hosts: [
        {
          daemonId: 'host-a',
          online: true,
          lastSeenAt: 1_700_000_000_000,
          host,
          accounts: [{ daemonId: 'host-a', backendId: 'claude-code', connected: true }],
        },
        // A machine that has never spoken since the server started is still
        // named — a surface renders it offline-and-unknown rather than
        // omitting it and waiting for a `daemon.online` that may never come.
        { daemonId: 'host-b', online: false, lastSeenAt: null, host: null, accounts: [] },
      ],
      webBundleHash: 'assets/index-DEADBEEF.js',
    });
    expect(ev.hosts.map((h) => h.daemonId)).toEqual(['host-a', 'host-b']);
    expect(ev.hosts[0]?.host?.backends[0]?.id).toBe('claude-code');
    expect(ev.hosts[0]?.accounts[0]?.backendId).toBe('claude-code');
    expect(ev.webBundleHash).toBe('assets/index-DEADBEEF.js');
  });

  it('rejects a host entry that names no machine', () => {
    const res = AuthOkEvent.safeParse({
      type: 'auth.ok',
      accountId: 'acct-1',
      surfaceId: 'srf-1',
      hosts: [{ online: true, lastSeenAt: null, host: null, accounts: [] }],
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('hosts.0.daemonId');
  });
});

describe('the unauthenticated report names the machine AND the backend', () => {
  it('rejects a report that names only the machine', () => {
    // A host with two backends can be authenticated on one and not the other;
    // "this machine is logged out" cannot say which credential to fix.
    const res = DaemonUnauthenticatedEvent.safeParse({
      type: 'daemon.unauthenticated',
      daemonId: 'host-a',
      reason: 'token expired',
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('backendId');
  });

  it('accepts the per-backend form', () => {
    const ev = DaemonUnauthenticatedEvent.parse({
      type: 'daemon.unauthenticated',
      daemonId: 'host-a',
      backendId: 'claude-code',
      reason: 'token expired',
    });
    expect(ev.backendId).toBe('claude-code');
  });

  it('replaces the account-wide report with a per-machine, per-backend one', () => {
    const ev = DaemonAccountEvent.parse({
      type: 'daemon.account',
      daemonId: 'host-a',
      backendId: 'claude-code',
      connected: true,
      accountEmail: 'tom@example.com',
    });
    expect(ev.daemonId).toBe('host-a');
    // Neither half may be dropped.
    expect(
      DaemonAccountEvent.safeParse({ type: 'daemon.account', daemonId: 'host-a', connected: true })
        .success,
    ).toBe(false);
    expect(
      DaemonAccountEvent.safeParse({
        type: 'daemon.account',
        backendId: 'claude-code',
        connected: true,
      }).success,
    ).toBe(false);
  });

  it('carries optional session/week usage windows, absent by default', () => {
    const withoutUsage = DaemonAccountEvent.parse({
      type: 'daemon.account',
      daemonId: 'host-a',
      backendId: 'claude-code',
      connected: true,
    });
    expect(withoutUsage.usage).toBeUndefined();

    const withUsage = DaemonAccountEvent.parse({
      type: 'daemon.account',
      daemonId: 'host-a',
      backendId: 'claude-code',
      connected: true,
      usage: {
        session: { status: 'allowed_warning', utilization: 0.82, resetsAt: 1_800_000_000_000 },
        week: { status: 'allowed', utilization: 0.1 },
      },
    });
    expect(withUsage.usage?.session).toMatchObject({
      status: 'allowed_warning',
      utilization: 0.82,
    });
    expect(withUsage.usage?.week).toMatchObject({ status: 'allowed' });

    // A window's utilization is a fraction, not a raw score — out of range is rejected.
    expect(
      DaemonAccountEvent.safeParse({
        type: 'daemon.account',
        daemonId: 'host-a',
        backendId: 'claude-code',
        connected: true,
        usage: { session: { status: 'allowed', utilization: 1.5 } },
      }).success,
    ).toBe(false);
  });
});

describe('the cross-chat listing names each chat’s machine', () => {
  it('rejects a listed chat with no daemonId', () => {
    const ok = PatchListChatsResponseEvent.safeParse({
      type: 'patch.list_chats.response',
      sourceChatId: 'c0',
      chatCount: 1,
      chats: [{ chatId: 'c1', daemonId: 'host-a' }],
    });
    expect(ok.success, JSON.stringify(ok.success ? {} : ok.error?.issues)).toBe(true);
    const res = PatchListChatsResponseEvent.safeParse({
      type: 'patch.list_chats.response',
      sourceChatId: 'c0',
      chatCount: 1,
      chats: [{ chatId: 'c1' }],
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('chats.0.daemonId');
  });
});

describe('directory browse is addressed to one machine at a time', () => {
  it('requires a daemonId on both the request and the response', () => {
    expect(
      PatchFoldersBrowseRequestEvent.safeParse({
        type: 'patch.folders.browse.request',
        requestId: 'b1',
        dir: '/work',
      }).success,
    ).toBe(false);
    const res = PatchFoldersBrowseResponseEvent.safeParse({
      type: 'patch.folders.browse.response',
      requestId: 'b1',
      ok: true,
      dir: '/work',
      entries: [],
    });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('daemonId');
  });
});

describe('regression guards — what host addressing must NOT have changed', () => {
  it('keeps the live-only events out of the sequenced set', () => {
    // Streamed text chunks, the queue/dequeue notices, the input ack and the
    // new component-progress frame are transient: no own `seq`, never
    // persisted, never replayed. `host.component_progress` joins that set, and
    // its SETTLED result lands on `daemon.host` instead.
    const liveOnly = [
      'chat.message_delta',
      'chat.queued',
      'chat.dequeued',
      'chat.input_ack',
      'host.component_progress',
    ] as const;
    for (const type of liveOnly) {
      const schema = EVENT_SCHEMAS[type];
      expect(Object.keys(schema.shape), `${type} must carry no seq`).not.toContain('seq');
    }
  });

  it('keeps seq on the events that are replayed', () => {
    for (const type of [
      'chat.message',
      'chat.tool_call',
      'chat.tool_result',
      'chat.permission_request',
      'chat.error',
    ] as const) {
      expect(Object.keys(EVENT_SCHEMAS[type].shape), `${type} must carry seq`).toContain('seq');
    }
  });

  it('keeps the two cursors on their deliberately opposite boundaries', () => {
    // spec/12 § Replay vs history cursors. `chat.replay.fromSeq` is EXCLUSIVE
    // (the last seq the caller already has) so a fresh caller must be able to
    // say -1; `since` on a history request is INCLUSIVE (the first seq the
    // caller wants) so its floor is 0 and -1 is meaningless there. Host
    // addressing must not have "aligned" them.
    expect(
      ChatReplayEvent.safeParse({ type: 'chat.replay', chatId: 'c1', fromSeq: -1 }).success,
    ).toBe(true);
    expect(
      ChatReplayEvent.safeParse({ type: 'chat.replay', chatId: 'c1', fromSeq: -2 }).success,
    ).toBe(false);
    expect(
      PatchChatHistoryRequestEvent.safeParse({
        type: 'patch.chat_history.request',
        requestId: 'h1',
        chatId: 'c1',
        since: 0,
      }).success,
    ).toBe(true);
    expect(
      PatchChatHistoryRequestEvent.safeParse({
        type: 'patch.chat_history.request',
        requestId: 'h1',
        chatId: 'c1',
        since: -1,
      }).success,
    ).toBe(false);
  });

  it('keeps idempotency on the (chatId, localId) pair', () => {
    // A retry is deduped by the pair, so both halves are mandatory on the
    // input frame and neither may be inferred.
    expect(issuePaths(ChatInputEvent.safeParse({ type: 'chat.input', message: 'hi' }))).toEqual(
      expect.arrayContaining(['chatId', 'localId']),
    );
    // Agent-emitted events carry NO localId — they are emitted exactly once, so
    // there is nothing to dedupe against.
    expect(Object.keys(EVENT_SCHEMAS['chat.tool_call'].shape)).not.toContain('localId');
    // chat.message is the exception, and NOT because it is agent-emitted: it is
    // also the PERSISTED USER TURN, which echoes the localId the surface sent so
    // the surface can reconcile it against the copy it already rendered
    // optimistically. This assertion used to say chat.message carried no
    // localId; the schema being .strict() then meant the host could not send
    // the echo at all, so both copies rendered and every first message appeared
    // twice. Optional, because an assistant turn and a trigger-originated user
    // turn have no originating surface to echo.
    expect(EVENT_SCHEMAS['chat.message'].shape.localId.isOptional()).toBe(true);
    expect(
      EVENT_SCHEMAS['chat.message'].safeParse({
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'hi',
        seq: 0,
      }).success,
    ).toBe(true);
  });

  it('keeps the audio session binary-framed and unsequenced', () => {
    // spec/03 § Audio session: PCM frames are binary, nothing there carries a
    // seq, and none of it is in the JSON event union.
    expect(Object.keys(EVENT_SCHEMAS)).not.toContain('audio.pcm16');
    expect(Object.keys(EVENT_SCHEMAS)).not.toContain('audio.tts_chunk');
    // The PCM frames stay JSON envelopes over a BINARY body, on their own
    // session union — host addressing did not pull them into the chat stream.
    expect(Object.keys(AUDIO_EVENT_SCHEMAS)).toEqual(
      expect.arrayContaining(['audio.pcm16', 'audio.tts_chunk']),
    );
    for (const [name, schema] of Object.entries(AUDIO_EVENT_SCHEMAS)) {
      expect(Object.keys(schema.shape), `${name} must carry no seq`).not.toContain('seq');
    }
  });

  it('round-trips a host-addressed frame through the codec unchanged', () => {
    const ev: WireEvent = {
      type: 'folders.list',
      daemonId: 'd1',
      roots: ['/work/proj'],
      recent: ['/home/tom/notes'],
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('still rejects an unknown key on a host-addressed frame (strict)', () => {
    const res = FoldersListEvent.safeParse({
      type: 'folders.list',
      daemonId: 'd1',
      roots: [],
      recent: [],
      folders: ['/legacy'],
    });
    expect(res.success).toBe(false);
  });
});

describe('the host-addressed surface set is enumerable, so the gate can be complete', () => {
  it('lists exactly the surface frames that carry a daemonId', () => {
    // spec/03 § Host events: "Every host-scoped control a surface changes has a
    // surface-originated frame here carrying `daemonId` — no exceptions." The
    // server gates the whole set at one ingress, so the set has to BE the whole
    // set: a frame added to the protocol but not to this list is ungated.
    expect([...HOST_ADDRESSED_SURFACE_EVENTS].sort()).toEqual(
      [
        'chat.spawn_request',
        'host.backend_add_account',
        'host.backend_usage_refresh',
        'host.claude_memory_delete',
        'host.claude_memory_set',
        'host.claude_settings_discard',
        'host.component_install',
        'host.component_remove',
        'host.folder_add',
        'host.folder_remove',
        'host.rename',
        'host.set_home',
        'host.settings',
        'host.update',
        'patch.folders.browse.request',
        'patch.host_files.request',
        'patch.models.request',
        'patch.recurrence.translate.request',
        'patch.spawn',
        'patch.terminal.open',
      ].sort(),
    );
  });

  it('every listed type really does require a daemonId in its schema', () => {
    for (const type of HOST_ADDRESSED_SURFACE_EVENTS) {
      const schema = EVENT_SCHEMAS[type];
      // Parsing the type alone must fail ON daemonId — proof the entry is not
      // just a string in a list but a frame the contract actually addresses.
      const res = schema.safeParse({ type });
      expect(res.success, `${type} parsed with no fields`).toBe(false);
      expect(issuePaths(res as never), type).toContain('daemonId');
      expect(isHostAddressedSurfaceEvent(type)).toBe(true);
    }
  });

  it('does not claim daemon-originated or chat-scoped frames', () => {
    // `daemon.online` carries a daemonId but is server→surface: gating it as a
    // surface frame would answer a disallowed-type frame with a host error
    // instead of closing the socket.
    expect(isHostAddressedSurfaceEvent('daemon.online')).toBe(false);
    // `host.removed` is server→surface only: a surface cannot remove a host by
    // sending it (that is `DELETE /api/hosts/:daemonId`).
    expect(isHostAddressedSurfaceEvent('host.removed')).toBe(false);
    expect(isHostAddressedSurfaceEvent('daemon.host')).toBe(false);
    expect(isHostAddressedSurfaceEvent('folders.list')).toBe(false);
    expect(isHostAddressedSurfaceEvent('chat.input')).toBe(false);
  });

  it('carries a distinct error code for a machine that is not registered', () => {
    // spec/04 § Spawn — the refusal has to be distinguishable from a folder or
    // session failure, because the fix is different (add the machine, not the
    // folder).
    expect(ChatErrorCode.safeParse('host_not_registered').success).toBe(true);
  });
});

describe("a host's Claude Code settings + memory (spec/02 § Claude Code settings)", () => {
  const memory = {
    project: '-home-tom-projects-example',
    file: 'feedback_tests.md',
    name: 'feedback_tests',
    description: 'do not mock the database in integration tests',
    memoryType: 'feedback',
  };

  it('round-trips a memory entry', () => {
    expect(ClaudeMemoryEntry.parse(memory)).toEqual(memory);
  });

  it('rejects a memory entry missing project or file', () => {
    expect(ClaudeMemoryEntry.safeParse({ ...memory, project: '' }).success).toBe(false);
    expect(ClaudeMemoryEntry.safeParse({ ...memory, file: '' }).success).toBe(false);
  });

  it('allows blank name/description/memoryType — an unparsable frontmatter still lists the file', () => {
    const res = ClaudeMemoryEntry.safeParse({
      ...memory,
      name: '',
      description: '',
      memoryType: '',
    });
    expect(res.success).toBe(true);
  });

  it('claude_settings.list / .updated carry the full memory list and any drift, daemonId required', () => {
    for (const type of ['claude_settings.list', 'claude_settings.updated'] as const) {
      const schema = EVENT_SCHEMAS[type];
      const ok = schema.safeParse({
        type,
        daemonId: 'd1',
        drift: '{"model":"opus"}',
        memories: [memory],
      });
      expect(ok.success, JSON.stringify(ok.success ? {} : ok.error?.issues)).toBe(true);
      expect(schema.safeParse({ type, daemonId: 'd1', memories: [] }).success).toBe(true);
      expect(schema.safeParse({ type, memories: [] }).success).toBe(false);
    }
  });

  it('round-trips claude_settings.updated through the codec unchanged', () => {
    const ev: WireEvent = { type: 'claude_settings.updated', daemonId: 'd1', memories: [memory] };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('host.claude_settings_discard requires daemonId', () => {
    expect(
      HostClaudeSettingsDiscardEvent.safeParse({ type: 'host.claude_settings_discard' }).success,
    ).toBe(false);
    expect(
      HostClaudeSettingsDiscardEvent.safeParse({
        type: 'host.claude_settings_discard',
        daemonId: 'd1',
      }).success,
    ).toBe(true);
  });

  it('host.claude_memory_delete requires daemonId, project and file — none may be empty', () => {
    const base = {
      type: 'host.claude_memory_delete' as const,
      daemonId: 'd1',
      project: 'p',
      file: 'f.md',
    };
    expect(HostClaudeMemoryDeleteEvent.safeParse(base).success).toBe(true);
    expect(HostClaudeMemoryDeleteEvent.safeParse({ ...base, daemonId: undefined }).success).toBe(
      false,
    );
    expect(HostClaudeMemoryDeleteEvent.safeParse({ ...base, project: '' }).success).toBe(false);
    expect(HostClaudeMemoryDeleteEvent.safeParse({ ...base, file: '' }).success).toBe(false);
  });
});
