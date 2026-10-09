// spec/14 ## Main chat panel — a `patch_job_*` call changes what runs on a
// schedule, so its row announces itself instead of collapsing into the same
// one-liner an `ls` gets. Reported 11 Sep 2026: a chat created a 30-minute
// recurring job and the user "didn't see anything at all".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import { describeTrigger } from '../lib/jobDescribe.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
  },
}));

const NOW = 1_800_000_000_000;

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'doorbell',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const JOB = {
  id: 'j_01M284TE41TMF4BB0FBC8DT4EA',
  name: 'Doorbell watch',
  enabled: true,
  trigger: { type: 'cron', expression: '0,30 8-20 * * *', timezone: 'Europe/London' },
  action: { type: 'spawn', daemonId: 'd1', folder: '/home/x', prompt: 'watch' },
};

function emitCreate(result: unknown): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool: 'mcp__patch__patch_job_create',
    args: { name: 'Doorbell watch', trigger: JOB.trigger },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'call-1',
    result,
  } as never);
}

describe('ChatRoute — patch_job_* rows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('announces a created job with its name, schedule and a link to it', () => {
    seed();
    emitCreate({ jobId: JOB.id, job: JOB });
    renderChat();
    expect(screen.getByTestId('tool-call-job-verb').textContent).toBe('Job created');
    const row = screen.getAllByTestId('tool-call')[0];
    expect(row?.textContent).toContain('Doorbell watch');
    // The schedule uses the SAME derivation the Jobs list uses, so a job reads
    // identically in both places — including where describeCron falls back to
    // the raw expression, as it does for this one.
    expect(screen.getByTestId('tool-call-job-trigger').textContent).toBe(
      describeTrigger(JOB.trigger as Parameters<typeof describeTrigger>[0]),
    );
    expect(screen.getByTestId('tool-call-job-link').getAttribute('href')).toBe(`/jobs/${JOB.id}`);
  });

  it('reads the job out of an MCP text block, not just a direct object', () => {
    seed();
    emitCreate({ content: [{ type: 'text', text: JSON.stringify({ jobId: JOB.id, job: JOB }) }] });
    renderChat();
    expect(screen.getByTestId('tool-call-job-verb').textContent).toBe('Job created');
    expect(screen.getByTestId('tool-call-job-link').getAttribute('href')).toBe(`/jobs/${JOB.id}`);
  });

  it('still announces the change when there is no usable result', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'mcp__patch__patch_job_disable',
      args: { jobId: JOB.id },
      callId: 'call-1',
    });
    renderChat();
    expect(screen.getByTestId('tool-call-job-verb').textContent).toBe('Job disabled');
    // The id came from the args, so the row can still be followed to the job.
    expect(screen.getByTestId('tool-call-job-link').getAttribute('href')).toBe(`/jobs/${JOB.id}`);
  });

  it('leaves a non-job patch tool on the ordinary collapsed row', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'mcp__patch__patch_job_list',
      args: {},
      callId: 'call-1',
    });
    renderChat();
    expect(screen.queryByTestId('tool-call-job-verb')).toBeNull();
  });
});
