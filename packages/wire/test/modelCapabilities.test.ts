// Which permission modes each model can run (spec/02 § Permission mode).
//
// The rule mirrors Claude Code's own, which is a DENYLIST of older models with
// everything else supported. The shape matters more than the entries: a model
// nobody has heard of yet must come out CAPABLE, or every future release would
// be silently dropped to a weaker mode until someone remembered to add it.

import { describe, expect, it } from 'vitest';
import {
  modelSupportsAutoMode,
  permissionModesFor,
  HARNESS_PERMISSION_MODES,
  resolvePermissionModeForModel,
} from '../src/modelCapabilities.js';

describe('modelSupportsAutoMode', () => {
  it('excludes the models Claude Code excludes', () => {
    for (const m of [
      'claude-opus-4-0',
      'claude-opus-4-1',
      'claude-opus-4-5',
      'claude-sonnet-4-0',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet',
    ]) {
      expect(modelSupportsAutoMode(m), m).toBe(false);
    }
  });

  it('matches on the FAMILY, so a dated id does not slip past the list', () => {
    // Every real spawn carries the dated form; Claude Code reduces it to the
    // family before its own check, and so must this.
    expect(modelSupportsAutoMode('claude-haiku-4-5-20251001')).toBe(false);
    expect(modelSupportsAutoMode('claude-sonnet-4-5-20250929')).toBe(false);
  });

  it('includes the current models', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-6']) {
      expect(modelSupportsAutoMode(m), m).toBe(true);
    }
  });

  it('assumes a model it has never heard of IS capable', () => {
    // The whole point of the denylist shape: no edit needed per release.
    expect(modelSupportsAutoMode('claude-opus-7')).toBe(true);
    expect(modelSupportsAutoMode('claude-something-nobody-shipped-yet')).toBe(true);
  });
});

describe('permissionModesFor', () => {
  it('drops only `auto` on a model that cannot run it', () => {
    expect(permissionModesFor('claude-haiku-4-5')).toEqual([
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
    ]);
  });

  it('offers every mode on a model that can', () => {
    expect(permissionModesFor('claude-opus-5')).toContain('auto');
  });
});

describe('resolvePermissionModeForModel', () => {
  it('degrades `auto` to `default` on a model that cannot run it, and says so', () => {
    expect(resolvePermissionModeForModel('auto', 'claude-haiku-4-5-20251001')).toEqual({
      mode: 'default',
      degradedFrom: 'auto',
    });
  });

  it('never degrades UPWARD — a degrade must not widen what an agent may do', () => {
    const { mode } = resolvePermissionModeForModel('auto', 'claude-haiku-4-5');
    expect(mode).not.toBe('bypassPermissions');
    expect(mode).not.toBe('acceptEdits');
  });

  it('leaves `auto` alone on a model that supports it', () => {
    expect(resolvePermissionModeForModel('auto', 'claude-opus-5')).toEqual({ mode: 'auto' });
  });

  it('touches no other mode, on any model — only `auto` has a model requirement', () => {
    for (const m of ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const) {
      expect(resolvePermissionModeForModel(m, 'claude-haiku-4-5')).toEqual({ mode: m });
    }
  });
});

describe('permission modes are keyed by harness', () => {
  it('offers a Codex model only the modes Codex can run', () => {
    expect(permissionModesFor('openai/gpt-5')).toEqual([
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
    ]);
  });

  it('exposes the per-harness table so a new provider is one entry', () => {
    expect(HARNESS_PERMISSION_MODES.claude).toContain('auto');
    expect(HARNESS_PERMISSION_MODES.codex).not.toContain('auto');
  });

  it('degrades a mode the model cannot run to default on any harness', () => {
    expect(resolvePermissionModeForModel('auto', 'openai/gpt-5')).toEqual({
      mode: 'default',
      degradedFrom: 'auto',
    });
    expect(resolvePermissionModeForModel('plan', 'openai/gpt-5')).toEqual({ mode: 'plan' });
  });
});
