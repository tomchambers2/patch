// Which permission modes a given model can actually run in (spec/02 § Permission mode).
//
// Claude Code decides this STATICALLY, from the model id alone — there is no
// endpoint to ask, and the CLI's own rule is a denylist of the older models
// with everything else supported:
//
//   if (m.includes("claude-3-") || m === "claude-opus-4-0" || m === "claude-opus-4-1"
//       || m === "claude-opus-4-5" || m === "claude-sonnet-4-0"
//       || m === "claude-sonnet-4-5" || m === "claude-haiku-4-5") return false;
//   return true;
//
// This module mirrors that shape, denylist and all, and the shape is the point:
// a model patch has never heard of is assumed CAPABLE, so every model released
// from here on works without an edit. The alternative — an allowlist — would
// silently drop each new model to a weaker mode until someone remembered to add
// it, which is the failure this whole area already produced once.
//
// Why patch needs its own copy at all: Claude Code does not refuse a mode the
// model cannot do, it SUBSTITUTES `default` and says nothing. `default` asks a
// human to approve every tool call, which in an unattended job chat is not a
// degraded mode but a dead one. Knowing up front lets patch resolve the mode
// deliberately, and say what it resolved, instead of finding out afterwards.
// The `init`-message check in the host stays as the backstop: if this table is
// ever wrong, the turn fails loudly rather than running in a mode nobody chose.

import { harnessForModel, PermissionMode, type HarnessId } from './events.js';

/**
 * Models that cannot run `auto`, mirroring Claude Code's own list.
 *
 * Anything NOT here — including every model released after this was written —
 * is treated as capable.
 */
const NO_AUTO_MODE_MODELS: readonly string[] = [
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

/**
 * Claude Code matches on the model FAMILY, not the dated id: `--model
 * claude-haiku-4-5-20251001` resolves to `claude-haiku-4-5` before the check.
 * So a dated id has to reduce to its family here too, or every real spawn
 * (which carries the dated form) would slip past the list.
 */
function modelFamily(modelId: string): string {
  return modelId.replace(/-\d{8}$/, '');
}

/** Can this model run `auto` — Claude Code's classifier-driven mode? */
export function modelSupportsAutoMode(modelId: string): boolean {
  if (modelId.startsWith('openai/')) return false;
  const family = modelFamily(modelId);
  if (family.includes('claude-3-')) return false;
  return !NO_AUTO_MODE_MODELS.includes(family);
}

/**
 * The permission modes each harness can run at all. Adding a provider is one
 * entry here (plus its `harnessForModel` rule): every surface's pickers and the
 * degrade rule below read this table rather than naming a provider.
 */
export const HARNESS_PERMISSION_MODES: Record<HarnessId, readonly PermissionMode[]> = {
  claude: PermissionMode.options,
  // Codex has no classifier-driven approval, so no `auto`.
  codex: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

/** Per-harness refinement by model id, for modes only some of its models run. */
const MODEL_MODE_RULES: Record<HarnessId, (modelId: string, mode: PermissionMode) => boolean> = {
  claude: (modelId, mode) => mode !== 'auto' || modelSupportsAutoMode(modelId),
  codex: () => true,
};

/** Every permission mode this model can be run in. */
export function permissionModesFor(modelId: string): PermissionMode[] {
  const harness = harnessForModel(modelId);
  const rule = MODEL_MODE_RULES[harness];
  return HARNESS_PERMISSION_MODES[harness].filter((m) => rule(modelId, m));
}

export interface ResolvedPermissionMode {
  /** The mode the turn will actually run in. */
  mode: PermissionMode;
  /**
   * The mode that was ASKED for, when it differs — i.e. this is a degrade, and
   * something has to say so. Absent when the request was honoured as-is.
   */
  degradedFrom?: PermissionMode;
}

/**
 * The mode a chat on `modelId` runs in, given the mode it was configured with.
 *
 * Degrades DOWNWARD only: a mode the model cannot do becomes `default`, never
 * something more permissive. Quietly widening what an agent may do without
 * asking is not a degrade, and it is not patch's call to make on the user's
 * behalf — whereas `default` merely means the tool calls come back to a human.
 *
 * The caller is responsible for SAYING it degraded. A degrade patch performs
 * deliberately and announces is a different thing from the silent substitution
 * this exists to replace; an unannounced one would be the same bug again.
 */
export function resolvePermissionModeForModel(
  requested: PermissionMode,
  modelId: string,
): ResolvedPermissionMode {
  if (permissionModesFor(modelId).includes(requested)) return { mode: requested };
  return { mode: 'default', degradedFrom: requested };
}

/** A paid API key and a subscription are separate sources even on one host. */
export function accountConnectedForModel(
  account:
    | {
        connected: boolean;
        accounts?: readonly { connected: boolean; kind?: 'chatgpt' | 'apiKey' }[];
      }
    | null
    | undefined,
  model?: string | null,
): boolean {
  if (!account) return true;
  if (!model?.startsWith('openai/') || !account.accounts) return account.connected;
  const kind = model.startsWith('openai/api/') ? 'apiKey' : 'chatgpt';
  return account.accounts.some((a) => a.connected && (a.kind ?? 'chatgpt') === kind);
}
