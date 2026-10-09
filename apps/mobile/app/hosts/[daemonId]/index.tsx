// One host's own page (Settings → Hosts → a host): its name, Make home, its
// agents and components, Files and Terminal, and Remove this host.

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { HostDetail } from '../../../src/components/settings/HostsSection';

export default function HostScreen(): React.ReactElement {
  const { daemonId } = useLocalSearchParams<{ daemonId: string }>();
  if (!daemonId) throw new Error('Host page opened without a daemonId');
  return <HostDetail daemonId={daemonId} />;
}
