// A layer Patch adds to Claude Code, full screen: the Patch tools prompt, the
// System prompt override or Claude Code's settings.json — shared, or one OS's
// override (Settings → Agent → Layers added to Claude Code → Edit). All shared
// settings (spec/01 § Settings), so no host is named.

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { LayerEditor, type Layer } from '../../src/components/settings/AgentBehaviorSection';

const LAYERS: readonly Layer[] = [
  'tools',
  'system',
  'claude-shared',
  'claude-darwin',
  'claude-linux',
  'goal-judge',
];

export default function LayerEditorScreen(): React.ReactElement {
  const { layer } = useLocalSearchParams<{ layer: string }>();
  const which = LAYERS.find((l) => l === layer);
  if (which === undefined) throw new Error(`Layer editor opened for an unknown layer: ${layer}`);
  return <LayerEditor layer={which} />;
}
