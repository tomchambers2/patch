// Hook schema + aggregateHookDecision/hookGateMatches (spec/20-hooks.md).

import { describe, it, expect } from 'vitest';
import {
  Hook,
  HookCreateBody,
  HookCheckOutcome,
  aggregateHookDecision,
  hookGateMatches,
  type HookRunResult,
  type HookCheckContext,
} from '../src/hooks.js';

describe('HookCreateBody', () => {
  it('accepts a minimal script hook', () => {
    const result = HookCreateBody.safeParse({
      name: 'no secrets',
      when: 'user_message',
      kind: 'script',
      script: { command: 'exit 0' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown field (strict)', () => {
    const result = HookCreateBody.safeParse({
      name: 'x',
      when: 'user_message',
      kind: 'script',
      script: { command: 'exit 0' },
      bogus: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('HookCheckOutcome', () => {
  it('pass needs no analysis', () => {
    expect(HookCheckOutcome.safeParse({ decision: 'pass' }).success).toBe(true);
  });
  it('advise requires analysis', () => {
    expect(HookCheckOutcome.safeParse({ decision: 'advise' }).success).toBe(false);
    expect(HookCheckOutcome.safeParse({ decision: 'advise', analysis: 'why' }).success).toBe(true);
  });
  it('block requires analysis', () => {
    expect(HookCheckOutcome.safeParse({ decision: 'block' }).success).toBe(false);
  });
});

describe('hookGateMatches', () => {
  const ctx: HookCheckContext = {
    message: 'hi',
    chatId: 'c1',
    folder: '/work',
    daemonId: 'd1',
    specialThread: false,
  };

  it('an empty gate matches everything ordinary', () => {
    expect(hookGateMatches({}, ctx)).toBe(true);
  });

  it('null allow-lists mean no restriction', () => {
    expect(hookGateMatches({ hosts: null, folders: null, chatIds: null }, ctx)).toBe(true);
  });

  it('every axis must clear for a match', () => {
    expect(hookGateMatches({ hosts: ['d1'], folders: ['/work'], chatIds: ['c1'] }, ctx)).toBe(true);
    expect(hookGateMatches({ hosts: ['d2'] }, ctx)).toBe(false);
  });

  it('specialThreads axis', () => {
    expect(hookGateMatches({}, { ...ctx, specialThread: true })).toBe(false);
    expect(hookGateMatches({ specialThreads: true }, { ...ctx, specialThread: true })).toBe(true);
    expect(hookGateMatches({ specialThreads: true }, ctx)).toBe(false);
  });
});

describe('aggregateHookDecision', () => {
  const ok = (
    decision: 'pass' | 'advise' | 'block',
    extra: Partial<HookRunResult> = {},
  ): HookRunResult => ({
    hookId: 'h',
    hookName: 'h',
    status: 'ok',
    decision,
    durationMs: 1,
    ...extra,
  });

  it('empty results is pass', () => {
    expect(aggregateHookDecision([])).toBe('pass');
  });

  it('all pass is pass', () => {
    expect(aggregateHookDecision([ok('pass'), ok('pass')])).toBe('pass');
  });

  it('any advise (no block/failed) is advise', () => {
    expect(aggregateHookDecision([ok('pass'), ok('advise')])).toBe('advise');
  });

  it('any block wins over advise', () => {
    expect(aggregateHookDecision([ok('advise'), ok('block')])).toBe('block');
  });

  it('a failed/timeout result holds the message like a block', () => {
    const failed: HookRunResult = { hookId: 'h', hookName: 'h', status: 'failed', durationMs: 1 };
    expect(aggregateHookDecision([ok('pass'), failed])).toBe('block');
    const timeout: HookRunResult = { hookId: 'h', hookName: 'h', status: 'timeout', durationMs: 1 };
    expect(aggregateHookDecision([ok('advise'), timeout])).toBe('block');
  });
});

describe('Hook schema', () => {
  it('accepts when: agent_response at the wire layer (spec/20-hooks.md)', () => {
    const result = Hook.safeParse({
      id: 'hook_01HXYZWVUTSRQPONMLKJIHGFE',
      name: 'x',
      enabled: true,
      when: 'agent_response',
      kind: 'script',
      script: { command: 'exit 0' },
      gate: {},
      timeoutMs: 1000,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe('HookCheckContext', () => {
  it('toolCallsSummary is optional, carried only for agent_response checks', () => {
    const userMessageCtx: HookCheckContext = {
      message: 'hi',
      chatId: 'c1',
      folder: '/work',
      daemonId: 'd1',
      specialThread: false,
    };
    expect(userMessageCtx.toolCallsSummary).toBeUndefined();
    const agentResponseCtx: HookCheckContext = {
      ...userMessageCtx,
      message: 'Done — booked for Thursday.',
      toolCallsSummary: 'Ran 2 commands, read 1 file',
    };
    expect(agentResponseCtx.toolCallsSummary).toBe('Ran 2 commands, read 1 file');
  });
});
