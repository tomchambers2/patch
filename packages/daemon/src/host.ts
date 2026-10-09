// This host's identity as the rest of the system sees it (spec/02 § Host
// identity, § Agent backends, § Optional components).
//
// A host is one machine among several. Everything it says about itself —
// what it is called, what it runs on, which agent backends it has provisioned,
// which large model weights are on its disk — is gathered here and emitted as
// a single `daemon.host` self-description, so there is exactly one place that
// decides what a host reports and one shape a surface has to render.
//
// NO FALLBACK: a field the host cannot determine is reported as the honest
// absent/failed value, never as a plausible-looking default. A host that
// claims a backend it does not have sends every chat spawned on it into a
// failure that names the wrong cause.

import { platform, arch } from 'node:os';
import { CLAUDE_BACKEND_ID } from '@patch/wire';
import type {
  DaemonHostEvent,
  HostBackend,
  HostComponent,
  HostProviderKey,
  McpServerConfig,
} from '@patch/wire';
import type { SdkPermissionMode } from './chatState.js';

export { CLAUDE_BACKEND_ID } from '@patch/wire';
export const CLAUDE_BACKEND_LABEL = 'Claude Code';

export interface HostDescriptionInput {
  daemonId: string;
  /** User-editable label; defaults to the machine's hostname at registration. */
  hostName: string;
  daemonVersion: string;
  /**
   * The source commit and build instant stamped into this machine's artifact
   * (spec/11 § Version reporting). Absent when the host runs from a source
   * checkout rather than a built artifact — absent is the honest value, never
   * a guess.
   */
  gitSha?: string | undefined;
  builtAt?: string | undefined;
  updateAvailable: boolean;
  permissionModeDefault: SdkPermissionMode;
  permissionOverrides: number;
  /**
   * Absent until this host has read a model catalogue successfully. Absent is
   * meaningful — a spawn naming no model on a host with none is an error saying
   * so, so this must not be filled in with a guess (spec/04 § Spawn).
   */
  defaultModel?: string | undefined;
  isHomeHost: boolean;
  /** This host can take its queued messages from the server (spec/04). */
  serverQueue?: boolean | undefined;
  /**
   * Where the server can reach this host's own audio WSS DIRECTLY
   * (`daemon.host.audioRelayHost`) — an optional latency optimisation, not a
   * requirement: absent means this host's voice sessions relay over its own
   * outbound server link instead (spec/03 § Audio relay over the host link).
   */
  audioRelayHost?: string | undefined;
  backends: HostBackend[];
  components: HostComponent[];
  /**
   * Currently selected Kokoro TTS voice. Absent when Kokoro is not installed
   * or the voice has never been explicitly set.
   */
  kokoroVoice?: string | undefined;
  /** Which hosted-voice provider keys this host holds (`daemon.host.voiceKeys`). */
  voiceKeys?: { gemini: boolean; openai: boolean } | undefined;
  /** What this host's voice calls have cost (`daemon.host.voiceUsage`, spec/07 § Call cost). */
  voiceUsage?:
    | { monthUsd: number; monthCalls: number; allUsd: number; allCalls: number }
    | undefined;
  /** Where each provider key comes from, never its value (`daemon.host.providerKeys`). */
  providerKeys?: HostProviderKey[] | undefined;
  /**
   * How many user messages between auto-regen of the chat name. `0` disables
   * periodic regen; absent means 0 (name only from first message).
   */
  chatNameInterval?: number | undefined;
  /** Whether this host auto-resumes turns blocked by a rate limit. */
  autoResumeRateLimit?: boolean | undefined;
  /**
   * Whether an unanswered question on this host expires, and the window in
   * seconds (spec/02 § Questions are not approvals). Stated together or not at
   * all: a surface reads the pair's absence as "this host predates the
   * setting", so half of it would be worse than none.
   */
  questionExpiry?: boolean | undefined;
  questionExpirySeconds?: number | undefined;
  /** Per-host system prompt override for the Claude harness (Task 3). */
  harnessSystemPrompt?: string | undefined;
  /** Per-host override of the built-in patch-tools prompt; absent = default. */
  harnessToolsPrompt?: string | undefined;
  /** The built-in patch-tools prompt, so a surface need not ship a copy. */
  harnessToolsPromptDefault?: string | undefined;
  /** Per-host skills to enable on every turn (Task 3). */
  harnessSkills?: string[] | 'all' | undefined;
  /** Whether Claude Code's own persistent memory is enabled on this host. */
  harnessMemoryEnabled: boolean;
  /**
   * LEGACY reading for surfaces that predate `harnessMcpServers`: true iff the
   * list has both `playwright` and `chrome-devtools`, both enabled.
   */
  harnessBrowserToolsEnabled: boolean;
  /** The MCP servers this host adds to every chat, in order (Settings → MCP). */
  harnessMcpServers: McpServerConfig[];
  /** Always true now: the shipped Manager/Speakers CLAUDE.md always loads. */
  harnessClaudeMdEnabled: boolean;
  /** spec/02 § Browser — Route through: the routing host's daemonId, or null when direct. */
  browserRouteThrough: string | null;
}

/** Assemble this host's `daemon.host` self-description. */
export function describeHost(input: HostDescriptionInput): DaemonHostEvent {
  return {
    type: 'daemon.host',
    daemonId: input.daemonId,
    hostName: input.hostName,
    platform: platform(),
    arch: arch(),
    daemonVersion: input.daemonVersion,
    ...(input.gitSha !== undefined ? { gitSha: input.gitSha } : {}),
    ...(input.builtAt !== undefined ? { builtAt: input.builtAt } : {}),
    updateAvailable: input.updateAvailable,
    permissionModeDefault: input.permissionModeDefault,
    permissionOverrides: input.permissionOverrides,
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
    isHomeHost: input.isHomeHost,
    ...(input.serverQueue !== undefined ? { serverQueue: input.serverQueue } : {}),
    ...(input.audioRelayHost !== undefined ? { audioRelayHost: input.audioRelayHost } : {}),
    backends: input.backends,
    components: input.components,
    ...(input.kokoroVoice !== undefined ? { kokoroVoice: input.kokoroVoice } : {}),
    ...(input.voiceKeys !== undefined ? { voiceKeys: input.voiceKeys } : {}),
    ...(input.voiceUsage !== undefined ? { voiceUsage: input.voiceUsage } : {}),
    ...(input.providerKeys !== undefined ? { providerKeys: input.providerKeys } : {}),
    ...(input.chatNameInterval !== undefined ? { chatNameInterval: input.chatNameInterval } : {}),
    ...(input.autoResumeRateLimit !== undefined
      ? { autoResumeRateLimit: input.autoResumeRateLimit }
      : {}),
    ...(input.questionExpiry !== undefined && input.questionExpirySeconds !== undefined
      ? {
          questionExpiry: input.questionExpiry,
          questionExpirySeconds: input.questionExpirySeconds,
        }
      : {}),
    ...(input.harnessSystemPrompt !== undefined
      ? { harnessSystemPrompt: input.harnessSystemPrompt }
      : {}),
    ...(input.harnessToolsPrompt !== undefined
      ? { harnessToolsPrompt: input.harnessToolsPrompt }
      : {}),
    ...(input.harnessToolsPromptDefault !== undefined
      ? { harnessToolsPromptDefault: input.harnessToolsPromptDefault }
      : {}),
    ...(input.harnessSkills !== undefined ? { harnessSkills: input.harnessSkills } : {}),
    // Stated UNCONDITIONALLY, same discipline as `questionExpiry` above: a
    // surface reads the ABSENCE of these as "this host predates the
    // setting", so a real `false` must never be omitted.
    harnessMemoryEnabled: input.harnessMemoryEnabled,
    harnessBrowserToolsEnabled: input.harnessBrowserToolsEnabled,
    harnessMcpServers: input.harnessMcpServers,
    harnessClaudeMdEnabled: input.harnessClaudeMdEnabled,
    browserRouteThrough: input.browserRouteThrough,
  };
}

/**
 * The Claude Code backend's entry for `daemon.host.backends[]`.
 *
 * `state` is what the host actually found, in the three cases spec/02
 * § Agent backends enumerates: present (use it), absent (needs provisioning),
 * present-and-logged-out (needs a credential). `version` is null until the
 * executable resolves — null means "not known", never "assume current".
 */
export function claudeBackendEntry(input: {
  executableResolved: boolean;
  version: string | null;
  credentialOk: boolean;
  error?: string | undefined;
}): HostBackend {
  const state: HostBackend['state'] = !input.executableResolved
    ? 'absent'
    : input.credentialOk
      ? 'present'
      : 'logged-out';
  return {
    id: CLAUDE_BACKEND_ID,
    label: CLAUDE_BACKEND_LABEL,
    version: input.version,
    state,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}
