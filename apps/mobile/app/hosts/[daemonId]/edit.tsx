// Host file editor (spec/15 § Host files and terminal, spec/03 § Host files).
//
// Open one text file on a host, edit it, and Save — explicitly: nothing is
// written until Save is pressed, and a dot beside the name says there are
// unsaved changes. Monospace, with no autocorrect or capitalisation, because
// what gets edited here is code, config and skills.
//
// A save goes over the version the file was OPENED at. If it changed on disk
// since (the agent edited it, another surface saved it), the host refuses the
// save and the editor says so, offering to reload the file — it never writes
// over someone else's change. Leaving with unsaved changes asks first.

import React from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { folderName } from '@patch/wire';
import { api } from '../../../src/api/rest';
import { HostToolHeader } from '../../../src/components/HostToolHeader';
import { isSaveConflict } from '../../../src/lib/hostFiles';
import { useGoBack } from '../../../src/lib/goBack';
import { usePresenceStore } from '../../../src/stores/presenceStore';
import { fonts, radii, space, textMin, useTheme } from '../../../src/lib/theme';

interface Loaded {
  /** What is on disk as of the last read or save. */
  saved: string;
  version: string;
}

export default function HostFileEditor(): React.ReactElement {
  const colors = useTheme();
  const { daemonId, path } = useLocalSearchParams<{ daemonId: string; path: string }>();
  const goBack = useGoBack(`/hosts/${daemonId}`);
  const hostName = usePresenceStore((s) => s.hosts[daemonId]?.host?.hostName ?? daemonId);

  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [text, setText] = React.useState('');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await api.hostFileRead(daemonId, path);
      setLoaded({ saved: res.content, version: res.version });
      setText(res.content);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [daemonId, path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = loaded !== null && text !== loaded.saved;

  const save = async (): Promise<void> => {
    if (loaded === null || !dirty || saving) return;
    setSaving(true);
    const content = text;
    try {
      const res = await api.hostFileWrite(daemonId, {
        path,
        content,
        baseVersion: loaded.version,
      });
      setLoaded({ saved: content, version: res.version });
    } catch (e) {
      if (isSaveConflict(e)) {
        Alert.alert(
          'Changed on disk',
          'This file changed since you opened it, so your save was not written.',
          [
            { text: 'Keep editing', style: 'cancel' },
            { text: 'Reload', style: 'destructive', onPress: () => void load() },
          ],
        );
      } else {
        Alert.alert('Save failed', (e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  // Back — the header's and the system's — asks before dropping edits.
  const leave = React.useCallback((): boolean => {
    if (!dirty) {
      goBack();
      return true;
    }
    Alert.alert('Discard changes?', 'Your edits to this file have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: goBack },
    ]);
    return true;
  }, [dirty, goBack]);

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', leave);
    return () => sub.remove();
  }, [leave]);

  const name = folderName(path);

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <HostToolHeader
        title={dirty ? `${name} ●` : name}
        hostName={`${hostName} · ${path}`}
        onBack={() => void leave()}
        right={
          <Pressable
            testID="editor-save"
            accessibilityRole="button"
            accessibilityLabel="Save"
            accessibilityState={{ disabled: !dirty || saving }}
            disabled={!dirty || saving}
            onPress={() => void save()}
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              marginRight: space.xs,
              borderRadius: radii.md,
              backgroundColor: dirty ? colors.leaf : colors.paperRaised,
              opacity: saving ? 0.6 : 1,
            }}
          >
            <Text
              style={{ color: dirty ? colors.onAccent : colors.ink3, fontFamily: fonts.bodyBold }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Text>
          </Pressable>
        }
      />
      {loadError !== null ? (
        <Text
          testID="editor-error"
          style={{ color: colors.red, paddingHorizontal: space.lg, paddingVertical: space.md }}
        >
          {loadError}
        </Text>
      ) : loaded === null ? (
        <ActivityIndicator
          testID="editor-loading"
          color={colors.leaf}
          style={{ margin: space.xl }}
        />
      ) : (
        <TextInput
          testID="editor-text"
          value={text}
          onChangeText={setText}
          multiline
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          textAlignVertical="top"
          scrollEnabled
          style={{
            flex: 1,
            color: colors.ink,
            fontFamily: fonts.mono,
            fontSize: textMin,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        />
      )}
    </View>
  );
}
