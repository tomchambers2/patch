// Semantic validation for hook bodies — the single source of truth shared by
// every CRUD surface (REST `/api/hooks`, direct file edits loaded by the
// store), mirroring `../jobs/validate.ts`.

import jsonata from 'jsonata';
import { SUPPORTED_HOOK_WHENS, type HookCreateBody, type HookPatchBody } from './types.js';

export class HookValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'HookValidationError';
  }
}

/**
 * Throws `HookValidationError` on the first problem (NO FALLBACK). Checks:
 *   - `when` is one of the implemented values (spec/20-hooks.md § Hook shape).
 *   - exactly one of `script` / `prompt` is present, matching `kind`.
 *   - `gate.filter`, when set, is valid JSONata.
 */
export function assertValidHookBody(
  body: HookCreateBody | HookPatchBody,
  existing?: { kind: 'script' | 'prompt'; hasScript: boolean; hasPrompt: boolean },
): void {
  if (body.when !== undefined && !SUPPORTED_HOOK_WHENS.includes(body.when)) {
    throw new HookValidationError(
      `hooks on "${body.when}" are not implemented — only ${SUPPORTED_HOOK_WHENS.map((w) => `"${w}"`).join(' or ')} (spec/20-hooks.md)`,
      'when',
    );
  }
  const kind = body.kind ?? existing?.kind;
  const hasScript =
    body.script !== undefined ? body.script !== null : (existing?.hasScript ?? false);
  const hasPrompt =
    body.prompt !== undefined ? body.prompt !== null : (existing?.hasPrompt ?? false);
  if (kind === 'script' && !hasScript) {
    throw new HookValidationError('a script hook requires "script"', 'script');
  }
  if (kind === 'prompt' && !hasPrompt) {
    throw new HookValidationError('a prompt hook requires "prompt"', 'prompt');
  }
  if (kind === 'script' && hasPrompt) {
    throw new HookValidationError('a script hook may not also carry "prompt"', 'prompt');
  }
  if (kind === 'prompt' && hasScript) {
    throw new HookValidationError('a prompt hook may not also carry "script"', 'script');
  }
  const filter = body.gate?.filter;
  if (typeof filter === 'string' && filter.length > 0) {
    try {
      jsonata(filter);
    } catch (err) {
      throw new HookValidationError(
        `invalid JSONata (gate.filter): ${(err as Error).message}`,
        'gate.filter',
      );
    }
  }
}
