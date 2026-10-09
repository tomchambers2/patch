import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deriveBadge } from '../stores/types.js';

describe('uiStore column-width persistence', () => {
  it('setSidebarWidth clamps and persists to localStorage', () => {
    useUiStore.getState().setSidebarWidth(360);
    expect(useUiStore.getState().sidebarWidth).toBe(360);
    expect(localStorage.getItem('patch.layout.sidebarWidth')).toBe('360');
    // clamps to the 200..600 range
    useUiStore.getState().setSidebarWidth(9999);
    expect(useUiStore.getState().sidebarWidth).toBe(600);
  });
});

describe('chatStore reducer', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    // The read watermark now persists to localStorage so a page reload restores
    // read rows. Clear it between cases so a persisted watermark from one test
    // (e.g. a markRead at seq 5) doesn't seed the next test's hydrate.
    localStorage.removeItem('patch.readState.v1');
  });

  it('chat.spawned adds a row', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/projects/foo',
    });
    const row = useChatStore.getState().chats['c1'];
    expect(row).toBeDefined();
    expect(row?.folder).toBe('~/projects/foo');
    expect(row?.activity).toBe('idle');
  });

  it('addLocalMessage optimistically renders the user turn, reconciled (not duplicated) on replay', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // User sends a message: it must appear immediately, before any echo —
    // the host never emits a live chat.message for the user's own input.
    s.addLocalMessage('c1', 'hello world', 'lid-1');
    let tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]?.role).toBe('user');
    expect(tl[0]?.content).toBe('hello world');
    expect(tl[0]?.localId).toBe('lid-1');
    // Assistant reply streams back live — appended, optimistic user turn stays.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: '[echo] hello world',
      seq: 1,
    });
    tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.map((e) => e.role)).toEqual(['user', 'assistant']);
    // On reconnect, chat.replay re-delivers the PERSISTED user turn. It must
    // reconcile onto the optimistic entry (promote seq, drop localId) — NOT dup.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hello world',
      seq: 0,
    });
    tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.role === 'user')).toHaveLength(1);
    expect(tl.find((e) => e.role === 'user')?.seq).toBe(0);
    expect(tl.find((e) => e.role === 'user')?.localId).toBeUndefined();
  });

  // spec/08 § Action, spec/14 § Job trigger turn — the wire field rides onto
  // the timeline entry untouched, same additive-field pattern as `compaction`
  // and `systemContext`.
  it('chat.message carries jobTrigger onto the timeline entry', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '{"route":"36","etaMinutes":4}',
      seq: 0,
      jobTrigger: true,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.jobTrigger).toBe(true);
  });

  it('chat.message with no jobTrigger leaves the field absent', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hello',
      seq: 0,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.jobTrigger).toBeUndefined();
  });

  it('voice call echo: a persisted turn arriving BEFORE the client transcript-final echo is not duplicated ({dedupeAgainstPersisted: true})', () => {
    const s = useChatStore.getState();
    // The host's own turn-persist + broadcast can win the race against the
    // audio WSS's onTranscriptFinal callback that drives this echo — the
    // host mints its own localId, so there's nothing here to reconcile by
    // localId, only content.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[voice • web] what time is it',
      seq: 3,
    });
    s.addLocalMessage('c1', 'what time is it', 'lid-voice-1', undefined, undefined, {
      dedupeAgainstPersisted: true,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.role === 'user')).toHaveLength(1);
  });

  it("marks words said in a call, the user's and the voice's, and strips the host tag", () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[voice • web] what is a nebula',
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: '[voice • web] A cloud of gas.',
      seq: 2,
    });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'typed', seq: 3 });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[voice hand-off • web] list the files',
      seq: 4,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const by = (seq: number) => tl.find((e) => e.seq === seq);
    expect(by(1)).toMatchObject({ content: 'what is a nebula', voice: true });
    expect(by(2)).toMatchObject({ content: 'A cloud of gas.', voice: true });
    expect(by(3)?.voice).toBeUndefined();
    // A hand-off's request is not spoken words: it has its own line.
    expect(by(4)?.voice).toBeUndefined();
    expect(by(4)?.voiceHandoff).toBe(true);
  });

  it("marks the agent's answer to a hand-off as said in the call, and a typed answer as not", () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[voice hand-off • web] list the files',
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'There are ten files.',
      seq: 2,
    });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'typed', seq: 3 });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'A typed answer.',
      seq: 4,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.seq === 2)?.voice).toBe(true);
    expect(tl.find((e) => e.seq === 4)?.voice).toBeUndefined();
  });

  it("your spoken words are marked whichever arrives first: the live echo or the host's tagged copy", () => {
    const s = useChatStore.getState();
    // The echo first, then the host's persisted copy folds into it.
    s.addLocalMessage('c1', 'what time is it', 'lid-1', undefined, undefined, {
      dedupeAgainstPersisted: true,
    });
    expect(useChatStore.getState().timelines['c1']?.[0]?.voice).toBe(true);
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[voice • web] what time is it',
      seq: 5,
      localId: 'lid-1',
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.role === 'user')).toHaveLength(1);
    expect(tl[0]).toMatchObject({ content: 'what time is it', seq: 5, voice: true });
    // An ordinary typed message folded the same way is not marked.
    s.addLocalMessage('c1', 'typed', 'lid-2');
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'typed',
      seq: 6,
      localId: 'lid-2',
    });
    expect(
      useChatStore.getState().timelines['c1']?.find((e) => e.seq === 6)?.voice,
    ).toBeUndefined();
  });

  it('a typed repeat send with content matching an earlier persisted message is NOT deduped (no dedupeAgainstPersisted)', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'ok',
      seq: 1,
    });
    // The composer never passes dedupeAgainstPersisted — a genuine repeat
    // send of identical text must still render as its own message.
    s.addLocalMessage('c1', 'ok', 'lid-repeat');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.role === 'user')).toHaveLength(2);
  });

  it('ensureChat seeds an optimistic row (voice-starts-a-chat) and never clobbers an existing one', () => {
    const s = useChatStore.getState();
    s.ensureChat('c_voice', '~/projects/portfolio');
    expect(useChatStore.getState().chats['c_voice']?.folder).toBe('~/projects/portfolio');
    // A second call (or a later chat.state) must not reset the row.
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c_voice',
      activity: 'running',
      lastUpdated: 5,
    });
    s.ensureChat('c_voice', '~/somewhere-else');
    const row = useChatStore.getState().chats['c_voice'];
    expect(row?.folder).toBe('~/projects/portfolio'); // unchanged
    expect(row?.activity).toBe('running'); // preserved
  });

  it('addLocalMessage seeds an optimistic row for a brand-new chat (no "not found yet" flash)', () => {
    const s = useChatStore.getState();
    // The `+ New chat` flow navigates to /chats/<id> the instant createChat
    // returns — BEFORE the host's chat.spawned lands. Without an optimistic
    // row, ChatRoute would render "Chat <id> not found yet". The seeded row
    // (with the chosen folder) makes the transcript render immediately.
    s.addLocalMessage('c_new', 'first turn', 'lid-new', '~/projects/portfolio');
    const row = useChatStore.getState().chats['c_new'];
    expect(row).toBeDefined();
    expect(row?.folder).toBe('~/projects/portfolio');
    expect(row?.preview).toBe('first turn');
    // chat.spawned then reconciles the row in place (no duplicate, folder kept).
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c_new',
      folder: '~/projects/portfolio',
    });
    expect(Object.keys(useChatStore.getState().chats).filter((id) => id === 'c_new')).toHaveLength(
      1,
    );
    expect(useChatStore.getState().chats['c_new']?.folder).toBe('~/projects/portfolio');
  });

  it('chat.message_delta accumulates progressively, then chat.message finalises in place (no duplicate)', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });

    // Deltas stream in for an in-flight assistant turn (messageSeq 0).
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 0, delta: 'The ' });
    let tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]?.role).toBe('assistant');
    expect(tl[0]?.content).toBe('The ');
    expect(tl[0]?.streaming).toBe(true);

    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 0, delta: 'cat ' });
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 0, delta: 'sat.' });
    tl = useChatStore.getState().timelines['c1'] ?? [];
    // Still a SINGLE accumulating entry — the reply grew progressively.
    expect(tl).toHaveLength(1);
    expect(tl[0]?.content).toBe('The cat sat.');
    expect(tl[0]?.streaming).toBe(true);
    // The sidebar preview is the durable first-user-message label, NOT the live
    // assistant text — with no user message on this chat yet, it stays null
    // rather than flipping to the streaming reply.
    expect(useChatStore.getState().chats['c1']?.preview).toBeNull();

    // Final durable chat.message at the same seq finalises in place.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'The cat sat.',
      seq: 0,
    });
    tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1); // not duplicated
    expect(tl[0]?.content).toBe('The cat sat.');
    expect(tl[0]?.streaming).toBe(false); // caret cleared
    expect(tl[0]?.seq).toBe(0);
  });

  it('chat.message_delta on a resumed chat does NOT collide with replayed history at the same seq', () => {
    // Regression: a resumed chat's replayed messages carry line-index-derived
    // seqs (history.ts KNOWN LIMITATION) that can equal a NEW turn's canonical
    // messageSeq. Matching the streaming accumulator by seq would append the
    // new reply onto an OLD message; it must match by the `streaming` flag.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // Replayed history: an older assistant turn at seq 1.
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'old q', seq: 0 });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'OLD ANSWER',
      seq: 1,
    });

    // New live turn streams in — its canonical messageSeq happens to be 1 too.
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'new q', seq: 1 });
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'New ' });
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'answer.' });

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    // The OLD answer is untouched; a NEW streaming entry was appended.
    const oldEntry = tl.find((e) => e.content === 'OLD ANSWER');
    expect(oldEntry).toBeDefined();
    expect(oldEntry?.streaming).toBeUndefined();
    const streamingEntry = tl.find((e) => e.streaming === true);
    expect(streamingEntry?.content).toBe('New answer.');
    // No assistant message was overwritten — both answers coexist.
    expect(tl.filter((e) => e.role === 'assistant')).toHaveLength(2);

    // Final chat.message finalises the streaming entry in place (not the old one).
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'New answer.',
      seq: 1,
    });
    const tl2 = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl2.filter((e) => e.role === 'assistant')).toHaveLength(2);
    expect(tl2.find((e) => e.content === 'OLD ANSWER')).toBeDefined();
    expect(tl2.find((e) => e.content === 'New answer.')?.streaming).toBe(false);
  });

  it('sidebar preview is a STABLE first-user-message label — never flips to later assistant/user text', () => {
    // Bug ("Preview on left message is flipping around"): the sidebar row
    // preview is the host's durable first-user-message snippet (chatRunner
    // captures it once and never overwrites it — it labels archived rows that
    // carry no live timeline). The store must mirror that: streaming assistant
    // deltas, the finalised assistant message, and any LATER user message must
    // all leave the preview untouched, or the left-hand label flips as a turn
    // runs.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });

    // The first user message becomes the durable preview.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'fix the bug',
      seq: 0,
    });
    expect(useChatStore.getState().chats['c1']?.preview).toBe('fix the bug');

    // Assistant streams a reply — preview must NOT flip to the assistant text.
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'Working ' });
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'on it.' });
    expect(useChatStore.getState().chats['c1']?.preview).toBe('fix the bug');

    // The finalised assistant message must NOT flip it either.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'Working on it.',
      seq: 1,
    });
    expect(useChatStore.getState().chats['c1']?.preview).toBe('fix the bug');

    // A LATER user message must NOT replace the durable first-message label.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'also add tests',
      seq: 2,
    });
    expect(useChatStore.getState().chats['c1']?.preview).toBe('fix the bug');

    // And a host chat.state carrying the durable preview keeps it pinned.
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 9,
      preview: 'fix the bug',
    });
    expect(useChatStore.getState().chats['c1']?.preview).toBe('fix the bug');
  });

  it('chat.state updates an existing row', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/projects/foo',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'awaiting-permission',
      lastUpdated: 123,
      pinned: true,
      pinnedAt: 100,
      disabled: false,
      name: 'fix the layout',
    });
    const row = useChatStore.getState().chats['c1'];
    expect(row?.activity).toBe('awaiting-permission');
    expect(row?.awaitingPermission).toBe(true);
    expect(row?.pinned).toBe(true);
    expect(row?.pinnedAt).toBe(100);
    expect(row?.name).toBe('fix the layout');
    expect(deriveBadge(row!)).toBe('permission');
  });

  it('chat.state carries the current-status summary + kind, and only an OMITTED field is preserved', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // New row defaults to no status.
    expect(useChatStore.getState().chats['c1']?.statusSummary).toBeNull();
    expect(useChatStore.getState().chats['c1']?.statusKind).toBeNull();

    // A chat.state carrying a status sets it.
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 10,
      statusSummary: 'Waiting on which branch to deploy',
      statusKind: 'question',
    });
    let row = useChatStore.getState().chats['c1'];
    expect(row?.statusSummary).toBe('Waiting on which branch to deploy');
    expect(row?.statusKind).toBe('question');

    // A later chat.state that OMITS the status fields (back-compat payload) must
    // NOT wipe the known status.
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 11,
    });
    row = useChatStore.getState().chats['c1'];
    expect(row?.statusSummary).toBe('Waiting on which branch to deploy');
    expect(row?.statusKind).toBe('question');

    // A new turn settling with a fresh status overwrites it (complete now).
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 12,
      statusSummary: 'Deployed to staging, nothing outstanding',
      statusKind: 'complete',
    });
    row = useChatStore.getState().chats['c1'];
    expect(row?.statusSummary).toBe('Deployed to staging, nothing outstanding');
    expect(row?.statusKind).toBe('complete');
  });

  it('chat.state carries the task list, and an OMITTED list is preserved (spec/02 § Task list)', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    expect(useChatStore.getState().chats['c1']?.todos).toEqual([]);

    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 10,
      todos: [
        { text: 'rebuild the index', status: 'in_progress' as const },
        { text: 'schedule it nightly', status: 'pending' as const },
      ],
    });
    expect(useChatStore.getState().chats['c1']?.todos).toEqual([
      { text: 'rebuild the index', status: 'in_progress' },
      { text: 'schedule it nightly', status: 'pending' },
    ]);

    // A back-compat payload that omits `todos` must not wipe the known list…
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 11,
    });
    expect(useChatStore.getState().chats['c1']?.todos).toHaveLength(2);

    // …but an explicitly EMPTY list clears it (the agent finished/dropped it).
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 12,
      todos: [],
    });
    expect(useChatStore.getState().chats['c1']?.todos).toEqual([]);
  });

  it('setTodos replaces the row’s task list wholesale', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.setTodos('c1', [{ text: 'benchmark it', status: 'pending' }]);
    expect(useChatStore.getState().chats['c1']?.todos).toEqual([
      { text: 'benchmark it', status: 'pending' },
    ]);
    s.setTodos('c1', []);
    expect(useChatStore.getState().chats['c1']?.todos).toEqual([]);
  });

  it('local archive flips status optimistically', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
    });
    useChatStore.getState().setArchived('c1', true);
    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    useChatStore.getState().setArchived('c1', false);
    expect(useChatStore.getState().chats['c1']?.status).toBe('active');
  });

  it('setDeleted flips status to deleted / active optimistically, and is a no-op for an unknown chat (E5)', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().setDeleted('c1', true);
    expect(useChatStore.getState().chats['c1']?.status).toBe('deleted');
    useChatStore.getState().setDeleted('c1', false);
    expect(useChatStore.getState().chats['c1']?.status).toBe('active');
    expect(() => useChatStore.getState().setDeleted('never-seen', true)).not.toThrow();
  });

  it('chat.permission_request queues a pending permission', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: { cmd: 'rm' }, description: 'delete temp file' },
      seq: 1,
    });
    const row = useChatStore.getState().chats['c1'];
    expect(row?.awaitingPermission).toBe(true);
    expect(row?.pendingPermissions[0]?.tool).toBe('Bash');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.kind).toBe('permission');
  });

  it("carries the request's expiry deadline onto the card's timeline entry", () => {
    // The question card counts down to the HOST's deadline (spec/02
    // § Questions are not approvals). Dropping it here would leave the card
    // with nothing to count to and no ring at all.
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', args: { questions: [] } },
      seq: 1,
      expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.permissionExpiry).toEqual({ at: 1_700_000_060_000, windowMs: 60_000 });
  });

  it('leaves the entry without a deadline when the request carries none', () => {
    // Expiry turned off on the host. Absent must stay absent — a zero or a
    // far-future instant would both draw a countdown to nothing.
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
    });
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', args: { questions: [] } },
      seq: 1,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]).not.toHaveProperty('permissionExpiry');
  });

  it('a trailing idle chat.state does NOT clear an unresolved permission', () => {
    // Repro of the badge regression: the mock backend / SDK under
    // bypassPermissions emits the permission event then completes the turn,
    // so a `chat.state activity:idle` arrives while the prompt is still
    // unanswered. The badge + waiting-pill must stay on `permission`.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Edit', args: {}, description: 'Edit a file' },
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 9,
    });
    const row = useChatStore.getState().chats['c1']!;
    expect(row.awaitingPermission).toBe(true);
    expect(row.activity).toBe('awaiting-permission');
    expect(deriveBadge(row)).toBe('permission');
  });

  it('resolvePermission clears the pending permission + badge + marks the card', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Edit', args: {}, description: 'Edit a file' },
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 9,
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    const row = useChatStore.getState().chats['c1']!;
    expect(row.pendingPermissions).toHaveLength(0);
    expect(row.awaitingPermission).toBe(false);
    expect(deriveBadge(row)).not.toBe('permission');
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
  });

  // Tom: approved a Bash call, then interrupted before it landed, and the card
  // flipped to Denied. The host's deny echo (the interrupt cancelling the
  // request) must not relabel a card the user already approved.
  it('a deny echo after an approval keeps the card Approved and marks it cancelled', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: {}, description: 'Run the cases' },
      seq: 1,
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    useChatStore.getState().resolvePermission('c1', 'r1', 'deny');
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
    expect(card?.permissionCancelled).toBe(true);
  });

  // spec/14 § Main chat panel — Question prompts. `permissionAnswers` is the
  // durable record of what an AskUserQuestion was resolved with — without it,
  // a resolved card's picked options lived only in the component's own local
  // state and were gone the moment it remounted.
  it('resolvePermission stores the answers an AskUserQuestion was resolved with', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', args: { questions: [] }, description: 'ask' },
      seq: 1,
    });
    useChatStore
      .getState()
      .resolvePermission('c1', 'r1', 'approve', { 'Which library?': 'date-fns' });
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionResolved).toBe('approve');
    expect(card?.permissionAnswers).toEqual({ 'Which library?': 'date-fns' });
  });

  it('resolvePermission leaves permissionAnswers unset when no answers are given', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Edit', args: {}, description: 'Edit a file' },
      seq: 1,
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    const card = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.kind === 'permission',
    );
    expect(card?.permissionAnswers).toBeUndefined();
  });

  it('chat.state with status:archived flips a chat into archived', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      status: 'archived',
      lastUpdated: 5,
    });
    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
  });

  it('removeChat drops the row + timeline', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hi',
      seq: 1,
    });
    useChatStore.getState().removeChat('c1');
    expect(useChatStore.getState().chats['c1']).toBeUndefined();
    expect(useChatStore.getState().timelines['c1']).toBeUndefined();
  });

  // A refused spawn (spec/04 § Spawn). The host's `chat.error` is fanned out
  // to every surface under the allocated chatId, and the reducer builds a row
  // for a chatId it has never seen — which is what left a "New chat" row in the
  // sidebar per failed spawn, for a chat absent from GET /api/chats.
  it('retractChat drops a refused spawn and a LATE chat.error cannot rebuild it', () => {
    const s = useChatStore.getState();
    // The fanned-out refusal lands first and seeds the ghost row.
    s.applyEvent({
      type: 'chat.error',
      chatId: 'ghost-1',
      error: { code: 'no_model_catalogue', message: 'no last-used model on d1' },
      seq: -1,
    });
    expect(useChatStore.getState().chats['ghost-1']).toBeDefined();

    // The POST's 400 names the id to retract.
    useChatStore.getState().retractChat('ghost-1');
    expect(useChatStore.getState().chats['ghost-1']).toBeUndefined();
    expect(useChatStore.getState().timelines['ghost-1']).toBeUndefined();

    // The WS frame and the HTTP response race — a duplicate/late refusal for a
    // retracted chat must not draw the row again.
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'ghost-1',
      error: { code: 'no_model_catalogue', message: 'no last-used model on d1' },
      seq: -1,
    });
    expect(useChatStore.getState().chats['ghost-1']).toBeUndefined();
    expect(useChatStore.getState().timelines['ghost-1']).toBeUndefined();

    // Retraction is scoped to the one chat: every other chat still applies.
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '~/p' });
    expect(useChatStore.getState().chats['c2']).toBeDefined();
  });

  // A host refusal with no chat of its own (`host.update` finding no artifact)
  // is addressed to the `pending-spawn` sentinel. It is a toast, never a chat:
  // `ensureRow` used to draw it as a stray "New chat" in the sidebar.
  it('a chat.error for pending-spawn does not draw a chat row', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'pending-spawn',
      error: { code: 'invalid_frame', message: 'host.update: machine d1 did not update' },
      seq: -1,
    });
    expect(useChatStore.getState().chats['pending-spawn']).toBeUndefined();
    expect(useChatStore.getState().timelines['pending-spawn']).toBeUndefined();
  });

  // `_reset` clears the tombstones too — without it a chatId retracted by one
  // test would stay ignored for the rest of the file (one jsdom window, one
  // module instance).
  it('retraction does not leak across a _reset', () => {
    useChatStore.getState().retractChat('c1');
    useChatStore.getState()._reset();
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    expect(useChatStore.getState().chats['c1']).toBeDefined();
  });

  it('deriveBadge maps activities correctly', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 1,
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('working');
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
    });
    // unvisited & lastSeq(0) > lastReadSeq(-1) → done
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('done');
    useChatStore.getState().markRead('c1');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
  });

  it('opening (markRead) flips an unread chat to read, by seq watermark', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'done!',
      seq: 5,
    });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 100,
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('done');
    // A visit marks it read.
    useChatStore.getState().markRead('c1');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
    expect(useChatStore.getState().chats['c1']!.lastReadSeq).toBe(5);
  });

  it('a chat.replay of old events does NOT re-mark a read chat unread', () => {
    // Reproduces the original bug: opening a chat triggers a chat.replay that
    // re-delivers the whole history. Under the old wall-clock model every
    // replayed chat.message bumped lastUpdated to "now", out-running the visit
    // timestamp and perpetually showing `done`. The seq watermark is immune.
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'finished',
      seq: 3,
    });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 50,
    });
    useChatStore.getState().markRead('c1');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');

    // Now replay the same history (same seqs) — as happens on open / reconnect.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hi',
      seq: 1,
    });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'finished',
      seq: 3,
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
  });

  it('genuinely new activity (higher seq) re-marks a read chat unread', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'first',
      seq: 2,
    });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 10,
    });
    useChatStore.getState().markRead('c1');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
    // A brand-new message with a higher seq arrives while the chat is NOT active.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'new result',
      seq: 7,
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('done');
  });

  it('hydrate on an already-known chat with no persisted watermark keeps its in-memory lastReadSeq', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // Never marked read, so localStorage carries no watermark for c1.
    s.hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 5,
      },
    ]);
    expect(useChatStore.getState().chats['c1']?.lastReadSeq).toBe(-1);
  });

  it('a REST refetch (hydrate) preserves read state for known chats', () => {
    // Reproduces the roster-wide "zero read badges" bug: hydrate runs on every
    // GET /api/chats (including React Query refetches), and used to rebuild rows
    // from defaults, wiping lastReadSeq/lastSeq back to unread.
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'result',
      seq: 4,
    });
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 20,
    });
    useChatStore.getState().markRead('c1');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');

    // Refetch arrives (no seq in the REST payload).
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 20,
      },
    ]);
    // Still read — the watermark and lastSeq survived the refetch.
    const row = useChatStore.getState().chats['c1']!;
    expect(row.lastReadSeq).toBe(4);
    expect(row.lastSeq).toBe(4);
    expect(deriveBadge(row)).toBe('read');
  });

  it('events arriving in the active chat keep it read (seen while open)', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().setActiveChat('c1'); // open it
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
    // A post-open chat.replay raises lastSeq while the chat is active — must
    // stay read, not flip to done.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'replayed history',
      seq: 9,
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
  });

  it('a chat finishing while its tab is backgrounded still goes done, not read', () => {
    // The route that owns `activeChatId` only unmounts on navigation — it
    // stays mounted (and `activeChatId` stays pointed at it) while the tab or
    // window is merely backgrounded (phone locked, switched app, occluded
    // desktop window). Without a visibility check, every event the still-"active"
    // chat received while nobody was looking — including the one that finished
    // it — pinned the read watermark to lastSeq, so the sidebar never showed
    // the green `done` dot at all: it went straight from `working` to `read`.
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().setActiveChat('c1'); // open it while visible
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      // The turn finishes while the tab is backgrounded.
      useChatStore.getState().applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'finished while you were away',
        seq: 3,
      });
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    }

    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('done');
  });

  it('a visit marks read DURABLY — a reload (fresh store + hydrate) restores read', () => {
    // Build an unread chat with activity at seq 7.
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'done',
      seq: 7,
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('done');

    // Visit it — marks read and persists the watermark to localStorage.
    useChatStore.getState().setActiveChat('c1');
    useChatStore.getState().setActiveChat(null);
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('read');
    expect(JSON.parse(localStorage.getItem('patch.readState.v1')!)['c1']).toBe(7);

    // Simulate a page reload: in-memory store is wiped; only the REST snapshot
    // (no seq, no read state) comes back. Without persistence the chat would
    // revert to `done` — the bug spec/14 forbids.
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 20,
      },
    ]);
    const row = useChatStore.getState().chats['c1']!;
    expect(row.lastReadSeq).toBe(7);
    // lastSeq from emptyRow is 0 (REST carries none) — read because the
    // persisted watermark (7) is not exceeded by any seen seq.
    expect(deriveBadge(row)).toBe('read');
  });

  // `openToolCalls` is a client-side counter, decremented only by a tool_result.
  // A result that never arrives (call replayed without its result, turn died
  // mid-call) used to leave the row on `working` after the host reported the
  // chat idle or errored — nothing is in flight once the turn has ended.
  it.each(['idle', 'errored'] as const)(
    'an unanswered tool call does not hold the row on working once the chat is %s',
    (activity) => {
      const s = useChatStore.getState();
      s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
      s.applyEvent({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: 1,
        tool: 'Bash',
        args: { command: 'ls' },
        callId: 'call-1',
      });
      expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('working');
      s.applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity,
        lastUpdated: 2,
      });
      expect(useChatStore.getState().chats['c1']!.openToolCalls).toBe(0);
      expect(deriveBadge(useChatStore.getState().chats['c1']!)).not.toBe('working');
    },
  );

  // A replay re-delivers an old call that never got a result (cancelled, or the
  // turn died). Into a chat the host already reports idle, no `chat.state`
  // follows to clear the count, so the row sat orange on a finished chat.
  it('a replayed unanswered tool call does not make an idle chat working', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 5,
    });
    s.applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      args: { command: 'ls' },
      callId: 'call-1',
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).not.toBe('working');
  });

  it('a REST snapshot reporting idle clears a leaked open-call count', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 1,
    });
    s.applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      args: { command: 'ls' },
      callId: 'call-1',
    });
    s.hydrate([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 10,
      },
    ]);
    expect(useChatStore.getState().chats['c1']!.openToolCalls).toBe(0);
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).not.toBe('working');
  });

  // A stale snapshot (a replayed `chat.state`, a REST refetch that raced a
  // newer frame) carries an older `lastUpdated` than the row already holds. It
  // must not roll `activity` back: that drew the read tick on a chat that was
  // working, and orange on one that had finished.
  it('a stale chat.state does not roll activity back', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const state = (activity: 'idle' | 'running', lastUpdated: number) =>
      s.applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity,
        lastUpdated,
      });
    state('running', 20);
    state('idle', 10);
    expect(useChatStore.getState().chats['c1']!.activity).toBe('running');
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('working');
    state('idle', 30);
    expect(useChatStore.getState().chats['c1']!.activity).toBe('idle');
  });

  it('a stale REST refetch (hydrate) does not roll activity back', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 20,
    });
    const row = useChatStore.getState().chats['c1']!;
    s.hydrate([{ ...row, activity: 'idle', lastUpdated: 10 }]);
    expect(useChatStore.getState().chats['c1']!.activity).toBe('running');
    s.hydrate([{ ...row, activity: 'idle', lastUpdated: 30 }]);
    expect(useChatStore.getState().chats['c1']!.activity).toBe('idle');
  });

  it('chat.tool_call and chat.tool_result append timeline entries and bump lastSeq', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'Bash',
      args: { command: 'ls' },
      callId: 'call-1',
    });
    let tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]).toMatchObject({ kind: 'tool_call', tool: 'Bash', callId: 'call-1' });
    expect(useChatStore.getState().chats['c1']?.lastSeq).toBe(1);

    s.applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 2,
      tool: 'Bash',
      result: { stdout: 'ok' },
      callId: 'call-1',
    });
    tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[1]).toMatchObject({ kind: 'tool_result', tool: 'Bash', callId: 'call-1' });
    expect(useChatStore.getState().chats['c1']?.lastSeq).toBe(2);
  });

  it('the same tool call arriving again at a different seq renders once', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const call = (seq: number) =>
      ({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq,
        tool: 'Bash',
        args: { command: 'ls' },
        callId: 'call-1',
      }) as const;
    s.applyEvent(call(1));
    s.applyEvent(call(2));
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'tool_call')).toHaveLength(1);
  });

  it('a re-delivered chat.replay does not duplicate tool_call/tool_result entries onto the tail (out of message order)', () => {
    // ws.ts § requestReplay: "opening a chat requests its transcript, and the
    // socket completing its connect a moment later requests every held chat —
    // the active chat included, timeline still empty. Both computed
    // `fromSeq: -1`, so the host streamed the whole transcript twice. The
    // store now folds a re-delivered turn onto its canonical seq" — true for
    // `chat.message` (matched by seq+role+content) but `chat.tool_call` /
    // `chat.tool_result` had no such reconciliation and were unconditionally
    // appended, so a re-delivered replay stacked a second copy of each at the
    // TAIL of the timeline — after the (correctly deduped) later message —
    // which is exactly "tool calls not shown in message order".
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const deliverTurn = () => {
      s.applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'ls the repo',
        seq: 0,
      });
      s.applyEvent({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: 1,
        tool: 'Bash',
        args: { command: 'ls' },
        callId: 'call-1',
      });
      s.applyEvent({
        type: 'chat.tool_result',
        chatId: 'c1',
        seq: 2,
        tool: 'Bash',
        result: { stdout: 'ok' },
        callId: 'call-1',
      });
      s.applyEvent({
        type: 'chat.message',
        chatId: 'c1',
        role: 'assistant',
        content: 'done.',
        seq: 3,
      });
    };
    // Two replays of the same full history, racing in on the same connect
    // (both `fromSeq: -1`) — exactly the scenario ws.ts documents.
    deliverTurn();
    deliverTurn();

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.map((e) => e.kind)).toEqual(['message', 'tool_call', 'tool_result', 'message']);
    expect(tl.filter((e) => e.kind === 'tool_call')).toHaveLength(1);
    expect(tl.filter((e) => e.kind === 'tool_result')).toHaveLength(1);
  });

  it('a re-delivered chat.permission_request does not draw a second Approve/Deny card', () => {
    // Same re-delivered-replay class as the tool_call/tool_result case above,
    // but the permission event reaches it by a WIDER path: `replayChat` in the
    // host (G2-d1) re-emits the canonical `chat.permission_request` for every
    // STILL-PENDING permission on the chat, unconditionally — it is not gated
    // on the replay's `fromSeq` the way the transcript events are. So ANY
    // second replay re-delivers it, not just two racing from `fromSeq: -1`:
    // leaving a chat with a pending Write approval and coming back re-asks from
    // a further-on cursor, and the card arrived twice. `requestId` is the
    // identity (`randomUUID()` per request in the host's `askPermission`),
    // and it must dedup BOTH the timeline card and `pendingPermissions` — a
    // doubled `pendingPermissions` entry also inflates the awaiting-permission
    // state and the `2` "Approve all outstanding" sweep.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const deliverPermission = () => {
      s.applyEvent({
        type: 'chat.permission_request',
        chatId: 'c1',
        requestId: 'req-1',
        request: {
          tool: 'Write',
          args: { file_path: '/tmp/x.ts', content: 'hi' },
          description: 'Write /tmp/x.ts',
        },
        seq: 1,
      });
    };
    deliverPermission();
    deliverPermission();

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'permission')).toHaveLength(1);
    const row = useChatStore.getState().chats['c1'];
    expect(row?.pendingPermissions).toHaveLength(1);
    expect(row?.pendingPermissions[0]?.requestId).toBe('req-1');
    // The state the single card drives is still correct after the dedup.
    expect(row?.awaitingPermission).toBe(true);
    expect(row?.activity).toBe('awaiting-permission');
  });

  // spec/14 § Side threads panel — a side branch's own question must not leak
  // into the main transcript, which draws only the active branch's track.
  it('a permission_request tagged with a non-active branch is kept out of the main view, in sideThreadPermissions instead', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
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
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'side-req-1',
      request: { tool: 'Bash', args: { cmd: 'ls' }, description: 'list files' },
      seq: 1,
      branchId: 'c1-b1',
    });

    const row = useChatStore.getState().chats['c1'];
    expect(row?.pendingPermissions).toHaveLength(0);
    expect(row?.awaitingPermission).toBeFalsy();
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'permission')).toHaveLength(0);

    const sidePerms = useChatStore.getState().sideThreadPermissions['c1::c1-b1'];
    expect(sidePerms).toHaveLength(1);
    expect(sidePerms?.[0]?.requestId).toBe('side-req-1');
    expect(sidePerms?.[0]?.tool).toBe('Bash');

    // Resolving it removes it from the side-thread map without touching the
    // (empty) main pendingPermissions.
    useChatStore.getState().resolveSideThreadPermission('c1', 'c1-b1', 'side-req-1');
    expect(useChatStore.getState().sideThreadPermissions['c1::c1-b1']).toHaveLength(0);
  });

  it('a permission_request tagged with the ACTIVE branch renders in the main view exactly as before branches existed', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.branches',
      chatId: 'c1',
      activeBranchId: 'c1-b0',
      branches: [
        { branchId: 'c1-b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
      ],
    });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'main-req-1',
      request: { tool: 'Bash', args: { cmd: 'ls' }, description: 'list files' },
      seq: 1,
      branchId: 'c1-b0',
    });
    const row = useChatStore.getState().chats['c1'];
    expect(row?.pendingPermissions).toHaveLength(1);
    expect(row?.pendingPermissions[0]?.requestId).toBe('main-req-1');
  });

  it("a replay racing the user's answer does not resurrect a resolved permission card", () => {
    // `resolvePermission` optimistically empties `pendingPermissions`, so a
    // replay arriving just after the user hit Approve finds that list clear.
    // The timeline half of the guard is what has to catch it — the resolved
    // card is still in the transcript — or the re-delivery would draw a fresh,
    // still-actionable Approve/Deny for a request already decided.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const event = {
      type: 'chat.permission_request' as const,
      chatId: 'c1',
      requestId: 'req-1',
      request: { tool: 'Write', args: { file_path: '/tmp/x.ts' }, description: 'Write /tmp/x.ts' },
      seq: 1,
    };
    s.applyEvent(event);
    useChatStore.getState().resolvePermission('c1', 'req-1', 'approve');
    expect(useChatStore.getState().chats['c1']?.pendingPermissions).toHaveLength(0);

    // The host replays the chat; the permission comes with it.
    s.applyEvent(event);

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const cards = tl.filter((e) => e.kind === 'permission');
    expect(cards).toHaveLength(1);
    // Still resolved — not re-armed as a live request.
    expect(cards[0]?.permissionResolved).toBe('approve');
    expect(useChatStore.getState().chats['c1']?.pendingPermissions).toHaveLength(0);
  });

  it('two DIFFERENT permission requests both render — dedup is per requestId, not per chat', () => {
    // Guard against over-deduping: a turn can legitimately pause on more than
    // one approval at once, which is the whole reason `pendingPermissions` is a
    // list and "Approve all outstanding" exists.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'req-1',
      request: { tool: 'Write', args: { file_path: '/tmp/a.ts' } },
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'req-2',
      request: { tool: 'Edit', args: { file_path: '/tmp/b.ts' } },
      seq: 2,
    });

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'permission')).toHaveLength(2);
    expect(useChatStore.getState().chats['c1']?.pendingPermissions).toHaveLength(2);
  });

  it('chat.message with attachments carries them onto the timeline entry', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const attachments = [
      { id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' as const },
    ];
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'see attached',
      seq: 1,
      attachments,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.attachments).toEqual(attachments);
  });

  it('resolvePermission is a no-op when the chat row does not exist', () => {
    expect(() =>
      useChatStore.getState().resolvePermission('never-seen', 'r1', 'approve'),
    ).not.toThrow();
  });

  it('resolvePermission leaves non-matching timeline entries untouched and no-ops with no timeline', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'before the permission card',
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Edit', args: {}, description: 'Edit a file' },
      seq: 2,
    });
    s.resolvePermission('c1', 'r1', 'deny');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    // The unrelated user-message entry passed through unchanged.
    expect(tl.find((e) => e.kind === 'message')?.permissionResolved).toBeUndefined();
    expect(tl.find((e) => e.kind === 'permission')?.permissionResolved).toBe('deny');

    // A row with pending permissions but literally no timeline entries at all
    // (defensive branch: `existing` is undefined).
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '~/p' });
    useChatStore.setState((st) => {
      const row = st.chats['c2']!;
      return {
        chats: {
          ...st.chats,
          c2: {
            ...row,
            pendingPermissions: [{ requestId: 'rX', tool: 'Bash', description: 'x', args: {} }],
          },
        },
      };
    });
    expect(() => useChatStore.getState().resolvePermission('c2', 'rX', 'approve')).not.toThrow();
  });

  it("updatePermissionExpiry moves the question card's countdown to a live reset (spec/02 § Questions are not approvals)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', args: { questions: [] } },
      seq: 1,
      expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
    });
    s.updatePermissionExpiry('c1', 'r1', { at: 1_700_000_120_000, windowMs: 60_000 });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.permissionExpiry).toEqual({ at: 1_700_000_120_000, windowMs: 60_000 });
  });

  it('updatePermissionExpiry does not touch an already-resolved card', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'AskUserQuestion', args: { questions: [] } },
      seq: 1,
      expiry: { at: 1_700_000_060_000, windowMs: 60_000 },
    });
    s.resolvePermission('c1', 'r1', 'approve');
    // A reset that lost the race with the answer must not revive the card's
    // countdown after it has already settled.
    s.updatePermissionExpiry('c1', 'r1', { at: 1_700_000_120_000, windowMs: 60_000 });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.permissionExpiry).toEqual({ at: 1_700_000_060_000, windowMs: 60_000 });
  });

  it('updatePermissionExpiry no-ops for a chat with no timeline at all', () => {
    expect(() =>
      useChatStore.getState().updatePermissionExpiry('never-seen', 'r1', {
        at: 1_700_000_060_000,
        windowMs: 60_000,
      }),
    ).not.toThrow();
  });

  it('mergeChats folds new rows in WITHOUT dropping chats already present', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'seen already',
      seq: 3,
    });
    s.markRead('c1');

    s.mergeChats([
      {
        chatId: 'c-archived',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'old thread',
        folder: '~/old',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 9,
      },
    ]);
    const state = useChatStore.getState();
    // The pre-existing chat is untouched.
    expect(state.chats['c1']?.lastReadSeq).toBe(3);
    // The new archived row was folded in.
    expect(state.chats['c-archived']?.folder).toBe('~/old');
    expect(state.chats['c-archived']?.status).toBe('archived');
  });

  it('mergeChats refreshes server-authoritative fields on an already-known chat and preserves its read watermark', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hi',
      seq: 5,
    });
    s.markRead('c1');
    s.mergeChats([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'renamed',
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 42,
        disabled: false,
        lastUpdated: 100,
      },
    ]);
    const row = useChatStore.getState().chats['c1']!;
    expect(row.name).toBe('renamed');
    expect(row.pinned).toBe(true);
    expect(row.lastReadSeq).toBe(5); // preserved, not reset
  });

  it('applyEvent chat.spawned tags the row with jobId when the wire event carries one (spec/14 § Sidebar)', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
      jobId: 'j1',
    });
    expect(useChatStore.getState().chats['c1']?.jobId).toBe('j1');
  });

  it('applyEvent chat.spawned defaults jobId to null for a chat no job spawned', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    expect(useChatStore.getState().chats['c1']?.jobId).toBeNull();
  });

  it('mergeChats folds in an explicit jobId on a brand-new automation row', () => {
    useChatStore.getState().mergeChats([
      {
        chatId: 'c-auto',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'automation run',
        folder: '~/p',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 5,
        jobId: 'j1',
      },
    ]);
    expect(useChatStore.getState().chats['c-auto']?.jobId).toBe('j1');
  });

  it('mergeChats omitting jobId preserves the already-known tag rather than clobbering it', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
      jobId: 'j1',
    });
    s.mergeChats([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'renamed',
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 100,
      },
    ]);
    expect(useChatStore.getState().chats['c1']?.jobId).toBe('j1');
  });

  it('mergeChats on an already-known chat with no persisted watermark keeps its in-memory lastReadSeq', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // Never marked read, so localStorage carries no watermark for c1.
    s.mergeChats([
      {
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 5,
      },
    ]);
    expect(useChatStore.getState().chats['c1']?.lastReadSeq).toBe(-1);
  });

  it('mergeChats seeds a brand-new chat from a persisted watermark left over from a prior session', () => {
    // Simulate a prior session's mark-read persisting to localStorage, then a
    // fresh store (mergeChats folding the chat in for the first time this run).
    window.localStorage.setItem('patch.readState.v1', JSON.stringify({ 'c-old': 12 }));
    useChatStore.getState().mergeChats([
      {
        chatId: 'c-old',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 5,
      },
    ]);
    expect(useChatStore.getState().chats['c-old']?.lastReadSeq).toBe(12);
  });

  it('setPinned pins and unpins a chat, stamping/clearing pinnedAt', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.setPinned('c1', true);
    let row = useChatStore.getState().chats['c1']!;
    expect(row.pinned).toBe(true);
    expect(row.pinnedAt).toBeGreaterThan(0);
    s.setPinned('c1', false);
    row = useChatStore.getState().chats['c1']!;
    expect(row.pinned).toBe(false);
    expect(row.pinnedAt).toBeNull();
  });

  it('setPinned is a no-op when the chat row does not exist', () => {
    expect(() => useChatStore.getState().setPinned('never-seen', true)).not.toThrow();
    expect(useChatStore.getState().chats['never-seen']).toBeUndefined();
  });

  it('setArchived is a no-op when the chat row does not exist', () => {
    expect(() => useChatStore.getState().setArchived('never-seen', true)).not.toThrow();
  });

  it('applyEvent ensures a row with an empty folder when a non-spawn event is the first thing seen for a chat', () => {
    // chat.message (and tool_call/tool_result/permission_request/message_delta)
    // call ensureRow(chatId) with NO folder arg — for a never-before-seen chat
    // this exercises the `folder ?? ''` default.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'brand-new',
      role: 'assistant',
      content: 'hello',
      seq: 0,
    });
    expect(useChatStore.getState().chats['brand-new']?.folder).toBe('');
  });

  it('addLocalMessage carries attachments onto the optimistic entry when provided', () => {
    const attachments = [
      { id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' as const },
    ];
    useChatStore.getState().addLocalMessage('c1', 'see this', 'lid-att', '~/p', attachments);
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.attachments).toEqual(attachments);
  });

  it('markRead is a no-op when the chat does not exist, or the watermark is already current', () => {
    const s = useChatStore.getState();
    expect(() => s.markRead('never-seen')).not.toThrow();

    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'done',
      seq: 3,
    });
    s.markRead('c1');
    const after1 = useChatStore.getState().chats['c1'];
    s.markRead('c1'); // already at the watermark — no-op
    expect(useChatStore.getState().chats['c1']).toBe(after1);
  });

  it('applyEvent no-ops for an unhandled event type (switch default)', () => {
    const s = useChatStore.getState();
    const before = useChatStore.getState().chats;
    expect(() => s.applyEvent({ type: 'daemon.online', daemonId: 'd1' })).not.toThrow();
    // The default case returns early — no state mutation at all.
    expect(useChatStore.getState().chats).toBe(before);
  });

  it('clearDelivery/failDelivery/retryDelivery are no-ops when the chat has no timeline', () => {
    const s = useChatStore.getState();
    expect(() => s.clearDelivery('never-seen', 'x')).not.toThrow();
    expect(() => s.failDelivery('never-seen', 'x')).not.toThrow();
    expect(() => s.retryDelivery('never-seen', 'x')).not.toThrow();
  });

  it('clearDelivery/failDelivery/retryDelivery are no-ops when the localId is not found', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'hi', 'lid-1');
    const before = useChatStore.getState().timelines['c1'];
    s.clearDelivery('c1', 'does-not-exist');
    s.failDelivery('c1', 'does-not-exist');
    s.retryDelivery('c1', 'does-not-exist');
    expect(useChatStore.getState().timelines['c1']).toBe(before);
  });

  it('removeChat clears activeChatId and openKebabFor only when they point at the removed chat', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '~/p' });
    s.setActiveChat('c2');
    s.setKebabOpen('c2');
    // Removing an unrelated chat leaves activeChatId/openKebabFor untouched.
    s.removeChat('c1');
    expect(useChatStore.getState().activeChatId).toBe('c2');
    expect(useChatStore.getState().openKebabFor).toBe('c2');
    // Removing the active/kebab-open chat clears both.
    s.removeChat('c2');
    expect(useChatStore.getState().activeChatId).toBeNull();
    expect(useChatStore.getState().openKebabFor).toBeNull();
  });

  it('an unvisited unread chat stays unread across a reload (no auto-mark-read)', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c2', folder: '~/p' });
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c2',
      role: 'assistant',
      content: 'unseen',
      seq: 3,
    });
    expect(deriveBadge(useChatStore.getState().chats['c2']!)).toBe('done');
    // Never visited → nothing persisted.
    expect(localStorage.getItem('patch.readState.v1')).toBeNull();

    // Reload: still unread (a visit, not time, is the only thing that reads it).
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([
      {
        chatId: 'c2',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: '~/p',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 20,
      },
    ]);
    expect(deriveBadge(useChatStore.getState().chats['c2']!)).toBe('done');
  });
});

describe('chatStore — chat.provider_context (spec/02 § Provider-level context)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('upserts one row per providerType rather than accumulating one per occurrence', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.provider_context',
      chatId: 'c1',
      seq: 1,
      providerType: 'total_tokens_reminder',
      label: 'Tokens remaining',
      text: '14,961,549 tokens left',
    });
    s.applyEvent({
      type: 'chat.provider_context',
      chatId: 'c1',
      seq: 4,
      providerType: 'total_tokens_reminder',
      label: 'Tokens remaining',
      text: '14,900,000 tokens left',
    });
    const pc = useChatStore.getState().chats['c1']?.providerContext;
    expect(Object.keys(pc ?? {})).toEqual(['total_tokens_reminder']);
    expect(pc?.['total_tokens_reminder']).toEqual({
      label: 'Tokens remaining',
      text: '14,900,000 tokens left', // the LATEST occurrence's text
      count: 2, // both occurrences counted, not just the latest kept silently
      firstSeq: 1, // stable position: the FIRST occurrence, not the latest
      lastSeq: 4,
    });
  });

  it('keeps distinct providerTypes as separate rows', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.provider_context',
      chatId: 'c1',
      seq: 1,
      providerType: 'model',
      label: 'Model',
      text: 'You are powered by the model named Sonnet 5.',
    });
    s.applyEvent({
      type: 'chat.provider_context',
      chatId: 'c1',
      seq: 2,
      providerType: 'date',
      label: 'Date',
      text: "Today's date is 2026-09-25.",
    });
    const pc = useChatStore.getState().chats['c1']?.providerContext ?? {};
    expect(Object.keys(pc).sort()).toEqual(['date', 'model']);
    expect(pc['model']?.count).toBe(1);
    expect(pc['date']?.count).toBe(1);
  });

  it('does not double-count a re-delivered chat.replay of the same occurrence', () => {
    // Same re-delivered-replay guard as chat.tool_call/chat.tool_result:
    // opening a chat re-asks from fromSeq: -1, so a live event already applied
    // can arrive a second time.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const deliver = () =>
      s.applyEvent({
        type: 'chat.provider_context',
        chatId: 'c1',
        seq: 3,
        providerType: 'environment',
        label: 'Environment',
        text: 'cwd: /home/tom/project',
      });
    deliver();
    deliver();
    const pc = useChatStore.getState().chats['c1']?.providerContext;
    expect(pc?.['environment']?.count).toBe(1);
  });
});

describe('chatStore message queueing (spec/04)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it('chat.queued flags the optimistic message; dequeued{running} clears it', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'second message', 'lid-2');
    // Queued behind a running turn.
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-2',
      message: 'second message',
      queueSeq: 1,
    });
    let tl = useChatStore.getState().timelines['c1'] ?? [];
    const q = tl.find((e) => e.localId === 'lid-2');
    expect(q?.queued).toBe(true);
    // Now it runs → flag cleared, entry kept.
    s.applyEvent({ type: 'chat.dequeued', chatId: 'c1', localId: 'lid-2', reason: 'running' });
    tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.localId === 'lid-2')?.queued).toBe(false);
    expect(tl.filter((e) => e.kind === 'message')).toHaveLength(1);
  });

  it('the persisted copy of a queued message clears QUEUED even when chat.dequeued was missed', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'second message', 'lid-2');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-2',
      message: 'second message',
      queueSeq: 1,
    });
    expect(useChatStore.getState().timelines['c1']?.[0]?.queued).toBe(true);
    // No chat.dequeued: the persisted user turn is all this surface ever sees.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'second message',
      seq: 7,
      localId: 'lid-2',
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'message')).toHaveLength(1);
    expect(tl[0]?.queued).toBe(false);
  });

  it('a message delivered mid-turn lands where the agent saw it and records the step', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'start', seq: 1 });
    for (const n of [2, 3]) {
      s.applyEvent({
        type: 'chat.tool_call',
        chatId: 'c1',
        seq: n,
        tool: 'Bash',
        args: { command: 'ls' },
        callId: `call-${n}`,
      });
    }
    s.addLocalMessage('c1', 'change course', 'lid-2');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-2',
      message: 'change course',
      queueSeq: 1,
    });
    s.applyEvent({
      type: 'chat.dequeued',
      chatId: 'c1',
      localId: 'lid-2',
      reason: 'running',
      delivered: true,
    });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'change course',
      seq: 4,
      localId: 'lid-2',
      midTurn: true,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const m = tl.find((e) => e.kind === 'message' && e.content === 'change course');
    expect(m?.queued).toBe(false);
    expect(m?.midTurn).toBe(true);
    expect(m?.midTurnStep).toBe(2);
    expect(tl.filter((e) => e.kind === 'message' && e.role === 'user')).toHaveLength(2);
  });

  it('a send-now flag set on a queued message survives its persisted copy arriving', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'stop that', 'lid-9');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-9',
      message: 'stop that',
      queueSeq: 1,
    });
    s.patchLocalMessage('c1', 'lid-9', { sentNow: true });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'stop that',
      seq: 5,
      localId: 'lid-9',
    });
    const m = (useChatStore.getState().timelines['c1'] ?? []).find(
      (e) => e.content === 'stop that',
    );
    expect(m?.sentNow).toBe(true);
    expect(m?.queued).toBe(false);
  });

  it('a queued message stays below the running turn output that arrives after it (position = process time, not send time)', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // Turn 1 is in flight: a user turn + an assistant reply streaming in.
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'turn one', seq: 0 });
    s.applyEvent({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'working ' });
    // The user queues a message BEHIND the still-running turn.
    s.addLocalMessage('c1', 'queued B', 'lid-B');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-B',
      message: 'queued B',
      queueSeq: 1,
    });
    // Turn 1 keeps producing output AFTER the queue happened — a tool call and
    // the finalised reply. None of this means the agent has seen the queued msg.
    s.applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      tool: 'Bash',
      args: { command: 'ls' },
      callId: 'call-1',
      seq: 2,
    });
    s.applyEvent({
      type: 'chat.message_delta',
      chatId: 'c1',
      messageSeq: 1,
      delta: 'on turn one.',
    });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'working on turn one.',
      seq: 1,
    });

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const idxB = tl.findIndex((e) => e.localId === 'lid-B');
    const idxTool = tl.findIndex((e) => e.kind === 'tool_call');
    // The queued message must sit BELOW turn 1's later output, not above it.
    expect(idxTool).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxTool);
    // In fact it is the last entry — the whole live transcript is above it.
    expect(idxB).toBe(tl.length - 1);
  });

  it('chat.dequeued{cancelled} removes the queued message', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'cancel me', 'lid-x');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-x',
      message: 'cancel me',
      queueSeq: 1,
    });
    s.applyEvent({ type: 'chat.dequeued', chatId: 'c1', localId: 'lid-x', reason: 'cancelled' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.localId === 'lid-x')).toBeUndefined();
  });

  it('chat.queued from another surface (no optimistic echo) appends a pending turn', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'remote-1',
      message: 'from the phone',
      queueSeq: 1,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const e = tl.find((x) => x.localId === 'remote-1');
    expect(e).toMatchObject({ role: 'user', content: 'from the phone', queued: true });
  });

  it('removeQueued optimistically drops a queued message', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'drop me', 'lid-d');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-d',
      message: 'drop me',
      queueSeq: 1,
    });
    s.removeQueued('c1', 'lid-d');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.localId === 'lid-d')).toBeUndefined();
  });

  it('removeQueued is a no-op when the chat has no timeline at all', () => {
    expect(() => useChatStore.getState().removeQueued('never-seen', 'x')).not.toThrow();
  });

  it('removeQueued is a no-op when the localId is not found (or not queued)', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'not queued', 'lid-nq');
    const before = (useChatStore.getState().timelines['c1'] ?? []).length;
    s.removeQueued('c1', 'lid-nq'); // present but not `queued: true`
    s.removeQueued('c1', 'does-not-exist');
    expect((useChatStore.getState().timelines['c1'] ?? []).length).toBe(before);
  });

  it('chat.dequeued is a no-op when the chat has no timeline, or the localId is not found', () => {
    const s = useChatStore.getState();
    // No timeline at all for this chat.
    expect(() =>
      s.applyEvent({
        type: 'chat.dequeued',
        chatId: 'never-seen',
        localId: 'x',
        reason: 'running',
      }),
    ).not.toThrow();

    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 1 });
    const before = useChatStore.getState().timelines['c1'];
    s.applyEvent({
      type: 'chat.dequeued',
      chatId: 'c1',
      localId: 'not-present',
      reason: 'running',
    });
    expect(useChatStore.getState().timelines['c1']).toBe(before); // unchanged reference
  });
});

// spec/14 § Running-turn controls — a stopped turn gets no reply and no
// chat.error from the host, so `chat.stopped` is the only signal the surface
// has that the message it is showing was interrupted rather than still working.
describe('chatStore — chat.stopped (a stopped or interrupted turn)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  function seedRunningTurn(chatId: string): void {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId, folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId, role: 'user', content: 'refactor it', seq: 1 });
    s.applyEvent({ type: 'chat.message_delta', chatId, messageSeq: 2, delta: 'Reading the' });
  }

  it('marks a bare-stopped turn stopped and settles the half-streamed reply', () => {
    seedRunningTurn('c1');
    useChatStore.getState().applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const user = tl.find((e) => e.role === 'user');
    expect(user?.turnStopped).toBe(true);
    expect(user?.turnInterrupted).toBeUndefined();
    // The reply stopped where it stopped — no forever-caret.
    const reply = tl.find((e) => e.role === 'assistant');
    expect(reply?.streaming).toBe(false);
    expect(reply?.content).toBe('Reading the');
  });

  // spec/09 § A turn the user stopped — a promote never goes idle in between,
  // so `chat.stopped` lands while `activity` is still `running`: the agent DID
  // see this turn (the promoted turn's own run resumed the same session).
  it('marks a turn cut off by a promoted message interrupted, not stopped', () => {
    const s = useChatStore.getState();
    seedRunningTurn('c1');
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'running',
      permissionMode: 'auto',
      lastUpdated: 5,
    });
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const user = tl.find((e) => e.role === 'user');
    expect(user?.turnInterrupted).toBe(true);
    expect(user?.turnStopped).toBeUndefined();
  });

  it('marks the turn that was RUNNING, not a message still queued behind it', () => {
    const s = useChatStore.getState();
    seedRunningTurn('c1');
    s.addLocalMessage('c1', 'type-ahead', 'lid-q');
    s.applyEvent({
      type: 'chat.queued',
      chatId: 'c1',
      localId: 'lid-q',
      message: 'type-ahead',
      queueSeq: 1,
    });
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.localId === 'lid-q')?.turnStopped).toBeUndefined();
    expect(tl.find((e) => e.seq === 1)?.turnStopped).toBe(true);
  });

  // Tom: "stop should stop the ai response. not cancel any pending messages.
  // they go through". The host keeps the queue across a stop and drains it, so
  // the surface must keep showing the queued block exactly as it was — dropping
  // it here, or clearing its `queued` flag, would show him the cancellation he
  // is asking not to have while the turns were in fact still about to run.
  it('leaves the whole queued block in place, still queued, after a stop', () => {
    const s = useChatStore.getState();
    seedRunningTurn('c1');
    for (const [localId, text] of [
      ['lid-1', 'then deploy it'],
      ['lid-2', 'and tell me when'],
    ] as const) {
      s.addLocalMessage('c1', text, localId);
      s.applyEvent({
        type: 'chat.queued',
        chatId: 'c1',
        localId,
        message: text,
        queueSeq: localId === 'lid-1' ? 1 : 2,
      });
    }
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });

    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const queued = tl.filter((e) => e.queued);
    expect(queued.map((e) => e.localId)).toEqual(['lid-1', 'lid-2']);
    expect(queued.every((e) => e.turnStopped === undefined)).toBe(true);
    // Only the turn that was actually running carries the stop.
    expect(tl.filter((e) => e.turnStopped).map((e) => e.seq)).toEqual([1]);

    // ...and they then run, as the host drains them: the dequeue is what
    // clears `queued`, never the stop.
    s.applyEvent({ type: 'chat.dequeued', chatId: 'c1', localId: 'lid-1', reason: 'running' });
    const after = useChatStore.getState().timelines['c1'] ?? [];
    expect(after.find((e) => e.localId === 'lid-1')?.queued).toBe(false);
    expect(after.find((e) => e.localId === 'lid-2')?.queued).toBe(true);
  });

  it('skips a message that is still delivery-pending (it was never the running turn)', () => {
    const s = useChatStore.getState();
    seedRunningTurn('c1');
    s.addLocalMessage('c1', 'not observed yet', 'lid-p');
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.localId === 'lid-p')?.turnStopped).toBeUndefined();
    expect(tl.find((e) => e.seq === 1)?.turnStopped).toBe(true);
  });

  it('leaves a turn that already FAILED alone — an error is not a cancellation', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'boom', seq: 1 });
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      seq: 2,
      error: { code: 'sdk_error', message: 'broke' },
      causeSeq: 1,
    });
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.find((e) => e.seq === 1)?.turnFailed).toBe(true);
    expect(tl.find((e) => e.seq === 1)?.turnStopped).toBeUndefined();
  });

  it('is idempotent, and a no-op for a chat with no timeline', () => {
    const s = useChatStore.getState();
    expect(() =>
      s.applyEvent({ type: 'chat.stopped', chatId: 'never-seen', reason: 'user-stop' }),
    ).not.toThrow();
    expect(useChatStore.getState().timelines['never-seen']).toBeUndefined();

    seedRunningTurn('c1');
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    s.applyEvent({ type: 'chat.stopped', chatId: 'c1', reason: 'user-stop' });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.turnStopped).length).toBe(1);
  });
});

// Todo (Tom, patch/todo.md — "Voice message should appear live."): a committed
// voice note must render its bubble the instant the user finishes speaking, in a
// live "transcribing" state, and fill in when the transcript returns — rather
// than the message only popping in after the upload + Whisper round-trip.
describe('chatStore — live voice-note transcription', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it('addTranscribingMessage seeds an optimistic user bubble in the transcribing state', () => {
    useChatStore.getState().addTranscribingMessage('c1', 'VN1', '/x/folder');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const entry = tl.find((e) => e.localId === 'VN1');
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('message');
    expect(entry?.role).toBe('user');
    expect(entry?.transcribing).toBe(true);
    expect(entry?.content ?? '').toBe('');
    // It seeds a row for a brand-new chat so ChatRoute renders immediately.
    expect(useChatStore.getState().chats['c1']).toBeDefined();
  });

  it('resolveTranscription fills the SAME bubble with the recognised text and clears transcribing', () => {
    const s = useChatStore.getState();
    s.addTranscribingMessage('c1', 'VN1', '/x/folder');
    s.resolveTranscription('c1', 'VN1', 'check the oven');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    // No duplicate — the same entry is updated in place.
    const users = tl.filter((e) => e.role === 'user');
    expect(users.length).toBe(1);
    const entry = users[0]!;
    expect(entry.content).toBe('check the oven');
    expect(entry.transcribing).toBeFalsy();
    expect(entry.deliveryPending).toBeFalsy();
    // localId is retained so the persisted [voice • web] echo reconciles by
    // content on replay instead of appending a duplicate.
    expect(entry.localId).toBe('VN1');
  });

  it('a chat.message persisted echo arriving BEFORE resolveTranscription folds into the transcribing placeholder (no duplicate)', () => {
    const s = useChatStore.getState();
    s.addTranscribingMessage('c1', 'VN1', '/x/folder');
    // The host's broadcast wins the race against the HTTP upload response
    // that would otherwise call resolveTranscription. Its localId is one the
    // server minted for the injected chat.input, never VN1, so it can't match
    // by localId — only the transcribing placeholder anchors it.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 9,
      role: 'user',
      content: '[voice • web] check the oven',
    });
    let tl = useChatStore.getState().timelines['c1'] ?? [];
    let users = tl.filter((e) => e.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]!.content).toBe('check the oven');
    expect(users[0]!.transcribing).toBeFalsy();
    expect(users[0]!.localId).toBeUndefined();
    // The late-arriving HTTP response then calls resolveTranscription with
    // VN1 — must be a safe no-op, not a second bubble.
    s.resolveTranscription('c1', 'VN1', 'check the oven');
    tl = useChatStore.getState().timelines['c1'] ?? [];
    users = tl.filter((e) => e.role === 'user');
    expect(users.length).toBe(1);
  });

  it('resolveTranscription with an empty/whitespace transcript removes the placeholder bubble', () => {
    const s = useChatStore.getState();
    s.addTranscribingMessage('c1', 'VN1', '/x/folder');
    s.resolveTranscription('c1', 'VN1', '   ');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => e.localId === 'VN1')).toBe(false);
  });

  it('cancelTranscription removes the placeholder bubble (upload failed / aborted)', () => {
    const s = useChatStore.getState();
    s.addTranscribingMessage('c1', 'VN1', '/x/folder');
    s.cancelTranscription('c1', 'VN1');
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.some((e) => e.localId === 'VN1')).toBe(false);
  });

  it('a persisted [voice • web] echo reconciles against the resolved bubble (no duplicate)', () => {
    const s = useChatStore.getState();
    s.addTranscribingMessage('c1', 'VN1', '/x/folder');
    s.resolveTranscription('c1', 'VN1', 'check the oven');
    // The host persists the turn with a [voice • web] prefix; on replay it
    // arrives as a normal chat.message and must fold into the optimistic bubble.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[voice • web] check the oven',
      seq: 3,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const users = tl.filter((e) => e.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]!.localId).toBeUndefined(); // promoted to the persisted seq
    expect(users[0]!.seq).toBe(3);
  });

  it('addTranscribingMessage reuses an existing chat row and tolerates an omitted folder', () => {
    const s = useChatStore.getState();
    // Row already exists (spawned) → the optimistic seed reuses it, not emptyRow.
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/proj' });
    s.addTranscribingMessage('c1', 'VN1'); // no folder arg
    expect(useChatStore.getState().chats['c1']?.folder).toBe('~/proj');
    // A brand-new chat with no folder arg still seeds a row (empty folder).
    s.addTranscribingMessage('fresh', 'VN2');
    expect(useChatStore.getState().chats['fresh']).toBeDefined();
    expect(useChatStore.getState().chats['fresh']?.folder).toBe('');
  });

  // spec/02 § Context compression — the boundary rides in on an ordinary
  // system chat.message. It is the `compaction` payload, not the role, that
  // makes it its own kind of transcript entry.
  it('turns a chat.message carrying compaction figures into a compaction entry', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Context compressed · from 168k',
      seq: 1,
      compaction: { trigger: 'auto', preTokens: 168165 },
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({
      kind: 'compaction',
      content: 'Context compressed · from 168k',
      compaction: { trigger: 'auto', preTokens: 168165 },
    });
  });

  it('leaves a system message with no compaction figures an ordinary message', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'connection restored',
      seq: 1,
    });
    expect(useChatStore.getState().timelines['c1']?.[0]).toMatchObject({
      kind: 'message',
      role: 'system',
    });
  });

  // spec/02 § Permission mode — the record of a mid-conversation mode change
  // rides in the same way, and is its own kind of transcript entry rather than
  // a system message anyone would read as the agent talking.
  it('turns a chat.message carrying permissionModeChange into a permission_mode entry', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → acceptEdits',
      seq: 4,
      permissionModeChange: 'acceptEdits',
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({
      kind: 'permission_mode',
      seq: 4,
      content: 'Permission mode → acceptEdits',
      permissionMode: 'acceptEdits',
    });
    expect(useChatStore.getState().chats['c1']?.lastSeq).toBe(4);
  });

  // spec/02 § Permission mode's plan-mode exception — Claude Code moving the
  // chat to `plan` itself gets the same entry kind, plus the flag naming who
  // made the change.
  it('carries permissionModeChangeAutomatic through onto the entry, when Claude Code made the change', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → plan (set by Claude Code)',
      seq: 4,
      permissionModeChange: 'plan',
      permissionModeChangeAutomatic: true,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]).toMatchObject({
      kind: 'permission_mode',
      permissionMode: 'plan',
      permissionModeChangeAutomatic: true,
    });
  });

  it('omits permissionModeChangeAutomatic for an ordinary (human) mode change', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → acceptEdits',
      seq: 4,
      permissionModeChange: 'acceptEdits',
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl[0]?.permissionModeChangeAutomatic).toBeUndefined();
  });

  it('draws one line when the same record is replayed twice', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    const ev = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → plan',
      seq: 2,
      permissionModeChange: 'plan',
    } as const;
    s.applyEvent(ev);
    s.applyEvent(ev);
    expect(useChatStore.getState().timelines['c1']).toHaveLength(1);
  });

  it('does not take the record as the chat’s preview — nobody typed it', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → plan',
      seq: 1,
      permissionModeChange: 'plan',
    });
    expect(useChatStore.getState().chats['c1']?.preview ?? null).toBeNull();
  });

  it('resolveTranscription / cancelTranscription are no-ops for an unknown chat or localId', () => {
    const s = useChatStore.getState();
    expect(() => s.resolveTranscription('nope', 'x', 'hi')).not.toThrow();
    expect(() => s.cancelTranscription('nope', 'x')).not.toThrow();
    s.addTranscribingMessage('c1', 'VN1', '/x');
    const before = useChatStore.getState().timelines['c1'];
    s.resolveTranscription('c1', 'other', 'hi');
    expect(useChatStore.getState().timelines['c1']).toBe(before); // unchanged reference
    // cancelTranscription on a present timeline but absent localId is a no-op
    // that keeps the same array reference (line 787 length-equality guard).
    s.cancelTranscription('c1', 'other');
    expect(useChatStore.getState().timelines['c1']).toBe(before);
  });
});

describe('chat.error reducer (spec/12 § Guaranteed input delivery)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  it('sdk_error with a causeSeq attaches turnFailed to the matching message, not a standalone row', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'do the thing', 'lid-1');
    // The host always persists (and this reconciles) the user's chat.message
    // BEFORE the SDK query that can fail even starts, so by the time chat.error
    // can arrive the entry's localId is already cleared — causeSeq (the
    // reconciled seq) is the identity that survives, not localId.
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'do the thing',
      seq: 0,
      localId: 'lid-1',
    });
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
      causeSeq: 0,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1); // no separate error row
    expect(tl[0]?.turnFailed).toBe(true);
    expect(tl[0]?.turnErrorMessage).toBe('boom');
    expect(tl[0]?.turnFailedSeq).toBe(1);
  });

  it('sdk_error with no causeSeq (older host) falls back to the newest un-failed user message', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'first', 'lid-1');
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'reply one',
      seq: 1,
    });
    s.addLocalMessage('c1', 'second', 'lid-2');
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom again' },
      seq: 2,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    const second = tl.find((e) => e.content === 'second');
    const first = tl.find((e) => e.content === 'first');
    expect(second?.turnFailed).toBe(true);
    expect(first?.turnFailed).toBeUndefined();
    expect(tl.some((e) => e.kind === 'error')).toBe(false);
  });

  it('a replayed chat.error at the same seq does not re-search or double-apply', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'do the thing', 'lid-1');
    s.applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'do the thing',
      seq: 0,
      localId: 'lid-1',
    });
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
      causeSeq: 0,
    });
    // Retry appends a brand new entry, as handleRetryTurn would before
    // resubmitting.
    s.addLocalMessage('c1', 'retry text', 'lid-2');
    const before = useChatStore.getState().timelines['c1'];
    // Same failure redelivered (e.g. reconnect replay) — must not touch the
    // new lid-2 entry nor add a standalone error row.
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
      causeSeq: 0,
    });
    expect(useChatStore.getState().timelines['c1']).toBe(before);
  });

  it('other error codes still render as a standalone error row, untouched by the sdk_error path', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'do the thing', 'lid-1');
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'daemon_unavailable', message: 'host is offline' },
      seq: 1,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(2);
    expect(tl[0]?.turnFailed).toBeUndefined();
    expect(tl[1]?.kind).toBe('error');
    expect(tl[1]?.errorCode).toBe('daemon_unavailable');
  });

  it('sdk_error with no matching message and no fallback target falls through to a standalone row (no silent drop)', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // No user message in the timeline at all to attach to.
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'sdk_error', message: 'boom' },
      seq: 1,
      causeSeq: 999,
    });
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]?.kind).toBe('error');
    expect(tl[0]?.errorCode).toBe('sdk_error');
  });
});

// spec/04 § Activity — the host↔server link dropping mid-turn is a passing
// condition, not the outcome of a turn. The server raises `daemon_unavailable`
// out-of-band so the spinner unsticks, and the host then keeps the promise on
// that card ("Message will resend."): it re-sends the interrupted turn on
// hydrate and the chat comes back to `running` on its own. The card was staying
// put anyway, so a two-second blip left what looked like a permanent failure in
// the transcript (the reported bug).
describe('chatStore — a resolved daemon_unavailable notice clears itself', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  /** Spawn c1, send a turn, then drop the link: what ws-hub emits on offline. */
  function blip(): void {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.addLocalMessage('c1', 'do the thing', 'lid-1');
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
      // OUT_OF_BAND_SEQ — a server-generated control error, never part of the
      // host's replayable per-chat stream.
      seq: -1,
    });
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'errored',
      lastUpdated: 1,
    });
  }

  function errorRows() {
    return (useChatStore.getState().timelines['c1'] ?? []).filter((e) => e.kind === 'error');
  }

  it('holds the notice while the chat is still errored', () => {
    blip();
    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0]?.errorCode).toBe('daemon_unavailable');
    expect(useChatStore.getState().chats['c1']?.activity).toBe('errored');
  });

  it('drops the notice and the errored state when the resumed turn reports running', () => {
    blip();
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'running',
      lastUpdated: 2,
    });
    expect(errorRows()).toHaveLength(0);
    expect(useChatStore.getState().chats['c1']?.activity).toBe('running');
    // The user's own message is untouched — only the control-plane notice goes.
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]?.kind).toBe('message');
    expect(tl[0]?.content).toBe('do the thing');
  });

  it('drops the notice when the host comes back and reports the chat idle', () => {
    blip();
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 2,
    });
    expect(errorRows()).toHaveLength(0);
  });

  it('keeps the notice when the host never comes back (no resolution event, no timer)', async () => {
    blip();
    // Nothing else arrives. Time passing is NOT a resolution signal.
    await new Promise((r) => setTimeout(r, 30));
    expect(errorRows()).toHaveLength(1);
    expect(useChatStore.getState().chats['c1']?.activity).toBe('errored');
  });

  it('leaves a REAL turn failure in place when the chat goes running again', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    // A code with no message to attach to falls through to a standalone row.
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'claude_oauth_missing', message: 'no credential' },
      seq: 1,
    });
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'running',
      lastUpdated: 2,
    });
    const rows = errorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.errorCode).toBe('claude_oauth_missing');
  });

  it('clears only the blipped chat — a chat on another host is untouched', () => {
    blip();
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd2', chatId: 'c2', folder: '~/q' });
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c2',
      error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
      seq: -1,
    });
    // Only c1's host comes back.
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'running',
      lastUpdated: 2,
    });
    expect(errorRows()).toHaveLength(0);
    expect(
      (useChatStore.getState().timelines['c2'] ?? []).filter((e) => e.kind === 'error'),
    ).toHaveLength(1);
  });

  it('clears inside a batched replay commit, in arrival order', () => {
    // spec/12 — a reconnect lands as ONE applyEvents commit. The offline pair
    // and the host's recovery state can arrive in the same fold.
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvents([
      {
        type: 'chat.error',
        chatId: 'c1',
        error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
        seq: -1,
      },
      {
        type: 'chat.state',
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'auto',
        activity: 'errored',
        lastUpdated: 1,
      },
      {
        type: 'chat.state',
        chatId: 'c1',
        daemonId: 'd1',
        permissionMode: 'auto',
        activity: 'running',
        lastUpdated: 2,
      },
    ]);
    expect(errorRows()).toHaveLength(0);
  });

  it('a re-delivered daemon_unavailable after the recovery draws the card again', () => {
    // A second, genuine blip is a new failure — clearing the first one must not
    // leave a dedupe ghost that swallows it (identity is (seq, code, message),
    // and out-of-band errors all share the sentinel seq).
    blip();
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'running',
      lastUpdated: 2,
    });
    expect(errorRows()).toHaveLength(0);
    s.applyEvent({
      type: 'chat.error',
      chatId: 'c1',
      error: { code: 'daemon_unavailable', message: 'Connection to the host was lost.' },
      seq: -1,
    });
    expect(errorRows()).toHaveLength(1);
  });
});

// spec/04 § Model — a chat's model can change mid-chat, and `chat.state` is how
// the change reaches every surface holding the chat, including the ones that
// did not ask for it (two windows open on one chat must not disagree).
describe('chatStore — a chat model change arriving on chat.state', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('applies the model the host reports', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
      model: 'claude-sonnet-4-6',
    });
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      permissionMode: 'auto',
      model: 'claude-opus-4-1',
    });
    expect(useChatStore.getState().chats['c1']?.model).toBe('claude-opus-4-1');
  });

  it('keeps the known model when the frame carries none — an old host sends no model', () => {
    // Absence means "unchanged, and don't guess": wiping to null on every state
    // emit would blank the header crumb of a perfectly healthy chat.
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c1',
      folder: '~/p',
      model: 'claude-sonnet-4-6',
    });
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 2,
      permissionMode: 'auto',
    });
    expect(useChatStore.getState().chats['c1']?.model).toBe('claude-sonnet-4-6');
  });
});

describe('chatStore applyEvents — batched replay application', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    localStorage.removeItem('patch.readState.v1');
  });

  // A `chat.replay` arrives as one wire frame per transcript entry. Applying
  // them one at a time meant one store commit — and so one render of the whole
  // stream — per message, which is what made opening a chat fill in visibly,
  // one message at a time. A batch is applied as a single sequential fold.
  it('applies a batch as ONE commit, identical to applying the events one by one', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      type: 'chat.message' as const,
      chatId: 'c1',
      seq: i,
      role: 'assistant' as const,
      content: `m${i}`,
    }));

    // One-by-one, for the reference result.
    const s = useChatStore.getState();
    for (const e of events) s.applyEvent(e);
    const oneByOne = useChatStore.getState().timelines['c1'];

    // Now the same events as a single batch.
    useChatStore.getState()._reset();
    let commits = 0;
    const unsub = useChatStore.subscribe(() => {
      commits++;
    });
    useChatStore.getState().applyEvents(events);
    unsub();

    expect(commits).toBe(1);
    const batched = useChatStore.getState().timelines['c1'];
    expect(batched?.length).toBe(30);
    expect(batched?.map((e) => e.content)).toEqual(oneByOne?.map((e) => e.content));
    expect(batched?.map((e) => e.seq)).toEqual(oneByOne?.map((e) => e.seq));
  });

  it('interleaves several chats in one batch without crossing their timelines', () => {
    useChatStore.getState().applyEvents([
      { type: 'chat.message', chatId: 'a', seq: 0, role: 'user', content: 'a0' },
      { type: 'chat.message', chatId: 'b', seq: 0, role: 'user', content: 'b0' },
      { type: 'chat.message', chatId: 'a', seq: 1, role: 'assistant', content: 'a1' },
      { type: 'chat.message', chatId: 'b', seq: 1, role: 'assistant', content: 'b1' },
    ]);
    const t = useChatStore.getState().timelines;
    expect(t['a']?.map((e) => e.content)).toEqual(['a0', 'a1']);
    expect(t['b']?.map((e) => e.content)).toEqual(['b0', 'b1']);
  });

  it('a batch of only unhandled event types does not commit', () => {
    const before = useChatStore.getState();
    let commits = 0;
    const unsub = useChatStore.subscribe(() => {
      commits++;
    });
    // `auth.ok` is a real wire frame the chat store has no case for. An
    // unconditional set() would hand every subscriber fresh chats/timelines
    // identities and re-render the whole sidebar for nothing.
    const authOk = { type: 'auth.ok' as const, accountId: 'a', surfaceId: 's', hosts: [] };
    useChatStore.getState().applyEvents([authOk, authOk]);
    unsub();
    expect(commits).toBe(0);
    expect(useChatStore.getState().chats).toBe(before.chats);
    expect(useChatStore.getState().timelines).toBe(before.timelines);
  });

  it('an empty batch is a no-op', () => {
    const before = useChatStore.getState();
    useChatStore.getState().applyEvents([]);
    expect(useChatStore.getState().chats).toBe(before.chats);
    expect(useChatStore.getState().timelines).toBe(before.timelines);
  });
});

// spec/12 § A usage or rate limit — the limit notice must not outlive the limit.
// The store only ever dropped `limitBlock` / `rateLimitResumingAt` when the
// host explicitly sent `null` on a `chat.state`, so a clearing path that
// forgot to publish one (or a `sendInput` that re-acked a duplicate localId and
// emitted no state at all) left the bubble standing over a chat that was no
// longer blocked, with a `Try now` that had nothing to run. A turn in flight is
// proof the pause is over, whatever fields came with the frame.
describe('a limit pause the chat has moved past clears itself', () => {
  // Every case here reuses one chatId, and the store is module-level state
  // shared across the whole file — without this the "never had a pause" case
  // inherits the previous case's block and asserts nothing.
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  function blocked(): void {
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c-lim',
      folder: '~/p',
    } as never);
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c-lim',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'errored',
      lastUpdated: 1,
      rateLimitResumingAt: null,
      limitBlock: { scope: 'week', accountLabel: 'Default', resetsAt: 1_000 },
    } as never);
  }

  function row() {
    return useChatStore.getState().chats['c-lim'];
  }

  /** A `chat.state` that says nothing at all about the pause. */
  function silentState(activity: string): void {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c-lim',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity,
      lastUpdated: 2,
    } as never);
  }

  it('holds the block while the chat is still parked on it', () => {
    blocked();
    expect(row()?.limitBlock?.accountLabel).toBe('Default');
  });

  it('drops it when the chat reports a turn running, even with no clearing fields', () => {
    blocked();
    silentState('running');
    expect(row()?.limitBlock).toBeNull();
    expect(row()?.rateLimitResumingAt).toBeNull();
    expect(row()?.resumeKind).toBeNull();
    expect(row()?.activity).toBe('running');
  });

  it('drops it when the resumed turn stops for a permission prompt', () => {
    blocked();
    silentState('awaiting-permission');
    expect(row()?.limitBlock).toBeNull();
  });

  it('keeps an ARMED pause: an auto-resume wait is an idle chat', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c-lim',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 1,
      rateLimitResumingAt: 9_999,
      resumeKind: 'rate_limit',
      limitBlock: { scope: 'session', accountLabel: 'Default', resetsAt: 9_999 },
    } as never);
    // An idle frame that says nothing about the pause must not erase it.
    silentState('idle');
    expect(row()?.limitBlock?.scope).toBe('session');
    expect(row()?.rateLimitResumingAt).toBe(9_999);
  });

  it('keeps an UNPARKED limit: errored is the shape it wears', () => {
    blocked();
    silentState('errored');
    expect(row()?.limitBlock?.accountLabel).toBe('Default');
  });

  it('lets the host re-block the chat on the very next frame', () => {
    blocked();
    silentState('running');
    expect(row()?.limitBlock).toBeNull();
    // The re-sent turn hits the limit again — a fresh block, not a resurrection.
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c-lim',
      daemonId: 'd1',
      permissionMode: 'auto',
      activity: 'errored',
      lastUpdated: 3,
      limitBlock: { scope: 'session', accountLabel: 'Default' },
    } as never);
    expect(row()?.limitBlock?.scope).toBe('session');
  });

  it('does not disturb a chat that never had a pause', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      daemonId: 'd1',
      chatId: 'c-lim',
      folder: '~/p',
    } as never);
    const before = useChatStore.getState().chats;
    silentState('running');
    expect(useChatStore.getState().chats['c-lim']?.limitBlock).toBeNull();
    expect(useChatStore.getState().chats).not.toBe(before);
  });
});
