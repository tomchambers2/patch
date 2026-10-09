import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Full unit-test surface: pure logic AND screen/component rendering.
//
// Rendering runs through react-test-renderer against a hand-rolled
// react-native stub (__tests__/stubs/react-native.ts) — every RN intrinsic
// (View/Text/Pressable/FlatList/Animated/...) is a thin host-node stand-in,
// so react-test-renderer's own tree (no real layout/native bridge) is enough
// to exercise component logic + handlers under plain Node. See that stub's
// header comment for the exact simplifications (Animated has no real timers,
// FlatList has no real virtualization, etc.) — none of them affect the JS
// control flow under test.
//
// We alias every native-module import the app pulls in (zustand stores,
// expo-*, react-native-*, lucide icons, the three @expo-google-fonts
// packages, ...) to local stubs so the whole app can be exercised in plain
// Node — no device, no Metro, no jsdom (react-test-renderer is a custom
// React renderer, not a DOM one).

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    environment: 'node',
    pool: 'forks',
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,tsx}', 'app/**/*.tsx'],
      exclude: [
        '**/*.d.ts',
        '**/__tests__/**',
        'android/**',
        'ios/**',
        // Pure type re-export barrels / config plumbing with no runtime
        // branches of their own.
        'src/stores/types.ts',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
  // otaUpdates.ts reads the bare RN/Metro global `__DEV__`, which only exists
  // on-device / under Metro. Fixed to false under test (both branches of
  // `__DEV__ || !Updates.isEnabled` are still reachable via the stub's
  // `__setEnabled`).
  define: {
    __DEV__: 'false',
  },
  resolve: {
    alias: {
      'react-native': path.resolve(__dirname, '__tests__/stubs/react-native.ts'),
      'react-native-mmkv': path.resolve(__dirname, '__tests__/stubs/mmkv.ts'),
      'react-native-safe-area-context': path.resolve(
        __dirname,
        '__tests__/stubs/safe-area-context.ts',
      ),
      'react-native-markdown-display': path.resolve(
        __dirname,
        '__tests__/stubs/markdown-display.ts',
      ),
      'react-native-svg': path.resolve(__dirname, '__tests__/stubs/svg.ts'),
      'react-native-callkeep': path.resolve(__dirname, '__tests__/stubs/callkeep.ts'),
      'react-native-webview': path.resolve(__dirname, '__tests__/stubs/webview.ts'),
      'expo-av': path.resolve(__dirname, '__tests__/stubs/expo-av.ts'),
      'expo-file-system': path.resolve(__dirname, '__tests__/stubs/expo-file-system.ts'),
      'expo-camera': path.resolve(__dirname, '__tests__/stubs/expo-camera.ts'),
      'expo-notifications': path.resolve(__dirname, '__tests__/stubs/expo-notifications.ts'),
      'expo-router': path.resolve(__dirname, '__tests__/stubs/expo-router.ts'),
      'expo-status-bar': path.resolve(__dirname, '__tests__/stubs/empty.ts'),
      'expo-linking': path.resolve(__dirname, '__tests__/stubs/expo-linking.ts'),
      'expo-constants': path.resolve(__dirname, '__tests__/stubs/expo-constants.ts'),
      'expo-crypto': path.resolve(__dirname, '__tests__/stubs/expo-crypto.ts'),
      'expo-clipboard': path.resolve(__dirname, '__tests__/stubs/expo-clipboard.ts'),
      'expo-image-picker': path.resolve(__dirname, '__tests__/stubs/expo-image-picker.ts'),
      'expo-document-picker': path.resolve(__dirname, '__tests__/stubs/expo-document-picker.ts'),
      'expo-image-manipulator': path.resolve(
        __dirname,
        '__tests__/stubs/expo-image-manipulator.ts',
      ),
      'expo-updates': path.resolve(__dirname, '__tests__/stubs/expo-updates.ts'),
      '@expo-google-fonts/fraunces': path.resolve(__dirname, '__tests__/stubs/google-fonts.ts'),
      '@expo-google-fonts/inter': path.resolve(__dirname, '__tests__/stubs/google-fonts.ts'),
      '@expo-google-fonts/jetbrains-mono': path.resolve(
        __dirname,
        '__tests__/stubs/google-fonts.ts',
      ),
      'lucide-react-native': path.resolve(__dirname, '__tests__/stubs/lucide.ts'),
    },
  },
});
