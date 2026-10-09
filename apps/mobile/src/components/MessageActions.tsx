// Copying message text (spec/15 § Chat detail — Copying message text).
//
// Long-pressing any transcript row — a user bubble, the assistant's reply, a
// tool call or its output — opens a small sheet with actions:
//
//   Copy text   — the WHOLE row's text (markdown source, not rendered glyphs)
//                 onto the clipboard, confirmed by a brief "Copied" toast.
//   Select text — a full-screen view of that row as ONE selectable text block,
//                 for copying part of it with the OS selection handles.
//
// A message row (`messageAt` supplied) ALSO toasts the real time the host
// persisted the turn the instant the long-press fires — alongside the sheet,
// not behind a button inside it — mirroring web's hover meta strip (spec/14
// § Messages) as closely as a surface with no hover can: the long-press IS
// the "hover", so the time shows the moment it registers, with no second tap
// to go find it.
//
// Why not native selection in the bubble itself: the markdown renderer draws a
// message as many separate <Text> leaves (one per paragraph, list item, code
// block), and Android selection cannot cross from one to the next — so a
// selection could never span two paragraphs — and a selectable leaf also
// swallows the long-press that opens this sheet. The select view holds the row
// as a single Text, where selection behaves like any other Android text.
//
// Wiring: wrap a row in <MessageLongPress text=… messageAt=…>, and mount
// <MessageActionsHost /> once on the screen. A copy that fails is an error
// toast, never a silent no-op (NO FALLBACK).

import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Copy, GitFork, TextSelect, X } from 'lucide-react-native';
import { create } from 'zustand';
import { useUiStore } from '../stores/uiStore';
import { openSideThreadDraft } from '../lib/sideThreadActions';
import { fonts, radii, space, typography, useTheme } from '../lib/theme';

/** How long the "Copied" confirmation stays up. */
export const COPIED_TOAST_MS = 1500;

/** spec/15 § Side threads screen — identifies the row for the "Open side
 * thread" sheet item. Only a settled message row carries this (mirrors web's
 * `canSideThread` restriction — a tool-call/task-notification row has no
 * persisted seq a side thread could fork from, and nor does a row still in
 * flight). */
export interface SideThreadOrigin {
  chatId: string;
  seq: number;
}

interface MessageActionState {
  /** The row's text while the sheet or the select view is open. */
  text: string | null;
  /** `ChatEventEntry.messageAt` for the row, when the row is a message with one. */
  messageAt: number | undefined;
  sideThread: SideThreadOrigin | undefined;
  view: 'sheet' | 'select';
  /** The brief confirmation line, or null. */
  toast: string | null;
  show(text: string, messageAt?: number, sideThread?: SideThreadOrigin): void;
  select(): void;
  close(): void;
  setToast(toast: string | null): void;
}

const useMessageActionStore = create<MessageActionState>((set) => ({
  text: null,
  messageAt: undefined,
  sideThread: undefined,
  view: 'sheet',
  toast: null,
  show(text, messageAt, sideThread) {
    // Clear any toast still lingering from a previous row's long-press —
    // this one hasn't earned a toast yet (MessageLongPress sets it right
    // after, for a row with a messageAt).
    set({ text, messageAt, sideThread, view: 'sheet', toast: null });
  },
  select() {
    set({ view: 'select' });
  },
  close() {
    set({ text: null, messageAt: undefined, sideThread: undefined, view: 'sheet' });
  },
  setToast(toast) {
    set({ toast });
  },
}));

/** Open the copy/select sheet for `text`, optionally carrying the row's real
 * message time and/or its side-thread fork point. */
export function showMessageActions(
  text: string,
  messageAt?: number,
  sideThread?: SideThreadOrigin,
): void {
  useMessageActionStore.getState().show(text, messageAt, sideThread);
}

/** Test seam: back to closed, no toast. */
export function __resetMessageActions(): void {
  useMessageActionStore.setState({
    text: null,
    messageAt: undefined,
    sideThread: undefined,
    view: 'sheet',
    toast: null,
  });
}

/**
 * The real time a message arrived, toasted the instant a message row's
 * long-press fires — mirrors web's `formatMessageTime`
 * (packages/web/src/routes/ChatRoute.tsx). A plain clock time, no date:
 * long-press is reached from a row already in view, so the day it happened
 * is context the surrounding transcript gives.
 */
export function formatMessageTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Copy `text` to the clipboard and say so. Exported so the select view's own
 * Copy all and any other caller share one path — and one failure message.
 */
export async function copyMessageText(text: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(text);
    useMessageActionStore.getState().setToast('Copied');
  } catch (e) {
    useUiStore.getState().pushError(`copy failed: ${(e as Error).message}`);
  }
}

/**
 * A transcript row that opens the copy/select sheet on long-press. `text` null
 * (a row with nothing to copy, e.g. an attachment-only message) makes it a
 * plain container with no long-press at all rather than a sheet that copies
 * nothing.
 */
export function MessageLongPress({
  text,
  messageAt,
  sideThread,
  onPress,
  style,
  testID,
  children,
}: {
  text: string | null;
  /** A plain tap — a queued message opens its editor on it (spec/04 § Edit). */
  onPress?: () => void;
  /** The row's `ChatEventEntry.messageAt`, when it's a message that has one. */
  messageAt?: number;
  /** spec/15 § Side threads screen TRIGGER — present on a settled message row. */
  sideThread?: SideThreadOrigin;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: React.ReactNode;
}): React.ReactElement {
  if (text === null) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      style={style}
      onPress={onPress}
      onLongPress={() => {
        showMessageActions(text, messageAt, sideThread);
        // The time toasts the instant the long-press fires, not after a
        // further tap inside the sheet it just opened (that was the whole
        // complaint: a message row's time cost a long-press AND a button).
        if (messageAt !== undefined) {
          useMessageActionStore.getState().setToast(formatMessageTime(messageAt));
        }
      }}
      delayLongPress={350}
      accessibilityHint="Long-press to copy or select the text"
    >
      {children}
    </Pressable>
  );
}

function SheetItem({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  testID: string;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: pressed ? colors.divider : 'transparent',
      })}
    >
      <View style={{ width: 24 }}>{icon}</View>
      <Text
        style={{ marginLeft: space.md, fontSize: 15, fontFamily: fonts.body, color: colors.ink }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The sheet, the select view and the toast. Mount once per screen. */
export function MessageActionsHost(): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const text = useMessageActionStore((s) => s.text);
  const sideThread = useMessageActionStore((s) => s.sideThread);
  const view = useMessageActionStore((s) => s.view);
  const toast = useMessageActionStore((s) => s.toast);
  const close = useMessageActionStore((s) => s.close);

  React.useEffect(() => {
    if (toast === null) return;
    const t = setTimeout(() => useMessageActionStore.getState().setToast(null), COPIED_TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <>
      <Modal
        visible={text !== null && view === 'sheet'}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: colors.shade }}
          onPress={close}
          accessibilityLabel="Dismiss"
        >
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => {}}
            testID="message-actions-sheet"
            style={{
              backgroundColor: colors.paperRaised,
              borderTopLeftRadius: radii.lg,
              borderTopRightRadius: radii.lg,
              paddingTop: space.sm,
              // The Modal is its own window: clear the system nav bar once.
              paddingBottom: insets.bottom + space.md,
            }}
          >
            <SheetItem
              testID="message-action-copy"
              icon={<Copy size={18} color={colors.ink2} />}
              label="Copy text"
              onPress={() => {
                const t = text;
                close();
                if (t !== null) void copyMessageText(t);
              }}
            />
            <SheetItem
              testID="message-action-select"
              icon={<TextSelect size={18} color={colors.ink2} />}
              label="Select text"
              onPress={() => useMessageActionStore.getState().select()}
            />
            {sideThread !== undefined ? (
              <SheetItem
                testID="message-action-side-thread"
                icon={<GitFork size={18} color={colors.ink2} />}
                label="Open side thread"
                onPress={() => {
                  const t = text;
                  const origin = sideThread;
                  close();
                  if (t === null) return;
                  openSideThreadDraft(origin.chatId, origin.seq, t);
                  router.push(`/chats/${origin.chatId}/threads`);
                }}
              />
            ) : null}
          </Pressable>
          {toast !== null && view === 'sheet' ? <Toast message={toast} anchor="top" /> : null}
        </Pressable>
      </Modal>

      <Modal
        visible={text !== null && view === 'select'}
        animationType="none"
        onRequestClose={close}
      >
        <View
          testID="message-select-view"
          style={{
            flex: 1,
            backgroundColor: colors.paper,
            paddingTop: insets.top + space.sm,
            paddingBottom: insets.bottom,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md }}>
            <Pressable
              onPress={close}
              style={{ padding: space.sm }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <X size={22} color={colors.ink} />
            </Pressable>
            <Text style={{ ...typography.title, flex: 1, color: colors.ink }}>Select text</Text>
            <Pressable
              testID="message-select-copy-all"
              onPress={() => {
                if (text !== null) void copyMessageText(text);
              }}
              style={{ padding: space.sm }}
              accessibilityRole="button"
              accessibilityLabel="Copy all"
            >
              <Copy size={20} color={colors.ink2} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.lg }}>
            <Text
              testID="message-select-text"
              selectable
              style={{ color: colors.ink, fontSize: 16, lineHeight: 24, fontFamily: fonts.body }}
            >
              {text}
            </Text>
          </ScrollView>
          {toast !== null && view === 'select' ? <Toast message={toast} /> : null}
        </View>
      </Modal>

      {toast !== null && text === null ? <Toast message={toast} /> : null}
    </>
  );
}

function Toast({
  message,
  anchor = 'bottom',
}: {
  message: string;
  /** 'top': the sheet is open underneath and would otherwise sit behind it. */
  anchor?: 'top' | 'bottom';
}): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        ...(anchor === 'top' ? { top: insets.top + space.lg } : { bottom: space.xxxl * 2 }),
        alignItems: 'center',
      }}
    >
      <Text
        testID="message-copied-toast"
        accessibilityLiveRegion="polite"
        style={{
          color: colors.paper,
          backgroundColor: colors.ink,
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
          borderRadius: radii.lg,
          overflow: 'hidden',
          fontFamily: fonts.bodyBold,
          fontSize: 14,
        }}
      >
        {message}
      </Text>
    </View>
  );
}
