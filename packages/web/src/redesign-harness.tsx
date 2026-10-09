// DEV-ONLY redesign harness — mounts the REAL Sidebar + ChatRoute against
// hydrated mock stores, populated with a realistic multi-turn conversation and
// a couple of sidebar chats, so the running UI can be SNAPSHOTTED into a
// self-contained file for the redesign / annotation studio. Never imported by
// the production entry (main.tsx). Sibling of dev-harness.tsx.
import { StrictMode } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './components/Sidebar.js';
import { ChatRoute } from './routes/ChatRoute.js';
import { useChatStore } from './stores/chatStore.js';
import type { ChatEventEntry } from './stores/chatStore.js';
import { usePresenceStore } from './stores/presenceStore.js';
import './index.css';

const queryClient = new QueryClient();

useChatStore.getState().hydrate([
  {
    chatId: 'thread_manager',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'manager',
    folder: '/home/tom/.patch/threads/manager',
    activity: 'idle',
    status: 'active',
    pinned: true,
    pinnedAt: 50,
    disabled: false,
    lastUpdated: 10,
  },
  {
    chatId: 'chat_bus',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'bus-watch',
    folder: '/home/tom/projects/bus',
    activity: 'running',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 9,
  },
  {
    chatId: 'chat_garden',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'garden-podcast',
    folder: '/home/tom/projects/garden',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 6,
  },
  {
    chatId: 'thread_speakers',
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: 'speakers',
    folder: '/home/tom/.patch/threads/speakers',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  },
]);

// A realistic manager conversation — user prompts, markdown assistant replies,
// a tool call + its result — so the transcript, bubbles, code blocks and tool
// disclosure are all present to annotate.
const managerTimeline: ChatEventEntry[] = (
  [
    {
      seq: 1,
      kind: 'message',
      role: 'user',
      content: 'Can you check whether the 5pm bus watcher actually fired today? It felt quiet.',
    },
    {
      seq: 2,
      kind: 'message',
      role: 'assistant',
      content: "Let me look at the watcher's run log for today and confirm the 17:00 tick landed.",
    },
    {
      seq: 3,
      kind: 'tool_call',
      role: 'assistant',
      tool: 'Bash',
      toolArgs: { command: 'tail -n 20 ~/projects/bus/.patch/runs/2026-07-15.log' },
      callId: 'call_1',
    },
    {
      seq: 4,
      kind: 'tool_result',
      tool: 'Bash',
      toolResult: {
        exit: 0,
        stdout:
          '16:45 tick ok (2 buses)\n17:00 tick ok (0 buses) — nothing within 30m window\n17:15 tick ok (1 bus)',
      },
      callId: 'call_1',
    },
    {
      seq: 5,
      kind: 'message',
      role: 'assistant',
      content:
        'It fired fine — the **17:00 tick ran on time**, it just found *nothing within the 30-minute window*, so it stayed silent by design.\n\n- 16:45 — 2 buses\n- **17:00 — 0 buses** (quiet, as you noticed)\n- 17:15 — 1 bus\n\nWant me to widen the alert window to 45 minutes so gaps like this still get a heads-up?',
    },
    {
      seq: 6,
      kind: 'message',
      role: 'user',
      content: 'Yeah, bump it to 45 minutes and redeploy.',
    },
    {
      seq: 7,
      kind: 'message',
      role: 'assistant',
      content:
        'Done — window is now `45m` and the watcher redeployed. Next tick at 17:30 will use the wider window.\n\n```diff\n- ALERT_WINDOW_MINUTES = 30\n+ ALERT_WINDOW_MINUTES = 45\n```',
    },
  ] as Array<Omit<ChatEventEntry, 'at'>>
).map((e, i) => ({ ...e, at: 1_752_500_000_000 + i * 1000 }));

useChatStore.setState((s) => ({
  timelines: { ...s.timelines, thread_manager: managerTimeline },
}));

usePresenceStore.getState().setConnection('connected');
usePresenceStore.getState().setHostOnline('host-dev', true);

const params = new URLSearchParams(window.location.search);
const chatId = params.get('chat') ?? 'thread_manager';

function Harness(): JSX.Element {
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
        <Sidebar />
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
);
