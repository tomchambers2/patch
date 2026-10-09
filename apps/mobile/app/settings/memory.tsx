// One Claude Code memory entry on one host (Settings → Memories → an entry).

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { MemoryDetail } from '../../src/components/settings/MemoriesSection';

export default function MemoryScreen(): React.ReactElement {
  const { daemonId, project, file } = useLocalSearchParams<{
    daemonId: string;
    project: string;
    file: string;
  }>();
  if (!daemonId || !project || !file) {
    throw new Error('Memory opened without a daemonId, project and file');
  }
  return <MemoryDetail daemonId={daemonId} project={project} file={file} />;
}
