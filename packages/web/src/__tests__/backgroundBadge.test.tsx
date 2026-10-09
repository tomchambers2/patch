// spec/14 § Status badges — the `background` state.
//
// The bug: a backgrounded `Bash` command or `Task` sub-agent outlives the turn
// that launched it, so the chat settles `idle` with work still in flight. The
// sidebar has every chat and the transcript of none, so it read `idle`, fell
// through to `done`/`read` and drew the finished tick over a chat whose build
// was still running — the strongest "nothing to do here" signal in the list,
// shown for the one case where something is very much still happening.
//
// The count comes from the host on `chat.state`, because it is the only party
// that sees every launch and every completion for every chat. Absence of a
// count is UNKNOWN and must change nothing.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deriveBadge, type ChatRow } from '../stores/types.js';
import { matchesStateFilter, needsAttention } from '../lib/chatGroups.js';

function row(over: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    name: 'a chat',
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    todos: [],
    folder: '/w',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    snoozedUntil: null,
    lastUpdated: 1,
    lastSeq: 1,
    lastReadSeq: 1,
    pendingPermissions: [],
    pendingWake: null,
    jobId: null,
    model: null,
    permissionMode: 'auto',
    awaitingPermission: false,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...(over as Partial<ChatRow>),
  } as ChatRow;
}

describe('deriveBadge — an idle chat with background work is not a finished one', () => {
  it('replaces the READ tick when a background task is still running', () => {
    // Visited since the last activity, so this is the darker ✓ the sidebar was
    // showing over live work.
    expect(deriveBadge(row({ lastSeq: 3, lastReadSeq: 3 }))).toBe('read');
    expect(deriveBadge(row({ lastSeq: 3, lastReadSeq: 3, backgroundTasks: 1 }))).toBe('background');
  });

  it('unread beats background, always — there is something new to look at regardless', () => {
    expect(deriveBadge(row({ lastSeq: 9, lastReadSeq: 1 }))).toBe('done');
    // Tom: "unread > background always" — a background job still running does
    // not make the unread output any less unread.
    expect(deriveBadge(row({ lastSeq: 9, lastReadSeq: 1, backgroundTasks: 2 }))).toBe('done');
  });

  it('NO FALLBACK: an unknown count changes nothing', () => {
    // A host that predates the field reports nothing at all, and a row that
    // has not yet heard a state frame knows nothing either. Neither is "none
    // running" and neither is "something running".
    expect(deriveBadge(row({ lastSeq: 3, lastReadSeq: 3, backgroundTasks: null }))).toBe('read');
    expect(deriveBadge(row({ lastSeq: 3, lastReadSeq: 3 }))).toBe('read');
  });

  it('a count of 0 is the positive claim that nothing is running', () => {
    expect(deriveBadge(row({ lastSeq: 3, lastReadSeq: 3, backgroundTasks: 0 }))).toBe('read');
  });

  it('keeps the ranking: a decision, a failure and a live turn all still win', () => {
    expect(
      deriveBadge(
        row({
          backgroundTasks: 1,
          pendingPermissions: [{ requestId: 'r', tool: 'Bash', description: undefined, args: {} }],
        }),
      ),
    ).toBe('permission');
    expect(deriveBadge(row({ backgroundTasks: 1, status: 'errored' }))).toBe('errored');
    expect(deriveBadge(row({ backgroundTasks: 1, activity: 'running' }))).toBe('working');
  });
});

describe('the state filter and the attention queue agree with the badge', () => {
  it('filters under "working" — it is work in flight, just not a turn', () => {
    const r = row({ backgroundTasks: 1 });
    expect(matchesStateFilter(r, 'working')).toBe(true);
    expect(matchesStateFilter(r, 'done')).toBe(false);
    expect(matchesStateFilter(r, 'failed')).toBe(false);
    expect(matchesStateFilter(r, 'all')).toBe(true);
  });

  it('does not need attention while it is still running, but DOES once it has unread output', () => {
    expect(needsAttention(row({ lastSeq: 9, lastReadSeq: 1 }))).toBe(true);
    // Unread beats background — see the deriveBadge test above.
    expect(needsAttention(row({ lastSeq: 9, lastReadSeq: 1, backgroundTasks: 1 }))).toBe(true);
    // No unread output yet, background job still running: nothing to look at.
    expect(needsAttention(row({ lastSeq: 3, lastReadSeq: 3, backgroundTasks: 1 }))).toBe(false);
  });
});

describe('deriveBadge — monitoring (a self-wake armed, nothing to read yet)', () => {
  it('shows monitoring when a wake is pending and there is nothing else to say', () => {
    expect(
      deriveBadge(row({ pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined } })),
    ).toBe('monitoring');
  });

  it('unread still beats monitoring, same as background', () => {
    expect(
      deriveBadge(
        row({
          lastSeq: 9,
          lastReadSeq: 1,
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('done');
  });

  it('a running background job beats a monitoring wake — the job is the stronger claim', () => {
    expect(
      deriveBadge(
        row({
          backgroundTasks: 1,
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('background');
  });

  it('a decision or failure still wins over monitoring', () => {
    expect(
      deriveBadge(
        row({
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
          pendingPermissions: [{ requestId: 'r', tool: 'Bash', description: undefined, args: {} }],
        }),
      ),
    ).toBe('permission');
    expect(
      deriveBadge(
        row({
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
          status: 'errored',
        }),
      ),
    ).toBe('errored');
  });
});

describe('deriveBadge — a declared question is the same fact as a pending permission', () => {
  it('shows permission for a DECLARED statusKind of question, with no native request pending', () => {
    expect(
      deriveBadge(
        row({ statusKind: 'question', statusSummary: 'need a decision', statusDeclared: true }),
      ),
    ).toBe('permission');
  });

  it('a report does not get the permission treatment — only a question does', () => {
    expect(
      deriveBadge(
        row({ statusKind: 'report', statusSummary: 'worth a look', statusDeclared: true }),
      ),
    ).not.toBe('permission');
  });

  it('a GENERATED question guess (not declared) does not freeze the badge indigo', () => {
    expect(
      deriveBadge(
        row({ statusKind: 'question', statusSummary: 'need a decision', statusDeclared: false }),
      ),
    ).not.toBe('permission');
    expect(
      deriveBadge(
        row({
          statusKind: 'question',
          statusSummary: 'need a decision',
          statusDeclared: false,
          lastSeq: 5,
          lastReadSeq: 1,
        }),
      ),
    ).toBe('done');
    expect(
      deriveBadge(
        row({
          statusKind: 'question',
          statusSummary: 'need a decision',
          statusDeclared: false,
          lastSeq: 5,
          lastReadSeq: 5,
        }),
      ),
    ).toBe('read');
  });
});

describe('StatusBadge — the background state', () => {
  it('draws a turning glyph, not another tinted dot', () => {
    const { container } = render(<StatusBadge badge="background" />);
    const el = screen.getByTestId('badge-background');
    expect(el).toBeInTheDocument();
    expect(container.querySelector('[data-testid="badge-background"] svg')).not.toBeNull();
    expect(el.textContent).not.toContain('✓');
    expect(el).toHaveAttribute('aria-label', 'background job running');
    expect(el).toHaveAttribute('title', 'Background job running');
    // spec/14 § Copy — a name, not an explainer.
    expect(el.getAttribute('title')).not.toContain('—');
    // Namespaced, like every other variant (see StatusBadge.test.tsx).
    expect([...el.classList]).toContain('badge-background');
    expect([...el.classList]).not.toContain('background');
  });
});

describe('chatStore — the count reaches the row', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    window.localStorage.clear();
  });

  it('takes the count off chat.state, and an ABSENT field leaves it alone', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // Nothing has said anything yet: unknown, not zero.
    expect(useChatStore.getState().chats['c1']?.backgroundTasks).toBeNull();

    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 10,
      backgroundTasks: 2,
    });
    expect(useChatStore.getState().chats['c1']?.backgroundTasks).toBe(2);
    // Already read (unread outranks background — this test is about the count
    // itself, not the read/unread interaction).
    s.markRead('c1');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('background');

    // An older host's frame carries no count. It must not blank what a newer
    // one already reported.
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 11,
    });
    expect(useChatStore.getState().chats['c1']?.backgroundTasks).toBe(2);

    // Zero is meaningful and clears it.
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 12,
      backgroundTasks: 0,
    });
    expect(useChatStore.getState().chats['c1']?.backgroundTasks).toBe(0);
  });

  it('survives a cold-start hydrate, which is where the reload bug lived', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'auto',
        name: 'a chat',
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
        backgroundTasks: 1,
      },
    ]);
    // The count itself is what this test guards — it used to vanish on
    // reload. A bare hydrate (no read-watermark seeded, no WS traffic since)
    // is indistinguishable from "never visited", which is unread by
    // definition (the -1 sentinel) and unread now correctly outranks
    // background — see the "unread beats background" test above. Read state
    // is a separate concern from whether the count survived at all.
    expect(useChatStore.getState().chats['c1']?.backgroundTasks).toBe(1);
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('done');
  });
});

describe('Sidebar row', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.getState().setSearchQuery('');
    window.localStorage.clear();
  });

  it('shows the background badge instead of the tick', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'auto',
        name: 'backgrounded build',
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
        backgroundTasks: 1,
      },
    ]);
    // Already read (unread now correctly outranks background — see the
    // "unread beats background" test above; this test is about the OTHER
    // case, where there is genuinely nothing new to look at).
    useChatStore.getState().markRead('c1');
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const chatRow = screen.getByTestId('chat-row-c1');
    expect(chatRow.querySelector('[data-testid="badge-background"]')).not.toBeNull();
    expect(chatRow.querySelector('[data-testid="badge-read"]')).toBeNull();
    expect(chatRow.querySelector('[data-testid="badge-done"]')).toBeNull();
    cleanup();
  });
});
