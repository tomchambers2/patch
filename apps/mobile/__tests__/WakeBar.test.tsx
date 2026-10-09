// Render coverage for the mobile wake bar (spec/02 § Self-wake; spec/15 §
// Chat detail). Mirrors packages/web/src/__tests__/ChatRoute.wake.test.tsx:
// (1) shows countdown + message, (2) no bar without a pending wake, (3) the
// countdown ticks live, (4) a due-but-undelivered wake reads "now".

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
  renderRN,
  queryHost,
  findHost,
  byTestId,
  textOf,
  actSync,
  actAsync,
} from './testUtils/render';
import { useUiStore } from '../src/stores/uiStore';
import { WakeBar } from '../src/components/WakeBar';
import type { ChatRow } from '../src/stores/types';

const apiMocks = vi.hoisted(() => ({ setLoop: vi.fn(async (): Promise<unknown> => undefined) }));
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

const NOW = 1_800_000_000_000;

function row(pendingWake: ChatRow['pendingWake']): ChatRow {
  return {
    chatId: 'c1',
    name: 'bus watch',
    daemonId: 'd1',
    folder: '~/f',
    activity: 'idle',
    permissionMode: 'bypassPermissions',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastVisitedAt: 0,
    preview: null,
    pendingPermissions: [],
    lastSeq: 0,
    pendingWake,
  };
}

describe('WakeBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the countdown to the next wake and its prompt', () => {
    const r = renderRN(
      <WakeBar
        row={row({ message: 'check whether the bus has left', fireAt: NOW + 9 * 60_000 })}
      />,
    );
    const bar = queryHost(r.root, byTestId('wake-bar'));
    expect(bar).not.toBeNull();
    expect(textOf(queryHost(r.root, byTestId('wake-bar-countdown'))!)).toContain('9m');
    expect(textOf(queryHost(r.root, byTestId('wake-bar-message'))!)).toContain(
      'check whether the bus has left',
    );
  });

  it('renders nothing when the chat has no pending wake', () => {
    const r = renderRN(<WakeBar row={row(null)} />);
    expect(queryHost(r.root, byTestId('wake-bar'))).toBeNull();
  });

  it('renders nothing when the row itself is undefined (chat not yet in the store)', () => {
    const r = renderRN(<WakeBar row={undefined} />);
    expect(queryHost(r.root, byTestId('wake-bar'))).toBeNull();
  });

  it('ticks the countdown down live', () => {
    const r = renderRN(
      <WakeBar row={row({ message: 'nag about bed', fireAt: NOW + 2 * 60_000 + 5_000 })} />,
    );
    expect(textOf(queryHost(r.root, byTestId('wake-bar-countdown'))!)).toContain('2m 5s');
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(textOf(queryHost(r.root, byTestId('wake-bar-countdown'))!)).toContain('1m 59s');
  });

  it('reads "now" once the fire time has passed but the turn has not landed', () => {
    const r = renderRN(<WakeBar row={row({ message: 'overdue', fireAt: NOW - 1_000 })} />);
    expect(textOf(queryHost(r.root, byTestId('wake-bar-countdown'))!)).toContain('now');
  });

  const press = (r: ReturnType<typeof renderRN>, id: string): void =>
    actSync(() => {
      (findHost(r.root, byTestId(id)).props.onPress as () => void)();
    });

  it('tapping the bar opens the full message; a one-shot wake is read-only there', () => {
    const long = 'check whether the bus has left and report back with the platform number';
    const r = renderRN(<WakeBar row={row({ message: long, fireAt: NOW + 60_000 })} />);
    expect(queryHost(r.root, byTestId('wake-modal'))).toBeNull();
    press(r, 'wake-bar');
    expect(textOf(findHost(r.root, byTestId('wake-modal-message')))).toBe(long);
    expect(queryHost(r.root, byTestId('wake-modal-input'))).toBeNull();
    press(r, 'wake-modal-close');
    expect(queryHost(r.root, byTestId('wake-modal'))).toBeNull();
  });

  it('a loop wake is editable in the modal and saves by re-arming at the same interval', async () => {
    apiMocks.setLoop.mockClear();
    const r = renderRN(
      <WakeBar row={row({ message: 'poll', fireAt: NOW + 60_000, every: 600_000 })} />,
    );
    press(r, 'wake-bar');
    const input = findHost(r.root, byTestId('wake-modal-input'));
    expect(input.props.value).toBe('poll');
    actSync(() => (input.props.onChangeText as (t: string) => void)('poll the bus times'));
    await actAsync(async () => {
      (findHost(r.root, byTestId('wake-modal-save')).props.onPress as () => void)();
    });
    expect(apiMocks.setLoop).toHaveBeenCalledWith('c1', {
      message: 'poll the bus times',
      every: 600,
    });
    expect(queryHost(r.root, byTestId('wake-modal'))).toBeNull();
  });

  it('a refused save keeps the modal open and says so', async () => {
    apiMocks.setLoop.mockRejectedValueOnce(new Error('nope'));
    useUiStore.setState({ errors: [] });
    const r = renderRN(
      <WakeBar row={row({ message: 'poll', fireAt: NOW + 60_000, every: 600_000 })} />,
    );
    press(r, 'wake-bar');
    actSync(() =>
      (findHost(r.root, byTestId('wake-modal-input')).props.onChangeText as (t: string) => void)(
        'x',
      ),
    );
    await actAsync(async () => {
      (findHost(r.root, byTestId('wake-modal-save')).props.onPress as () => void)();
    });
    expect(queryHost(r.root, byTestId('wake-modal'))).not.toBeNull();
    expect(useUiStore.getState().errors.length).toBe(1);
  });
});
