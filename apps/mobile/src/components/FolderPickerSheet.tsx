// The new-chat folder picker (spec/15 § Folder picker sheet): a bottom sheet
// with one search box. Typing filters recents by name/path; typing `/` or `~`
// switches to live path completion on the chosen host. Host chips appear only
// with more than one host; Browse… opens the host's directory tree in the
// same sheet. Picking a folder picks its host too.

import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronLeft, ChevronRight, CornerLeftUp, Folder } from 'lucide-react-native';
import { api } from '../api/rest';
import { agoLabel } from '../lib/agoLabel';
import {
  completePath,
  filterPathEntries,
  filterRows,
  isPathQuery,
  splitPathQuery,
  type FolderRecent,
} from '../lib/folderPicker';
import { fixed, fonts, radii, space, textMin, useTheme } from '../lib/theme';
import { folderName } from '@patch/wire';

export interface PickerHost {
  daemonId: string;
  name: string;
  online: boolean;
}

interface Entry {
  name: string;
  path: string;
}

export function FolderPickerSheet({
  visible,
  recents,
  hosts,
  currentDaemonId,
  onPick,
  onDismiss,
}: {
  visible: boolean;
  recents: readonly FolderRecent[];
  hosts: readonly PickerHost[];
  /** The host the screen is on now — path mode and Browse… default to it. */
  currentDaemonId: string | null;
  onPick: (daemonId: string, folder: string) => void;
  onDismiss: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = React.useState('');
  const [hostTab, setHostTab] = React.useState<string | 'all'>('all');
  const [browsing, setBrowsing] = React.useState(false);

  // A reopened sheet never shows the last session's text or browse position.
  React.useEffect(() => {
    if (visible) {
      setQuery('');
      setHostTab('all');
      setBrowsing(false);
      setError(null);
    }
  }, [visible]);

  const hostNames = React.useMemo(
    () => Object.fromEntries(hosts.map((h) => [h.daemonId, h.name])),
    [hosts],
  );
  // The host path completion and Browse… act on: the chosen chip, else the
  // current host, else the only host. Null (several hosts, none chosen) is
  // said out loud, never guessed.
  const actingHost =
    hostTab !== 'all'
      ? hostTab
      : (currentDaemonId ?? (hosts.length === 1 ? hosts[0]!.daemonId : null));

  const [dir, setDir] = React.useState<string | null>(null);
  const [parent, setParent] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // One in-flight guard so a slow response for an old keystroke never
  // overwrites the list for the current one.
  const seq = React.useRef(0);
  const load = React.useCallback(
    async (host: string, target: string | undefined): Promise<void> => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.browseFolders(host, target);
        if (mine !== seq.current) return;
        setDir(res.dir);
        setParent(res.parent);
        setEntries(res.entries);
      } catch (e) {
        if (mine !== seq.current) return;
        setEntries([]);
        setError((e as Error).message);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [],
  );

  const pathMode = visible && !browsing && isPathQuery(query);
  const pathQuery = pathMode ? splitPathQuery(query.trim()) : null;
  const pathDir = pathQuery?.dir ?? null;
  React.useEffect(() => {
    if (pathDir === null || actingHost === null) return;
    void load(actingHost, pathDir);
  }, [pathDir, actingHost, load]);

  const startBrowse = (): void => {
    if (actingHost === null) {
      setError('Choose which host to browse.');
      return;
    }
    setBrowsing(true);
    setDir(null);
    setParent(null);
    setEntries([]);
    void load(actingHost, undefined);
  };

  const choose = (daemonId: string, folder: string): void => {
    onPick(daemonId, folder);
  };

  const rows = filterRows(recents, pathMode ? '' : query, hostTab);
  const suggestions = pathQuery ? filterPathEntries(entries, pathQuery.partial) : [];

  const rowStyle = ({ pressed }: { pressed: boolean }) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: pressed ? colors.accentTint : 'transparent',
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: fixed.backdrop }}>
        <Pressable
          style={{ flex: 1 }}
          onPress={onDismiss}
          accessibilityLabel="Dismiss folder picker"
          testID="folder-sheet-backdrop"
        />
        <View
          testID="folder-sheet"
          style={{
            maxHeight: '75%',
            minHeight: '50%',
            backgroundColor: colors.paperRaised,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            paddingTop: space.md,
            paddingBottom: insets.bottom,
          }}
        >
          {browsing ? (
            <View testID="folder-sheet-browser" style={{ flex: 1 }}>
              <Pressable
                onPress={() => setBrowsing(false)}
                testID="folder-sheet-browse-back"
                style={rowStyle}
              >
                <ChevronLeft size={18} color={colors.ink3} />
                <Text style={{ color: colors.ink2, fontFamily: fonts.body }}>Folders</Text>
              </Pressable>
              {dir ? (
                <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xs }}>
                  <Text
                    testID="folder-sheet-breadcrumb"
                    style={{ color: colors.ink, fontSize: 15 }}
                  >
                    {folderName(dir)}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: textMin }}>
                    {dir}
                  </Text>
                </View>
              ) : null}
              {dir && actingHost ? (
                <Pressable
                  testID="folder-sheet-use-folder"
                  onPress={() => choose(actingHost, dir)}
                  style={rowStyle}
                >
                  <Check size={16} color={colors.leaf} />
                  <Text style={{ color: colors.leaf, fontFamily: fonts.bodyBold }}>
                    Use this folder
                  </Text>
                </Pressable>
              ) : null}
              {dir && actingHost ? (
                <Pressable
                  testID="folder-sheet-browse-up"
                  onPress={() => void load(actingHost, parent ?? undefined)}
                  style={rowStyle}
                >
                  <CornerLeftUp size={16} color={colors.ink3} />
                  <Text style={{ color: colors.ink2 }}>Up a level</Text>
                </Pressable>
              ) : null}
              <ScrollView keyboardShouldPersistTaps="handled">
                {loading ? (
                  <ActivityIndicator color={colors.leaf} style={{ margin: space.lg }} />
                ) : error ? (
                  <Text
                    testID="folder-sheet-error"
                    style={{ color: colors.red, padding: space.lg, fontSize: 13 }}
                  >
                    {error}
                  </Text>
                ) : entries.length === 0 ? (
                  <Text style={{ color: colors.ink3, padding: space.lg, fontSize: 13 }}>
                    No subfolders here.
                  </Text>
                ) : (
                  entries.map((e) => (
                    <Pressable
                      key={e.path}
                      testID={`folder-sheet-browse-entry-${e.name}`}
                      onPress={() => actingHost && void load(actingHost, e.path)}
                      style={rowStyle}
                    >
                      <Folder size={16} color={colors.ink3} />
                      <Text
                        numberOfLines={1}
                        style={{ color: colors.ink, fontFamily: fonts.body, flex: 1 }}
                      >
                        {e.name}
                      </Text>
                      <ChevronRight size={16} color={colors.inkFaint} />
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </View>
          ) : (
            <>
              <TextInput
                testID="folder-sheet-search"
                autoFocus
                value={query}
                onChangeText={(t) => {
                  setError(null);
                  setQuery(t);
                }}
                placeholder="Search folders or type a path"
                placeholderTextColor={colors.ink3}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  marginHorizontal: space.lg,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderRadius: radii.md,
                  borderWidth: 1,
                  borderColor: colors.divider,
                  backgroundColor: colors.paper,
                  color: colors.ink,
                  fontFamily: fonts.body,
                  fontSize: 15,
                }}
              />
              {hosts.length > 1 ? (
                <ScrollView
                  horizontal
                  keyboardShouldPersistTaps="handled"
                  style={{ flexGrow: 0, marginTop: space.sm }}
                  contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.xs }}
                >
                  {[{ daemonId: 'all', name: 'All', online: true }, ...hosts].map((h) => {
                    const on = h.daemonId === hostTab;
                    return (
                      <Pressable
                        key={h.daemonId}
                        testID={`folder-sheet-host-${h.daemonId}`}
                        accessibilityState={{ selected: on }}
                        onPress={() => setHostTab(h.daemonId)}
                        style={{
                          paddingHorizontal: space.md,
                          paddingVertical: space.xs,
                          borderRadius: radii.pill,
                          borderWidth: 1,
                          borderColor: on ? colors.leaf : colors.divider,
                          backgroundColor: on ? colors.accentTint : colors.paper,
                          opacity: h.online ? 1 : 0.5,
                        }}
                      >
                        <Text
                          style={{
                            color: on ? colors.leaf : colors.ink2,
                            fontFamily: on ? fonts.bodyBold : fonts.body,
                            fontSize: textMin,
                          }}
                        >
                          {h.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
              <ScrollView
                keyboardShouldPersistTaps="handled"
                style={{ marginTop: space.sm }}
                testID="folder-sheet-list"
              >
                {pathMode ? (
                  <>
                    {actingHost === null ? (
                      <Text
                        testID="folder-sheet-error"
                        style={{ color: colors.red, padding: space.lg, fontSize: 13 }}
                      >
                        Choose which host to browse.
                      </Text>
                    ) : (
                      <Pressable
                        testID="folder-sheet-use-typed"
                        onPress={() => choose(actingHost, query.trim())}
                        style={rowStyle}
                      >
                        <Check size={16} color={colors.leaf} />
                        <Text
                          numberOfLines={1}
                          style={{ color: colors.leaf, fontFamily: fonts.bodyBold, flex: 1 }}
                        >
                          Use {query.trim()}
                        </Text>
                      </Pressable>
                    )}
                    {loading ? (
                      <ActivityIndicator color={colors.leaf} style={{ margin: space.lg }} />
                    ) : error && actingHost !== null ? (
                      <Text
                        testID="folder-sheet-error"
                        style={{ color: colors.red, padding: space.lg, fontSize: 13 }}
                      >
                        {error}
                      </Text>
                    ) : (
                      suggestions.map((e) => (
                        <Pressable
                          key={e.path}
                          testID={`folder-sheet-suggestion-${e.name}`}
                          onPress={() => setQuery(completePath(pathDir ?? '/', e.name))}
                          style={rowStyle}
                        >
                          <Folder size={16} color={colors.ink3} />
                          <Text
                            numberOfLines={1}
                            style={{ color: colors.ink, fontFamily: fonts.body, flex: 1 }}
                          >
                            {e.name}
                          </Text>
                        </Pressable>
                      ))
                    )}
                  </>
                ) : (
                  <>
                    {rows.length === 0 ? (
                      <Text
                        testID="folder-sheet-empty"
                        style={{ color: colors.ink3, padding: space.lg, fontSize: 13 }}
                      >
                        No matching folders.
                      </Text>
                    ) : (
                      rows.map((r) => (
                        <Pressable
                          key={`${r.daemonId}\u0000${r.folder}`}
                          testID={`folder-sheet-row-${r.folder}`}
                          onPress={() => choose(r.daemonId, r.folder)}
                          style={rowStyle}
                        >
                          <Folder size={18} color={colors.ink3} />
                          <View style={{ flex: 1 }}>
                            <Text
                              numberOfLines={1}
                              style={{ color: colors.ink, fontFamily: fonts.body, fontSize: 15 }}
                            >
                              {r.name}
                            </Text>
                            <Text
                              numberOfLines={1}
                              style={{ color: colors.ink3, fontSize: textMin }}
                            >
                              {r.shortPath}
                            </Text>
                          </View>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={{ color: colors.ink3, fontSize: textMin }}>
                              {hostNames[r.daemonId] ?? r.daemonId}
                            </Text>
                            {r.lastUpdated > 0 ? (
                              <Text style={{ color: colors.ink3, fontSize: textMin }}>
                                {agoLabel(r.lastUpdated)}
                              </Text>
                            ) : null}
                          </View>
                        </Pressable>
                      ))
                    )}
                    <Pressable testID="folder-sheet-browse" onPress={startBrowse} style={rowStyle}>
                      <Folder size={18} color={colors.leaf} />
                      <Text style={{ color: colors.leaf, fontFamily: fonts.bodyBold }}>
                        Browse…
                      </Text>
                    </Pressable>
                    {error ? (
                      <Text
                        testID="folder-sheet-error"
                        style={{ color: colors.red, padding: space.lg, fontSize: 13 }}
                      >
                        {error}
                      </Text>
                    ) : null}
                  </>
                )}
              </ScrollView>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
