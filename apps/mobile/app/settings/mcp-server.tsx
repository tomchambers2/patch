// One MCP server on one host, to add (no `name`) or edit (Settings → MCP).

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { McpServerEditor } from '../../src/components/settings/McpSection';

export default function McpServerScreen(): React.ReactElement {
  const { daemonId, name } = useLocalSearchParams<{ daemonId: string; name?: string }>();
  if (!daemonId) throw new Error('MCP server opened without a daemonId');
  return <McpServerEditor daemonId={daemonId} name={name ? name : null} />;
}
