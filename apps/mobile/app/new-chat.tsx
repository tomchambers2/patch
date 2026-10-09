// New-chat screen (spec/15 § New chat flow) — type-first, the same shape as
// web's new chat (spec/14 § Sidebar §8 / § New-chat setup row). The composer is
// here from the start, docked at the bottom of the window with the three
// things a new chat must decide sitting directly above it as quick picks —
// not spread across the top, so the screen reads like the chat it is about to
// become (empty transcript above, controls + composer below) rather than a
// form:
//
//   Folder — one pill, `<folder> · <host>`, opening the folder picker sheet
//            (one search box; picking a folder picks its host too).
//   Model  — the three most recently used models on that host, plus the pill
//            that opens the host's full live catalogue.
//   Mode   — the permission mode the chat starts in.
//
// NOTHING exists server-side until the first send. The composer's send asks
// this screen for its target (`sendTarget`), which creates the chat
// (`POST /api/chats`, the call web makes) and hands back its id; the composer
// then echoes and sends exactly as it would into any chat, and this screen
// navigates into the new chat at once — attachments upload there, in the
// stream, and a failed one stays there as `Not uploaded` with Retry / ×
// (spec/15 § Composer → Attachments; lib/sendQueue.ts). So a created chat is
// always one that was sent into, and backing out before sending leaves no
// chat behind — the draft text and attachments stay under the new-chat draft
// key for next time, as web keeps a new-chat draft.
//
// Untouched, the model and mode ride on nothing: the host resolves its own
// (spec/04 § Spawn) rather than the phone pinning its guess.

import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronLeft, Folder } from 'lucide-react-native';
import { folderName, type PermissionMode } from '@patch/wire';
import { api, ApiError } from '../src/api/rest';
import { FolderPickerSheet } from '../src/components/FolderPickerSheet';
import { Composer, permissionModeIcon } from '../src/components/Composer';
import { ModelPicker } from '../src/components/ModelPicker';
import { useSettingsStore } from '../src/stores/settingsStore';
import { AnchoredMenu } from '../src/components/AnchoredMenu';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { useUiStore } from '../src/stores/uiStore';
import { defaultDaemonId, hostDefaultModel, usePresenceStore } from '../src/stores/presenceStore';
import { NEW_CHAT_DRAFT_KEY, newChatRoute } from '../src/lib/newChat';
import { buildRecentFolders } from '../src/lib/folderPicker';
import { useModelCatalog } from '../src/lib/models';
import { recentModelPicks } from '../src/lib/newChatSetup';
import { loadLastNewChat, saveLastNewChat } from '../src/lib/lastNewChat';
import {
  PERMISSION_MODE_ORDER,
  offeredPermissionModes,
  permissionModeLabel,
} from '../src/lib/permissionModes';
import { compactModelLabel } from '../src/lib/modelLabel';
import { fonts, radii, space, textMin, typography, useTheme } from '../src/lib/theme';
import { useGoBack } from '../src/lib/goBack';

/** One quick-pick button — the shared shape of every row on this screen. */
function Chip({
  label,
  selected,
  dimmed = false,
  onPress,
  testID,
  icon,
  trailing,
}: {
  label: string;
  selected: boolean;
  dimmed?: boolean;
  onPress: () => void;
  testID: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: selected ? colors.leaf : colors.divider,
        backgroundColor: selected ? colors.accentTint : pressed ? colors.divider : colors.paper,
        opacity: dimmed ? 0.5 : 1,
        maxWidth: 220,
      })}
    >
      {icon}
      <Text
        numberOfLines={1}
        style={{
          color: selected ? colors.leaf : colors.ink2,
          fontFamily: selected ? fonts.bodyBold : fonts.body,
          fontSize: 14,
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

/** A labelled row of chips. */
function PickRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View style={{ paddingHorizontal: space.lg, marginTop: space.md }}>
      <Text style={{ color: colors.ink3, fontSize: textMin, marginBottom: space.xs }}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, alignItems: 'center' }}>
        {children}
      </View>
    </View>
  );
}

export default function NewChat(): React.ReactElement {
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/chats');
  const colors = useTheme();
  // Frozen at open: the recents and model picks below read this snapshot, so a
  // chat changing elsewhere (a job, a hidden thread, a reply landing in an
  // existing chat) never reorders or swaps what the user is looking at.
  const [chats] = React.useState(() => useChatStore.getState().chats);
  const [last] = React.useState(loadLastNewChat);
  const hosts = usePresenceStore((s) => s.hosts);
  const hostIds = React.useMemo(() => Object.keys(hosts), [hosts]);

  // ── Host + folder ─────────────────────────────────────────────────────────
  // Opens on the most recently used (host, folder) pair, else the default host
  // with no folder (spec/14 § Sidebar §8 — "defaults to the most-recently-used
  // (host, folder) pair"). Seeded ONCE, when the roster first has hosts in it
  // (a cold start can open this screen before the greeting lands); after that
  // only the user moves it.
  // A caller that already knows where the chat belongs (chat detail's ⋯ → New
  // chat: "another one here") passes that host + folder, and the screen opens
  // on them instead of the most recent pair — still type-first, nothing is
  // created until the first send.
  const here = useLocalSearchParams<{ daemonId?: string; folder?: string }>();
  const hereDaemonId = typeof here.daemonId === 'string' && here.daemonId ? here.daemonId : null;
  const hereFolder = typeof here.folder === 'string' && here.folder ? here.folder : null;
  const [daemonId, setDaemonId] = React.useState<string | null>(
    hereDaemonId ?? last?.daemonId ?? null,
  );
  const [folder, setFolder] = React.useState<string | null>(
    hereDaemonId ? hereFolder : (last?.folder ?? null),
  );
  const seededRef = React.useRef(hereDaemonId !== null || last !== null);
  React.useEffect(() => {
    if (seededRef.current || hostIds.length === 0) return;
    seededRef.current = true;
    setDaemonId(defaultDaemonId(hosts));
  }, [hosts, hostIds]);

  // Every folder the sheet offers, across hosts. The SELECTOR returns the
  // stored map (a stable reference that only changes when a host
  // republishes); the flat list is derived here — a selector that built the
  // array itself would hand React a new reference on every render.
  const hostFolders = useFolderStore((s) => s.byHost);
  const recents = React.useMemo(() => buildRecentFolders(chats, hostFolders), [chats, hostFolders]);
  const [folderSheetOpen, setFolderSheetOpen] = React.useState(false);

  // ── Model ─────────────────────────────────────────────────────────────────
  const hostModel = usePresenceStore((s) => hostDefaultModel(s.hosts, daemonId));
  // The explicit choice, or null while there is none — only an explicit
  // choice rides on the spawn, so this is never seeded from `hostModel`.
  const [model, setModel] = React.useState<string | null>(
    hereDaemonId ? null : (last?.model ?? null),
  );
  const effectiveModel = model ?? hostModel;
  // The shared accounts a chat on this model could start on (spec/10 —
  // preferred account); null leaves it to the strategy.
  const [preferredAccountId, setPreferredAccountId] = React.useState<string | null>(null);
  const sharedSecrets = useSettingsStore((st) => st.data?.shared?.secrets);
  const preferable = React.useMemo(
    () =>
      (
        (effectiveModel?.startsWith('openai/') ? sharedSecrets?.codex : sharedSecrets?.claude) ?? []
      ).filter((a) => a.connected),
    [sharedSecrets, effectiveModel],
  );
  React.useEffect(() => {
    if (preferredAccountId !== null && !preferable.some((a) => a.id === preferredAccountId)) {
      setPreferredAccountId(null);
    }
  }, [preferable, preferredAccountId]);
  const catalog = useModelCatalog(daemonId);
  const modelPicks = React.useMemo(
    () => (daemonId ? recentModelPicks(chats, daemonId, catalog.models) : []),
    [chats, daemonId, catalog.models],
  );

  // ── Permission mode ───────────────────────────────────────────────────────
  const hostModeDefault = usePresenceStore((s) =>
    daemonId ? (s.hosts[daemonId]?.host?.permissionModeDefault ?? null) : null,
  );
  const [mode, setMode] = React.useState<PermissionMode | null>(
    hereDaemonId ? null : (last?.permissionMode ?? null),
  );
  const effectiveMode = mode ?? hostModeDefault;
  const [modeMenuOpen, setModeMenuOpen] = React.useState(false);
  const offeredModes = offeredPermissionModes(effectiveModel);
  const ModeIcon = permissionModeIcon(effectiveMode ?? 'default');

  const chooseFolder = (id: string, picked: string): void => {
    const h = hosts[id];
    if (h && !h.online) {
      useUiStore
        .getState()
        .pushError(`${h.host?.hostName ?? id} is offline — start the chat on another host`);
      return;
    }
    if (id !== daemonId) {
      // A model and a mode belong to the machine they were picked on; neither
      // carries over to another.
      setModel(null);
      setMode(null);
    }
    setDaemonId(id);
    setFolder(picked);
    setFolderSheetOpen(false);
  };

  // ── Create on first send ──────────────────────────────────────────────────
  // Once created, the send goes into the chat at once (its uploads follow it
  // there), so there is never a created chat left to retry into or discard.
  const sendTarget = async (): Promise<string | null> => {
    const pushError = useUiStore.getState().pushError;
    if (daemonId === null) {
      pushError('Choose which host to start the chat on.');
      return null;
    }
    if (folder === null) {
      pushError('Choose a folder before sending.');
      return null;
    }
    try {
      const res = await api.createChat({
        daemonId,
        folder,
        ...(model === null ? {} : { model }),
        ...(mode === null ? {} : { permissionMode: mode }),
        ...(preferredAccountId === null ? {} : { preferredAccountId }),
      });
      // Seed the row BEFORE the composer echoes into it and before navigating
      // (spec/15 § New chat flow): a chat with no store row is invisible to
      // the WS replay loop, so it would never receive a reply. The server's
      // echoed folder is the canonical path `chat.spawned` will carry.
      useChatStore.getState().ensureChat(res.chatId, res.folder);
      saveLastNewChat({ daemonId, folder, model, permissionMode: mode });
      return res.chatId;
    } catch (e) {
      // The host's `chat.error` for a refused spawn may already have seeded
      // a row for a chat that does not exist — retract it (web does the same).
      const body = e instanceof ApiError ? (e.body as { retractChatId?: string } | null) : null;
      if (body?.retractChatId) useChatStore.getState().removeChat(body.retractChatId);
      pushError(`Failed to create chat: ${(e as Error).message}`);
      return null;
    }
  };

  const onSent = (chatId: string): void => {
    // Always the brand-new chat — never Manager (spec/15 item 16).
    router.replace(newChatRoute(chatId) as `/chats/${string}`);
  };

  const hostLabel = (id: string): string => hosts[id]?.host?.hostName ?? id;
  const pickerHosts = Object.values(hosts)
    .map((h) => ({ daemonId: h.daemonId, name: hostLabel(h.daemonId), online: h.online }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, paddingTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md }}>
        <Pressable onPress={goBack} style={{ padding: space.sm }} accessibilityLabel="Cancel">
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text numberOfLines={1} style={{ ...typography.title, color: colors.ink, flex: 1 }}>
          New chat
        </Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Empty transcript area — a new chat has no messages yet, so this
            just holds the space the real chat's message list will occupy,
            pushing the quick picks and composer down to the bottom of the
            window instead of stacking them under the header. */}
        <View testID="new-chat-top-spacer" style={{ flex: 1 }} />

        <ScrollView
          style={{ flexShrink: 1 }}
          contentContainerStyle={{ paddingBottom: space.sm }}
          keyboardShouldPersistTaps="handled"
        >
          <PickRow label="Folder">
            <Chip
              testID="new-chat-folder-pill"
              label={
                folder === null
                  ? 'Choose a folder…'
                  : `${folderName(folder)}${daemonId ? ` · ${hostLabel(daemonId)}` : ''}`
              }
              selected={folder !== null}
              onPress={() => setFolderSheetOpen(true)}
              icon={<Folder size={14} color={folder !== null ? colors.leaf : colors.ink3} />}
              trailing={<ChevronDown size={14} color={colors.ink3} />}
            />
          </PickRow>

          <PickRow label="Model">
            {modelPicks.map((m) => (
              <Chip
                key={m.id}
                testID={`new-chat-model-quick-${m.id}`}
                label={compactModelLabel(m.id, m.label)}
                selected={m.id === effectiveModel}
                onPress={() => setModel(m.id)}
              />
            ))}
            <ModelPicker
              daemonId={daemonId}
              selected={effectiveModel}
              onSelect={setModel}
              variant="compact"
            />
          </PickRow>

          {/* The account the chat's turns START on (spec/10 § Backend
              credentials — preferred account). A preference, not a pin. */}
          {preferable.length > 1 ? (
            <PickRow label="Account">
              <Chip
                testID="new-chat-account-strategy"
                label="By strategy"
                selected={preferredAccountId === null}
                onPress={() => setPreferredAccountId(null)}
              />
              {preferable.map((a) => (
                <Chip
                  key={a.id}
                  testID={`new-chat-account-${a.id}`}
                  label={a.label}
                  selected={preferredAccountId === a.id}
                  onPress={() => setPreferredAccountId(a.id)}
                />
              ))}
            </PickRow>
          ) : null}

          <PickRow label="Permissions">
            <Chip
              testID="new-chat-permission-mode"
              label={effectiveMode === null ? 'Host default' : permissionModeLabel(effectiveMode)}
              selected={false}
              onPress={() => setModeMenuOpen(true)}
              icon={
                <ModeIcon
                  size={14}
                  color={effectiveMode === 'bypassPermissions' ? colors.red : colors.ink3}
                />
              }
            />
          </PickRow>
        </ScrollView>

        <Composer
          chatId={NEW_CHAT_DRAFT_KEY}
          folder={folder ?? undefined}
          sendTarget={sendTarget}
          onSent={onSent}
        />
      </KeyboardAvoidingView>

      <FolderPickerSheet
        visible={folderSheetOpen}
        recents={recents}
        hosts={pickerHosts}
        currentDaemonId={daemonId}
        onPick={chooseFolder}
        onDismiss={() => setFolderSheetOpen(false)}
      />

      <AnchoredMenu
        visible={modeMenuOpen}
        items={PERMISSION_MODE_ORDER.map((m) => ({
          id: m,
          label: permissionModeLabel(m),
          testID: `permission-mode-option-${m}`,
          disabled: !offeredModes.includes(m),
          selected: m === effectiveMode,
          destructive: m === 'bypassPermissions',
        }))}
        onSelect={(id) => setMode(id as PermissionMode)}
        onDismiss={() => setModeMenuOpen(false)}
        placement="bottom"
      />
    </View>
  );
}
