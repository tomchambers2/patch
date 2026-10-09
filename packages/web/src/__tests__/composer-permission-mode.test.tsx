// The composer's approval-mode dropdown (spec/14 § Composer — Approval mode):
// the mode this chat's next turn will run under, sitting under the text input
// because it governs the turn about to be sent.
//
// Two properties this file is the guard for. The option text is the SDK's own
// mode id, because that exact string is what reaches the model — a friendlier
// word would mean the user picks one thing and the model is told another. And
// there is no row that clears the mode: a chat always has one (spec/02
// § Permission mode), so every pick sends a `chat.settings` carrying a mode.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type { PermissionMode, WireEvent } from '@patch/wire';
import { Composer } from '../components/Composer.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatRow } from '../stores/types.js';

function fakeWs(sent: WireEvent[]) {
  return { send: (e: WireEvent) => sent.push(e) } as unknown as Parameters<typeof setActiveWs>[0];
}

function seedChat(chatId: string, permissionMode: PermissionMode): void {
  const row: ChatRow = {
    chatId,
    name: null,
    daemonId: 'd1',
    folder: '/work',
    activity: 'idle',
    permissionMode,
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    pendingWake: null,
    todos: [],
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    snoozedUntil: null,
    pendingPermissions: [],
    lastSeq: -1,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
  useChatStore.setState((s) => ({ chats: { ...s.chats, [chatId]: row } }));
}

function renderComposer(chatId: string) {
  return render(<Composer chatId={chatId} daemonId="d1" onSend={() => {}} />);
}

/** The dropdown itself. */
function select(): HTMLSelectElement {
  return screen.getByTestId('permission-mode') as HTMLSelectElement;
}

/** The select's wrapper — the direct child of `.composer-actions` (it carries the custom caret). */
function selectRow(): Element {
  return select().parentElement!;
}

describe('Composer — approval mode', () => {
  let sent: WireEvent[];

  beforeEach(() => {
    window.localStorage.clear();
    useChatStore.setState({ chats: {} });
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    sent = [];
    setActiveWs(fakeWs(sent));
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });

  it('sits inside the composer, in the action row under the text input', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    const actions = screen.getByTestId('composer').querySelector('.composer-actions');
    expect(actions).not.toBeNull();
    expect(actions!.contains(select())).toBe(true);
  });

  it('follows the utility buttons and still leaves send last in the row', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    const actions = screen.getByTestId('composer').querySelector('.composer-actions')!;
    const order = Array.from(actions.children);
    expect(order.indexOf(selectRow())).toBeGreaterThan(
      order.indexOf(screen.getByTestId('attach-btn')),
    );
    expect(order.indexOf(selectRow())).toBeGreaterThan(
      order.indexOf(screen.getByTestId('voice-note-btn')),
    );
    // Send is pinned to the far right (spec/14 § Composer), so the dropdown
    // moving right of the utility buttons must not have overtaken it.
    expect(order.indexOf(selectRow())).toBeLessThan(order.indexOf(screen.getByTestId('send-btn')));
    expect(actions.lastElementChild).toBe(screen.getByTestId('send-btn'));
  });

  it('sits left of stop (which replaces send) while a turn is running', () => {
    seedChat('c1', 'auto');
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStop={() => {}} running />);
    const actions = screen.getByTestId('composer').querySelector('.composer-actions')!;
    const order = Array.from(actions.children);
    expect(order.indexOf(selectRow())).toBeLessThan(order.indexOf(screen.getByTestId('stop-btn')));
    expect(actions.lastElementChild).toBe(screen.getByTestId('stop-btn'));
  });

  it('shows the mode the next turn will use', () => {
    seedChat('c1', 'plan');
    renderComposer('c1');
    expect(select().value).toBe('plan');
  });

  it('offers exactly the five modes and nothing else', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    const values = Array.from(select().querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan']);
  });

  it("names each mode in the SDK's own words, inventing no label", () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    const options = Array.from(select().querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toEqual([
      'Auto',
      'Default',
      'Accept edits',
      'Bypass permissions',
      'Plan',
    ]);
    // The label a user reads is the value that goes over the wire, cased and
    // spaced for reading and nothing more — no synonym, no invented word, so
    // the mode he picks is the mode the model is given.
    for (const o of options) {
      expect(o.textContent?.toLowerCase().replace(/ /g, '')).toBe(o.value.toLowerCase());
    }
  });

  it('has no row that clears the mode back to the host default', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    expect(select().textContent).not.toMatch(/follow|host|default the chat/i);
    expect(select().querySelector('option[value="follow-host"]')).toBeNull();
  });

  it('carries an accessible name — there is no visible label beside it', () => {
    seedChat('c1', 'plan');
    renderComposer('c1');
    expect(screen.getByRole('combobox', { name: 'Approval mode' })).toBe(select());
    // spec/14 § Copy — no helper text: the tooltip NAMES the control, it does
    // not describe it ("What the agent can do" was a description).
    expect(select().title).toBe('Approval mode');
  });

  it('choosing a mode sends chat.settings carrying it', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    fireEvent.change(select(), { target: { value: 'plan' } });
    expect(sent).toEqual([{ type: 'chat.settings', chatId: 'c1', permissionMode: 'plan' }]);
  });

  it('every option sends a mode — none of them sends a bare frame', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    for (const o of Array.from(select().querySelectorAll('option'))) {
      fireEvent.change(select(), { target: { value: o.value } });
    }
    expect(sent).toHaveLength(5);
    for (const frame of sent) expect('permissionMode' in (frame as object)).toBe(true);
    expect(sent.map((f) => (f as { permissionMode: string }).permissionMode)).toEqual([
      'auto',
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
    ]);
  });

  it('reflects a mode changed on another surface without a remount', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    expect(select().value).toBe('auto');
    act(() => seedChat('c1', 'bypassPermissions'));
    expect(select().value).toBe('bypassPermissions');
  });

  it('does not send anything when the control is not touched', () => {
    seedChat('c1', 'auto');
    renderComposer('c1');
    expect(sent).toEqual([]);
  });

  it('is absent on the new-chat placeholder — its setup row above owns the choice', () => {
    renderComposer('new');
    expect(screen.queryByTestId('permission-mode')).toBeNull();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('is present on an existing chat the roster has not reported a mode for', () => {
    renderComposer('c1');
    expect(select()).toBeTruthy();
    expect(select().value).toBe('');
  });

  it('is disabled while the link is down, rather than dropping the change silently', () => {
    seedChat('c1', 'auto');
    usePresenceStore.getState().setConnection('connecting');
    renderComposer('c1');
    expect(select().disabled).toBe(true);
  });
});
