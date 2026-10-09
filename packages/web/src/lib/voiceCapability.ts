// Is voice available on a given MACHINE (spec/07, spec/16, plan H1)?
//
// "Voice becomes something that happens on a particular machine." A chat's
// voice runs on that chat's own machine, so speaking to a chat requires the
// speech components to be installed THERE — voice is a per-machine capability,
// not a property of the product.
//
// Without this a call button looked identical on every machine and failed at
// the moment of speaking, on the machine the user could not see.

import type { HostComponent } from '@patch/wire';
import type { HostPresence } from '../stores/presenceStore.js';

/** The components a spoken turn needs on the machine running the chat. */
export const VOICE_COMPONENT_IDS = ['kokoro'] as const;

export type VoiceCapability =
  | { available: true }
  | {
      available: false;
      /** Named, because the machine is the thing the user cannot see. */
      hostLabel: string;
      /** Missing components, so the prompt can state the download size. */
      missing: HostComponent[];
      reason: string;
    };

/**
 * Whether a chat on `host` can hold a spoken turn.
 *
 * A machine that has not reported yet is NOT assumed capable: claiming voice
 * works and failing mid-call is worse than saying "not known yet".
 *
 * A machine whose speech backend is REMOTE installs nothing for it and still
 * works — such a machine simply offers no local component, which is why the
 * check is "the component is installed OR the machine offers none at all".
 */
export function voiceCapability(host: HostPresence | undefined): VoiceCapability {
  const report = host?.host;
  if (!report) {
    return {
      available: false,
      hostLabel: host?.daemonId ?? 'unknown machine',
      missing: [],
      reason: 'this machine has not reported what it can do yet',
    };
  }
  const label = report.hostName;
  const offered = report.components.filter((c) =>
    (VOICE_COMPONENT_IDS as readonly string[]).includes(c.id),
  );
  // Offers none → a remote speech backend; nothing to install, voice works.
  if (offered.length === 0) return { available: true };
  const missing = offered.filter((c) => c.state !== 'installed');
  if (missing.length === 0) return { available: true };
  return {
    available: false,
    hostLabel: label,
    missing,
    reason: `${label} needs ${missing.map((m) => m.label).join(', ')} for voice`,
  };
}

/** One prompt, naming the download size and the machine (plan H1). */
export function voiceInstallPrompt(cap: Extract<VoiceCapability, { available: false }>): string {
  const mb = cap.missing.reduce((n, c) => n + c.bytes, 0) / 1e6;
  return `Install ${cap.missing.map((m) => m.label).join(', ')} on ${cap.hostLabel} (${mb.toFixed(0)} MB)?`;
}
