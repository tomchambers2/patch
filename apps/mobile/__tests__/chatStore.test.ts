// Logic tests for the mobile chat store. Mirrors the corresponding
// web tests but exercises the appendLocalUserMessage path the mobile
// composer uses for optimistic echo.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { deriveBadge } from '../src/stores/types';

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('mobile chatStore', () => {
  it('hydrates rows + computes read badge initially', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'one',
        folder: '~/x',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 100,
      },
    ]);
    const row = useChatStore.getState().chats['c1'];
    expect(row).toBeDefined();
    if (!row) throw new Error('row missing');
    expect(deriveBadge(row)).toBe('done'); // lastUpdated > lastVisitedAt(0)
  });

  it('applyEvent: chat.message updates preview + lastSeq', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 7,
      role: 'assistant',
      content: 'hello mobile world',
    });
    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(row.preview).toBe('hello mobile world');
    expect(row.lastSeq).toBe(7);
    expect(useChatStore.getState().timelines['c1']?.length).toBe(1);
  });

  it('reconciles an optimistic user echo with its persisted copy by content (no duplicate)', () => {
    const store = useChatStore.getState();
    store.appendLocalUserMessage('c1', 'hi there', 'L1');
    // The persisted copy re-arrives (e.g. chat.replay after reconnect).
    store.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 0,
      role: 'user',
      content: 'hi there',
    });
    const tl = useChatStore.getState().timelines['c1'];
    // ONE entry, promoted to the real seq, localId + delivery marks cleared.
    expect(tl?.length).toBe(1);
    expect(tl?.[0]?.seq).toBe(0);
    expect(tl?.[0]?.localId).toBeUndefined();
    expect(tl?.[0]?.deliveryPending).toBe(false);
  });

  it('reconciles a voice echo against the daemon-tagged persisted copy + marks it voice', () => {
    const store = useChatStore.getState();
    store.appendLocalUserMessage('c1', 'read me the news', 'L9');
    // Host persists voice turns tagged; the tag is stripped for reconcile.
    store.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 0,
      role: 'user',
      content: '[voice • mobile] read me the news',
    });
    const tl = useChatStore.getState().timelines['c1'];
    expect(tl?.length).toBe(1);
    expect(tl?.[0]?.localId).toBeUndefined();
    expect(tl?.[0]?.voice).toBe(true);
  });

  it('voice note: persisted echo arriving BEFORE the local echo does not duplicate (dedupeAgainstPersisted)', () => {
    const store = useChatStore.getState();
    // The host's broadcast wins the race against the HTTP upload response —
    // it lands as a plain entry first, with no localId of ours to fold into.
    store.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'user',
      content: '[voice • mobile] read me the news',
    });
    // voiceNote.ts then calls this with dedupeAgainstPersisted: true once the
    // upload resolves — must NOT push a second copy.
    store.appendLocalUserMessage('c1', 'read me the news', 'L9', undefined, {
      dedupeAgainstPersisted: true,
    });
    const tl = useChatStore.getState().timelines['c1'];
    expect(tl?.length).toBe(1);
    expect(tl?.[0]?.seq).toBe(5);
  });

  it('a typed repeat send with matching content to an earlier persisted message is NOT deduped (no dedupeAgainstPersisted)', () => {
    const store = useChatStore.getState();
    store.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'user',
      content: 'ok',
    });
    // Composer path never passes dedupeAgainstPersisted — a legitimate repeat
    // send of identical text must still show as its own message.
    store.appendLocalUserMessage('c1', 'ok', 'L2');
    const tl = useChatStore.getState().timelines['c1'];
    expect(tl?.length).toBe(2);
  });

  it('appendLocalUserMessage echoes into the timeline with negative seq + delivery-pending', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    const tl = useChatStore.getState().timelines['c1'];
    expect(tl?.length).toBe(1);
    expect(tl?.[0]?.role).toBe('user');
    expect(tl?.[0]?.content).toBe('hi');
    expect((tl?.[0]?.seq ?? 0) < 0).toBe(true);
    // spec/12 — optimistic sends start delivery-pending, keyed by localId.
    expect(tl?.[0]?.localId).toBe('L1');
    expect(tl?.[0]?.deliveryPending).toBe(true);
  });

  it('delivery flags: clear / fail / retry patch the entry by localId (spec/12)', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    const flags = (): { pending?: boolean; failed?: boolean } => {
      const e = useChatStore.getState().timelines['c1']?.[0];
      return { pending: e?.deliveryPending, failed: e?.deliveryFailed };
    };
    useChatStore.getState().failDelivery('c1', 'L1');
    expect(flags()).toEqual({ pending: false, failed: true });
    useChatStore.getState().retryDelivery('c1', 'L1');
    expect(flags()).toEqual({ pending: true, failed: false });
    useChatStore.getState().clearDelivery('c1', 'L1');
    expect(flags()).toEqual({ pending: false, failed: false });
  });

  it('delivery actions on a chatId with no timeline at all are no-ops', () => {
    expect(() => useChatStore.getState().clearDelivery('ghost', 'L1')).not.toThrow();
    expect(() => useChatStore.getState().failDelivery('ghost', 'L1')).not.toThrow();
    expect(() => useChatStore.getState().retryDelivery('ghost', 'L1')).not.toThrow();
  });

  it('delivery actions for an unknown localId within an existing timeline are no-ops', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    expect(() => useChatStore.getState().clearDelivery('c1', 'never-existed')).not.toThrow();
    // The real entry is untouched.
    expect(useChatStore.getState().timelines['c1']![0]!.deliveryPending).toBe(true);
  });

  it('chat.permission_request flips badge to permission', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'rm -rf /', args: { command: 'rm -rf /' } },
    });
    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(deriveBadge(row)).toBe('permission');
    expect(row.pendingPermissions).toHaveLength(1);
  });

  it('chat.permission_request carries the tool args onto the timeline entry', () => {
    // `AskUserQuestion`'s card renders the question from the tool's own
    // arguments (spec/15 § Chat detail), not just its name — dropping `args`
    // here left the card with nothing to read.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: {
        tool: 'AskUserQuestion',
        description: 'AskUserQuestion',
        args: { questions: [{ header: 'H', question: 'Q?', options: [], multiSelect: false }] },
      },
    });
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.toolArgs).toEqual({
      questions: [{ header: 'H', question: 'Q?', options: [], multiSelect: false }],
    });
  });

  it("carries the request's expiry deadline onto the card's timeline entry", () => {
    // The question card counts down to the HOST's deadline (spec/02
    // § Questions are not approvals). Dropping it here would leave the card
    // with nothing to count to and no ring at all.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', description: 'AskUserQuestion', args: { questions: [] } },
      expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
    });
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionExpiry).toEqual({ at: 1_700_000_060_000, windowMs: 60_000 });
  });

  it('leaves the entry without a deadline when the request carries none', () => {
    // Expiry turned off on the host. Absent must stay absent — a zero or a
    // far-future instant would both draw a countdown to nothing.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', description: 'AskUserQuestion', args: { questions: [] } },
    });
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card).not.toHaveProperty('permissionExpiry');
  });

  // spec/15 § Side threads screen — a side branch's own question must not
  // leak into the main transcript, which draws only the active branch's track.
  it('a permission_request tagged with a non-active branch is kept out of the main view, in sideThreadPermissions instead', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c1',
      activeBranchId: 'c1-b0',
      branches: [
        { branchId: 'c1-b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
        {
          branchId: 'c1-b1',
          parentBranchId: 'c1-b0',
          forkFromSeq: 0,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
        },
      ],
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'side-req-1',
      request: { tool: 'Bash', args: { cmd: 'ls' }, description: 'list files' },
      seq: 1,
      branchId: 'c1-b1',
    });

    const row = useChatStore.getState().chats['c1'];
    expect(row?.pendingPermissions ?? []).toHaveLength(0);
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'permission')).toHaveLength(0);

    const sidePerms = useChatStore.getState().sideThreadPermissions['c1::c1-b1'];
    expect(sidePerms).toHaveLength(1);
    expect(sidePerms?.[0]?.requestId).toBe('side-req-1');

    useChatStore.getState().resolveSideThreadPermission('c1', 'c1-b1', 'side-req-1');
    expect(useChatStore.getState().sideThreadPermissions['c1::c1-b1']).toHaveLength(0);
  });

  it('chat.permission_expiry_update moves the card to a focus-driven reset (spec/02 § Questions are not approvals)', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', description: 'AskUserQuestion', args: { questions: [] } },
      expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_expiry_update',
      chatId: 'c1',
      requestId: 'r1',
      expiry: { at: 1_700_000_120_000, windowMs: 60_000 },
      seq: 4,
    });
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionExpiry).toEqual({ at: 1_700_000_120_000, windowMs: 60_000 });
  });

  it('a re-delivered chat.permission_request does not draw a second Approve/Deny card', () => {
    // The host's `replayChat` (G2-d1) re-emits the canonical
    // `chat.permission_request` for every still-pending permission on the chat,
    // ungated by the replay's `fromSeq` — so any second replay re-delivers it
    // and the card was drawn twice. `requestId` is the identity, and it must
    // dedup the timeline card AND `pendingPermissions` (a doubled entry there
    // inflates the awaiting-permission state and the approve-all sweep).
    const deliver = (): void =>
      useChatStore.getState().applyEvent({
        type: 'chat.permission_request',
        chatId: 'c1',
        seq: 3,
        requestId: 'r1',
        request: {
          tool: 'Write',
          description: 'Write /tmp/x.ts',
          args: { file_path: '/tmp/x.ts' },
        },
      });
    deliver();
    deliver();

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'permission')).toHaveLength(1);
    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(row.pendingPermissions).toHaveLength(1);
    expect(deriveBadge(row)).toBe('permission');

    // Dedup is per requestId, not per chat: a turn can pause on more than one
    // approval at once, which is why `pendingPermissions` is a list.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 4,
      requestId: 'r2',
      request: { tool: 'Edit', description: 'Edit /tmp/y.ts', args: { file_path: '/tmp/y.ts' } },
    });
    expect(useChatStore.getState().chats['c1']!.pendingPermissions).toHaveLength(2);
  });

  it('resolvePermission clears the pending permission + badge + marks the card', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'rm -rf /', args: {} },
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');

    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(row.pendingPermissions).toHaveLength(0);
    expect(row.awaitingPermission).toBe(false);
    expect(row.activity).toBe('running');
    expect(deriveBadge(row)).not.toBe('permission');
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
  });

  // spec/15 § Chat detail (mirrors web's chatStore.test.ts). Without storing
  // the answers, a resolved AskUserQuestion card's picked options lived only
  // in transient screen state and were gone on remount.
  it('resolvePermission stores the answers an AskUserQuestion was resolved with', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', description: 'ask', args: { questions: [] } },
    });
    useChatStore
      .getState()
      .resolvePermission('c1', 'r1', 'approve', { 'Which library?': 'date-fns' });

    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionAnswers).toEqual({ 'Which library?': 'date-fns' });
  });

  it('resolvePermission keeps the chat waiting while another request is outstanding', () => {
    for (const requestId of ['r1', 'r2']) {
      useChatStore.getState().applyEvent({
        type: 'chat.permission_request',
        chatId: 'c1',
        seq: 3,
        requestId,
        request: { tool: 'Bash', description: 'x', args: {} },
      });
    }
    useChatStore.getState().resolvePermission('c1', 'r1', 'deny');

    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(row.pendingPermissions.map((p) => p.requestId)).toEqual(['r2']);
    expect(row.awaitingPermission).toBe(true);
    expect(row.activity).toBe('awaiting-permission');
    const cards = (useChatStore.getState().timelines['c1'] ?? []).filter(
      (e) => e.kind === 'permission',
    );
    expect(cards.map((c) => c.permissionResolved)).toEqual(['deny', undefined]);
  });

  it('resolvePermission is a no-op for a chat row it has never seen', () => {
    expect(() =>
      useChatStore.getState().resolvePermission('never-seen', 'r1', 'approve'),
    ).not.toThrow();
    expect(useChatStore.getState().chats['never-seen']).toBeUndefined();
  });

  it('chat.permission_response resolves the card the host answered (voice yes/no)', () => {
    // spec/07 § Permission prompts during voice — the host parses the spoken
    // "yes"/"no" and emits the response itself, so this surface never tapped
    // anything and never resolved the card locally.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'Edit', description: 'Edit /tmp/x.ts', args: {} },
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r1',
      approve: true,
      decision: 'approve',
    });

    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(row.pendingPermissions).toHaveLength(0);
    expect(row.awaitingPermission).toBe(false);
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
  });

  it('a deny echo after an approval keeps the card Approved and marks it cancelled', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'Run the cases', args: {} },
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    useChatStore.getState().applyEvent({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r1',
      approve: false,
      decision: 'deny',
    });
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
    expect(card?.permissionCancelled).toBe(true);
  });

  it('chat.permission_response carries answers through to the resolved AskUserQuestion card', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'rq',
      request: { tool: 'AskUserQuestion', description: 'ask', args: { questions: [] } },
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'rq',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which library?': 'date-fns' }),
      answers: { 'Which library?': 'date-fns' },
    });

    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission' && e.requestId === 'rq',
    );
    expect(card?.permissionAnswers).toEqual({ 'Which library?': 'date-fns' });
  });

  it('settles an AskUserQuestion card the host cancelled because a message was sent', () => {
    // spec/02 § Questions are not approvals — sending a message while the
    // agent's question is open cancels it host-side, and this echo is the
    // only thing that tells the phone. Without it the question card sits there
    // with live options for a question that has already been resolved.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'rq',
      request: { tool: 'AskUserQuestion', description: 'Ask the user a question', args: {} },
    });
    expect(useChatStore.getState().chats['c1']?.awaitingPermission).toBe(true);

    useChatStore.getState().applyEvent({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'rq',
      approve: false,
      decision: 'deny',
    });

    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(row.pendingPermissions).toHaveLength(0);
    expect(row.awaitingPermission).toBe(false);
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission' && e.requestId === 'rq',
    );
    expect(card?.permissionResolved).toBe('deny');
  });

  it('chat.permission_response reads deny from either decision or the legacy approve flag', () => {
    const seed = (requestId: string): void =>
      useChatStore.getState().applyEvent({
        type: 'chat.permission_request',
        chatId: 'c1',
        seq: 3,
        requestId,
        request: { tool: 'Bash', description: 'x', args: {} },
      });
    seed('r1');
    seed('r2');
    useChatStore.getState().applyEvent({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r1',
      approve: false,
      decision: 'deny',
    });
    // An older sender emits the boolean only.
    useChatStore.getState().applyEvent({
      type: 'chat.permission_response',
      chatId: 'c1',
      requestId: 'r2',
      approve: false,
    });
    const cards = (useChatStore.getState().timelines['c1'] ?? []).filter(
      (e) => e.kind === 'permission',
    );
    expect(cards.map((c) => c.permissionResolved)).toEqual(['deny', 'deny']);
  });

  it('a request and its response in ONE batch still resolve the card', () => {
    // The socket coalesces a burst into a single `applyEvents` fold, and a
    // spoken answer resolves fast enough to share that window.
    useChatStore.getState().applyEvents([
      {
        type: 'chat.permission_request',
        chatId: 'c1',
        seq: 3,
        requestId: 'r1',
        request: { tool: 'Bash', description: 'x', args: {} },
      },
      { type: 'chat.permission_response', chatId: 'c1', requestId: 'r1', approve: true },
    ]);
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
    expect(useChatStore.getState().chats['c1']!.pendingPermissions).toHaveLength(0);
  });

  it('chat.permission_response with no chatId, or for an unknown chat, commits nothing', () => {
    // The surface→host ingress omits chatId (the host keys on requestId
    // alone) — there is no card to address, so it must not seed a row.
    useChatStore.getState().applyEvents([
      { type: 'chat.permission_response', requestId: 'r1', approve: true },
      { type: 'chat.permission_response', chatId: 'ghost', requestId: 'r1', approve: true },
    ]);
    expect(useChatStore.getState().chats).toEqual({});
    expect(useChatStore.getState().timelines).toEqual({});
  });

  it('markRead drops badge to read', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'hello',
    });
    useChatStore.getState().markRead('c1');
    const row = useChatStore.getState().chats['c1'];
    if (!row) throw new Error('row missing');
    expect(deriveBadge(row)).toBe('read');
  });

  it('removeChat drops the row + timeline', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'hi',
    });
    useChatStore.getState().removeChat('c1');
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
    expect(useChatStore.getState().timelines['c1']).toBeUndefined();
  });

  it('removeChat also clears activeChatId when the removed chat was active', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 1,
      role: 'assistant',
      content: 'hi',
    });
    useChatStore.getState().setActiveChat('c1');
    useChatStore.getState().removeChat('c1');
    expect(useChatStore.getState().activeChatId).toBeNull();
  });

  it('removeChat leaves activeChatId alone when a DIFFERENT chat is removed', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 0,
      },
      {
        chatId: 'c2',
        name: null,
        folder: '',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 0,
      },
    ]);
    useChatStore.getState().setActiveChat('c1');
    useChatStore.getState().removeChat('c2');
    expect(useChatStore.getState().activeChatId).toBe('c1');
  });

  describe('setActiveChat', () => {
    it('sets the active chat and marks it read', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'assistant',
        content: 'hi',
      });
      useChatStore.getState().setActiveChat('c1');
      expect(useChatStore.getState().activeChatId).toBe('c1');
      expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
    });

    it('clearing the active chat (null) does not call markRead', () => {
      useChatStore.getState().setActiveChat(null);
      expect(useChatStore.getState().activeChatId).toBeNull();
    });
  });

  describe('markRead / setArchived / setPinned — no-op on an unknown chat', () => {
    it('markRead on a chatId with no row is a no-op', () => {
      expect(() => useChatStore.getState().markRead('ghost')).not.toThrow();
    });
    it('setArchived on a chatId with no row is a no-op', () => {
      expect(() => useChatStore.getState().setArchived('ghost', true)).not.toThrow();
      expect(useChatStore.getState().chats['ghost']).toBeUndefined();
    });
    it('setPinned on a chatId with no row is a no-op', () => {
      expect(() => useChatStore.getState().setPinned('ghost', true)).not.toThrow();
      expect(useChatStore.getState().chats['ghost']).toBeUndefined();
    });
  });

  describe('setArchived / setPinned', () => {
    beforeEach(() => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: null,
          folder: '',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
        },
      ]);
    });
    it('setArchived(true) then (false) toggles status', () => {
      useChatStore.getState().setArchived('c1', true);
      expect(useChatStore.getState().chats['c1']!.status).toBe('archived');
      useChatStore.getState().setArchived('c1', false);
      expect(useChatStore.getState().chats['c1']!.status).toBe('active');
    });
    it('setPinned(true) sets pinnedAt; setPinned(false) clears it', () => {
      useChatStore.getState().setPinned('c1', true);
      expect(useChatStore.getState().chats['c1']!.pinned).toBe(true);
      expect(useChatStore.getState().chats['c1']!.pinnedAt).not.toBeNull();
      useChatStore.getState().setPinned('c1', false);
      expect(useChatStore.getState().chats['c1']!.pinned).toBe(false);
      expect(useChatStore.getState().chats['c1']!.pinnedAt).toBeNull();
    });
  });

  describe('applyEvent — every event type', () => {
    it('chat.spawned creates/updates the row folder AND its host', () => {
      useChatStore
        .getState()
        .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/new' });
      expect(useChatStore.getState().chats['c1']!.folder).toBe('~/new');
      // Dropping `daemonId` left every mobile chat row without a host, so
      // nothing could ask which machine's credential gates it, or whose disk
      // the folder is on (spec/04 § Spawn — paths are scoped to their host).
      expect(useChatStore.getState().chats['c1']!.daemonId).toBe('d1');
    });

    it('keeps each row on its OWN host when two chats spawn on different machines', () => {
      useChatStore
        .getState()
        .applyEvent({ type: 'chat.spawned', daemonId: 'host-a', chatId: 'ca', folder: '/work' });
      useChatStore
        .getState()
        .applyEvent({ type: 'chat.spawned', daemonId: 'host-b', chatId: 'cb', folder: '/work' });
      expect(useChatStore.getState().chats['ca']!.daemonId).toBe('host-a');
      expect(useChatStore.getState().chats['cb']!.daemonId).toBe('host-b');
    });

    it('chat.state updates activity/status/pinned/name/folder/lastUpdated and derives awaitingPermission', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'awaiting-permission',
        status: 'active',
        pinned: true,
        pinnedAt: 5,
        name: 'Named',
        folder: '~/f',
        lastUpdated: 42,
      });
      const row = useChatStore.getState().chats['c1']!;
      expect(row.activity).toBe('awaiting-permission');
      expect(row.awaitingPermission).toBe(true);
      expect(row.pinned).toBe(true);
      expect(row.pinnedAt).toBe(5);
      expect(row.name).toBe('Named');
      expect(row.folder).toBe('~/f');
      expect(row.lastUpdated).toBe(42);
    });

    it('chat.state falls back to the existing row values for omitted optional fields', () => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: 'Existing',
          folder: '~/orig',
          activity: 'idle',
          status: 'archived',
          pinned: true,
          pinnedAt: 9,
          lastUpdated: 1,
        },
      ]);
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 2,
      });
      const row = useChatStore.getState().chats['c1']!;
      expect(row.status).toBe('archived');
      expect(row.pinned).toBe(true);
      expect(row.pinnedAt).toBe(9);
      expect(row.name).toBe('Existing');
      expect(row.folder).toBe('~/orig');
      expect(row.awaitingPermission).toBe(false);
    });

    // spec/02 § Self-wake — the wake bar (spec/15 § Chat detail) reads this
    // field, so the store must carry it exactly like the web store does.
    it('chat.state sets pendingWake when the host arms a self-wake', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 1,
        pendingWake: { message: 'check the bus', fireAt: 1_000 },
      });
      expect(useChatStore.getState().chats['c1']!.pendingWake).toEqual({
        message: 'check the bus',
        fireAt: 1_000,
      });
    });

    it('chat.state with pendingWake omitted preserves the existing pendingWake', () => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: null,
          folder: '~/f',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
          pendingWake: { message: 'nag about bed', fireAt: 2_000 },
        },
      ]);
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 2,
      });
      expect(useChatStore.getState().chats['c1']!.pendingWake).toEqual({
        message: 'nag about bed',
        fireAt: 2_000,
      });
    });

    it('chat.state with pendingWake: null clears a fired or cancelled wake', () => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: null,
          folder: '~/f',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
          pendingWake: { message: 'nag about bed', fireAt: 2_000 },
        },
      ]);
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 3,
        pendingWake: null,
      });
      expect(useChatStore.getState().chats['c1']!.pendingWake).toBeNull();
    });

    it('chat.state carries snoozedUntil onto the row (spec/04 § Snooze)', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 1,
        snoozedUntil: 9_000,
      });
      expect(useChatStore.getState().chats['c1']!.snoozedUntil).toBe(9_000);
    });

    it('chat.state with snoozedUntil omitted preserves the existing snooze', () => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: null,
          folder: '~/f',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
          snoozedUntil: 9_000,
        },
      ]);
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 2,
      });
      expect(useChatStore.getState().chats['c1']!.snoozedUntil).toBe(9_000);
    });

    it('chat.state with snoozedUntil: null is the host waking the chat', () => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: null,
          folder: '~/f',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
          snoozedUntil: 9_000,
        },
      ]);
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId: 'c1',
        activity: 'idle',
        lastUpdated: 3,
        snoozedUntil: null,
      });
      expect(useChatStore.getState().chats['c1']!.snoozedUntil).toBeNull();
    });

    it('setSnoozed is the optimistic local flip, and a no-op for an unknown chat', () => {
      useChatStore.getState().hydrate([
        {
          chatId: 'c1',
          name: null,
          folder: '~/f',
          activity: 'idle',
          status: 'active',
          pinned: false,
          pinnedAt: null,
          lastUpdated: 0,
          snoozedUntil: null,
        },
      ]);
      useChatStore.getState().setSnoozed('c1', 7_000);
      expect(useChatStore.getState().chats['c1']!.snoozedUntil).toBe(7_000);
      useChatStore.getState().setSnoozed('c1', null);
      expect(useChatStore.getState().chats['c1']!.snoozedUntil).toBeNull();
      expect(() => useChatStore.getState().setSnoozed('nope', 1)).not.toThrow();
      expect(useChatStore.getState().chats['nope']).toBeUndefined();
    });

    it('chat.message from a USER strips the [voice • …] prefix and sets voice:true', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'user',
        content: '[voice • mobile] turn the lights on',
      });
      const e = useChatStore.getState().timelines['c1']![0]!;
      expect(e.content).toBe('turn the lights on');
      expect(e.voice).toBe(true);
      expect(useChatStore.getState().chats['c1']!.preview).toBe('turn the lights on');
    });

    it('chat.message from a USER with no voice tag leaves content untouched, voice unset', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'user',
        content: 'plain text',
      });
      const e = useChatStore.getState().timelines['c1']![0]!;
      expect(e.content).toBe('plain text');
      expect(e.voice).toBeUndefined();
    });

    it('chat.message carries attachments into the timeline entry when present', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        seq: 1,
        role: 'assistant',
        content: 'see attached',
        attachments: [{ id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' }],
      });
      expect(useChatStore.getState().timelines['c1']![0]!.attachments).toHaveLength(1);
    });

    it('chat.tool_call appends a tool_call timeline entry and bumps lastSeq', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: 4,
        tool: 'Bash',
        args: { command: 'ls' },
        callId: 'call1',
      });
      const e = useChatStore.getState().timelines['c1']![0]!;
      expect(e.kind).toBe('tool_call');
      expect(e.tool).toBe('Bash');
      expect(e.toolArgs).toEqual({ command: 'ls' });
      expect(useChatStore.getState().chats['c1']!.lastSeq).toBe(4);
    });

    it('chat.tool_result appends a tool_result timeline entry', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.tool_result',
        chatId: 'c1',
        seq: 5,
        tool: 'Bash',
        result: 'ok',
        callId: 'call1',
      });
      const e = useChatStore.getState().timelines['c1']![0]!;
      expect(e.kind).toBe('tool_result');
      expect(e.toolResult).toBe('ok');
    });

    it('chat.artifact appends an artifact timeline entry and bumps lastSeq', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.artifact',
        chatId: 'c1',
        seq: 6,
        artifactId: 'a1',
        title: 'Bristol bus times',
        url: '/api/chats/c1/artifact/a1',
        path: 'out/buses.html',
        updatedAt: 1,
      });
      const e = useChatStore.getState().timelines['c1']![0]!;
      expect(e.kind).toBe('artifact');
      expect(e.artifactId).toBe('a1');
      expect(e.artifactTitle).toBe('Bristol bus times');
      expect(e.artifactUrl).toBe('/api/chats/c1/artifact/a1');
      expect(e.artifactPath).toBe('out/buses.html');
      expect(useChatStore.getState().chats['c1']!.lastSeq).toBe(6);
    });

    it('republishing a chat.artifact (same artifactId) replaces the existing entry in place', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.artifact',
        chatId: 'c1',
        seq: 6,
        artifactId: 'a1',
        title: 'Bristol bus times',
        url: '/api/chats/c1/artifact/a1',
        path: 'out/buses.html',
        updatedAt: 1,
      });
      useChatStore.getState().applyEvent({
        type: 'chat.artifact',
        chatId: 'c1',
        seq: 9,
        artifactId: 'a1',
        title: 'Bristol bus times v2',
        url: '/api/chats/c1/artifact/a1',
        path: 'out/buses.html',
        updatedAt: 2,
      });
      const timeline = useChatStore.getState().timelines['c1']!;
      expect(timeline.filter((e) => e.kind === 'artifact')).toHaveLength(1);
      expect(timeline[0]!.artifactTitle).toBe('Bristol bus times v2');
    });

    it('an unrecognised event type is a no-op (default branch)', () => {
      const before = useChatStore.getState().chats;
      useChatStore
        .getState()
        .applyEvent({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' });
      expect(useChatStore.getState().chats).toBe(before); // untouched reference
    });
  });
});

// The same three faults the web surface had, on the phone (fixed there first,
// found here by reading this store against it):
//
//   1. the optimistic bubble reconciled on CONTENT, so any drift between what
//      was typed and what the host persists rendered the turn twice;
//   2. `chat.error` had no case at all, so a failed turn was a message with no
//      reply and no reason;
//   3. a re-delivered transcript appended a second copy of every message —
//      opening a chat asks for a replay, and the socket completing its connect
//      a moment later asks again.
describe('a turn that goes wrong, and one that arrives twice', () => {
  it('reconciles the optimistic echo on localId, not on the text', () => {
    useChatStore.getState().appendLocalUserMessage('c-live', 'hey', 'lid-1');
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-live',
      role: 'user',
      // The host persists what the transcript will yield, which is not always
      // byte-identical to what the composer sent.
      content: 'hey ',
      seq: 0,
      localId: 'lid-1',
    } as never);
    const users = (useChatStore.getState().timelines['c-live'] ?? []).filter(
      (e) => e.kind === 'message' && e.role === 'user',
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.seq).toBe(0);
  });

  it('renders a failed turn in the transcript, with its code', () => {
    useChatStore.getState().appendLocalUserMessage('c-err', 'hey', 'lid-2');
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'c-err',
      error: { code: 'sdk_error', message: 'the agent backend is not installed' },
      seq: 1,
    } as never);
    const errors = (useChatStore.getState().timelines['c-err'] ?? []).filter(
      (e) => e.kind === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.content).toMatch(/not installed/);
    expect(errors[0]?.errorCode).toBe('sdk_error');
  });

  it('does not stack the same failure when it is replayed', () => {
    const err = {
      type: 'chat.error',
      chatId: 'c-err2',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
    };
    useChatStore.getState().applyEvent(err as never);
    useChatStore.getState().applyEvent(err as never);
    expect(
      (useChatStore.getState().timelines['c-err2'] ?? []).filter((e) => e.kind === 'error'),
    ).toHaveLength(1);
  });

  it('renders a transcript once when the whole replay arrives twice', () => {
    const transcript = [
      { type: 'chat.message', chatId: 'c-dup', role: 'user', content: 'hey', seq: 0 },
      { type: 'chat.message', chatId: 'c-dup', role: 'assistant', content: 'hello back', seq: 1 },
    ];
    for (const e of transcript) useChatStore.getState().applyEvent(e as never);
    for (const e of transcript) useChatStore.getState().applyEvent(e as never);
    expect(
      (useChatStore.getState().timelines['c-dup'] ?? []).filter((e) => e.kind === 'message'),
    ).toHaveLength(2);
  });

  it('still renders two turns that happen to say the same thing', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-same',
      role: 'user',
      content: 'again?',
      seq: 0,
    } as never);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c-same',
      role: 'user',
      content: 'again?',
      seq: 2,
    } as never);
    expect(
      (useChatStore.getState().timelines['c-same'] ?? []).filter((e) => e.kind === 'message'),
    ).toHaveLength(2);
  });
});

// spec/04 § Activity — mirrors web's "a resolved daemon_unavailable notice
// clears itself". The server raises `daemon_unavailable` out-of-band when the
// host↔server link drops mid-turn, purely so the spinner unsticks; the host
// then re-sends the interrupted turn on hydrate and the chat returns to
// `running` by itself. The notice must go with the condition it describes —
// and nothing else in the transcript may go with it.
describe('a resolved daemon_unavailable notice clears itself', () => {
  function blip(): void {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c-blip',
      folder: '~/p',
    } as never);
    s.appendLocalUserMessage('c-blip', 'do the thing', 'lid-1');
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c-blip',
      error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
      seq: -1,
    } as never);
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c-blip',
      permissionMode: 'auto',
      activity: 'errored',
      lastUpdated: 1,
    } as never);
  }

  function errorRows() {
    return (useChatStore.getState().timelines['c-blip'] ?? []).filter((e) => e.kind === 'error');
  }

  it('holds the notice while the chat is still errored', () => {
    blip();
    expect(errorRows()).toHaveLength(1);
    expect(useChatStore.getState().chats['c-blip']?.activity).toBe('errored');
  });

  it('drops the notice and the errored state once the resumed turn reports running', () => {
    blip();
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c-blip',
      permissionMode: 'auto',
      activity: 'running',
      lastUpdated: 2,
    } as never);
    expect(errorRows()).toHaveLength(0);
    expect(useChatStore.getState().chats['c-blip']?.activity).toBe('running');
    // The user's own message survives — only the control-plane notice goes.
    expect(
      (useChatStore.getState().timelines['c-blip'] ?? []).filter((e) => e.kind === 'message'),
    ).toHaveLength(1);
  });

  it('leaves a real turn failure in place when the chat goes running again', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c-blip',
      folder: '~/p',
    } as never);
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c-blip',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
    } as never);
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c-blip',
      permissionMode: 'auto',
      activity: 'running',
      lastUpdated: 2,
    } as never);
    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0]?.errorCode).toBe('sdk_error');
  });
});

// spec/12 § What a recovery leaves behind — a turn the host re-sent is ONE
// turn, however many goes it took. The host re-sends an owed turn itself
// (restart resume, error ladder), and each re-send is a real, separately
// persisted user message, so without the fold the phone draws the same sentence
// once per attempt — the duplication Tom photographed on the desktop.
describe('a re-sent turn folds onto the bubble it already has', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  function userBubbles() {
    return (useChatStore.getState().timelines['c1'] ?? []).filter(
      (e) => e.kind === 'message' && e.role === 'user',
    );
  }

  it('draws one bubble across three attempts, not three', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'go', seq: 2 });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'go',
      seq: 7,
      retryOfSeq: 2,
    });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'go',
      seq: 12,
      retryOfSeq: 2,
    });
    expect(userBubbles()).toHaveLength(1);
    expect(userBubbles()[0]?.attempts?.map((a) => a.seq)).toEqual([2, 7, 12]);
  });

  it('leaves a message the USER re-typed alone — that is a new turn', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'go', seq: 2 });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'go', seq: 7 });
    expect(userBubbles()).toHaveLength(2);
  });
});
