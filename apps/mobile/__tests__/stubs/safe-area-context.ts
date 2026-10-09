// react-native-safe-area-context stub for unit tests.
import React from 'react';

export function SafeAreaProvider(props: {
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement('SafeAreaProvider', props, props.children);
}

export function SafeAreaView(props: {
  children?: React.ReactNode;
  edges?: string[];
  [k: string]: unknown;
}): React.ReactElement {
  return React.createElement('SafeAreaView', props, props.children);
}

let _insets = { top: 20, bottom: 10, left: 0, right: 0 };
/** Test helper: set what useSafeAreaInsets() returns. */
export function __setSafeAreaInsets(insets: Partial<typeof _insets>): void {
  _insets = { ..._insets, ...insets };
}
export function useSafeAreaInsets(): typeof _insets {
  return _insets;
}
