import { describe, expect, it } from 'vitest';
import { decode } from '../src/index.js';

// A host built before the cross-host audio relay (0.1.1286 and earlier)
// sends `daemon.host` with no `audioRelayHost`. When the field was required
// the server dropped every such report, so an older host's backends,
// components and voice state went stale the moment the server was deployed
// ahead of it.
describe('daemon.host from a host that predates the audio relay', () => {
  const report = {
    type: 'daemon.host',
    daemonId: 'host-a',
    hostName: 'Hetzner',
    platform: 'linux',
    arch: 'x64',
    daemonVersion: '0.1.1286',
    updateAvailable: true,
    permissionModeDefault: 'bypassPermissions',
    permissionOverrides: 0,
    defaultModel: 'claude-opus-5-5',
    isHomeHost: true,
    backends: [{ id: 'claude-code', label: 'Claude Code', version: '2.1.220', state: 'present' }],
    components: [{ id: 'kokoro', label: 'Kokoro TTS', bytes: 340_000_000, state: 'installed' }],
    voiceKeys: { gemini: false, openai: false },
  };

  it('decodes without an audioRelayHost', () => {
    const ev = decode(JSON.stringify(report));
    expect(ev.type).toBe('daemon.host');
    expect((ev as { audioRelayHost?: string }).audioRelayHost).toBeUndefined();
  });
});
