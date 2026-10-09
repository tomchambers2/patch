// ErrorToasts — surfaces queued errors from the uiStore (mobile mirror of the
// web `ErrorToasts`). NO FALLBACK: every failed REST/WS/upload path pushes to
// `uiStore.pushError`, so without this the failure is invisible and the control
// that triggered it reads as a dead no-op (an attachment upload that 502s just
// blinked the send button and did nothing).
//
// Rendered once at the root layout, above every screen and overlay. Tap to
// dismiss; errors also auto-dismiss so a stale one doesn't sit over the UI
// forever.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUiStore } from '../stores/uiStore';
import { fonts, radii, space, useTheme } from '../lib/theme';

/** How long a toast stays up before it dismisses itself. */
export const TOAST_TTL_MS = 8000;

export function ErrorToasts(): React.ReactElement | null {
  const colors = useTheme();
  const errors = useUiStore((s) => s.errors);
  const dismiss = useUiStore((s) => s.dismissError);

  // Auto-dismiss each toast TTL_MS after it was pushed. The store only hands
  // back a new `errors` array when the queue actually changes, so the timers
  // are rescheduled on a push/dismiss and never on an unrelated re-render.
  React.useEffect(() => {
    const timers = errors.map((e) => setTimeout(() => dismiss(e.id), TOAST_TTL_MS));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [errors, dismiss]);

  if (errors.length === 0) return null;
  return (
    <View
      testID="error-toasts"
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        padding: space.sm,
        gap: space.xs,
      }}
    >
      {errors.map((e) => (
        <Pressable
          key={e.id}
          testID={`error-toast-${e.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${e.message}. Tap to dismiss.`}
          onPress={() => dismiss(e.id)}
          style={{
            backgroundColor: colors.red,
            borderRadius: radii.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>{e.message}</Text>
        </Pressable>
      ))}
    </View>
  );
}
