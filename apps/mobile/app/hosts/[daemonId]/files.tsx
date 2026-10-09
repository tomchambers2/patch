// Host Files browser (spec/15 § Host files and terminal, spec/03 § Host files).
//
// Browse ONE machine's filesystem and open a text file in the editor — no
// chat needed, which is the point: editing a skill in `~/.claude/skills` or a
// dotfile used to mean opening a chat whose folder happened to contain it.
//
// One directory per screen: a folder tap pushes the next directory, so the
// system back gesture walks back up the way you came. With no `path` the
// screen lists the host user's home and learns its absolute path from the
// answer. NO FALLBACK: a listing that fails says so in place of the list.

import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CornerLeftUp, File, Folder, SquareTerminal } from 'lucide-react-native';
import { folderName } from '@patch/wire';
import { api, type HostFileEntry } from '../../../src/api/rest';
import { HostToolHeader } from '../../../src/components/HostToolHeader';
import { PlacesChips } from '../../../src/components/HostPlaces';
import { EmptyState } from '../../../src/components/EmptyState';
import { EMPTY_STATES } from '../../../src/lib/emptyStates';
import { useGoBack } from '../../../src/lib/goBack';
import {
  childPath,
  editRoute,
  filesRoute,
  formatSize,
  startFolders,
  terminalRoute,
} from '../../../src/lib/hostFiles';
import { useFolderStore } from '../../../src/stores/folderStore';
import { usePresenceStore } from '../../../src/stores/presenceStore';
import { fonts, space, textMin, typography, useTheme } from '../../../src/lib/theme';

interface Listing {
  path: string;
  parent: string | null;
  entries: HostFileEntry[];
}

export default function HostFiles(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const { daemonId, path } = useLocalSearchParams<{ daemonId: string; path?: string }>();
  const goBack = useGoBack(`/hosts/${daemonId}`);
  const hostName = usePresenceStore((s) => s.hosts[daemonId]?.host?.hostName ?? daemonId);
  const hostFolders = useFolderStore((s) => s.byHost[daemonId]);
  const places = startFolders(hostFolders?.roots ?? [], hostFolders?.recent ?? []);

  const [listing, setListing] = React.useState<Listing | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Home's absolute path, once the host has told us (a path-less listing).
  const [home, setHome] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setListing(null);
    setError(null);
    api.hostFilesList(daemonId, path).then(
      (res) => {
        if (!live) return;
        setListing(res);
        if (path === undefined) setHome(res.path);
      },
      (e: unknown) => {
        if (live) setError((e as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, [daemonId, path]);

  const openDir = (dir: string | null): void => {
    router.push(filesRoute(daemonId, dir ?? undefined));
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <HostToolHeader
        title="Files"
        hostName={hostName}
        onBack={goBack}
        right={
          listing ? (
            <Pressable
              testID="files-terminal-here"
              accessibilityRole="button"
              accessibilityLabel="Terminal here"
              onPress={() => router.push(terminalRoute(daemonId, listing.path))}
              style={{ padding: space.sm }}
            >
              <SquareTerminal size={22} color={colors.leaf} />
            </Pressable>
          ) : null
        }
      />
      <View>
        <PlacesChips
          folders={places}
          current={listing?.path ?? null}
          home={home}
          onPick={openDir}
        />
      </View>
      {error !== null ? (
        <Text
          testID="files-error"
          style={{ color: colors.red, paddingHorizontal: space.lg, paddingVertical: space.md }}
        >
          {error}
        </Text>
      ) : listing === null ? (
        <ActivityIndicator
          testID="files-loading"
          color={colors.leaf}
          style={{ margin: space.xl }}
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: space.xl }}>
          <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
            <Text testID="files-dir-name" style={{ color: colors.ink, fontFamily: fonts.bodyBold }}>
              {listing.path === '/' ? '/' : folderName(listing.path)}
            </Text>
            <Text testID="files-dir-path" style={{ color: colors.ink3, ...typography.meta }}>
              {listing.path}
            </Text>
          </View>
          {listing.parent !== null ? (
            <Row
              testID="files-up"
              label="Up a level"
              icon={<CornerLeftUp size={16} color={colors.ink3} />}
              onPress={() => openDir(listing.parent)}
            />
          ) : null}
          {listing.entries.length === 0 ? (
            <EmptyState icon={Folder} {...EMPTY_STATES.folder} />
          ) : (
            listing.entries.map((e) => (
              <Row
                key={e.name}
                testID={`files-entry-${e.name}`}
                label={e.name}
                detail={e.type === 'file' && e.size !== undefined ? formatSize(e.size) : null}
                disabled={e.type === 'other'}
                icon={
                  e.type === 'dir' ? (
                    <Folder size={16} color={colors.leaf} />
                  ) : (
                    <File size={16} color={colors.ink3} />
                  )
                }
                onPress={() => {
                  const full = childPath(listing.path, e.name);
                  if (e.type === 'dir') openDir(full);
                  else router.push(editRoute(daemonId, full));
                }}
              />
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Row({
  testID,
  label,
  detail,
  icon,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  detail?: string | null;
  icon: React.ReactNode;
  disabled?: boolean;
  onPress: () => void;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: pressed ? colors.accentTint : 'transparent',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {icon}
      <Text style={{ color: colors.ink, marginLeft: space.sm, flex: 1 }} numberOfLines={1}>
        {label}
      </Text>
      {detail ? <Text style={{ color: colors.ink3, fontSize: textMin }}>{detail}</Text> : null}
    </Pressable>
  );
}
