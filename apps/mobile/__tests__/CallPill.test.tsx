// On-call pill (spec/15 § Voice states): while a call is open away from its
// chat, a small persistent pill reads `On call · Manager · 1:23`; tapping it
// returns to the call's chat, its button ends the call.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actSync,
  byLabel,
  byTestId,
  findHost,
  renderRN as renderRNRaw,
  textOf,
} from './testUtils/render';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';

const { endVoiceCallSpy } = vi.hoisted(() => ({
  endVoiceCallSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/voiceCall', () => ({ endVoiceCall: endVoiceCallSpy }));

import { CallPill } from '../src/components/CallPill';

const T0 = new Date('2026-09-24T10:00:00Z').getTime();
const mounted: ReturnType<typeof renderRNRaw>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderRNRaw> {
  const r = renderRNRaw(el);
  mounted.push(r);
  return r;
}

function call(
  chatId: string,
  extra: Partial<ReturnType<typeof useVoiceStore.getState>> = {},
): void {
  useVoiceStore.setState({
    activeSession: { sessionId: 's', chatId, audioUrl: '/a', startedAt: T0 },
    callMuted: false,
    callError: null,
    callPhase: 'listening',
    callMode: 'call',
    callConnectedAt: T0,
    ...extra,
  });
}

const label = (r: ReturnType<typeof renderRN>): string =>
  textOf(findHost(r.root, byTestId('call-pill-label')));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  endVoiceCallSpy.mockClear();
  __resetRouterMock();
  useChatStore.getState()._reset();
  useVoiceStore.setState({ activeSession: null, callError: null, callConnectedAt: null });
});

afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  vi.useRealTimers();
});

describe('CallPill', () => {
  it('renders nothing with no call', () => {
    expect(renderRN(<CallPill />).toJSON()).toBeNull();
  });

  it('reads "On call · Manager · m:ss" with a running clock', () => {
    call('thread_manager');
    const r = renderRN(<CallPill />);
    expect(label(r)).toBe('On call · Manager · 0:00');
    actSync(() => {
      vi.advanceTimersByTime(83_000);
    });
    expect(label(r)).toBe('On call · Manager · 1:23');
  });

  it('names hands-free, and a chat by its title', () => {
    useChatStore.setState({
      chats: {
        c1: { chatId: 'c1', name: 'Garden plan', folder: '/g' } as never,
      },
    });
    call('c1', { callMode: 'hands-free' });
    const r = renderRN(<CallPill />);
    expect(label(r)).toBe('Hands-free · Garden plan · 0:00');
  });

  it('reads "Connecting…" with no clock until the session connects', () => {
    call('thread_manager', { callPhase: 'connecting', callConnectedAt: null });
    const r = renderRN(<CallPill />);
    expect(label(r)).toBe('Connecting… · Manager');
  });

  it('a failed call says so', () => {
    call('thread_manager', { callError: 'Call dropped' });
    const r = renderRN(<CallPill />);
    expect(label(r)).toBe('Call failed · Manager');
  });

  it('tapping returns to the call’s chat; the button ends the call', () => {
    call('thread_manager', { callMuted: true });
    const r = renderRN(<CallPill />);
    findHost(r.root, byLabel('On call · Manager · 0:00 — return to the call')).props['onPress']();
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/thread_manager');
    findHost(r.root, byLabel('End call')).props['onPress']();
    expect(endVoiceCallSpy).toHaveBeenCalledTimes(1);
    actSync(() => findHost(r.root, byLabel('End call')).props['onPressIn']());
    expect(findHost(r.root, byLabel('End call')).props['style']).toMatchObject({ opacity: 0.7 });
  });
});
