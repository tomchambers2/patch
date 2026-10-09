// ArtifactViewer — full-screen in-app view of a published artifact (spec/15 §
// Artifacts; mirrors web's panel/new-tab choice in
// `packages/web/src/lib/openArtifact.ts`, except mobile has no desktop web
// panel to dock into, so the in-app view IS where every artifact opens). A
// sandboxed WebView loads the artifact's served URL; Open in browser hands
// the same URL to the OS browser for anyone who wants it there instead.
//
// Wiring: call `openArtifactViewer(url, title)` from the transcript card or
// the artifact bar's chip, and mount `<ArtifactViewerHost />` once on the
// chat-detail screen (mirrors MessageActions.tsx's store + Host split, so
// both triggers share one modal instance).

import React from 'react';
import { Linking, Modal, Pressable, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { ExternalLink, X } from 'lucide-react-native';
import { create } from 'zustand';
import { space, typography, useTheme } from '../lib/theme';
import { isRelayed, useLocalUri } from '../lib/servedFile';

interface ArtifactViewerState {
  artifact: { url: string; title: string } | null;
  open(url: string, title: string): void;
  close(): void;
}

const useArtifactViewerStore = create<ArtifactViewerState>((set) => ({
  artifact: null,
  open(url, title) {
    set({ artifact: { url, title } });
  },
  close() {
    set({ artifact: null });
  },
}));

/** Open the full-screen artifact viewer for the artifact served at `url`. */
export function openArtifactViewer(url: string, title: string): void {
  useArtifactViewerStore.getState().open(url, title);
}

/**
 * Open a served file the best way this route allows: handed to the OS on a
 * direct route, shown in the in-app viewer on a relayed one (the OS cannot reach
 * a server that is only there through the tunnel).
 */
export function openServed(url: string, title: string): void {
  if (isRelayed()) openArtifactViewer(url, title);
  else void Linking.openURL(url);
}

/** Test seam: back to closed. */
export function __resetArtifactViewer(): void {
  useArtifactViewerStore.setState({ artifact: null });
}

export function ArtifactViewerHost(): React.ReactElement | null {
  const colors = useTheme();
  const artifact = useArtifactViewerStore((s) => s.artifact);
  const close = useArtifactViewerStore((s) => s.close);
  const { uri: shown, error } = useLocalUri(artifact?.url ?? null);
  if (artifact === null) return null;

  return (
    <Modal testID="artifact-viewer" visible animationType="slide" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: space.sm,
            paddingVertical: space.sm,
            borderBottomWidth: 1,
            borderColor: colors.divider,
          }}
        >
          <Text
            testID="artifact-viewer-title"
            numberOfLines={1}
            style={{ ...typography.title, color: colors.ink, flex: 1 }}
          >
            {artifact.title}
          </Text>
          {isRelayed() ? null : (
            <Pressable
              testID="artifact-viewer-open-browser"
              onPress={() => void Linking.openURL(artifact.url)}
              accessibilityRole="button"
              accessibilityLabel="Open in browser"
              hitSlop={space.sm}
              style={{ padding: space.sm }}
            >
              <ExternalLink size={20} color={colors.ink} />
            </Pressable>
          )}
          <Pressable
            testID="artifact-viewer-close"
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close artifact"
            hitSlop={space.sm}
            style={{ padding: space.sm }}
          >
            <X size={22} color={colors.ink} />
          </Pressable>
        </View>
        {error ? (
          <Text testID="artifact-viewer-error" style={{ color: colors.red, padding: space.md }}>
            Could not load this file: {error}
          </Text>
        ) : shown ? (
          <WebView
            testID="artifact-viewer-webview"
            source={{ uri: shown }}
            originWhitelist={['*']}
            allowFileAccess
            style={{ flex: 1 }}
          />
        ) : null}
      </View>
    </Modal>
  );
}
