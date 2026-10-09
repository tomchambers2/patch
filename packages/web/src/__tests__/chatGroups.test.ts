// nextChatAfterArchive — where archiving the open chat leaves you
// (spec/04 § Lifecycle). Resolved against the order the sidebar draws.

import { describe, it, expect } from 'vitest';
import {
  chatsInProject,
  groupChats,
  nextChatAfterArchive,
  sortAttentionQueue,
} from '../lib/chatGroups.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  const merged = {
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions',
    name: 'a chat',
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: 0,
    lastSeq: 0,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    jobId: null,
    ...overrides,
  } as ChatRow;
  // Most of this suite's fixtures only ever set `lastUpdated` — they predate
  // `lastUserActivity` and are testing something else entirely (lifecycle,
  // filters, selection). Mirroring it onto `lastUserActivity` by default
  // keeps every one of those recency-ordered fixtures sorting exactly as it
  // did; a test that cares about the two diverging sets
  // `lastUserActivity` explicitly, which wins over the mirror.
  if (overrides.lastUpdated !== undefined && overrides.lastUserActivity === undefined) {
    merged.lastUserActivity = overrides.lastUpdated;
  }
  return merged;
}

/** One folder, drawn newest-first: r1, r2, r3. */
const three = [
  row({ chatId: 'r1', lastUpdated: 300 }),
  row({ chatId: 'r2', lastUpdated: 200 }),
  row({ chatId: 'r3', lastUpdated: 100 }),
];

describe('nextChatAfterArchive', () => {
  it('takes you to the row below the one you archived', () => {
    expect(nextChatAfterArchive(three, 'r1', ['r1'], false)).toBe('r2');
    expect(nextChatAfterArchive(three, 'r2', ['r2'], false)).toBe('r3');
  });

  it('takes you back up when you archived the last row', () => {
    expect(nextChatAfterArchive(three, 'r3', ['r3'], false)).toBe('r2');
  });

  it('has nowhere to go when the list empties', () => {
    expect(nextChatAfterArchive([row({ chatId: 'only' })], 'only', ['only'], false)).toBeNull();
  });

  it('skips the other rows leaving in the same bulk archive', () => {
    expect(nextChatAfterArchive(three, 'r1', ['r1', 'r2'], false)).toBe('r3');
    expect(nextChatAfterArchive(three, 'r2', ['r2', 'r3'], false)).toBe('r1');
  });

  it('crosses out of a folder into the next one', () => {
    const chats = [
      row({ chatId: 'a1', folder: '~/newer', lastUpdated: 500 }),
      row({ chatId: 'b1', folder: '~/older', lastUpdated: 100 }),
    ];
    expect(nextChatAfterArchive(chats, 'a1', ['a1'], false)).toBe('b1');
  });

  it('walks pinned rows before the folders', () => {
    const chats = [
      row({ chatId: 'p1', pinned: true, pinnedAt: 10, lastUpdated: 1 }),
      row({ chatId: 'f1', lastUpdated: 900 }),
    ];
    expect(nextChatAfterArchive(chats, 'p1', ['p1'], false)).toBe('f1');
  });

  it('ignores archived, deleted and snoozed rows — they are not in the list', () => {
    const chats = [
      row({ chatId: 'r1', lastUpdated: 300 }),
      row({ chatId: 'gone', status: 'archived', lastUpdated: 250 }),
      row({ chatId: 'binned', status: 'deleted', lastUpdated: 240 }),
      row({ chatId: 'later', snoozedUntil: Date.now() + 60_000, lastUpdated: 230 }),
      row({ chatId: 'r2', lastUpdated: 200 }),
    ];
    expect(nextChatAfterArchive(chats, 'r1', ['r1'], false)).toBe('r2');
  });

  it('walks the needs-attention list when that filter is on', () => {
    // `done` (lastSeq beyond lastReadSeq) needs attention; `read` does not.
    const chats = [
      row({ chatId: 'done1', lastUpdated: 300, lastSeq: 5, lastReadSeq: 1 }),
      row({ chatId: 'read1', lastUpdated: 200 }),
      row({ chatId: 'done2', lastUpdated: 100, lastSeq: 5, lastReadSeq: 1 }),
    ];
    expect(nextChatAfterArchive(chats, 'done1', ['done1'], true)).toBe('done2');
    expect(nextChatAfterArchive(chats, 'done1', ['done1'], false)).toBe('read1');
  });

  it('ignores hidden rows — they are not in the list', () => {
    const chats = [
      row({ chatId: 'r1', lastUpdated: 300 }),
      row({ chatId: 'bg', hidden: true, lastUpdated: 250 }),
      row({ chatId: 'r2', lastUpdated: 200 }),
    ];
    expect(nextChatAfterArchive(chats, 'r1', ['r1'], false)).toBe('r2');
    expect(nextChatAfterArchive(chats, 'bg', ['bg'], false)).toBe('r1');
  });

  it('starts at the top of the list when the archived chat had no row of its own', () => {
    const chats = [
      row({ chatId: 'napping', snoozedUntil: Date.now() + 60_000, lastUpdated: 400 }),
      ...three,
    ];
    expect(nextChatAfterArchive(chats, 'napping', ['napping'], false)).toBe('r1');
  });
});

// Hidden (spec/04 § Hidden): a separate axis from `status`, exclusive like
// snooze — a hidden chat is drawn in the Hidden section and nowhere else, and
// only while it is active.
describe('groupChats — hidden', () => {
  it('keeps a hidden chat out of pinned and the folders, and lists it under hidden', () => {
    const chats = [
      row({ chatId: 'plain', lastUpdated: 300 }),
      row({ chatId: 'bg', hidden: true, lastUpdated: 200 }),
      row({ chatId: 'bg-pinned', hidden: true, pinned: true, pinnedAt: 5, lastUpdated: 100 }),
    ];
    const g = groupChats(chats);
    expect(g.hidden.map((c) => c.chatId).sort()).toEqual(['bg', 'bg-pinned']);
    expect(g.pinned).toEqual([]);
    expect(g.folders.flatMap((f) => f.rows).map((c) => c.chatId)).toEqual(['plain']);
  });

  it('draws a chat that is both hidden and snoozed once, under hidden', () => {
    const chats = [row({ chatId: 'both', hidden: true, snoozedUntil: Date.now() + 60_000 })];
    const g = groupChats(chats);
    expect(g.hidden.map((c) => c.chatId)).toEqual(['both']);
    expect(g.snoozed).toEqual([]);
  });

  it('draws an archived chat that keeps the flag as archived', () => {
    const chats = [row({ chatId: 'stopped', status: 'archived', hidden: true })];
    const g = groupChats(chats);
    expect(g.archived.map((c) => c.chatId)).toEqual(['stopped']);
    expect(g.hidden).toEqual([]);
  });

  it('treats an absent or false flag as not hidden', () => {
    const chats = [row({ chatId: 'shown', hidden: false }), row({ chatId: 'unknown' })];
    const g = groupChats(chats);
    expect(g.hidden).toEqual([]);
    expect(
      g.folders
        .flatMap((f) => f.rows)
        .map((c) => c.chatId)
        .sort(),
    ).toEqual(['shown', 'unknown']);
  });

  it('orders hidden chats oldest first, so a run updating settles at the bottom', () => {
    const chats = [
      row({ chatId: 'newer', hidden: true, lastUpdated: 300 }),
      row({ chatId: 'older', hidden: true, lastUpdated: 100 }),
    ];
    expect(groupChats(chats).hidden.map((c) => c.chatId)).toEqual(['older', 'newer']);
  });

  it('still lists a hidden job run under automations', () => {
    const chats = [row({ chatId: 'run', hidden: true, jobId: 'j1' })];
    expect(groupChats(chats).automations.map((c) => c.chatId)).toEqual(['run']);
  });
});

// Automations (spec/14 § Sidebar): an ADDITIONAL, always-current tag-based
// view — a job-spawned chat still lands in whichever other bucket it
// belongs to (active folder, archived, snoozed), not moved out of it.
describe('groupChats — automations', () => {
  it('collects every job-spawned chat regardless of its other bucket', () => {
    const chats = [
      row({ chatId: 'active-job', jobId: 'j1', lastUpdated: 300 }),
      row({ chatId: 'archived-job', jobId: 'j2', status: 'archived', lastUpdated: 200 }),
      row({
        chatId: 'snoozed-job',
        jobId: 'j3',
        snoozedUntil: Date.now() + 60_000,
        lastUpdated: 100,
      }),
      row({ chatId: 'not-a-job', jobId: null, lastUpdated: 400 }),
    ];
    const { automations } = groupChats(chats);
    expect(automations.map((c) => c.chatId).sort()).toEqual(
      ['active-job', 'archived-job', 'snoozed-job'].sort(),
    );
  });

  it('leaves a job-spawned chat in its normal bucket too — non-exclusive membership', () => {
    const chats = [row({ chatId: 'active-job', jobId: 'j1', lastUpdated: 300 })];
    const { automations, folders } = groupChats(chats);
    expect(automations.map((c) => c.chatId)).toContain('active-job');
    expect(folders.flatMap((f) => f.rows).map((c) => c.chatId)).toContain('active-job');
  });

  it('sorts automations oldest first — FIFO, so a run settles at the bottom', () => {
    const chats = [
      row({ chatId: 'old', jobId: 'j1', lastUpdated: 100 }),
      row({ chatId: 'new', jobId: 'j2', lastUpdated: 300 }),
    ];
    const { automations } = groupChats(chats);
    expect(automations.map((c) => c.chatId)).toEqual(['old', 'new']);
  });

  it('does not reshuffle the whole list when a run already in it updates — it rejoins the back instead of jumping to the front (Todoist: "Load chats bottom up so you don\'t get a jarring effect")', () => {
    const chats = [
      row({ chatId: 'a', jobId: 'j1', lastUpdated: 100 }),
      row({ chatId: 'b', jobId: 'j2', lastUpdated: 200 }),
      row({ chatId: 'c', jobId: 'j3', lastUpdated: 300 }),
    ];
    expect(groupChats(chats).automations.map((c) => c.chatId)).toEqual(['a', 'b', 'c']);

    // 'a' ticks (a live activity update while it's already listed) — it must
    // move to the BACK, not jump to the front and shove 'b'/'c' down.
    const updated = chats.map((c) => (c.chatId === 'a' ? { ...c, lastUpdated: 400 } : c));
    expect(groupChats(updated).automations.map((c) => c.chatId)).toEqual(['b', 'c', 'a']);
  });

  it('excludes soft-deleted job-spawned chats — cold storage, same as every other section', () => {
    const chats = [row({ chatId: 'deleted-job', jobId: 'j1', status: 'deleted', lastUpdated: 1 })];
    const { automations, deleted } = groupChats(chats);
    expect(automations).toHaveLength(0);
    expect(deleted.map((c) => c.chatId)).toContain('deleted-job');
  });
});

// sortAttentionQueue (Todoist: "needs attention queue - updated things should
// be at the bottom of the queue"): a FIFO re-ordering of an already-filtered
// needs-attention list — opposite of groupChats's own recency-first sort.
describe('sortAttentionQueue', () => {
  const done = (overrides: Partial<ChatRow> = {}) =>
    row({ lastSeq: 5, lastReadSeq: 1, ...overrides });
  const permission = (overrides: Partial<ChatRow> = {}) =>
    row({
      pendingPermissions: [{ requestId: 'r', tool: 'Bash', args: {}, description: 'x' }],
      ...overrides,
    });

  it('queues oldest-updated first, most-recently-updated last', () => {
    const rows = [
      done({ chatId: 'newest', lastUpdated: 300 }),
      done({ chatId: 'oldest', lastUpdated: 100 }),
      done({ chatId: 'middle', lastUpdated: 200 }),
    ];
    expect(sortAttentionQueue(rows).map((c) => c.chatId)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('a row that updates again sinks to the bottom instead of jumping to the top', () => {
    const before = [
      done({ chatId: 'waiting-longer', lastUpdated: 100 }),
      done({ chatId: 'just-updated', lastUpdated: 200 }),
    ];
    expect(sortAttentionQueue(before).map((c) => c.chatId)).toEqual([
      'waiting-longer',
      'just-updated',
    ]);
    // "just-updated" updates again — even newer now — it stays at the back,
    // it does not cut back to the front.
    const after = [
      done({ chatId: 'waiting-longer', lastUpdated: 100 }),
      done({ chatId: 'just-updated', lastUpdated: 400 }),
    ];
    expect(sortAttentionQueue(after).map((c) => c.chatId)).toEqual([
      'waiting-longer',
      'just-updated',
    ]);
  });

  it('permission rows still lead the queue ahead of done rows, regardless of recency', () => {
    const rows = [
      done({ chatId: 'done-old', lastUpdated: 100 }),
      permission({ chatId: 'perm-new', lastUpdated: 900 }),
    ];
    expect(sortAttentionQueue(rows).map((c) => c.chatId)).toEqual(['perm-new', 'done-old']);
  });

  it('ties within the same rank fall back to the stable chatId tiebreaker', () => {
    const rows = [done({ chatId: 'b', lastUpdated: 100 }), done({ chatId: 'a', lastUpdated: 100 })];
    expect(sortAttentionQueue(rows).map((c) => c.chatId)).toEqual(['a', 'b']);
  });
});

// chatsInProject — the set behind "archive all in project" (spec/14 § Sidebar →
// Folders). The point of it is that it is WIDER than grouped.folders[].rows.
describe('chatsInProject', () => {
  it('includes the pinned and snoozed chats that groupChats keeps out of the folder rows', () => {
    const all = [
      row({ chatId: 'plain', folder: '~/p', lastUpdated: 300 }),
      row({ chatId: 'pin', folder: '~/p', pinned: true, pinnedAt: 5, lastUpdated: 200 }),
      row({
        chatId: 'snoozed',
        folder: '~/p',
        snoozedUntil: Date.now() + 60_000,
        lastUpdated: 100,
      }),
    ];
    // The drawn rows are only ever the plain one...
    expect(groupChats(all).folders[0]?.rows.map((c) => c.chatId)).toEqual(['plain']);
    // ...while archive-all reaches all three.
    expect(chatsInProject(all, '~/p').map((c) => c.chatId)).toEqual(['plain', 'pin', 'snoozed']);
  });

  it('leaves already-archived and soft-deleted chats alone', () => {
    const all = [
      row({ chatId: 'active', folder: '~/p', lastUpdated: 300 }),
      row({ chatId: 'gone', folder: '~/p', status: 'archived', lastUpdated: 200 }),
      row({ chatId: 'binned', folder: '~/p', status: 'deleted', lastUpdated: 100 }),
    ];
    expect(chatsInProject(all, '~/p').map((c) => c.chatId)).toEqual(['active']);
  });

  it('never includes special threads, and never reaches into another folder', () => {
    const all = [
      row({ chatId: 'mine', folder: '~/p', lastUpdated: 300 }),
      row({ chatId: 'thread_manager', folder: '~/p', lastUpdated: 200 }),
      row({ chatId: SPECIAL_THREAD_IDS.speakers, folder: '~/p', lastUpdated: 120 }),
      row({ chatId: 'elsewhere', folder: '~/other', lastUpdated: 100 }),
    ];
    expect(chatsInProject(all, '~/p').map((c) => c.chatId)).toEqual(['mine']);
  });
});

// Recent projects must survive archiving the LAST chat in a folder and then
// reloading (Todoist: "archiving the last chat in a project makes the project
// disappear from the sidebar"). After a reload the store holds only the ACTIVE
// roster — the archived chat is simply absent — so `groupChats` takes the
// server's folder roster as a second source and seeds `folderRecency` from it.
describe('groupChats — recentFolders seeded from the folder roster', () => {
  it('keeps a folder whose only chat is archived and therefore absent from the store', () => {
    // Exactly the post-reload state: /arch has NO row at all.
    const chats = [row({ chatId: 'live', folder: '~/live', lastUpdated: 20 })];
    const roster = [
      { folder: '~/live', daemonId: 'd1', lastUpdated: 20 },
      { folder: '~/arch', daemonId: 'd1', lastUpdated: 10 },
    ];
    expect(groupChats(chats).recentFolders).toEqual([]);
    // ~/live is already drawn as an open Folders section, so only ~/arch is
    // offered as a recent — the "don't list it twice" filter still applies.
    expect(groupChats(chats, roster).recentFolders).toEqual(['~/arch']);
  });

  it('orders roster and live folders together, most-recent-first', () => {
    const chats = [
      row({ chatId: 'p', folder: '~/pinned', lastUpdated: 50, pinned: true, pinnedAt: 1 }),
    ];
    const roster = [
      { folder: '~/old', daemonId: 'd1', lastUpdated: 1 },
      { folder: '~/new', daemonId: 'd1', lastUpdated: 99 },
      { folder: '~/mid', daemonId: 'd1', lastUpdated: 40 },
    ];
    const { recentFolders } = groupChats(chats, roster);
    expect(recentFolders).toEqual(['~/new', '~/mid', '~/old']);
  });

  it('a live row beats the roster when it is newer (the roster is a cold-start floor, not a ceiling)', () => {
    // The roster was fetched at boot; this chat has since been archived live,
    // bumping its lastUpdated past the roster's stale value.
    const chats = [row({ chatId: 'a', folder: '~/proj', status: 'archived', lastUpdated: 900 })];
    const roster = [
      { folder: '~/proj', daemonId: 'd1', lastUpdated: 10 },
      { folder: '~/other', daemonId: 'd1', lastUpdated: 500 },
    ];
    const { recentFolders } = groupChats(chats, roster);
    expect(recentFolders).toEqual(['~/proj', '~/other']);
  });

  it('a folder deleted since boot still drops out, roster or not', () => {
    // Soft-delete is the one thing that DOES retire a folder. The roster row is
    // stale (it predates the delete), but the live `deleted` row must win.
    const chats = [row({ chatId: 'd', folder: '~/gone', status: 'deleted', lastUpdated: 5 })];
    const roster = [{ folder: '~/gone', daemonId: 'd1', lastUpdated: 5 }];
    expect(groupChats(chats, roster).recentFolders).toEqual([]);
  });

  it('never offers a special thread\u2019s folder', () => {
    const chats: ChatRow[] = [];
    const roster = [{ folder: '~/proj', daemonId: 'd1', lastUpdated: 5 }];
    expect(groupChats(chats, roster).recentFolders).toEqual(['~/proj']);
    // Manager/Speakers folders are filtered server-side, but the
    // store's own special rows must not sneak one in either.
    const withSpecial = [
      row({ chatId: SPECIAL_THREAD_IDS.speakers, folder: '~/speakers', lastUpdated: 99 }),
    ];
    expect(groupChats(withSpecial, roster).recentFolders).toEqual(['~/proj']);
  });
});

describe('groupChats — sidebar ordering (spec/14 § Sidebar ordering)', () => {
  it('sorts rows within a folder by the user’s own last activity, not lastUpdated', () => {
    // b was sent to more recently by the user, even though a's lastUpdated
    // (an agent reply, say) is newer.
    const chats = [
      row({ chatId: 'a', folder: '~/proj', lastUpdated: 900, lastUserActivity: 100 }),
      row({ chatId: 'b', folder: '~/proj', lastUpdated: 200, lastUserActivity: 800 }),
    ];
    const { folders } = groupChats(chats);
    expect(folders[0]!.rows.map((r) => r.chatId)).toEqual(['b', 'a']);
  });

  it('an agent reply (lastUpdated bump with no change to lastUserActivity) never reorders a row', () => {
    const before = [
      row({ chatId: 'older', folder: '~/proj', lastUpdated: 100, lastUserActivity: 100 }),
      row({ chatId: 'newer', folder: '~/proj', lastUpdated: 200, lastUserActivity: 200 }),
    ];
    expect(groupChats(before).folders[0]!.rows.map((r) => r.chatId)).toEqual(['newer', 'older']);

    // The agent replies to `older` — lastUpdated jumps way ahead, but the
    // user never sent anything, so lastUserActivity is untouched.
    const afterAgentReply = [
      row({ chatId: 'older', folder: '~/proj', lastUpdated: 9999, lastUserActivity: 100 }),
      row({ chatId: 'newer', folder: '~/proj', lastUpdated: 200, lastUserActivity: 200 }),
    ];
    expect(groupChats(afterAgentReply).folders[0]!.rows.map((r) => r.chatId)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('a user message moves its chat to the top of the folder', () => {
    const chats = [
      row({ chatId: 'a', folder: '~/proj', lastUpdated: 500, lastUserActivity: 500 }),
      row({ chatId: 'b', folder: '~/proj', lastUpdated: 100, lastUserActivity: 100 }),
    ];
    expect(groupChats(chats).folders[0]!.rows.map((r) => r.chatId)).toEqual(['a', 'b']);

    // The user sends a message in `b`: its lastUserActivity jumps to the front.
    const afterUserSend = [
      row({ chatId: 'a', folder: '~/proj', lastUpdated: 500, lastUserActivity: 500 }),
      row({ chatId: 'b', folder: '~/proj', lastUpdated: 600, lastUserActivity: 600 }),
    ];
    expect(groupChats(afterUserSend).folders[0]!.rows.map((r) => r.chatId)).toEqual(['b', 'a']);
  });

  it('a working or permission badge does not float a row to the top of its folder — only lastUserActivity decides position', () => {
    const chats = [
      row({
        chatId: 'idle-but-recent',
        folder: '~/proj',
        lastUpdated: 500,
        lastUserActivity: 500,
        activity: 'idle',
      }),
      row({
        chatId: 'working-but-older',
        folder: '~/proj',
        lastUpdated: 100,
        lastUserActivity: 100,
        activity: 'running',
      }),
    ];
    expect(groupChats(chats).folders[0]!.rows.map((r) => r.chatId)).toEqual([
      'idle-but-recent',
      'working-but-older',
    ]);
  });

  it('folders themselves are ordered by the most recent user activity across their chats, not lastUpdated', () => {
    const chats = [
      row({ chatId: 'a', folder: '~/stale-agent-churn', lastUpdated: 9999, lastUserActivity: 1 }),
      row({ chatId: 'b', folder: '~/recent-user', lastUpdated: 50, lastUserActivity: 500 }),
    ];
    const { folders } = groupChats(chats);
    expect(folders.map((f) => f.folder)).toEqual(['~/recent-user', '~/stale-agent-churn']);
  });

  it('pinned order is unaffected — still sorts by pinnedAt, manual, not activity', () => {
    const chats = [
      row({
        chatId: 'a',
        pinned: true,
        pinnedAt: 100,
        lastUpdated: 900,
        lastUserActivity: 900,
      }),
      row({
        chatId: 'b',
        pinned: true,
        pinnedAt: 200,
        lastUpdated: 100,
        lastUserActivity: 100,
      }),
    ];
    expect(groupChats(chats).pinned.map((r) => r.chatId)).toEqual(['b', 'a']);
  });
});

describe('groupChats ordering choice', () => {
  const rows = [
    row({ chatId: 'a1', name: 'Zed', folder: '~/alpha', lastUserActivity: 10, lastUpdated: 50 }),
    row({ chatId: 'a2', name: 'Bob', folder: '~/alpha', lastUserActivity: 20, lastUpdated: 5 }),
    row({ chatId: 'b1', name: 'Mid', folder: '~/beta', lastUserActivity: 15, lastUpdated: 90 }),
  ];
  it('defaults to last action for chats and projects', () => {
    const g = groupChats(rows);
    expect(g.folders.map((f) => f.folder)).toEqual(['~/alpha', '~/beta']);
    expect(g.folders[0]!.rows.map((r) => r.chatId)).toEqual(['a2', 'a1']);
  });
  it('last update orders by any activity', () => {
    const g = groupChats(rows, [], { chatSort: 'last-update', groupSort: 'last-update' });
    expect(g.folders.map((f) => f.folder)).toEqual(['~/beta', '~/alpha']);
    expect(g.folders[1]!.rows.map((r) => r.chatId)).toEqual(['a1', 'a2']);
  });
  it('chat sort and project sort are independent; name is A-Z', () => {
    const g = groupChats(rows, [], { chatSort: 'name', groupSort: 'last-action' });
    expect(g.folders.map((f) => f.folder)).toEqual(['~/alpha', '~/beta']);
    expect(g.folders[0]!.rows.map((r) => r.chatId)).toEqual(['a2', 'a1']);
    const h = groupChats(rows, [], { chatSort: 'last-action', groupSort: 'name' });
    expect(h.folders.map((f) => f.folder)).toEqual(['~/alpha', '~/beta']);
    const r = groupChats(
      rows.map((x) => ({ ...x, folder: x.folder === '~/alpha' ? '~/zzz' : x.folder })),
      [],
      {
        chatSort: 'last-action',
        groupSort: 'name',
      },
    );
    expect(r.folders.map((f) => f.folder)).toEqual(['~/beta', '~/zzz']);
  });
});
