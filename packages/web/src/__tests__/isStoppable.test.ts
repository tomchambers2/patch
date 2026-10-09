import { describe, it, expect } from 'vitest';
import { isStoppable } from '../stores/types.js';

const perm = (tool: string) => ({ requestId: 'r', tool, description: '', args: {} });

describe('isStoppable', () => {
  it('is true while the agent is running', () => {
    expect(isStoppable({ activity: 'running', pendingPermissions: [] })).toBe(true);
  });
  it('is false when parked only on an AskUserQuestion', () => {
    expect(
      isStoppable({
        activity: 'awaiting-permission',
        pendingPermissions: [perm('AskUserQuestion')],
      }),
    ).toBe(false);
  });
  it('is true when parked on an approval', () => {
    expect(
      isStoppable({ activity: 'awaiting-permission', pendingPermissions: [perm('Bash')] }),
    ).toBe(true);
  });
  it('is false when idle', () => {
    expect(isStoppable({ activity: 'idle', pendingPermissions: [] })).toBe(false);
  });
});
