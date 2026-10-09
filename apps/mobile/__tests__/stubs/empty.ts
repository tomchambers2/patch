// Catch-all stub for native modules pulled in via barrel imports during
// tests of pure logic. Anything an actual test exercises gets a real stub.
export {};

// expo-status-bar: a thin host-node stand-in so app/_layout.tsx can render
// its <StatusBar style={...} /> under react-test-renderer.
import React from 'react';
export function StatusBar(props: { style?: 'light' | 'dark' | 'auto' }): React.ReactElement {
  return React.createElement('StatusBar', props);
}
