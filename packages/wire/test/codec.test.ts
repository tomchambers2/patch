// Round-trip every event type through encode/decode, plus rejection cases.
//
// Per task: covers ALL event types. Failure to add a new event here means
// the test won't break — but we also assert the test cases match the
// EVENT_SCHEMAS registry, which DOES break if you add an event without a test.

import { describe, test, expect } from 'vitest';
import {
  DEFAULT_SHARED_SETTINGS,
  encode,
  decode,
  isWireEvent,
  assertValidPermissionResponse,
  EVENT_SCHEMAS,
  OUT_OF_BAND_SEQ,
  WireDecodeError,
  type WireEvent,
  type WireEventType,
} from '../src/index.js';

const FIXTURES: { [K in WireEventType]: Extract<WireEvent, { type: K }> } = {
  'chat.spawned': {
    type: 'chat.spawned',
    chatId: 'c1',
    daemonId: 'host-a',
    folder: '/work/proj',
    parentChatId: 'cParent',
    jobId: 'j_00000000000000000000000012',
  },
  'chat.message': {
    type: 'chat.message',
    chatId: 'c1',
    role: 'assistant',
    content: 'hello',
    seq: 0,
  },
  'chat.message_delta': {
    type: 'chat.message_delta',
    chatId: 'c1',
    messageSeq: 0,
    delta: 'hel',
  },
  'chat.input_ack': {
    type: 'chat.input_ack',
    chatId: 'c1',
    localId: 'L1',
  },
  'chat.tool_call': {
    type: 'chat.tool_call',
    chatId: 'c1',
    tool: 'Bash',
    args: { command: 'ls' },
    callId: 'tc-1',
    seq: 1,
  },
  'chat.tool_result': {
    type: 'chat.tool_result',
    chatId: 'c1',
    tool: 'Bash',
    callId: 'tc-1',
    result: 'output',
    seq: 2,
  },
  'chat.provider_context': {
    type: 'chat.provider_context',
    chatId: 'c1',
    providerType: 'model',
    label: 'Model',
    text: 'You are powered by the model named Sonnet 5.',
    seq: 2,
  },
  'chat.permission_request': {
    type: 'chat.permission_request',
    chatId: 'c1',
    requestId: 'req-1',
    request: { tool: 'Bash', args: { command: 'rm -rf' }, description: 'dangerous' },
    seq: 3,
  },
  'chat.permission_expiry_update': {
    type: 'chat.permission_expiry_update',
    chatId: 'c1',
    requestId: 'req-1',
    expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
    seq: 4,
  },
  'chat.artifact': {
    type: 'chat.artifact',
    chatId: 'c1',
    artifactId: 'd41d8cd98f00b204e9800998ecf8427e',
    title: 'Bristol bus times',
    url: '/api/chats/c1/artifact/d41d8cd98f00b204e9800998ecf8427e',
    path: 'out/buses.html',
    updatedAt: 1700000000,
    seq: 4,
  },
  'chat.tool_run_summary': {
    type: 'chat.tool_run_summary',
    chatId: 'c1',
    callIds: ['t1', 't2'],
    summary: 'Set up the project locally',
    seq: 5,
  },
  'chat.state': {
    type: 'chat.state',
    permissionMode: 'bypassPermissions',
    chatId: 'c1',
    activity: 'running',
    lastUpdated: 1700000000,
  },
  'chat.stopped': { type: 'chat.stopped', chatId: 'c1', reason: 'user' },
  'chat.delegate_update': {
    type: 'chat.delegate_update',
    chatId: 'c1',
    delegateId: 'c2',
    label: 'research task',
    status: 'running',
    seq: 5,
  },
  'chat.queued': {
    type: 'chat.queued',
    chatId: 'c1',
    localId: 'L2',
    message: 'queued behind the running turn',
    queueSeq: 1,
  },
  'chat.dequeued': { type: 'chat.dequeued', chatId: 'c1', localId: 'L2', reason: 'running' },
  'chat.unqueue_request': { type: 'chat.unqueue_request', chatId: 'c1', localId: 'L2' },
  // spec/10 § Usage — stop waiting out a limit and try the parked turn now.
  'chat.resume_now_request': { type: 'chat.resume_now_request', chatId: 'c1' },
  'chat.promote_request': { type: 'chat.promote_request', chatId: 'c1', localId: 'L2' },
  // spec/04 ## Message queueing § Edit — replace a queued turn's typed text in place.
  'chat.edit_queued_request': {
    type: 'chat.edit_queued_request',
    chatId: 'c1',
    localId: 'L2',
    message: 'what I meant instead',
  },
  // spec/04 § Branching — edit a user turn (fork a track) and switch tracks.
  'chat.fork_request': {
    type: 'chat.fork_request',
    chatId: 'c1',
    seq: 4,
    message: 'rephrased',
    localId: 'L3',
  },
  'chat.side_request': {
    type: 'chat.side_request',
    chatId: 'c1',
    seq: 5,
    message: 'why did you say that?',
    localId: 'L4',
  },
  'chat.branch_switch_request': {
    type: 'chat.branch_switch_request',
    chatId: 'c1',
    branchId: 'c1-b0',
  },
  'chat.branch_rename_request': {
    type: 'chat.branch_rename_request',
    chatId: 'c1',
    branchId: 'c1-b1',
    name: 'My side thread',
  },
  'chat.send_back_request': {
    type: 'chat.send_back_request',
    chatId: 'c1',
    branchId: 'c1-b1',
  },
  'chat.branches': {
    type: 'chat.branches',
    chatId: 'c1',
    activeBranchId: 'c1-b1',
    branches: [
      { branchId: 'c1-b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'edit 1',
        createdAt: 2,
      },
    ],
  },
  'chat.error': {
    type: 'chat.error',
    chatId: 'c1',
    error: { code: 'sdk_error', message: 'boom' },
    seq: 4,
  },
  'daemon.online': { type: 'daemon.online', daemonId: 'host-a' },
  'daemon.offline': { type: 'daemon.offline', daemonId: 'host-a', reason: 'heartbeat-timeout' },
  'daemon.unauthenticated': {
    type: 'daemon.unauthenticated',
    daemonId: 'host-a',
    backendId: 'claude-code',
    reason: 'oauth-expired',
  },
  'daemon.host': {
    type: 'daemon.host',
    daemonId: 'host-a',
    hostName: "Tom's MacBook",
    platform: 'darwin',
    arch: 'arm64',
    daemonVersion: '0.1.0',
    updateAvailable: false,
    permissionModeDefault: 'bypassPermissions',
    permissionOverrides: 1,
    defaultModel: 'claude-opus-5',
    isHomeHost: true,
    audioRelayHost: '127.0.0.1:3003',
    backends: [{ id: 'claude-code', label: 'Claude Code', version: '2.1.220', state: 'present' }],
    components: [{ id: 'kokoro', label: 'Kokoro TTS', bytes: 340_000_000, state: 'not-installed' }],
    voiceKeys: { gemini: false, openai: true },
  },
  'daemon.account': {
    type: 'daemon.account',
    daemonId: 'host-a',
    backendId: 'claude-code',
    connected: true,
    accountEmail: 'tom@anthropic.com',
  },
  'host.rename': { type: 'host.rename', daemonId: 'host-a', hostName: 'hetzner' },
  'host.set_home': { type: 'host.set_home', daemonId: 'host-a' },
  'host.removed': { type: 'host.removed', daemonId: 'host-a' },
  'host.settings': {
    type: 'host.settings',
    daemonId: 'host-a',
    harnessMcpServers: [],
  },
  'host.component_install': {
    type: 'host.component_install',
    daemonId: 'host-a',
    componentId: 'kokoro',
  },
  'host.component_remove': {
    type: 'host.component_remove',
    daemonId: 'host-a',
    componentId: 'kokoro',
  },
  'host.component_progress': {
    type: 'host.component_progress',
    daemonId: 'host-a',
    componentId: 'kokoro',
    state: 'downloading',
    receivedBytes: 1024,
    totalBytes: 340_000_000,
  },
  'host.update': { type: 'host.update', daemonId: 'host-a' },
  'host.folder_add': { type: 'host.folder_add', daemonId: 'host-a', path: '/work/new' },
  'host.folder_remove': { type: 'host.folder_remove', daemonId: 'host-a', path: '/work/old' },
  'host.claude_memory_delete': {
    type: 'host.claude_memory_delete',
    daemonId: 'host-a',
    project: '/work/proj',
    file: 'notes.md',
  },
  'host.claude_memory_set': {
    type: 'host.claude_memory_set',
    daemonId: 'host-a',
    project: '-work-proj',
    file: 'notes.md',
    body: 'Remember this.\n',
  },
  'host.backend_add_account': {
    type: 'host.backend_add_account',
    daemonId: 'host-a',
    backendId: 'codex',
    authMethod: 'device',
    requestId: 'signin-1',
    label: 'Work',
  },
  // spec/10 § Usage — read every account's limits from Anthropic now.
  'host.backend_usage_refresh': {
    type: 'host.backend_usage_refresh',
    daemonId: 'host-a',
    backendId: 'claude-code',
  },
  // spec/03 § Settings
  'settings.snapshot': {
    type: 'settings.snapshot',
    daemonId: 'host-a',
    version: 3,
    settings: DEFAULT_SHARED_SETTINGS,
    secrets: {
      claude: [
        {
          id: 'a1',
          label: 'Work',
          credential: { accessToken: 'sk-ant-oat01-x', organizationId: 'org-1' },
        },
      ],
      codex: [{ id: 'c1', label: 'ChatGPT', kind: 'chatgpt', authJson: null }],
      providerKeys: { groq: 'gsk_example_not_real_000' },
    },
  },
  'settings.applied': { type: 'settings.applied', daemonId: 'host-a', version: 3 },
  'settings.changed': {
    type: 'settings.changed',
    version: 3,
    settings: DEFAULT_SHARED_SETTINGS,
    secrets: {
      claude: [{ id: 'a1', label: 'Work', connected: true, organizationId: 'org-1' }],
      codex: [],
      providerKeys: [{ id: 'groq', set: true, last4: '0000' }],
    },
    hosts: [{ daemonId: 'host-a', appliedVersion: 3 }],
  },
  'notifications.changed': { type: 'notifications.changed', unread: 2 },
  'settings.secret_update': {
    type: 'settings.secret_update',
    daemonId: 'host-a',
    update: { backendId: 'codex', accountId: 'c1', authJson: '{"tokens":{}}' },
  },
  'settings.adopt.request': {
    type: 'settings.adopt.request',
    requestId: 'ad1',
    daemonId: 'host-a',
    kind: 'provider-key',
    id: 'groq',
  },
  'settings.adopt.response': {
    type: 'settings.adopt.response',
    requestId: 'ad1',
    daemonId: 'host-a',
    ok: true,
    result: { kind: 'provider-key', id: 'groq', value: 'gsk_example_not_real_000' },
  },
  'settings.account_signed_in': {
    type: 'settings.account_signed_in',
    daemonId: 'host-a',
    requestId: 'signin-1',
    account: { id: 'c2', label: 'me@example.com', kind: 'chatgpt', authJson: '{"tokens":{}}' },
  },
  'host.claude_settings_discard': { type: 'host.claude_settings_discard', daemonId: 'host-a' },
  'device.session': { type: 'device.session', deviceId: 'dev-1', name: 'kitchen', active: true },
  'folders.list': {
    type: 'folders.list',
    daemonId: 'host-a',
    roots: ['/work/proj'],
    recent: ['/home/tom/notes'],
  },
  'folders.updated': {
    type: 'folders.updated',
    daemonId: 'host-a',
    roots: ['/work/proj'],
    recent: [],
  },
  'claude_settings.list': {
    type: 'claude_settings.list',
    daemonId: 'host-a',
    drift: '{"model":"opus"}',
    memories: [],
  },
  'claude_settings.updated': {
    type: 'claude_settings.updated',
    daemonId: 'host-a',
    memories: [],
  },
  'new_chat_draft.set': {
    type: 'new_chat_draft.set',
    draft: { id: 'draft-1', folder: '/p', text: 'hi' },
  },
  'new_chat_draft.remove': { type: 'new_chat_draft.remove', id: 'draft-1' },
  'new_chat_draft.updated': {
    type: 'new_chat_draft.updated',
    draft: { id: 'draft-1', folder: '/p', text: 'hi' },
    updatedAt: 1,
  },
  'new_chat_draft.removed': { type: 'new_chat_draft.removed', id: 'draft-1', updatedAt: 1 },
  'new_chat_draft.list': {
    type: 'new_chat_draft.list',
    drafts: [{ id: 'draft-1', folder: '/p', text: 'hi', updatedAt: 1 }],
  },
  'composer_draft.set': { type: 'composer_draft.set', chatId: 'c1', text: 'not sent yet' },
  'composer_draft.clear': { type: 'composer_draft.clear', chatId: 'c1' },
  'composer_draft.updated': {
    type: 'composer_draft.updated',
    chatId: 'c1',
    text: 'not sent yet',
    updatedAt: 1_700_000_000_000,
  },
  'composer_draft.cleared': {
    type: 'composer_draft.cleared',
    chatId: 'c1',
    updatedAt: 1_700_000_000_000,
  },
  'composer_draft.list': {
    type: 'composer_draft.list',
    drafts: [{ chatId: 'c1', text: 'not sent yet', updatedAt: 1_700_000_000_000 }],
  },
  'chat.input': { type: 'chat.input', chatId: 'c1', message: 'hi', localId: 'lid-1' },
  'chat.settings': { type: 'chat.settings', chatId: 'c1', permissionMode: 'plan' },
  'chat.permission_response': {
    type: 'chat.permission_response',
    requestId: 'req-1',
    approve: true,
  },
  'chat.spawn_request': {
    type: 'chat.spawn_request',
    daemonId: 'host-a',
    folder: '/work/x',
    prompt: 'go',
  },
  'chat.stop_request': { type: 'chat.stop_request', chatId: 'c1' },
  'chat.resume_request': { type: 'chat.resume_request', chatId: 'c1' },
  'chat.focus_change': { type: 'chat.focus_change', chatId: 'c1' },
  'chat.pin_request': { type: 'chat.pin_request', chatId: 'c1', pinned: true },
  'meeting.control_request': { type: 'meeting.control_request', chatId: 'c1', action: 'start' },
  'meeting.get_request': { type: 'meeting.get_request', chatId: 'c1' },
  'meeting.audio': { type: 'meeting.audio', chatId: 'c1', source: 'mic', audioBase64: 'AA==' },
  'meeting.action_request': {
    type: 'meeting.action_request',
    chatId: 'c1',
    actionId: 'a1',
    decision: 'do',
  },
  'meeting.state': { type: 'meeting.state', chatId: 'c1', meeting: null },
  'chat.archive_request': { type: 'chat.archive_request', chatId: 'c1', archived: true },
  'chat.hide_request': { type: 'chat.hide_request', chatId: 'c1', hidden: true },
  'chat.disable_request': { type: 'chat.disable_request', chatId: 'c1', disabled: true },
  'chat.rotate_request': { type: 'chat.rotate_request', chatId: 'c1' },
  'manager.sweep_run': {
    type: 'manager.sweep_run',
    runId: 'run-1',
    candidates: [
      {
        chatId: 'c1',
        daemonId: 'd1',
        folder: '/home/tom/project',
        edge: 'stalled',
        idleMinutes: 120,
      },
    ],
    messagesPerChat: 20,
    prompt: 'Decide whether to nudge, wake, flag or leave each candidate.',
    model: 'claude-opus-4',
  },
  'manager.sweep_result': {
    type: 'manager.sweep_result',
    runId: 'run-1',
    actions: [{ chatId: 'c1', action: 'nudge' }],
    tokensUsed: 1200,
  },
  'chat.snooze_request': {
    type: 'chat.snooze_request',
    chatId: 'c1',
    snoozedUntil: 1_700_000_060_000,
  },
  'chat.delete_request': { type: 'chat.delete_request', chatId: 'c1', deleted: true },
  'chat.goal_request': { type: 'chat.goal_request', chatId: 'c1', goal: 'Ship it' },
  'chat.todos_request': {
    type: 'chat.todos_request',
    chatId: 'c1',
    todos: [
      { text: 'rebuild the index', status: 'in_progress' },
      { text: 'ship it', status: 'pending' },
    ],
  },
  'chat.rename_request': { type: 'chat.rename_request', chatId: 'c1', name: 'Bed Planner Rework' },
  'chat.reminder_request': {
    type: 'chat.reminder_request',
    chatId: 'c1',
    reminder: 'water plants',
  },
  'chat.loop_request': {
    type: 'chat.loop_request',
    chatId: 'c1',
    loop: { message: 'check on the build', every: '5m' },
  },
  'chat.model_request': {
    type: 'chat.model_request',
    chatId: 'c1',
    model: 'claude-opus-4-1',
  },
  'file.write': { type: 'file.write', chatId: 'c1', path: 'foo.txt', content: 'x' },
  'patch.file_changed': { type: 'patch.file_changed', chatId: 'c1', path: 'foo.txt' },
  'surface.heartbeat': { type: 'surface.heartbeat' },
  'surface.heartbeat_ack': { type: 'surface.heartbeat_ack' },
  'surface.foregrounded': { type: 'surface.foregrounded' },
  'surface.input': { type: 'surface.input', idleMs: 4200, scope: 'system' },
  'surface.backgrounded': { type: 'surface.backgrounded' },
  'patch.peek.request': {
    type: 'patch.peek.request',
    sourceChatId: 'c1',
    targetChatId: 'c2',
    requestId: 'req-1',
    limit: 50,
  },
  'patch.peek.response': {
    type: 'patch.peek.response',
    requestId: 'req-1',
    sourceChatId: 'c1',
    targetChatId: 'c2',
    ok: true,
    result: { chat_state: { chatId: 'c2', activity: 'idle' }, events: [], truncated: false },
  },
  'patch.send_to': {
    type: 'patch.send_to',
    sourceChatId: 'c1',
    targetChatId: 'c2',
    message: 'do thing',
    requestId: 'req-1',
  },
  'patch.send_to.response': {
    type: 'patch.send_to.response',
    requestId: 'req-1',
    sourceChatId: 'c1',
    targetChatId: 'c2',
    ok: true,
  },
  'patch.spawn': {
    type: 'patch.spawn',
    daemonId: 'host-a',
    sourceChatId: 'c1',
    folder: '/work/x',
    prompt: 'go',
  },
  'patch.spawn.response': {
    type: 'patch.spawn.response',
    requestId: 'req-1',
    sourceChatId: 'c1',
    daemonId: 'host-b',
    folder: '/work/x',
    ok: true,
    chatId: 'c2',
  },
  'patch.history.request': {
    type: 'patch.history.request',
    sourceChatId: 'c1',
    targetChatId: 'c2',
    fromSeq: 0,
    limit: 50,
    requestId: 'req-1',
  },
  'patch.history.response': {
    type: 'patch.history.response',
    requestId: 'req-1',
    sourceChatId: 'c1',
    targetChatId: 'c2',
    ok: true,
    result: { events: [], nextFromSeq: 12 },
  },
  'patch.list_chats.request': {
    type: 'patch.list_chats.request',
    sourceChatId: 'c1',
    archived: 'include',
  },
  'patch.list_chats.response': {
    type: 'patch.list_chats.response',
    chats: [{ chatId: 'c1', daemonId: 'host-a' }],
    sourceChatId: 'c1',
    chatCount: 3,
  },
  'patch.activity.request': {
    type: 'patch.activity.request',
    sourceChatId: 'c1',
    since: 1_000,
    until: 5_000,
  },
  'patch.activity.response': {
    type: 'patch.activity.response',
    sourceChatId: 'c1',
    messages: [
      {
        chatId: 'c2',
        chatName: 'bus watch',
        daemonId: 'host-a',
        folder: '/home/tom/bus',
        text: 'is it late',
        ts: 2_000,
      },
    ],
    messagesTruncated: false,
  },
  'patch.activity.read.request': {
    type: 'patch.activity.read.request',
    requestId: 'r1',
    since: 1_000,
    until: 5_000,
    limit: 200,
  },
  'patch.activity.read.response': {
    type: 'patch.activity.read.response',
    requestId: 'r1',
    messages: [{ chatId: 'c2', text: 'is it late', ts: 2_000 }],
  },
  'patch.stop': { type: 'patch.stop', sourceChatId: 'c1', targetChatId: 'c2' },
  'patch.job_create': {
    type: 'patch.job_create',
    sourceChatId: 'c1',
    jobId: 'j1',
    name: 'morning bus',
  },
  'patch.job_update': { type: 'patch.job_update', sourceChatId: 'c1', jobId: 'j1' },
  'patch.job_delete': { type: 'patch.job_delete', sourceChatId: 'c1', jobId: 'j1' },
  'patch.job_toggle': {
    type: 'patch.job_toggle',
    sourceChatId: 'c1',
    jobId: 'j1',
    enabled: false,
  },
  'patch.jobs.request': {
    type: 'patch.jobs.request',
    requestId: 'r1',
    op: 'list',
  },
  'patch.jobs.response': {
    type: 'patch.jobs.response',
    requestId: 'r1',
    ok: true,
  },
  'patch.background_task_stats.request': {
    type: 'patch.background_task_stats.request',
    requestId: 'bts1',
    chatId: 'c1',
    taskIds: ['baiw888mq'],
  },
  'patch.background_task_stats.response': {
    type: 'patch.background_task_stats.response',
    requestId: 'bts1',
    ok: true,
    stats: [{ taskId: 'baiw888mq', cpuPercent: 98.4, rssBytes: 412_000_000, processes: 3 }],
  },
  'patch.watch_list.request': {
    type: 'patch.watch_list.request',
    requestId: 'wl1',
    chatId: 'c1',
  },
  'patch.watch_list.response': {
    type: 'patch.watch_list.response',
    requestId: 'wl1',
    ok: true,
    tasks: [
      {
        taskId: 't1',
        description: 'run the test suite',
        command: 'pnpm test',
        outputFile: '/tmp/c1/watch/t1.output',
        status: 'running',
        startedAt: 1_700_000_000_000,
      },
    ],
  },
  'patch.watch_stop.request': {
    type: 'patch.watch_stop.request',
    requestId: 'ws1',
    chatId: 'c1',
    taskId: 't1',
  },
  'patch.watch_stop.response': {
    type: 'patch.watch_stop.response',
    requestId: 'ws1',
    ok: true,
    stopped: true,
  },
  'patch.files.request': {
    type: 'patch.files.request',
    requestId: 'fr1',
    chatId: 'c1',
    path: 'src',
  },
  'patch.files.response': {
    type: 'patch.files.response',
    requestId: 'fr1',
    ok: true,
    path: 'src',
    entries: [
      { name: 'foo.ts', type: 'file', size: 12 },
      { name: 'lib', type: 'dir' },
    ],
  },
  'patch.file_op.request': {
    type: 'patch.file_op.request',
    requestId: 'fo1',
    chatId: 'c1',
    op: 'rename',
    path: 'src/old.ts',
    to: 'src/new.ts',
  },
  'patch.file_op.response': {
    type: 'patch.file_op.response',
    requestId: 'fo1',
    ok: false,
    error: { code: 'exists', message: 'already exists: src/new.ts' },
  },
  'patch.doc.request': {
    type: 'patch.doc.request',
    requestId: 'doc1',
    chatId: 'c1',
    path: 'notes.md',
  },
  'patch.doc.response': {
    type: 'patch.doc.response',
    requestId: 'doc1',
    ok: true,
    view: {
      mode: 'propose',
      suggestions: [{ id: 's1', find: 'foo', replace: 'bar', status: 'pending', createdAt: 1 }],
      threads: [
        {
          id: 't1',
          anchor: 'foo',
          resolved: false,
          comments: [{ id: 'c1', author: 'user', text: 'why?', createdAt: 1 }],
        },
      ],
      versions: [{ id: 'v1', content: 'foo bar', savedBy: 'user', createdAt: 1 }],
    },
  },
  'patch.doc_action.request': {
    type: 'patch.doc_action.request',
    requestId: 'da1',
    chatId: 'c1',
    path: 'notes.md',
    action: { op: 'accept_suggestion', id: 's1' },
  },
  'patch.doc_action.response': {
    type: 'patch.doc_action.response',
    requestId: 'da1',
    ok: false,
    error: { code: 'conflict', message: 'suggestion already resolved' },
  },
  'patch.doc_convert.request': {
    type: 'patch.doc_convert.request',
    requestId: 'dc1',
    chatId: 'c1',
    path: 'report.docx',
  },
  'patch.doc_convert.response': {
    type: 'patch.doc_convert.response',
    requestId: 'dc1',
    ok: true,
    mdPath: 'report.md',
    warnings: ['dropped an embedded chart'],
    reused: false,
  },
  'patch.doc_export.request': {
    type: 'patch.doc_export.request',
    requestId: 'de1',
    chatId: 'c1',
    path: 'notes.md',
    format: 'pdf',
  },
  'patch.doc_export.response': {
    type: 'patch.doc_export.response',
    requestId: 'de1',
    ok: true,
    path: 'notes.pdf',
    mimeType: 'application/pdf',
    dataBase64: 'YmFzZTY0',
    warnings: [],
  },
  'server.queue_mode': { type: 'server.queue_mode', enabled: true },
  'patch.queue_pull.request': {
    type: 'patch.queue_pull.request',
    requestId: 'qp1',
    chatId: 'c1',
  },
  'patch.queue_pull.response': {
    type: 'patch.queue_pull.response',
    requestId: 'qp1',
    items: [{ type: 'chat.input', chatId: 'c1', message: 'while you work', localId: 'L1' }],
  },
  'patch.log_sync.request': { type: 'patch.log_sync.request', chatId: 'c1', afterSeq: 12 },
  'patch.log_sync.batch': {
    type: 'patch.log_sync.batch',
    chatId: 'c1',
    events: [{ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 13 }],
    done: true,
  },
  'patch.log_restore': {
    type: 'patch.log_restore',
    chatId: 'c1',
    events: [{ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 13 }],
    done: false,
  },
  'chat.committed': { type: 'chat.committed', chatId: 'c1', through: 41 },
  'host.manager_adopt': {
    type: 'host.manager_adopt',
    daemonId: 'd1',
    epoch: 2,
    handoff: 'user: hello',
    nextSeq: 7,
  },
  'host.manager_release': { type: 'host.manager_release', daemonId: 'd1', epoch: 3 },
  'patch.chat_history.request': {
    type: 'patch.chat_history.request',
    requestId: 'ch1',
    chatId: 'c1',
    since: 3,
  },
  'patch.chat_history.response': {
    type: 'patch.chat_history.response',
    requestId: 'ch1',
    ok: true,
    events: [{ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 3 }],
  },
  'patch.skills.request': {
    type: 'patch.skills.request',
    requestId: 'sk1',
    folder: '/Users/tom/projects/portfolio',
    daemonId: 'd1',
  },
  'patch.skills.response': {
    type: 'patch.skills.response',
    requestId: 'sk1',
    ok: true,
    skills: ['forage', 'plant'],
    paths: {
      forage: '/Users/tom/projects/portfolio/.claude/skills/forage/SKILL.md',
      plant: '/Users/tom/.claude/skills/plant.md',
    },
    descriptions: {
      forage: 'Find wild food nearby.',
    },
    frontmatter: {
      forage: { name: 'forage', description: 'Find wild food nearby.', 'user-invocable': 'true' },
    },
  },
  'patch.models.request': {
    type: 'patch.models.request',
    requestId: 'md1',
    daemonId: 'host-a',
  },
  'patch.models.response': {
    type: 'patch.models.response',
    requestId: 'md1',
    daemonId: 'host-a',
    models: [{ id: 'claude-opus-5', label: 'Claude Opus 5', backend: 'claude-code' }],
    errors: [],
    fetchedAt: '2026-08-03T09:00:00.000Z',
  },
  'patch.recurrence.translate.request': {
    type: 'patch.recurrence.translate.request',
    requestId: 'rt1',
    daemonId: 'host-a',
    phrase: 'every 3rd Sunday between May and August',
  },
  'patch.recurrence.translate.response': {
    type: 'patch.recurrence.translate.response',
    requestId: 'rt1',
    daemonId: 'host-a',
    ok: true,
    rrule: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
  },
  'patch.folders.browse.request': {
    type: 'patch.folders.browse.request',
    requestId: 'fb1',
    daemonId: 'host-a',
    dir: '/Users/tom/projects',
  },
  'patch.folders.browse.response': {
    type: 'patch.folders.browse.response',
    requestId: 'fb1',
    daemonId: 'host-a',
    ok: true,
    dir: '/Users/tom/projects',
    parent: null,
    entries: [{ name: 'portfolio', path: '/Users/tom/projects/portfolio' }],
  },
  'patch.terminal.open': {
    type: 'patch.terminal.open',
    daemonId: 'host-a',
    sessionId: 'term-1',
    folder: '/Users/tom/projects',
  },
  'patch.terminal.input': {
    type: 'patch.terminal.input',
    sessionId: 'term-1',
    data: 'git clone git@github.com:tom/thing.git\n',
  },
  'patch.terminal.signal': {
    type: 'patch.terminal.signal',
    sessionId: 'term-1',
    signal: 'SIGINT',
  },
  'patch.terminal.close': { type: 'patch.terminal.close', sessionId: 'term-1' },
  'patch.terminal.resize': {
    type: 'patch.terminal.resize',
    sessionId: 'term-1',
    cols: 48,
    rows: 20,
  },
  'patch.host_files.request': {
    type: 'patch.host_files.request',
    requestId: 'hf1',
    daemonId: 'host-a',
    op: 'write',
    path: '/Users/tom/.claude/skills/plant/SKILL.md',
    content: '# plant\n',
    baseVersion: 'abc123',
  },
  'patch.host_files.response': {
    type: 'patch.host_files.response',
    requestId: 'hf1',
    daemonId: 'host-a',
    ok: true,
    path: '/Users/tom/.claude/skills',
    parent: '/Users/tom/.claude',
    entries: [{ name: 'plant', type: 'dir' }],
  },
  'patch.blob.request': {
    type: 'patch.blob.request',
    requestId: 'b1',
    daemonId: 'host-a',
    chatId: 'c1',
    sha: 'a'.repeat(64),
  },
  'patch.blob.response': {
    type: 'patch.blob.response',
    requestId: 'b1',
    daemonId: 'host-a',
    ok: true,
    mime: 'image/png',
    data: 'iVBORw0KGgo=',
  },
  'chat.replay_batch': {
    type: 'chat.replay_batch',
    chatId: 'c1',
    events: [
      { type: 'chat.message', chatId: 'c1', seq: 0, role: 'user', content: 'hi' },
      { type: 'chat.message', chatId: 'c1', seq: 1, role: 'assistant', content: 'hello' },
    ],
    done: true,
  },
  'patch.chat_move.request': {
    type: 'patch.chat_move.request',
    requestId: 'cm1',
    daemonId: 'host-b',
    chatId: 'c1',
    op: 'import',
    folder: '/home/tom/Unite',
    bundle: {
      chatId: 'c1',
      sourceFolder: '/Users/tom/Unite',
      files: [{ path: 'chat/meta.json', data: 'e30=' }],
      attachments: {},
    },
  },
  'patch.chat_move.response': {
    type: 'patch.chat_move.response',
    requestId: 'cm1',
    daemonId: 'host-b',
    chatId: 'c1',
    op: 'import',
    ok: false,
    error: { code: 'folder_not_found', message: '/home/tom/Unite is not a directory' },
  },
  'patch.chat_search.request': {
    type: 'patch.chat_search.request',
    requestId: 'cs1',
    daemonId: 'host-a',
    query: 'boiler',
    limit: 20,
  },
  'patch.chat_search.response': {
    type: 'patch.chat_search.response',
    requestId: 'cs1',
    daemonId: 'host-a',
    ok: true,
    hits: [
      {
        chatId: 'c1',
        daemonId: 'host-a',
        name: 'Boiler',
        preview: null,
        folder: '/Users/tom',
        status: 'archived',
        section: 'archived',
        pinned: false,
        snoozedUntil: null,
        lastUpdated: 1,
        jobId: null,
        nameMatch: true,
        nameHighlights: [[0, 6]],
        messageMatches: 0,
        snippet: null,
      },
    ],
    total: 1,
    searchedChats: 3,
    transcriptsMissing: 0,
  },
  'patch.terminal.ready': {
    type: 'patch.terminal.ready',
    sessionId: 'term-1',
    cwd: '/Users/tom/projects',
  },
  'patch.terminal.output': {
    type: 'patch.terminal.output',
    sessionId: 'term-1',
    stream: 'stdout',
    data: "Cloning into 'thing'...\n",
  },
  'patch.terminal.command-exit': {
    type: 'patch.terminal.command-exit',
    sessionId: 'term-1',
    code: 1,
  },
  'patch.terminal.exit': {
    type: 'patch.terminal.exit',
    sessionId: 'term-1',
    code: 0,
    reason: 'shell_exit',
  },
  'patch.terminal.error': {
    type: 'patch.terminal.error',
    sessionId: 'term-1',
    code: 'folder_not_found',
    message: 'folder does not exist on the host: /nope',
  },
  'patch.browser_tunnel.open': {
    type: 'patch.browser_tunnel.open',
    streamId: 'stream-1',
    daemonId: 'd1',
    host: 'example.com',
    port: 443,
  },
  'patch.browser_tunnel.ready': {
    type: 'patch.browser_tunnel.ready',
    streamId: 'stream-1',
  },
  'patch.browser_tunnel.data': {
    type: 'patch.browser_tunnel.data',
    streamId: 'stream-1',
    data: 'aGVsbG8=',
  },
  'patch.browser_tunnel.close': {
    type: 'patch.browser_tunnel.close',
    streamId: 'stream-1',
  },
  'patch.browser_tunnel.error': {
    type: 'patch.browser_tunnel.error',
    streamId: 'stream-1',
    code: 'host_offline',
    message: 'routing host d2 is offline',
  },
  'patch.audio_relay.open': {
    type: 'patch.audio_relay.open',
    sessionId: 'sess-1',
  },
  'patch.audio_relay.ready': {
    type: 'patch.audio_relay.ready',
    sessionId: 'sess-1',
  },
  'patch.audio_relay.frame': {
    type: 'patch.audio_relay.frame',
    sessionId: 'sess-1',
    data: 'aGVsbG8=',
    binary: false,
  },
  'patch.audio_relay.close': {
    type: 'patch.audio_relay.close',
    sessionId: 'sess-1',
  },
  'patch.audio_relay.error': {
    type: 'patch.audio_relay.error',
    sessionId: 'sess-1',
    code: 'connect_failed',
    message: 'voice is not installed on this host',
  },
  'job.exec_request': {
    type: 'job.exec_request',
    daemonId: 'd1',
    jobId: 'j_1',
    fireId: 'f_1',
    folder: '/home/tom/projects/portfolio',
    command: 'bin/tick.sh',
    timeoutMs: 60_000,
  },
  'job.exec_result': {
    type: 'job.exec_result',
    jobId: 'j_1',
    fireId: 'f_1',
    ok: true,
    exitCode: 0,
    durationMs: 812,
    stdout: '2 new photos\n',
    stderr: '',
  },
  'hook.check_request': {
    type: 'hook.check_request',
    daemonId: 'd1',
    requestId: 'req_1',
    hookId: 'hook_1',
    kind: 'script',
    script: { command: 'exit 0' },
    timeoutMs: 15_000,
    context: {
      message: 'hello',
      chatId: 'c1',
      folder: '/home/tom/projects/portfolio',
      daemonId: 'd1',
      specialThread: false,
    },
  },
  'hook.check_result': {
    type: 'hook.check_result',
    requestId: 'req_1',
    hookId: 'hook_1',
    status: 'ok',
    decision: 'pass',
    durationMs: 12,
  },
  'hook.agent_response_check_request': {
    type: 'hook.agent_response_check_request',
    daemonId: 'd1',
    chatId: 'c1',
    checkId: 'arc_1',
    folder: '/home/tom/projects/portfolio',
    specialThread: false,
    reply: 'Done — the boiler service is booked for Thursday.',
    toolCallsSummary: 'Ran 2 commands, read 1 file',
  },
  'hook.agent_response_outcome': {
    type: 'hook.agent_response_outcome',
    daemonId: 'd1',
    chatId: 'c1',
    checkId: 'arc_1',
    results: [
      {
        hookId: 'hook_1',
        hookName: 'no secrets in replies',
        status: 'ok',
        decision: 'pass',
        durationMs: 10,
      },
    ],
  },
  'patch.voice_note.transcribe_request': {
    type: 'patch.voice_note.transcribe_request',
    requestId: 'vn1',
    surfaceKind: 'mobile',
    format: 'm4a',
    audioBase64: 'AAECAwQ=',
  },
  'patch.voice_note.transcribe_response': {
    type: 'patch.voice_note.transcribe_response',
    requestId: 'vn1',
    ok: true,
    transcript: 'buy oat milk',
  },
  'patch.attachment.store_request': {
    type: 'patch.attachment.store_request',
    requestId: 'at1',
    chatId: 'chat_1',
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'screenshot.png',
    mimeType: 'image/png',
    kind: 'image',
    dataBase64: 'AAECAwQ=',
  },
  'patch.attachment.store_response': {
    type: 'patch.attachment.store_response',
    requestId: 'at1',
    ok: true,
    path: '/home/tom/proj/.patch/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAV-screenshot.png',
  },
  'patch.artifact.publish_request': {
    type: 'patch.artifact.publish_request',
    requestId: 'ar1',
    chatId: 'c1',
    artifactId: 'd41d8cd98f00b204e9800998ecf8427e',
    title: 'Bristol bus times',
    path: 'out/buses.html',
    html: '<!doctype html><html><body><h1>buses</h1></body></html>',
  },
  'patch.artifact.publish_response': {
    type: 'patch.artifact.publish_response',
    requestId: 'ar1',
    ok: true,
    url: '/api/chats/c1/artifact/d41d8cd98f00b204e9800998ecf8427e',
  },
  'patch.pad.request': {
    type: 'patch.pad.request',
    requestId: 'r1',
    op: 'create',
    chatId: 'c1',
    name: 'Care screens',
    app: 'Dog Log',
    device: 'phone',
    files: [{ path: 'index.html', base64: 'PGgxPmhpPC9oMT4=' }],
  },
  'patch.pad.response': {
    type: 'patch.pad.response',
    requestId: 'r1',
    ok: true,
    result: { id: 'care-screens' },
  },
  'secrets.list': {
    type: 'secrets.list',
    secrets: [
      { key: 'OPENAI_API_KEY', value: 'sk-123' },
      { key: 'TODOIST_TOKEN', value: 'td-456' },
    ],
  },
  'secrets.updated': {
    type: 'secrets.updated',
    secrets: [{ key: 'OPENAI_API_KEY', value: 'sk-789' }],
  },
  'patch.secrets.set_request': {
    type: 'patch.secrets.set_request',
    requestId: 'se1',
    key: 'OPENAI_API_KEY',
    value: 'sk-123',
  },
  'patch.secrets.delete_request': {
    type: 'patch.secrets.delete_request',
    requestId: 'se2',
    key: 'OPENAI_API_KEY',
  },
  'patch.secrets.response': {
    type: 'patch.secrets.response',
    requestId: 'se1',
    ok: false,
    error: { code: 'invalid_key', message: 'invalid key' },
  },
  notify: {
    type: 'notify',
    chatId: 'c1',
    channel: 'push',
    message: 'done',
    priority: 'urgent',
    kind: 'call',
    callId: 'call-1',
    deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
    actions: {
      kind: 'question',
      requestId: 'r1',
      questionText: 'Auth method?',
      options: ['OAuth', 'JWT'],
    },
  },
  'patch.call': {
    type: 'patch.call',
    chatId: 'c1',
    message: 'urgent: prod is down, picking up?',
  },
  'chat.call_request': {
    type: 'chat.call_request',
    callId: 'call-1',
    chatId: 'c1',
    message: 'urgent: prod is down, picking up?',
  },
  'chat.speak': {
    type: 'chat.speak',
    callId: 'call-1',
    chatId: 'c1',
    message: 'the bus chat is blocked on a permission',
  },
  'chat.call_response': {
    type: 'chat.call_response',
    callId: 'call-1',
    response: 'accept',
  },
  'chat.call_winner': {
    type: 'chat.call_winner',
    callId: 'call-1',
    acceptedSurfaceId: 'srf-phone',
  },
  'chat.call_timeout': {
    type: 'chat.call_timeout',
    callId: 'call-1',
  },
  'patch.diag.inject_permission': {
    type: 'patch.diag.inject_permission',
    chatId: 'thread_manager',
    tool: 'Bash',
    description: 'Run a command — approve?',
  },
  'patch.diag.voice_inject': {
    type: 'patch.diag.voice_inject',
    surfaceId: 'web-dev-1',
    text: 'yes',
  },
  hello: {
    type: 'hello',
    clientType: 'surface-web',
    clientVersion: '1.2.3',
    auth: 'jwt-token',
  },
  ack: { type: 'ack', chatId: 'c1', seq: 42 },
  'chat.replay': { type: 'chat.replay', chatId: 'c1', fromSeq: 10 },
  'pairing.nonce': {
    type: 'pairing.nonce',
    nonce: 'abc',
    surfacePublicKey: 'pk',
    expiresAt: 1700001000,
  },
  'pairing.signed_credential': {
    type: 'pairing.signed_credential',
    nonce: 'abc',
    surfacePublicKey: 'pk',
    credential: 'jwt',
  },
  'auth.revoked': { type: 'auth.revoked', reason: 'user-action' },
  'auth.expired': { type: 'auth.expired', reason: 'credential expired' },
  'auth.ok': {
    type: 'auth.ok',
    accountId: 'acct-1',
    surfaceId: 'srf-1',
    hosts: [
      {
        daemonId: 'host-a',
        online: true,
        lastSeenAt: 1_700_000_000_000,
        host: null,
        accounts: [],
      },
    ],
  },
};

describe('codec', () => {
  test('FIXTURES covers every event in EVENT_SCHEMAS', () => {
    const fixtureKeys = new Set(Object.keys(FIXTURES));
    const schemaKeys = new Set(Object.keys(EVENT_SCHEMAS));
    expect(fixtureKeys).toEqual(schemaKeys);
  });

  for (const [eventType, fixture] of Object.entries(FIXTURES)) {
    test(`round-trip: ${eventType}`, () => {
      const encoded = encode(fixture as WireEvent);
      expect(typeof encoded).toBe('string');
      const decoded = decode(encoded);
      expect(decoded).toEqual(fixture);
    });
  }

  test('decode throws WireDecodeError on invalid JSON', () => {
    try {
      decode('not json {');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WireDecodeError);
      expect((err as WireDecodeError).message).toMatch(/invalid JSON/);
    }
  });

  test('decode throws WireDecodeError on unknown event type', () => {
    expect(() => decode(JSON.stringify({ type: 'totally.made.up', chatId: 'c' }))).toThrow(
      WireDecodeError,
    );
  });

  test('decode throws on chat.message missing seq', () => {
    const bad = { type: 'chat.message', chatId: 'c1', role: 'user', content: 'x' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on chat.input missing localId', () => {
    const bad = { type: 'chat.input', chatId: 'c1', message: 'hi' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('chat.input carries disabledTools (per-chat tool gating) round-trip', () => {
    const evt = {
      type: 'chat.input' as const,
      chatId: 'c1',
      message: 'hi',
      localId: 'lid-1',
      disabledTools: ['Bash', 'mcp__patch__patch_spawn'],
    };
    const decoded = decode(encode(evt as WireEvent));
    expect(decoded).toEqual(evt);
  });

  test('decode rejects chat.input disabledTools that is not a string[]', () => {
    const bad = {
      type: 'chat.input',
      chatId: 'c1',
      message: 'hi',
      localId: 'lid-1',
      disabledTools: 'Bash',
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects chat.edit_queued_request without a localId or message', () => {
    expect(() =>
      decode(JSON.stringify({ type: 'chat.edit_queued_request', chatId: 'c1', message: 'x' })),
    ).toThrow(WireDecodeError);
    expect(() =>
      decode(JSON.stringify({ type: 'chat.edit_queued_request', chatId: 'c1', localId: 'L2' })),
    ).toThrow(WireDecodeError);
  });

  test('decode throws on chat.tool_call missing seq', () => {
    const bad = {
      type: 'chat.tool_call',
      chatId: 'c1',
      tool: 'Bash',
      args: {},
      callId: 'tc',
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on chat.replay missing fromSeq', () => {
    const bad = { type: 'chat.replay', chatId: 'c1' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on hello missing clientType', () => {
    const bad = { type: 'hello', clientVersion: '1.0.0' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on notify with bad channel', () => {
    const bad = { type: 'notify', chatId: 'c1', channel: 'sms', message: 'x' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on negative seq', () => {
    const bad = { type: 'chat.message', chatId: 'c1', role: 'user', content: 'x', seq: -1 };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects unknown extra keys (strict schemas)', () => {
    const bad = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'x',
      seq: 0,
      somethingElse: 'sneaky',
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects unknown extra keys on nested objects (strict schemas)', () => {
    const bad = {
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r',
      request: { tool: 't', args: {}, sneaky: true },
      seq: 0,
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('chat.error round-trips with OUT_OF_BAND_SEQ (-1) — spawn-time error', () => {
    // Regression: the host emits a spawn-time `chat.error` (folder_not_found)
    // with seq=OUT_OF_BAND_SEQ when no chat context exists. The schema used to
    // require nonnegative seq, so the server dropped the frame on decode and the
    // error never reached the surface (silent failure). The codec must now
    // round-trip it intact.
    expect(OUT_OF_BAND_SEQ).toBe(-1);
    const ev: WireEvent = {
      type: 'chat.error',
      chatId: 'pending-spawn',
      error: { code: 'folder_not_found', message: 'folder does not exist: /tmp/nope' },
      seq: OUT_OF_BAND_SEQ,
    };
    const decoded = decode(encode(ev));
    expect(decoded).toEqual(ev);
  });

  test('only chat.error may carry a negative seq; chat.message still rejects -1', () => {
    // The sentinel is scoped to chat.error. A negative seq on a real stream
    // event remains a hard decode error.
    const badMessage = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'x',
      seq: -1,
    };
    expect(() => decode(JSON.stringify(badMessage))).toThrow(WireDecodeError);
    // And -2 is rejected even on chat.error (only -1 is the sentinel floor).
    const tooNegative = {
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom' },
      seq: -2,
    };
    expect(() => decode(JSON.stringify(tooNegative))).toThrow(WireDecodeError);
  });

  describe('chat.message systemContext (spec/02 § System-reminder disclosure)', () => {
    test('round-trips a user turn carrying one captured reminder', () => {
      const ev: WireEvent = {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'carry on',
        seq: 4,
        systemContext: [
          {
            source: 'patch',
            label: 'Turn interrupted by restart',
            text: 'This turn was already running when the host restarted, so it was cut off partway through.',
          },
        ],
      };
      expect(decode(encode(ev))).toEqual(ev);
    });

    test('round-trips more than one captured reminder, in order', () => {
      const ev: WireEvent = {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'go',
        seq: 5,
        systemContext: [
          { source: 'patch', label: 'Broadcast digest', text: 'Recent broadcasts…' },
          { source: 'patch', label: 'Todo list updated', text: 'The user edited…' },
        ],
      };
      const decoded = decode(encode(ev));
      expect(decoded).toEqual(ev);
      expect((decoded as typeof ev).systemContext?.map((i) => i.label)).toEqual([
        'Broadcast digest',
        'Todo list updated',
      ]);
    });

    test('an older chat.message with no systemContext still decodes fine (additive/optional)', () => {
      const raw = { type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 6 };
      const decoded = decode(JSON.stringify(raw)) as WireEvent & { systemContext?: unknown };
      expect(decoded.systemContext).toBeUndefined();
    });

    test('rejects an empty systemContext array rather than an omitted field', () => {
      const bad = {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'hi',
        seq: 7,
        systemContext: [],
      };
      expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
    });

    test('rejects a systemContext item with an unrecognised source', () => {
      const bad = {
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'hi',
        seq: 8,
        systemContext: [{ source: 'made-up', label: 'x', text: 'y' }],
      };
      expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
    });
  });

  test('chat.replay accepts fromSeq=-1 (fresh surface wants all events incl. seq 0)', () => {
    const ev: WireEvent = { type: 'chat.replay', chatId: 'c1', fromSeq: -1 };
    expect(decode(encode(ev))).toEqual(ev);
    // -2 is still rejected.
    expect(() =>
      decode(JSON.stringify({ type: 'chat.replay', chatId: 'c1', fromSeq: -2 })),
    ).toThrow(WireDecodeError);
  });

  test('WireDecodeError surfaces the zod issue path + message on .message', () => {
    try {
      decode(JSON.stringify({ type: 'chat.input', chatId: 'c1', message: 'hi' }));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WireDecodeError);
      const e = err as WireDecodeError;
      // Contains a zod path reference (localId) — not the raw payload.
      expect(e.message).toMatch(/localId/);
      // .message is bounded: no raw payload bytes leak in.
      expect(e.message).not.toContain('"type":"chat.input"');
    }
  });

  test('WireDecodeError carries a bounded preview of the offending payload (opt-in)', () => {
    try {
      decode('{"type":"nope"}');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WireDecodeError);
      const e = err as WireDecodeError;
      expect(e.preview).toContain('nope');
      // The RAW FRAME is on `.preview`, never on `.message` — only the
      // path + issue + the bounded rejected VALUE go there.
      expect(e.message).not.toContain('{"type":"nope"}');
      // spec/03 § Host events (unhappy paths): a refusal names the offending
      // value. Here the discriminator itself is the offending value.
      expect(e.received).toBe('"nope"');
      expect(e.message).toContain('received: "nope"');
    }
  });

  test('the rejected value is named, bounded, and reachable at a nested path', () => {
    // An empty machine name is one of the enumerated unhappy paths: the refusal
    // must say WHICH field held WHAT, or it is indistinguishable from an edit
    // that silently did not save.
    try {
      decode(JSON.stringify({ type: 'host.rename', daemonId: 'host-a', hostName: '' }));
      expect.fail('expected throw');
    } catch (err) {
      const e = err as WireDecodeError;
      expect(e.message).toContain('hostName');
      expect(e.received).toBe('""');
    }
    // And a long value is truncated rather than pasted whole onto `.message`.
    try {
      decode(JSON.stringify({ type: 'host.rename', daemonId: 'host-a', hostName: 42 }));
      expect.fail('expected throw');
    } catch (err) {
      const e = err as WireDecodeError;
      expect(e.received).toBe('42');
    }
    try {
      decode(
        JSON.stringify({ type: 'host.folder_add', daemonId: 'host-a', path: ['x'.repeat(200)] }),
      );
      expect.fail('expected throw');
    } catch (err) {
      const e = err as WireDecodeError;
      expect(e.received).toBeDefined();
      expect(e.received!.length).toBe(81); // 80 chars + the ellipsis
      expect(e.received!.endsWith('…')).toBe(true);
    }
  });

  test('chat.input round-trips with voice-device source', () => {
    const ev: WireEvent = {
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'lights off',
      localId: 'lid-vd-1',
      source: { kind: 'voice-device', deviceId: 'kitchen' },
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  test('decode rejects chat.input with bad source kind', () => {
    const bad = {
      type: 'chat.input',
      chatId: 'c1',
      message: 'hi',
      localId: 'l',
      source: { kind: 'mystery', deviceId: 'x' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects chat.call_response with invalid response', () => {
    const bad = { type: 'chat.call_response', callId: 'c', response: 'maybe' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects patch.call missing chatId', () => {
    const bad = { type: 'patch.call' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode accepts a Buffer (utf-8)', () => {
    const event: WireEvent = { type: 'surface.heartbeat' };
    const decoded = decode(Buffer.from(encode(event), 'utf8'));
    expect(decoded).toEqual(event);
  });

  // Group 19: approve-with-edits flow.
  test('chat.permission_response round-trips with decision + editedNewString', () => {
    const event: WireEvent = {
      type: 'chat.permission_response',
      requestId: 'req-9',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: 'tweaked content',
    };
    const decoded = decode(encode(event));
    expect(decoded).toEqual(event);
  });

  // spec/14 § Main chat panel — Question prompts: the host's echo of an
  // AskUserQuestion resolution carries what was actually picked, so a
  // surface that did not originate the resolution can still show it.
  test('chat.permission_response round-trips with answers', () => {
    const event: WireEvent = {
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'req-answers',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which library?': 'date-fns' }),
      answers: { 'Which library?': 'date-fns' },
    };
    const decoded = decode(encode(event));
    expect(decoded).toEqual(event);
  });

  test('chat.permission_request round-trips with proposedDiff', () => {
    const event: WireEvent = {
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'req-1',
      request: {
        tool: 'Edit',
        args: { file_path: '/x.ts' },
        description: 'edit',
        proposedDiff: '--- a/x.ts\n+++ b/x.ts\n',
      },
      seq: 5,
    };
    const decoded = decode(encode(event));
    expect(decoded).toEqual(event);
  });

  test('decode rejects chat.permission_response with unknown decision value', () => {
    const bad = JSON.stringify({
      type: 'chat.permission_response',
      requestId: 'r',
      approve: true,
      decision: 'maybe',
    });
    expect(() => decode(bad)).toThrow(WireDecodeError);
  });

  // spec/09 § What the message says. The doorbell reads this field off the
  // settling frame itself, so a codec that quietly dropped it would leave the
  // whole feature a no-op in production while every unit test above still
  // passed — the frames those build never go near encode/decode.
  describe('chat.state turnSummary survives the codec', () => {
    const settled = {
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      permissionMode: 'auto',
      lastUpdated: 1700000000,
    } as const;

    test('the agent\u2019s closing text round-trips verbatim', () => {
      const event = {
        ...settled,
        turnSummary: 'Dug over the top bed and sowed rocket \u2014 nothing else outstanding.',
      } as WireEvent;
      const decoded = decode(encode(event));
      expect(decoded).toEqual(event);
      expect((decoded as { turnSummary?: string | null }).turnSummary).toBe(
        'Dug over the top bed and sowed rocket \u2014 nothing else outstanding.',
      );
    });

    test('an explicit null round-trips as null, not as absent', () => {
      const event = { ...settled, turnSummary: null } as WireEvent;
      const decoded = decode(encode(event));
      expect(decoded).toEqual(event);
      expect('turnSummary' in (decoded as object)).toBe(true);
      expect((decoded as { turnSummary?: string | null }).turnSummary).toBeNull();
    });

    test('a frame from a host too old to send it still decodes', () => {
      const decoded = decode(encode(settled as WireEvent));
      expect((decoded as { turnSummary?: string | null }).turnSummary).toBeUndefined();
    });

    test('decode rejects a non-string turnSummary rather than coercing it', () => {
      expect(() => decode(JSON.stringify({ ...settled, turnSummary: 42 }))).toThrow(
        WireDecodeError,
      );
    });
  });

  // Spec constraint: activity must be exactly idle|running|awaiting-permission|errored
  test('decode rejects chat.state with invalid activity value', () => {
    const bad = {
      type: 'chat.state',
      chatId: 'c1',
      activity: 'paused',
      lastUpdated: 1700000000,
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // Spec constraint: every chat stream item must carry seq
  test('decode throws on chat.tool_result missing seq', () => {
    const bad = {
      type: 'chat.tool_result',
      chatId: 'c1',
      tool: 'Bash',
      callId: 'tc-1',
      result: 'output',
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on chat.permission_request missing seq', () => {
    const bad = {
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'req-1',
      request: { tool: 'Bash', args: {} },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on chat.error missing seq', () => {
    const bad = {
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // Spec constraint: daemon.unauthenticated requires reason
  test('decode throws on daemon.unauthenticated missing reason', () => {
    const bad = { type: 'daemon.unauthenticated' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // Spec constraint: notify channel must be exactly push|desktop|speakers
  test('decode rejects notify with channel voice (not in enum)', () => {
    const bad = { type: 'notify', chatId: 'c1', channel: 'voice', message: 'x' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // spec/09 § `### push` — deepLink is optional and additive, so an older
  // daemon/client that never sends it still round-trips cleanly.
  test('decode accepts notify without deepLink (optional field)', () => {
    const ok = { type: 'notify', chatId: 'c1', channel: 'push', message: 'x' };
    expect(() => decode(JSON.stringify(ok))).not.toThrow();
  });

  test('decode rejects notify with an empty deepLink', () => {
    const bad = { type: 'notify', chatId: 'c1', channel: 'push', message: 'x', deepLink: '' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects notify with a deepLink over the 2048-char cap', () => {
    const bad = {
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'x',
      deepLink: 'citymapper://directions?' + 'a'.repeat(2048),
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // spec/09 § Notification actions — absent is the baseline Reply-only case,
  // so an older daemon/client that never sends it still round-trips cleanly.
  test('decode accepts notify without actions (optional field)', () => {
    const ok = { type: 'notify', chatId: 'c1', channel: 'push', message: 'x' };
    expect(() => decode(JSON.stringify(ok))).not.toThrow();
  });

  test('decode accepts notify with permission actions', () => {
    const ok = {
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'x',
      actions: { kind: 'permission', requestId: 'r1' },
    };
    expect(() => decode(JSON.stringify(ok))).not.toThrow();
  });

  test('decode accepts notify with message actions carrying quickReplies', () => {
    const ok = {
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'x',
      actions: { kind: 'message', quickReplies: ['Yes', 'Snooze 10 min'] },
    };
    expect(() => decode(JSON.stringify(ok))).not.toThrow();
  });

  test('decode rejects notify with more than 2 quickReplies', () => {
    const bad = {
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'x',
      actions: { kind: 'message', quickReplies: ['a', 'b', 'c'] },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects notify with more than 3 question options', () => {
    const bad = {
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'x',
      actions: {
        kind: 'question',
        requestId: 'r1',
        questionText: 'q',
        options: ['a', 'b', 'c', 'd'],
      },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode rejects notify actions with an unknown field (strict)', () => {
    const bad = {
      type: 'notify',
      chatId: 'c1',
      channel: 'push',
      message: 'x',
      actions: { kind: 'message', bogus: 'nope' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // Spec constraint: chat.input localId is required (UUID for dedup)
  test('decode throws on chat.input with empty localId', () => {
    const bad = { type: 'chat.input', chatId: 'c1', message: 'hi', localId: '' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // Spec constraint: hello requires clientType
  test('decode throws on hello missing clientVersion', () => {
    const bad = { type: 'hello', clientType: 'surface-web' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // Spec constraint: chat.spawned requires chatId and folder
  test('decode throws on chat.spawned missing folder', () => {
    const bad = { type: 'chat.spawned', chatId: 'c1' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  test('decode throws on chat.spawned missing chatId', () => {
    const bad = { type: 'chat.spawned', folder: '/work/proj' };
    expect(() => decode(JSON.stringify(bad))).toThrow(WireDecodeError);
  });

  // `jobId` is server-populated only (packages/server/src/jobs/chat-links.ts) —
  // an old host that has never heard of it must still decode fine, so it's
  // optional and its absence must not throw.
  test('decode accepts chat.spawned with no jobId (old-daemon back-compat)', () => {
    const legacy = { type: 'chat.spawned', chatId: 'c1', daemonId: 'd1', folder: '/x' };
    const decoded = decode(JSON.stringify(legacy));
    expect(decoded).toEqual(legacy);
  });

  test('decode accepts an ArrayBuffer frame', () => {
    const event: WireEvent = { type: 'surface.heartbeat' };
    const bytes = new TextEncoder().encode(encode(event));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decode(buf)).toEqual(event);
  });

  test('decode throws on an unsupported frame type (not string/Buffer/ArrayBuffer/Uint8Array)', () => {
    try {
      decode(12345 as unknown as string);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WireDecodeError);
      // No cause is passed for this failure mode, so formatMessage falls back
      // to the bare reason (no zod issue, no SyntaxError to report).
      expect((err as WireDecodeError).message).toBe('unsupported frame type');
    }
  });

  test('WireDecodeError preview truncates long payloads with a char-count suffix', () => {
    const longMessage = 'x'.repeat(500);
    try {
      decode(
        JSON.stringify({
          type: 'chat.message',
          chatId: 'c1',
          role: 'user',
          content: longMessage,
          seq: -1,
        }),
      );
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WireDecodeError);
      const preview = (err as WireDecodeError).preview;
      expect(preview.length).toBeLessThan(500);
      expect(preview).toMatch(/…\(\+\d+ chars\)$/);
    }
  });

  // Hosts update their host on their own schedule, so a host answering the
  // skills request without naming each skill's file (or its description) is a
  // normal, current state — not a malformed frame. It must decode, carrying
  // neither.
  test('a skills response that names no files or descriptions still decodes', () => {
    const decoded = decode(
      JSON.stringify({
        type: 'patch.skills.response',
        requestId: 'sk1',
        ok: true,
        skills: ['forage', 'plant'],
      }),
    );
    expect(decoded.type).toBe('patch.skills.response');
    const ev = decoded as Extract<WireEvent, { type: 'patch.skills.response' }>;
    expect(ev.paths).toBeUndefined();
    expect(ev.descriptions).toBeUndefined();
    expect(ev.frontmatter).toBeUndefined();
  });

  test('a skills response carries the whole frontmatter per skill, keyed by field', () => {
    const decoded = decode(
      JSON.stringify({
        type: 'patch.skills.response',
        requestId: 'sk1',
        ok: true,
        skills: ['forage'],
        descriptions: { forage: 'Find wild food nearby.' },
        frontmatter: {
          forage: {
            name: 'forage',
            description: 'Find wild food nearby.',
            'user-invocable': 'true',
          },
        },
      }),
    );
    const ev = decoded as Extract<WireEvent, { type: 'patch.skills.response' }>;
    expect(ev.frontmatter).toEqual({
      forage: { name: 'forage', description: 'Find wild food nearby.', 'user-invocable': 'true' },
    });
  });
});

describe('isWireEvent', () => {
  test('returns true for a valid event', () => {
    expect(isWireEvent({ type: 'surface.heartbeat' })).toBe(true);
    expect(
      isWireEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 0 }),
    ).toBe(true);
  });

  test('returns false for an invalid or unknown event, without throwing', () => {
    expect(isWireEvent({ type: 'nonsense' })).toBe(false);
    expect(isWireEvent({ type: 'chat.message', chatId: 'c1' })).toBe(false);
    expect(isWireEvent(null)).toBe(false);
    expect(isWireEvent('not an object')).toBe(false);
  });
});

describe('assertValidPermissionResponse', () => {
  test('does not throw when decision is not approve_with_edits', () => {
    expect(() =>
      assertValidPermissionResponse({
        type: 'chat.permission_response',
        requestId: 'r',
        approve: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertValidPermissionResponse({
        type: 'chat.permission_response',
        requestId: 'r',
        approve: false,
        decision: 'deny',
      }),
    ).not.toThrow();
  });

  test('does not throw when approve_with_edits carries a non-empty editedNewString', () => {
    expect(() =>
      assertValidPermissionResponse({
        type: 'chat.permission_response',
        requestId: 'r',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: 'new content',
      }),
    ).not.toThrow();
  });

  test('throws when approve_with_edits is missing editedNewString', () => {
    expect(() =>
      assertValidPermissionResponse({
        type: 'chat.permission_response',
        requestId: 'r',
        approve: true,
        decision: 'approve_with_edits',
      }),
    ).toThrowError(/requires editedNewString/);
  });

  // spec/03 § Answering with content: required means present and a string, not
  // non-empty. An empty string is how an edit that DELETES the content is
  // approved (an `Edit` with an empty `new_string`, a `Write` of an empty file).
  test('does not throw when approve_with_edits carries an empty-string editedNewString', () => {
    expect(() =>
      assertValidPermissionResponse({
        type: 'chat.permission_response',
        requestId: 'r',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: '',
      }),
    ).not.toThrow();
  });

  test('throws when approve_with_edits carries a null editedNewString', () => {
    expect(() =>
      assertValidPermissionResponse({
        type: 'chat.permission_response',
        requestId: 'r',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: null,
      }),
    ).toThrowError(/requires editedNewString/);
  });
});
