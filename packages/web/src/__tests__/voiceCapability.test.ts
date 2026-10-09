// Voice as a per-MACHINE capability (plan H1, spec/07).
//
// A call button looked identical on every machine and failed at the moment of
// speaking, on the machine the user could not see.

import { describe, it, expect } from 'vitest';
import { voiceCapability, voiceInstallPrompt } from '../lib/voiceCapability.js';
import type { HostPresence } from '../stores/presenceStore.js';

function host(components: unknown[], hostName = 'laptop'): HostPresence {
  return {
    daemonId: 'host-a',
    online: true,
    lastSeenAt: 1,
    host: {
      daemonId: 'host-a',
      hostName,
      platform: 'darwin',
      arch: 'arm64',
      daemonVersion: '0.1.375',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      isHomeHost: true,
      backends: [],
      components,
    },
    accounts: {},
  } as unknown as HostPresence;
}

describe('voiceCapability', () => {
  it('is available when the speech component is installed on that machine', () => {
    const cap = voiceCapability(
      host([{ id: 'kokoro', label: 'Kokoro', bytes: 340e6, state: 'installed' }]),
    );
    expect(cap.available).toBe(true);
  });

  it('is unavailable when the component is missing, naming the machine AND what it needs', () => {
    const cap = voiceCapability(
      host([{ id: 'kokoro', label: 'Kokoro', bytes: 340e6, state: 'absent' }], 'beta-box'),
    );
    expect(cap.available).toBe(false);
    if (cap.available) throw new Error('unreachable');
    expect(cap.hostLabel).toBe('beta-box');
    expect(cap.reason).toContain('beta-box');
    expect(cap.reason).toContain('Kokoro');
  });

  it('a machine whose speech backend is remote offers no component and still works', () => {
    expect(voiceCapability(host([])).available).toBe(true);
  });

  it('a machine that has not reported is NOT assumed capable', () => {
    const cap = voiceCapability({
      daemonId: 'quiet',
      online: false,
      lastSeenAt: null,
      host: null,
      accounts: {},
    } as unknown as HostPresence);
    expect(cap.available).toBe(false);
    if (cap.available) throw new Error('unreachable');
    expect(cap.reason).toContain('has not reported');
  });

  it('the prompt names the download size and the machine, in one prompt', () => {
    const cap = voiceCapability(
      host([{ id: 'kokoro', label: 'Kokoro', bytes: 340e6, state: 'absent' }], 'beta-box'),
    );
    if (cap.available) throw new Error('unreachable');
    const prompt = voiceInstallPrompt(cap);
    expect(prompt).toContain('beta-box');
    expect(prompt).toContain('340 MB');
  });
});
