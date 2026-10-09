// Chats tab — a slim header (wordmark + connection dot, search button), then a
// full-width column: Manager at top, then user-pinned, then folders, then
// Channels (read-only), then Hidden, Snoozed and Archived (all collapsed by
// default, each header carrying a count). Search asks the server (spec/03 § Chat
// search) once the query is long enough to send, and filters the loaded rows
// locally until it answers. Mirrors the web sidebar shape (spec/15 ## Chats tab).

import React from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  AlarmClock,
  Bot,
  Ear,
  Inbox,
  MessageCircle,
  Phone,
  Radio,
  Search,
  X,
} from 'lucide-react-native';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatSearchHit, ChatSearchHostResult } from '@patch/wire';
import { useChatStore } from '../../src/stores/chatStore';
import { ChatRowItem, useSettledPreview } from '../../src/components/ChatRow';
import { BatchView } from '../../src/components/BatchView';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { DaemonOfflineBanner } from '../../src/components/DaemonOfflineBanner';
import { EmptyState } from '../../src/components/EmptyState';
import { EMPTY_STATES } from '../../src/lib/emptyStates';
import { needsAttention, sortAttentionQueue } from '../../src/lib/attentionQueue';
import { matchesStateFilter, type ChatStateFilter } from '../../src/lib/stateFilter';
import { useBatchStore } from '../../src/stores/batchStore';
import { useUiStore } from '../../src/stores/uiStore';
import { OptionPicker } from '../../src/components/OptionPicker';
import {
  applySidebarView,
  sidebarViewFrom,
  sidebarViewTriggerLabel,
  SIDEBAR_VIEW_OPTIONS,
  type SidebarView,
} from '../../src/lib/sidebarView';
import {
  CHATS_SEARCHING,
  CHATS_SEARCH_MORE,
  CHATS_SEARCH_PLACEHOLDER,
  chatSearchFailed,
} from '../../src/lib/labels';
import { filterChats } from '../../src/lib/chatFilter';
import {
  hostMarkerText,
  localSearchHits,
  searchableQuery,
  useChatSearch,
  type ChatSearchState,
} from '../../src/lib/chatSearch';
import { ChatSearchHitRow } from '../../src/components/ChatSearchHitRow';
import { connectionDotColor } from '../../src/lib/connection';
import { usePresenceStore } from '../../src/stores/presenceStore';
import { fonts, radii, space, typography, useTheme } from '../../src/lib/theme';
import { startVoiceNote, releaseVoiceNoteIfHeld } from '../../src/lib/voiceNote';
import { startVoiceCall } from '../../src/lib/voiceCall';
import type { ChatRow, DisplayBadge } from '../../src/stores/types';
import { deriveBadge, isHidden, isSnoozed } from '../../src/stores/types';
import { badgeColor } from '../../src/lib/badge';
import { getSectionOpen, setSectionOpen } from '../../src/lib/sectionCollapse';
import type { CollapsibleSection } from '../../src/lib/sectionCollapse';

/** This tab's own four collapsible sections — a narrower slice of the
 * shared `CollapsibleSection` key space (spec/15 §§ Chats tab, Jobs screen
 * store their fold state under the same MMKV-backed helper but each only
 * ever toggles its own sections). */
type ChatsTabSection = Extract<CollapsibleSection, 'channels' | 'hidden' | 'snoozed' | 'archived'>;
import { useSectionCounts, type SectionCounts } from '../../src/lib/sectionCounts';
import { useArchivedChats, useHiddenChats } from '../../src/lib/archivedChats';

const MANAGER_ID = SPECIAL_THREAD_IDS.manager;
const SPEAKERS_ID = SPECIAL_THREAD_IDS.speakers;

// Manager card — the fixed slot at the top of the list, drawn as its own card
// rather than a chat row (spec/15 ## Chats tab §1): an avatar, the name, the
// last message, the Manager's status, and Call / Hands-free buttons that start
// the same sessions the Manager chat's top bar does. Tap opens the Manager
// thread; tap-and-hold sends a voice note to it (the Voice tab's gesture). It
// does NOT reuse ChatRowItem, whose status badge and Pin/Delete sheet are both
// wrong for the fixed Manager slot.
const MANAGER_STATUS: Record<DisplayBadge, string> = {
  working: 'Working',
  permission: 'Waiting on you',
  errored: 'Failed',
  done: 'New reply',
  background: 'Background job',
  monitoring: 'Monitoring',
  read: 'Idle',
};

function ManagerRow({ row }: { row: ChatRow }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const preview = useSettledPreview(row);
  const badge = deriveBadge(row);
  const statusColor = badgeColor(badge, colors);
  const actionButton = {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.accentSoft,
    backgroundColor: colors.paperRaised,
  } as const;
  const actionLabel = {
    ...typography.label,
    marginLeft: space.xs,
    color: colors.ink,
  } as const;
  return (
    <Pressable
      testID="manager-card"
      onPress={() => router.push(`/chats/${row.chatId}`)}
      onLongPress={() => startVoiceNote(row.chatId, 'hold')}
      onPressOut={() => releaseVoiceNoteIfHeld(row.chatId)}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel="Open chat manager"
      style={{
        marginHorizontal: space.lg,
        marginBottom: space.md,
        padding: space.md,
        backgroundColor: colors.accentTint,
        borderColor: colors.accentSoft,
        borderWidth: 1,
        borderRadius: radii.lg,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          testID="manager-avatar"
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: colors.paperRaised,
            borderWidth: 1,
            borderColor: colors.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: space.md,
          }}
        >
          <Bot size={24} color={colors.leafSoft} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
            <Text
              numberOfLines={1}
              style={{ ...typography.rowTitle, flex: 1, fontSize: 17, color: colors.ink }}
            >
              {row.name ?? 'Manager'}
            </Text>
            <Text testID="manager-status" style={{ ...typography.meta, color: statusColor }}>
              {MANAGER_STATUS[badge]}
            </Text>
          </View>
          <Text
            numberOfLines={2}
            style={{ ...typography.secondary, color: colors.ink2, marginTop: 2 }}
          >
            {preview}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', marginTop: space.md, gap: space.sm }}>
        <Pressable
          onPress={() => startVoiceCall(row.chatId)}
          accessibilityRole="button"
          accessibilityLabel="Call Manager"
          style={actionButton}
        >
          <Phone size={16} color={colors.ink} />
          <Text style={actionLabel}>Call</Text>
        </Pressable>
        <Pressable
          onPress={() => startVoiceCall(row.chatId, 'hands-free')}
          accessibilityRole="button"
          accessibilityLabel="Hands-free with Manager"
          style={actionButton}
        >
          <Ear size={16} color={colors.ink} />
          <Text style={actionLabel}>Hands-free</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

// Channel row (Speakers) — read-only mirror (spec/15 §4). Tap
// opens the read-only transcript; there is NO swipe-to-archive, NO long-press
// Pin/Delete context sheet, NO voice note. This thread is not a user chat.
function ChannelRow({ row }: { row: ChatRow }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const label = 'Speakers';
  const preview = useSettledPreview(row);
  return (
    <Pressable
      onPress={() => router.push(`/chats/${row.chatId}`)}
      accessibilityRole="button"
      accessibilityLabel={`Open channel ${label}`}
      style={{
        marginHorizontal: space.lg,
        marginBottom: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.md,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.paperRaised,
        borderColor: colors.lineSoft,
        borderWidth: 1,
        borderRadius: radii.md,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ ...typography.rowTitle, color: colors.ink2 }}>
          {row.name ?? label}
        </Text>
        <Text numberOfLines={1} style={{ ...typography.meta, color: colors.ink3, marginTop: 2 }}>
          {preview}
        </Text>
      </View>
      <Text style={{ ...typography.meta, color: colors.ink3 }}>read-only</Text>
    </Pressable>
  );
}

// Snoozed section body (spec/15 ## Chats tab §6; spec/04 § Snooze). Rendered as
// ONE list item holding every snoozed row, because a snoozed chat is defined by
// where it is drawn: this is the one place it appears, and grouping the rows
// makes that containment structural rather than a convention rows have to obey.
// Each row is a plain ChatRowItem — it shows its wake time in the timestamp
// slot, and Unsnooze is on its swipe tray and long-press sheet.
function SnoozedSection({ rows }: { rows: ChatRow[] }): React.ReactElement {
  return (
    <View testID="snoozed-section">
      {rows.length === 0 ? (
        <EmptyState
          icon={AlarmClock}
          title={EMPTY_STATES.snoozed.title}
          body={EMPTY_STATES.snoozed.body}
        />
      ) : (
        rows.map((row) => <ChatRowItem key={row.chatId} row={row} />)
      )}
    </View>
  );
}

// The Chats tab's slim header (spec/15 ## Chats tab § Header): the wordmark with
// its connection dot on the left, the search button on the right; searching
// swaps the row's content for the search field and a close button. Fixed at
// HEADER_HEIGHT either way, so opening search never shifts the list. It is the
// list's top gap as well — the first row sits straight under it.
const HEADER_HEIGHT = 44;

function ChatsHeader({
  searching,
  query,
  onQuery,
  onOpenSearch,
  onCloseSearch,
}: {
  searching: boolean;
  query: string;
  onQuery: (q: string) => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
}): React.ReactElement {
  const colors = useTheme();
  // The dot reflects the WS link ONLY (spec/15 § Offline / error states); the
  // host being down is its own app-level banner, never this dot.
  const conn = usePresenceStore((s) => s.connection);
  const dotColor = connectionDotColor(conn, colors);
  const iconButton = {
    width: HEADER_HEIGHT,
    height: HEADER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    // Pull the 44dp touch target's padding out past the row's edge, so the
    // glyph itself lines up with the rows' right-hand content.
    marginRight: -space.md,
  } as const;
  return (
    <View
      testID="chats-header"
      style={{
        height: HEADER_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space.lg,
      }}
    >
      {searching ? (
        <>
          <TextInput
            autoFocus
            value={query}
            onChangeText={onQuery}
            returnKeyType="search"
            placeholder={CHATS_SEARCH_PLACEHOLDER}
            placeholderTextColor={colors.ink3}
            accessibilityLabel="chats-search"
            style={{
              flex: 1,
              color: colors.ink,
              fontFamily: fonts.body,
              fontSize: 15,
              paddingVertical: 0,
            }}
          />
          <Pressable
            onPress={onCloseSearch}
            accessibilityRole="button"
            accessibilityLabel="Close search"
            style={iconButton}
          >
            <X size={20} color={colors.ink2} />
          </Pressable>
        </>
      ) : (
        <>
          <Text style={{ ...typography.wordmark, color: colors.leafSoft }}>patch</Text>
          {/* Rides the wordmark's ascender, as on web (spec/14 § Sidebar §1).
              No dot at all before the first connect lands. */}
          {dotColor === null ? null : (
            <View
              accessibilityLabel="connection state"
              testID={`connection-dot-${conn}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: dotColor,
                marginLeft: space.xs,
                marginBottom: space.md,
              }}
            />
          )}
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={onOpenSearch}
            accessibilityRole="button"
            accessibilityLabel="Search chats"
            style={iconButton}
          >
            <Search size={20} color={colors.ink2} />
          </Pressable>
        </>
      )}
    </View>
  );
}

// The Chats tab's one view dropdown (spec/15 § Chats tab; mirrors web's
// `SidebarViewMenu`, `14-design-web.md` § Sidebar §1b). Replaces the old
// Chats/Batch switch and the Needs attention chip below it — three controls'
// worth of "what does the list show" collapsed into one pill + list
// (`OptionPicker`, the same shape as every other dropdown in this app). The
// Batch option carries the same non-zero member count web's dropdown shows —
// the server's own membership count, the same the batch view lists.
function SidebarViewMenu(): React.ReactElement {
  const mode = useBatchStore((s) => s.mode);
  const setMode = useBatchStore((s) => s.setMode);
  const batchCount = useBatchStore((s) => s.batch?.members.length ?? 0);

  const attentionOnly = useUiStore((s) => s.attentionOnly);
  const setAttentionOnly = useUiStore((s) => s.setAttentionOnly);
  const stateFilter = useUiStore((s) => s.stateFilter);
  const setStateFilter = useUiStore((s) => s.setStateFilter);

  const view = sidebarViewFrom(mode === 'batch', attentionOnly, stateFilter);

  return (
    <View style={{ paddingHorizontal: space.lg, marginBottom: space.sm, alignItems: 'flex-start' }}>
      <OptionPicker
        testID="chats-view-menu"
        selectedId={view}
        selectedLabel={sidebarViewTriggerLabel(view)}
        emptyText="No views"
        options={SIDEBAR_VIEW_OPTIONS.map((o) => ({
          id: o.value,
          label: o.value === 'batch' && batchCount > 0 ? `${o.label} · ${batchCount}` : o.label,
        }))}
        onSelect={(id) =>
          applySidebarView(id as SidebarView, {
            setBatchMode: (on) => setMode(on ? 'batch' : 'regular'),
            setAttentionOnly,
            setStateFilter,
          })
        }
      />
    </View>
  );
}

interface Section {
  kind:
    | 'header'
    | 'manager'
    | 'pinned-row'
    | 'folder-row'
    | 'channel-row'
    | 'channels-empty'
    | 'hidden-row'
    | 'snoozed-section'
    | 'archived-row'
    | 'attention-empty'
    | 'search-empty';
  label?: string;
  /** The collapsible section this header opens and closes; absent = a plain label. */
  toggle?: ChatsTabSection;
  /** A collapsible header's count; `null` draws none (not loaded yet). */
  count?: number | null;
  row?: ChatRow;
  rows?: ChatRow[];
}

interface Open {
  channels: boolean;
  hidden: boolean;
  snoozed: boolean;
  archived: boolean;
}

/**
 * The list, top to bottom (spec/15 ## Chats tab). With a search query every
 * section is filtered by it — pinned, folders, channels, hidden, snoozed and archived
 * alike, Manager included — collapsed sections are searched too, sections with
 * no match drop out entirely, and the collapse toggles and counts step aside
 * (they describe the whole section, not the matches).
 *
 * `attentionMatches`, when non-null (the view dropdown's Unread option, and
 * not currently searching), replaces the whole list with just Manager + a
 * Pinned/Folders view filtered down to it and re-ordered FIFO
 * (`sortAttentionQueue`) — Channels, Hidden, Snoozed and Archived hide
 * entirely, same as the web sidebar's mode (`14-design-web.md` § Chat
 * lifecycle → Needs attention toggle).
 *
 * `stateFilter` (the dropdown's Working/Waiting on you/Failed options) narrows
 * Pinned + Folders the same way `attentionMatches` does, but leaves Channels,
 * Hidden, Snoozed and Archived showing — it answers "what's failed", not "what
 * needs me", so the rest of the list stays reachable (mirrors web's own
 * `matchesStateFilter`, which only ever touches pinned/folder rows).
 */
function buildSections(
  chats: Record<string, ChatRow>,
  open: Open,
  counts: SectionCounts,
  query: string,
  attentionMatches: ((row: ChatRow) => boolean) | null,
  stateFilter: ChatStateFilter,
): Section[] {
  const searching = query.trim() !== '';
  const match = (rows: ChatRow[]): ChatRow[] => (searching ? filterChats(rows, query) : rows);
  // Only Pinned + Folders answer the state filter (see doc comment above) —
  // Manager, Channels, Hidden, Snoozed and Archived are untouched by it.
  const matchPinnedOrFolder = (rows: ChatRow[]): ChatRow[] => {
    const byQuery = match(rows);
    return stateFilter === 'all'
      ? byQuery
      : byQuery.filter((r) => matchesStateFilter(r, stateFilter));
  };

  const all = Object.values(chats);
  const manager = all.find((c) => c.chatId === MANAGER_ID);
  const channels = all.filter((c) => c.chatId === SPEAKERS_ID);
  const channelIds = new Set<string>([MANAGER_ID, SPEAKERS_ID]);
  // `errored` is a chat whose last turn failed, not one the user put away — it
  // belongs in its folder like any other live chat, same as web's own active
  // bucket (`chatGroups.ts`'s `status !== 'archived' && status !== 'deleted'`).
  // Strict `=== 'active'` silently dropped it from the Chats tab entirely,
  // which is how the Failed state filter (and Unread, which also counts an
  // `errored` badge) found nothing to show for one.
  const active = all.filter(
    (c) => !channelIds.has(c.chatId) && c.status !== 'archived' && c.status !== 'deleted',
  );
  const userArchived = all.filter((c) => !channelIds.has(c.chatId) && c.status === 'archived');
  // A hidden chat is drawn in Hidden and nowhere else (spec/04 § Hidden) —
  // checked before snooze, as the server does, so a hidden chat that is also
  // snoozed is drawn once, there.
  const hidden = active.filter(isHidden).sort((a, b) => b.lastUpdated - a.lastUpdated);
  const visible = active.filter((c) => !isHidden(c));
  // Snoozed is DERIVED from the clock, never a stored flag (spec/04 § Snooze),
  // so a wake time that passed while the phone was asleep returns the chat to
  // its folder on this first paint — no event required.
  const snoozed = visible
    .filter((c) => isSnoozed(c))
    .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  const userActive = visible.filter((c) => !isSnoozed(c));

  const pinned = userActive
    .filter((c) => c.pinned)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));

  const folders = new Map<string, ChatRow[]>();
  for (const c of userActive) {
    if (c.pinned) continue;
    const list = folders.get(c.folder) ?? [];
    list.push(c);
    folders.set(c.folder, list);
  }

  const out: Section[] = [];
  // No section header over Manager: the row is itself named "Manager".
  if (manager && match([manager]).length > 0) out.push({ kind: 'manager', row: manager });

  if (attentionMatches && !searching) {
    let anyRows = false;
    const pinnedAttention = sortAttentionQueue(pinned.filter(attentionMatches));
    if (pinnedAttention.length > 0) {
      anyRows = true;
      out.push({ kind: 'header', label: 'Pinned' });
      for (const r of pinnedAttention) out.push({ kind: 'pinned-row', row: r });
    }
    for (const [folder, rows] of [...folders.entries()].sort()) {
      const shown = sortAttentionQueue(rows.filter(attentionMatches));
      if (shown.length === 0) continue;
      anyRows = true;
      out.push({ kind: 'header', label: folder || '(no folder)' });
      for (const r of shown) out.push({ kind: 'folder-row', row: r });
    }
    if (!anyRows) out.push({ kind: 'attention-empty' });
    return out;
  }

  const pinnedShown = matchPinnedOrFolder(pinned);
  if (pinnedShown.length > 0) {
    out.push({ kind: 'header', label: 'Pinned' });
    for (const r of pinnedShown) out.push({ kind: 'pinned-row', row: r });
  }
  for (const [folder, rows] of [...folders.entries()].sort()) {
    // spec/14 § Sidebar ordering — sorts by the user's own last activity
    // (when they last sent a message, or chat creation), never `lastUpdated`:
    // an agent reply, a status change, a job tick or a finished turn must
    // not move a row.
    const shown = matchPinnedOrFolder(rows.sort((a, b) => b.lastUserActivity - a.lastUserActivity));
    if (shown.length === 0) continue;
    out.push({ kind: 'header', label: folder || '(no folder)' });
    for (const r of shown) out.push({ kind: 'folder-row', row: r });
  }
  const archivedChronological = [...userArchived].sort((a, b) => b.lastUpdated - a.lastUpdated);

  if (searching) {
    const channelsShown = match(channels);
    if (channelsShown.length > 0) {
      out.push({ kind: 'header', label: 'Channels' });
      for (const c of channelsShown) out.push({ kind: 'channel-row', row: c });
    }
    const hiddenShown = match(hidden);
    if (hiddenShown.length > 0) {
      out.push({ kind: 'header', label: 'Hidden' });
      for (const r of hiddenShown) out.push({ kind: 'hidden-row', row: r });
    }
    const snoozedShown = match(snoozed);
    if (snoozedShown.length > 0) {
      out.push({ kind: 'header', label: 'Snoozed' });
      out.push({ kind: 'snoozed-section', rows: snoozedShown });
    }
    const archivedShown = match(archivedChronological);
    if (archivedShown.length > 0) {
      out.push({ kind: 'header', label: 'Archived' });
      for (const r of archivedShown) out.push({ kind: 'archived-row', row: r });
    }
    // A query that matches nothing gets a proper empty state, not a blank
    // list (spec/15 § Empty states — empty chat search).
    if (out.length === 0) out.push({ kind: 'search-empty' });
    return out;
  }

  out.push({ kind: 'header', label: 'Channels', toggle: 'channels' });
  if (open.channels) {
    // A proper empty state, never a blank gap (spec/15 § Empty states).
    if (channels.length === 0) out.push({ kind: 'channels-empty' });
    for (const c of channels) out.push({ kind: 'channel-row', row: c });
  }
  // Hidden, like Archived, is left out of the cold-start roster: its count is
  // the server's total and opening it fetches the list (useHiddenChats), which
  // `chat.state` then keeps live.
  out.push({ kind: 'header', label: 'Hidden', toggle: 'hidden', count: counts.hidden });
  if (open.hidden) {
    for (const r of hidden) out.push({ kind: 'hidden-row', row: r });
  }
  // Snoozed counts its own rows: the cold-start list includes every snoozed
  // chat (`snoozed=include`), so the local number is exactly what opens.
  out.push({ kind: 'header', label: 'Snoozed', toggle: 'snoozed', count: snoozed.length });
  if (open.snoozed) out.push({ kind: 'snoozed-section', rows: snoozed });
  // Archived: its count is the server's total (useSectionCounts), and opening
  // it fetches the list behind it (useArchivedChats).
  out.push({ kind: 'header', label: 'Archived', toggle: 'archived', count: counts.archived });
  if (open.archived) {
    for (const r of archivedChronological) out.push({ kind: 'archived-row', row: r });
  }
  return out;
}

/** One row of the search results list (spec/03 § Chat search). */
type SearchItem =
  | { kind: 'searching' }
  | { kind: 'hit'; hit: ChatSearchHit; local: boolean }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'more'; busy: boolean }
  | { kind: 'host'; host: ChatSearchHostResult; text: string };

/**
 * The results list for a query long enough to send. Until the server answers
 * the current query, the loaded chats filtered locally stand in under a
 * "Searching…" line; once it answers, its hits are the list — the server is
 * the truth. A failure is a row, never only a toast, and every host that was
 * not searched is named under the results, even when there are none.
 */
function buildSearchItems(
  s: ChatSearchState,
  local: ChatSearchHit[],
  hostName: (daemonId: string, fromServer: string | null) => string,
): SearchItem[] {
  if (s.status === 'waiting') {
    return [
      { kind: 'searching' },
      ...local.map((hit): SearchItem => ({ kind: 'hit', hit, local: true })),
    ];
  }
  if (s.status === 'failed') return [{ kind: 'error', message: String(s.error) }];
  const out: SearchItem[] = [];
  if (s.hits.length === 0) out.push({ kind: 'empty' });
  for (const hit of s.hits) out.push({ kind: 'hit', hit, local: false });
  if (s.nextOffset !== null) out.push({ kind: 'more', busy: s.loadingMore });
  if (s.error !== null) out.push({ kind: 'error', message: s.error });
  for (const host of s.hosts) {
    const text = hostMarkerText(host, hostName(host.daemonId, host.hostName));
    if (text !== null) out.push({ kind: 'host', host, text });
  }
  return out;
}

function searchItemKey(item: SearchItem): string {
  if (item.kind === 'hit') return `hit-${item.hit.chatId}`;
  if (item.kind === 'host') return `host-${item.host.daemonId}`;
  return item.kind;
}

function SearchResults({
  query,
  onHitPress,
}: {
  query: string;
  onHitPress: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const search = useChatSearch(query);
  const chats = useChatStore((s) => s.chats);
  // A host is named as the app already names it (its self-reported hostName,
  // the Hosts section's label), then by what the server said, then its id.
  const presence = usePresenceStore((s) => s.hosts);
  const hostName = (daemonId: string, fromServer: string | null): string =>
    presence[daemonId]?.host?.hostName ?? fromServer ?? daemonId;
  const serverNames = new Map(search.hosts.map((h) => [h.daemonId, h.hostName]));
  const waiting = search.status === 'waiting';
  const local = React.useMemo(
    () => (waiting ? localSearchHits(Object.values(chats), query) : []),
    [waiting, chats, query],
  );
  const items = buildSearchItems(search, local, hostName);
  const quiet = { ...typography.meta, color: colors.ink3 } as const;
  const noteRow = { paddingHorizontal: space.lg, paddingVertical: space.sm } as const;
  return (
    <FlatList
      testID="chat-search-results"
      data={items}
      keyboardShouldPersistTaps="handled"
      keyExtractor={searchItemKey}
      renderItem={({ item }) => {
        switch (item.kind) {
          case 'searching':
            return (
              <Text testID="chat-search-searching" style={{ ...quiet, ...noteRow }}>
                {CHATS_SEARCHING}
              </Text>
            );
          case 'hit':
            return (
              <ChatSearchHitRow
                hit={item.hit}
                hostName={hostName(item.hit.daemonId, serverNames.get(item.hit.daemonId) ?? null)}
                testID={item.local ? 'chat-search-local-hit' : 'chat-search-hit'}
                onPress={onHitPress}
              />
            );
          case 'empty':
            return (
              <EmptyState
                icon={MessageCircle}
                title={EMPTY_STATES.chatSearch.title}
                body={EMPTY_STATES.chatSearch.body}
              />
            );
          case 'error':
            return (
              <Text testID="chat-search-error" style={{ ...quiet, ...noteRow, color: colors.red }}>
                {chatSearchFailed(item.message)}
              </Text>
            );
          case 'more':
            return (
              <Pressable
                testID="chat-search-more"
                onPress={search.loadMore}
                disabled={item.busy}
                accessibilityRole="button"
                style={{ ...noteRow, alignItems: 'center', opacity: item.busy ? 0.5 : 1 }}
              >
                <Text style={{ ...typography.label, color: colors.leafSoft }}>
                  {item.busy ? CHATS_SEARCHING : CHATS_SEARCH_MORE}
                </Text>
              </Pressable>
            );
          case 'host':
            return (
              <Text
                testID={`chat-search-host-${item.host.daemonId}`}
                style={{ ...quiet, ...noteRow }}
              >
                {item.text}
              </Text>
            );
        }
      }}
    />
  );
}

export default function ChatsScreen(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const chats = useChatStore((s) => s.chats);
  // Channels is EXPANDED by default (spec/15 §4): a collapsed channel list
  // reads as "hidden/broken". Hidden, Snoozed and Archived are COLLAPSED by default
  // (§§5–7) — they are cold storage, and their header count says what is in
  // them without opening. Every toggle is remembered across launches.
  const [open, setOpen] = React.useState<Open>(() => ({
    channels: getSectionOpen('channels', true),
    hidden: getSectionOpen('hidden', false),
    snoozed: getSectionOpen('snoozed', false),
    archived: getSectionOpen('archived', false),
  }));
  // Search (spec/15 ## Chats tab § Search, spec/03 § Chat search): `searching`
  // is whether the header shows the field. A query long enough to send
  // (CHAT_SEARCH_MIN_QUERY) swaps the list for the server's results; a single
  // character cannot be sent, so it keeps the instant local filter over the
  // sections rather than doing nothing while the user is mid-word.
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const counts = useSectionCounts();
  // Hidden and archived rows are not in the cold-start roster; fetch each
  // whenever it could be drawn — its section is open, or a search covers it.
  useHiddenChats(open.hidden || searching);
  useArchivedChats(open.archived || searching);

  // Batch mode (spec/15 § Batch view): the `Batch` tab swaps the whole column
  // for BatchView, which owns its own scroll region — the Chats tab's own
  // FlatList/search is simply not rendered while it is active.
  const batchMode = useBatchStore((s) => s.mode) === 'batch';

  // Needs-attention mode (spec/15 § Needs attention). Opening a row marks it
  // read, which would ordinarily drop it out of the filter the instant you
  // tap it — the row you're looking at vanishes under your thumb. Instead it
  // is HELD: kept in the filtered list (greyed like any other read row) until
  // you navigate to a DIFFERENT chat. Mirrors the web sidebar's own held-row
  // effect (`packages/web/src/components/Sidebar.tsx`) exactly, keyed off the
  // same `activeChatId` this app already tracks on chat-detail mount/unmount.
  const attentionOnly = useUiStore((s) => s.attentionOnly);
  // The view dropdown's Working/Waiting on you/Failed options (spec/15 §
  // Chats tab). Mutually exclusive with `attentionOnly`/batch mode — the
  // dropdown only ever sets one of the three at a time (lib/sidebarView.ts).
  const stateFilter = useUiStore((s) => s.stateFilter);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const [heldChatId, setHeldChatId] = React.useState<string | null>(null);
  const prevAttentionIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const currentIds = new Set(
      Object.values(chats)
        .filter(needsAttention)
        .map((c) => c.chatId),
    );
    const activeIsWorking = activeChatId !== null && chats[activeChatId]?.activity === 'running';
    if (
      attentionOnly &&
      activeChatId !== null &&
      !activeIsWorking &&
      prevAttentionIdsRef.current.has(activeChatId) &&
      !currentIds.has(activeChatId)
    ) {
      setHeldChatId(activeChatId);
    } else if (!attentionOnly || heldChatId !== activeChatId || activeIsWorking) {
      setHeldChatId(null);
    }
    prevAttentionIdsRef.current = currentIds;
  }, [chats, attentionOnly, activeChatId, heldChatId]);
  const attentionMatches = React.useMemo(
    () =>
      attentionOnly ? (row: ChatRow) => needsAttention(row) || row.chatId === heldChatId : null,
    [attentionOnly, heldChatId],
  );

  const serverQuery = searching ? searchableQuery(query) : null;
  const items = React.useMemo(
    () => buildSections(chats, open, counts, query, attentionMatches, stateFilter),
    [chats, open, counts, query, attentionMatches, stateFilter],
  );

  const toggle = (section: ChatsTabSection): void => {
    const next = !open[section];
    setSectionOpen(section, next);
    setOpen({ ...open, [section]: next });
  };

  // Shared by the header's close button and pressing a search result: either
  // way, search is done and the normal list should be what's there next.
  const closeSearch = (): void => {
    setQuery('');
    setSearching(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <ChatsHeader
        searching={searching}
        query={query}
        onQuery={setQuery}
        onOpenSearch={() => setSearching(true)}
        onCloseSearch={closeSearch}
      />
      <SidebarViewMenu />
      <OfflineBanner />
      <DaemonOfflineBanner />
      {batchMode ? (
        <BatchView />
      ) : serverQuery !== null ? (
        <SearchResults query={serverQuery} onHitPress={closeSearch} />
      ) : (
        <FlatList
          data={items}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item, idx) =>
            item.kind === 'header'
              ? `h-${idx}-${item.label}`
              : item.kind === 'search-empty' ||
                  item.kind === 'channels-empty' ||
                  item.kind === 'snoozed-section' ||
                  item.kind === 'attention-empty'
                ? `${item.kind}-${idx}`
                : `r-${item.row?.chatId}`
          }
          renderItem={({ item }) => {
            if (item.kind === 'header') {
              const section = item.toggle;
              return (
                <Pressable
                  onPress={section ? () => toggle(section) : undefined}
                  disabled={!section}
                  accessibilityRole={section ? 'button' : 'header'}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'baseline',
                    paddingHorizontal: space.lg,
                    paddingTop: space.lg,
                    paddingBottom: space.sm,
                  }}
                >
                  <Text style={{ ...typography.sectionHeader, color: colors.ink3 }}>
                    {section ? `${item.label} ${open[section] ? '▾' : '▸'}` : item.label}
                  </Text>
                  {section && item.count !== undefined && item.count !== null ? (
                    <Text
                      testID={`${section}-count`}
                      style={{ ...typography.meta, marginLeft: space.sm, color: colors.inkFaint }}
                    >
                      {item.count}
                    </Text>
                  ) : null}
                </Pressable>
              );
            }
            if (item.kind === 'search-empty') {
              return (
                <EmptyState
                  icon={MessageCircle}
                  title={EMPTY_STATES.chatSearch.title}
                  body={EMPTY_STATES.chatSearch.body}
                />
              );
            }
            if (item.kind === 'snoozed-section') {
              return <SnoozedSection rows={item.rows ?? []} />;
            }
            if (item.kind === 'channels-empty') {
              return (
                <EmptyState
                  icon={Radio}
                  title={EMPTY_STATES.channels.title}
                  body={EMPTY_STATES.channels.body}
                />
              );
            }
            if (item.kind === 'attention-empty') {
              return (
                <EmptyState
                  icon={Inbox}
                  title={EMPTY_STATES.attentionEmpty.title}
                  body={EMPTY_STATES.attentionEmpty.body}
                />
              );
            }
            if (!item.row) return null;
            if (item.kind === 'manager') return <ManagerRow row={item.row} />;
            if (item.kind === 'channel-row') return <ChannelRow row={item.row} />;
            // pinned / folder / hidden / archived rows are regular user chats — full
            // ChatRowItem (⋯ row-actions menu + long-press context sheet).
            return <ChatRowItem row={item.row} />;
          }}
          ListEmptyComponent={
            <EmptyState
              icon={MessageCircle}
              title={EMPTY_STATES.chats.title}
              body={EMPTY_STATES.chats.body}
              action={{ label: 'New chat', onPress: () => router.push('/new-chat') }}
            />
          }
        />
      )}
    </View>
  );
}
