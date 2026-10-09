import { describe, expect, it } from 'vitest';
import { codexPermission, codexItem } from '../src/codexBackend.js';
import { permissionModesFor } from '@patch/wire';
describe('OpenAI execution contract', () => {
  it('does not offer Claude auto approval for OpenAI models', () => {
    expect(permissionModesFor('openai/example')).not.toContain('auto');
    expect(() => codexPermission('auto')).toThrow(/does not support/);
  });
  it('keeps plan read-only and bypass explicit', () => {
    expect(codexPermission('plan').sandbox).toBe('read-only');
    expect(codexPermission('bypassPermissions')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });
  it('preserves command failures and tool call identity', () => {
    const item = {
      type: 'commandExecution',
      id: 'call-1',
      command: 'false',
      status: 'failed',
      aggregatedOutput: 'failure',
    };
    expect(codexItem(item, false)?.tool?.callId).toBe('call-1');
    expect(codexItem(item, true)?.toolResult).toEqual({
      name: 'Bash',
      callId: 'call-1',
      result: 'failure',
      isError: true,
    });
  });
});
