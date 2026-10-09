// components/MessageActions.tsx — the long-press copy/select sheet (spec/15
// § Chat detail — Copying message text), exercised on its own. The wiring
// into the transcript is covered in chatDetail.timeline.test.tsx.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderRN,
  actSync,
  actAsync,
  flush,
  findHost,
  findAllHost,
  byTestId,
  byLabel,
} from './testUtils/render';
import {
  COPIED_TOAST_MS,
  MessageActionsHost,
  MessageLongPress,
  __resetMessageActions,
  formatMessageTime,
  showMessageActions,
} from '../src/components/MessageActions';
import { __lastCopied, __resetClipboard } from './stubs/expo-clipboard';
import { Text } from 'react-native';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { useSideThreadsStore, DRAFT_TAB_ID } from '../src/stores/sideThreadsStore';

beforeEach(() => {
  __resetClipboard();
  __resetMessageActions();
  __resetRouterMock();
  useSideThreadsStore.setState({ activeTabByChatId: {}, pendingNewTab: {}, draftByChatId: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MessageLongPress', () => {
  it('a row with nothing to copy is a plain container with no long-press', () => {
    const r = renderRN(
      <MessageLongPress text={null} testID="row">
        <Text>img</Text>
      </MessageLongPress>,
    );
    const row = findHost(r.root, byTestId('row'));
    expect(row.type).toBe('View');
    expect(row.props.onLongPress).toBeUndefined();
  });

  it('a row with text opens the sheet on long-press', () => {
    const r = renderRN(
      <>
        <MessageLongPress text="hello" testID="row">
          <Text>hello</Text>
        </MessageLongPress>
        <MessageActionsHost />
      </>,
    );
    actSync(() => findHost(r.root, byTestId('row')).props.onLongPress());
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(1);
  });
});

describe('MessageActionsHost', () => {
  it('tapping the backdrop closes the sheet without copying', () => {
    const r = renderRN(<MessageActionsHost />);
    actSync(() => showMessageActions('x'));
    actSync(() => findHost(r.root, byLabel('Dismiss')).props.onPress());
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(0);
    expect(__lastCopied()).toBeNull();
  });

  it('the select view copies all, toasts in place, and closes', async () => {
    const r = renderRN(<MessageActionsHost />);
    actSync(() => showMessageActions('select me'));
    actSync(() => findHost(r.root, byTestId('message-action-select')).props.onPress());
    await actAsync(async () => {
      findHost(r.root, byTestId('message-select-copy-all')).props.onPress();
      await flush();
    });
    expect(__lastCopied()).toBe('select me');
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(1);
    actSync(() => findHost(r.root, byLabel('Close')).props.onPress());
    expect(findAllHost(r.root, byTestId('message-select-view'))).toHaveLength(0);
  });

  it('the Copied toast goes away on its own', async () => {
    vi.useFakeTimers();
    const r = renderRN(<MessageActionsHost />);
    actSync(() => showMessageActions('x'));
    await actAsync(async () => {
      findHost(r.root, byTestId('message-action-copy')).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(1);
    actSync(() => {
      vi.advanceTimersByTime(COPIED_TOAST_MS);
    });
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(0);
  });

  it('showMessageActions alone (no messageAt) shows no time toast', () => {
    const r = renderRN(<MessageActionsHost />);
    actSync(() => showMessageActions('x'));
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(0);
  });
});

describe('MessageLongPress with messageAt', () => {
  it('long-press toasts the message time immediately, alongside the still-open sheet', () => {
    const at = 1_700_000_000_000;
    const r = renderRN(
      <>
        <MessageLongPress text="hello" messageAt={at} testID="row">
          <Text>hello</Text>
        </MessageLongPress>
        <MessageActionsHost />
      </>,
    );
    actSync(() => findHost(r.root, byTestId('row')).props.onLongPress());
    // The sheet is still open — this isn't instead of Copy/Select/Open side
    // thread, it's in addition, with no extra tap needed for the time.
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(1);
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(1);
    expect(findHost(r.root, byTestId('message-copied-toast')).children).toEqual([
      formatMessageTime(at),
    ]);
    expect(__lastCopied()).toBeNull();
  });

  it('a row with no messageAt long-presses straight to the sheet, no toast', () => {
    const r = renderRN(
      <>
        <MessageLongPress text="hello" testID="row">
          <Text>hello</Text>
        </MessageLongPress>
        <MessageActionsHost />
      </>,
    );
    actSync(() => findHost(r.root, byTestId('row')).props.onLongPress());
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(1);
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(0);
  });

  it("the time toast from one row doesn't bleed into the next row's sheet", () => {
    const r = renderRN(
      <>
        <MessageLongPress text="hello" messageAt={1_700_000_000_000} testID="row-a">
          <Text>hello</Text>
        </MessageLongPress>
        <MessageLongPress text="world" testID="row-b">
          <Text>world</Text>
        </MessageLongPress>
        <MessageActionsHost />
      </>,
    );
    actSync(() => findHost(r.root, byTestId('row-a')).props.onLongPress());
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(1);
    actSync(() => findHost(r.root, byLabel('Dismiss')).props.onPress());
    actSync(() => findHost(r.root, byTestId('row-b')).props.onLongPress());
    expect(findAllHost(r.root, byTestId('message-copied-toast'))).toHaveLength(0);
  });
});

// spec/15 § Side threads screen — TRIGGER: the long-press sheet's "Open side
// thread" item.
describe('MessageLongPress with sideThread (spec/15 § Side threads screen)', () => {
  it('a row with no sideThread origin has no "Open side thread" item', () => {
    const r = renderRN(
      <>
        <MessageLongPress text="hello" testID="row">
          <Text>hello</Text>
        </MessageLongPress>
        <MessageActionsHost />
      </>,
    );
    actSync(() => findHost(r.root, byTestId('row')).props.onLongPress());
    expect(findAllHost(r.root, byTestId('message-action-side-thread'))).toHaveLength(0);
  });

  it('tapping "Open side thread" arms a draft off that message and navigates to the threads screen', () => {
    const r = renderRN(
      <>
        <MessageLongPress
          text="the original message"
          sideThread={{ chatId: 'c1', seq: 4 }}
          testID="row"
        >
          <Text>the original message</Text>
        </MessageLongPress>
        <MessageActionsHost />
      </>,
    );
    actSync(() => findHost(r.root, byTestId('row')).props.onLongPress());
    actSync(() => findHost(r.root, byTestId('message-action-side-thread')).props.onPress());

    expect(useSideThreadsStore.getState().draftByChatId['c1']).toEqual({
      seq: 4,
      quotedMessage: 'the original message',
    });
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe(DRAFT_TAB_ID);
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c1/threads');
    // The sheet closes, same as every other action.
    expect(findAllHost(r.root, byTestId('message-actions-sheet'))).toHaveLength(0);
  });
});
