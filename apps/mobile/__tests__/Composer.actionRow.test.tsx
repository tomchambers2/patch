// The composer action row Tom settled on (spec/15 § Composer):
//   [camera][image][file][mic] … [model pill][padlock][Send | Stop]
// Pins:
//   - the order, with the flexible spacer between the mic and the model pill
//   - the model pill reads a compact friendly name and changes the model with
//     the same `chat.model_request` web's header sends; it applies to the next
//     message, and a host that never confirms is reported, not waited on
//   - Stop REPLACES Send while a turn runs and the composer is empty, and sends
//     the same `chat.stop_request` web's stop button does
//   - typing while a turn runs brings Send back, and that send goes through the
//     normal delivery path (the host queues it behind the running turn)
//   - on a 360dp phone the pill is the only control that shrinks

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  renderRN,
  update,
  findHost,
  queryHost,
  findAllHost,
  byLabel,
  byTestId,
  byType,
  textOf,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import type { DictationHandle, DictationOutcome } from '../src/lib/dictation';
import * as dictationModule from '../src/lib/dictation';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';
import { compactModelLabel } from '../src/lib/modelLabel';
import { lightColors } from '../src/lib/theme';

const { modelsSpy } = vi.hoisted(() => ({ modelsSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
    models: modelsSpy,
  },
}));

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

import { useComposerDraftStore } from '../src/lib/composerDraft';
import {
  Composer,
  MODEL_CONFIRM_TIMEOUT_MS,
  PENDING_SEND_TIMEOUT_MS,
} from '../src/components/Composer';

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  vi.clearAllMocks();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  modelsSpy.mockResolvedValue({
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    ],
  });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
  vi.useRealTimers();
});

function seed(
  overrides: { activity?: 'idle' | 'running' | 'awaiting-permission'; model?: string | null } = {},
): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      name: 'Chat',
      folder: '/home/tom/work',
      activity: overrides.activity ?? 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
      model: overrides.model === undefined ? 'claude-opus-5-5' : overrides.model,
    },
  ]);
}

/** Host controls on the action row, named by label or testID, in order. */
function rowOrder(root: ReactTestInstance): string[] {
  const row = findHost(root, byTestId('composer-actions-row'));
  const wanted = new Set([
    'Take photo',
    'Attach photo or image',
    'Attach any file',
    'Dictate into message',
    'composer-actions-spacer',
    'composer-model-pill',
    'permission-mode-padlock',
    'composer-stop',
    'Send message',
  ]);
  return row
    .findAll((i) => typeof i.type === 'string')
    .map((i) => {
      const id = i.props['testID'] as string | undefined;
      const label = i.props['accessibilityLabel'] as string | undefined;
      if (id !== undefined && wanted.has(id)) return id;
      if (label !== undefined && wanted.has(label)) return label;
      return null;
    })
    .filter((x): x is string => x !== null);
}

function dictationFactory(): typeof dictationModule.startDictation {
  return vi.fn(
    (_chatId: string, _onPartial: (t: string) => void, _onError: (m: string) => void) => {
      const finish = vi.fn(async (_send: boolean) => ({ kind: 'no-audio' }) as DictationOutcome);
      return { finish } satisfies DictationHandle;
    },
  ) as unknown as typeof dictationModule.startDictation;
}

describe('Composer action row — order', () => {
  it('a dictation in flight adds Clear after the mic, so the mic never moves (Todoist 6hf6qmQc4RPxX25c)', async () => {
    seed();
    const factory = dictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    const row = findHost(r.root, byTestId('composer-actions-row'));
    const ordered = row
      .findAll((i) => typeof i.type === 'string' && i !== row)
      .map((i) => (i.props['accessibilityLabel'] as string) ?? (i.props['testID'] as string))
      .filter((x): x is string => x !== undefined);
    expect(ordered.slice(0, 5)).toEqual([
      'Take photo',
      'Attach photo or image',
      'Attach any file',
      'Dictate into message',
      'Clear dictation',
    ]);
  });

  it('the mic sits at the same index whether idle or mid-dictation (it never shifts)', async () => {
    seed();
    const factory = dictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" dictationFactory={factory} />);
    const idleIndex = rowOrder(r.root).indexOf('Dictate into message');
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    const dictatingIndex = rowOrder(r.root).indexOf('Dictate into message');
    expect(dictatingIndex).toBe(idleIndex);
  });

  it('reads camera, image, file, mic … model pill, padlock, send', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(rowOrder(r.root)).toEqual([
      'Take photo',
      'Attach photo or image',
      'Attach any file',
      'Dictate into message',
      'composer-actions-spacer',
      'composer-model-pill',
      'permission-mode-padlock',
      'Send message',
    ]);
  });

  it('with a turn running and nothing typed, Stop takes Send’s place at the end', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(rowOrder(r.root).slice(-3)).toEqual([
      'composer-model-pill',
      'permission-mode-padlock',
      'composer-stop',
    ]);
  });

  it('keeps the model pill and padlock on an existing chat the roster has not named yet', () => {
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-model-pill'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('permission-mode-padlock'))).not.toBeNull();
  });

  it('keeps the model pill when the host reports no model (never a guess)', () => {
    seed({ model: null });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-model-pill'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('permission-mode-padlock'))).not.toBeNull();
  });

  it('leaves them to the setup rows on the new-chat screen (a send target)', () => {
    const r = renderRN(
      <Composer chatId="c1" folder="/home/tom/work" sendTarget={async () => null} />,
    );
    expect(queryHost(r.root, byTestId('composer-model-pill'))).toBeNull();
    expect(queryHost(r.root, byTestId('permission-mode-padlock'))).toBeNull();
  });
});

describe('Composer action row — fits a 360dp phone', () => {
  it('only the model pill shrinks; send and the icon buttons keep their size', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const pillStyle = findHost(r.root, byTestId('composer-model-pill')).props['style'] as Record<
      string,
      number
    >;
    expect(pillStyle['flexShrink']).toBe(1);
    expect(pillStyle['maxWidth']).toBeLessThanOrEqual(120);
    const send = findHost(r.root, byLabel('Send message')).props['style'] as Record<string, number>;
    expect(send['flexShrink'] ?? 0).toBe(0);
    // Budget: 12px padding each side, six fixed 36px buttons, 2px gaps and a
    // minimum spacer — what is left is the pill's room, and it must be enough
    // to read "Opus 5.5".
    const fixed = 2 * 12 + 6 * send['width']! + 7 * 2 + 4;
    expect(360 - fixed).toBeGreaterThanOrEqual(90);
  });
});

describe('Composer model pill', () => {
  it('reads a compact friendly name, not the raw id', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(textOf(findHost(r.root, byTestId('composer-model-pill')))).toContain('Opus 5.5');
    expect(textOf(findHost(r.root, byTestId('composer-model-pill')))).not.toContain('claude-');
  });

  it('does not ask the host for its catalogue until the pill is opened', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(flush);
    expect(modelsSpy).not.toHaveBeenCalled();
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    expect(modelsSpy).toHaveBeenCalledWith('d1');
  });

  it('choosing a model sends chat.model_request — the same frame web sends', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-sonnet-5')).props['onPress'](),
    );
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-sonnet-5',
    });
    // Pending until the host confirms: the pill reads the pick, dimmed.
    const pill = findHost(r.root, byTestId('composer-model-pill'));
    expect(textOf(pill)).toContain('Sonnet 5');
    expect(pill.props['accessibilityState']).toMatchObject({ busy: true });
  });

  it('says the change applies to the next message', async () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    expect(textOf(findHost(r.root, byTestId('model-picker-note')))).toMatch(
      /next message — this turn keeps its model/,
    );
  });

  it('re-picking the model already in force sends nothing', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-opus-5-5')).props['onPress'](),
    );
    expect(wsMock.send).not.toHaveBeenCalled();
  });

  it('the host confirming (chat.state carrying the model) settles the pill', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-sonnet-5')).props['onPress'](),
    );
    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, model: 'claude-sonnet-5' } },
      });
    });
    update(r, <Composer chatId="c1" folder="/home/tom/work" />);
    const pill = findHost(r.root, byTestId('composer-model-pill'));
    expect(pill.props['accessibilityState']).toMatchObject({ busy: false });
    expect(textOf(pill)).toContain('Sonnet 5');
  });

  it('a host that never confirms is reported and the pill goes back (NO FALLBACK)', async () => {
    vi.useFakeTimers();
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await vi.advanceTimersByTimeAsync(0);
    });
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-sonnet-5')).props['onPress'](),
    );
    actSync(() => {
      vi.advanceTimersByTime(MODEL_CONFIRM_TIMEOUT_MS + 1);
    });
    expect(textOf(findHost(r.root, byTestId('composer-model-pill')))).toContain('Opus 5.5');
    expect(
      useUiStore.getState().errors.some((e) => /did not switch the model/.test(e.message)),
    ).toBe(true);
  });
});

describe('Composer — Stop replaces Send while a turn runs', () => {
  it('idle: Send shows, Stop does not', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byLabel('Send message'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
  });

  it('running with an empty composer: Stop (a square) instead of Send', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const stop = findHost(r.root, byTestId('composer-stop'));
    expect(stop.props['accessibilityLabel']).toBe('Stop turn');
    expect(stop.findAll((i) => i.type === ('Icon' as unknown as string))[0]!.props['name']).toBe(
      'Square',
    );
    expect(
      queryHost(r.root, (i) => String(i.props['accessibilityLabel'] ?? '').startsWith('Send')),
    ).toBeNull();
  });

  it('awaiting a permission mid-turn still offers Stop', () => {
    seed({ activity: 'awaiting-permission' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
  });

  it('parked only on an AskUserQuestion offers no Stop', () => {
    seed({ activity: 'awaiting-permission' });
    useChatStore.setState((st) => ({
      chats: {
        ...st.chats,
        c1: {
          ...st.chats['c1']!,
          pendingPermissions: [
            { requestId: 'q1', tool: 'AskUserQuestion', description: '', args: {} },
          ],
        },
      },
    }));
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
  });

  it('tapping Stop sends chat.stop_request — the frame web’s stop button sends', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    findHost(r.root, byTestId('composer-stop')).props['onPress']();
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'chat.stop_request', chatId: 'c1' });
  });

  it('typing while running brings Send back, and it queues the message', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('and then do this'));
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    const send = findHost(r.root, byLabel('Send message (queued after the current turn)'));
    actSync(() => send.props['onPress']());
    // The ordinary delivery path: the host queues a chat.input behind the
    // running turn, exactly as a web send mid-turn is queued.
    expect(submitSpy).toHaveBeenCalledWith(
      'c1',
      'and then do this',
      expect.any(String),
      undefined,
      expect.any(Function),
      expect.anything(),
    );
    expect(wsMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.stop_request' }),
    );
    // Composer cleared by the send → back to Stop while the turn still runs.
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
  });

  it('whitespace alone does not count as typed text — still Stop', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('   '));
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
  });

  it('when the turn finishes, Stop goes back to Send', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, activity: 'idle' } },
      });
    });
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    expect(queryHost(r.root, byLabel('Send message'))).not.toBeNull();
  });

  it('with the link down Stop is visibly unavailable rather than a dead tap', () => {
    seed({ activity: 'running' });
    usePresenceStore.setState({ connection: 'offline' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const stop = findHost(r.root, byTestId('composer-stop'));
    expect(stop.props['accessibilityLabel']).toMatch(/^Stop unavailable — /);
  });
});

// A plain send (no attachment) clears the draft synchronously, but the host
// confirming the turn as `running` — what lets Stop take over — arrives a
// moment later over the socket. Without holding the busy styling across that
// gap, empty draft + not-yet-running reads identically to nothing-to-send:
// the send button flashes dead grey right when a turn is about to start
// (Todoist 6hf2JM6695c7rhJ6).
describe('Composer — Send stays active across the send→running gap', () => {
  /** The send Pressable, whichever of its labels it is currently wearing. */
  function sendButton(r: ReturnType<typeof renderRN>) {
    return findHost(
      r.root,
      (i) =>
        i.type === 'Pressable' &&
        /^(Send message|Sending)/.test(String(i.props['accessibilityLabel'] ?? '')),
    );
  }

  it('keeps the active colour and a spinner until the host confirms running, then Stop takes over', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('hello'));
    actSync(() => sendButton(r).props['onPress']());

    // The draft is gone and the host has not said the turn is running yet —
    // Stop is already offered, so the send can be cancelled while it is in
    // flight (Todoist 6hhjmc4fghR3qVw6), and it sends chat.stop_request.
    const stop = findHost(r.root, byTestId('composer-stop'));
    expect(queryHost(r.root, byLabel('Send message'))).toBeNull();
    expect(findAllHost(r.root, byType('ActivityIndicator'))).toHaveLength(0);
    actSync(() => stop.props['onPress']());
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'chat.stop_request', chatId: 'c1' });
    // Stopping ends the pending gap: Send is back, dead grey (empty draft).
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    expect(sendButton(r).props['style'].backgroundColor).toBe(lightColors.divider);
  });

  it('Stop takes over from the pending send once the host confirms running', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('hello'));
    actSync(() => sendButton(r).props['onPress']());
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();

    // The host's chat.state lands — Stop takes over, exactly as it does for
    // any other running-and-empty composer.
    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, activity: 'running' } },
      });
    });
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
    expect(queryHost(r.root, byLabel('Send message'))).toBeNull();
  });

  it('settles instead of spinning forever if running never comes back (e.g. queued offline)', () => {
    vi.useFakeTimers();
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('hello'));
    actSync(() => sendButton(r).props['onPress']());
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();

    actSync(() => vi.advanceTimersByTime(PENDING_SEND_TIMEOUT_MS + 1));

    const settled = sendButton(r);
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    expect(settled.props['style'].backgroundColor).toBe(lightColors.divider);
  });

  it('a queued send mid-turn (already running) goes straight to Stop, no gap', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('and then this'));
    const send = findHost(r.root, byLabel('Send message (queued after the current turn)'));
    actSync(() => send.props['onPress']());
    // Already running at send time, so no busy gap to bridge — Stop is back
    // immediately, not a lingering busy Send.
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
    expect(findAllHost(r.root, byType('ActivityIndicator'))).toHaveLength(0);
  });

  // Send/Stop paint a filled circle, so at the shared 36px touch target they
  // read heavier than the outline-only icons beside them (Todoist
  // 6hf2JM6695c7rhJ6 — "looks big even if it isn't"). The drawn circle is
  // smaller; hit slop makes up the difference so the touch target still
  // matches every other action-row control.
  it('paints Send/Stop smaller than the shared touch target, with hit slop making up the difference', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const stop = findHost(r.root, byTestId('composer-stop'));
    const stopWidth = stop.props['style'].width as number;
    const stopHitSlop = stop.props['hitSlop'] as number;
    expect(stopWidth).toBeLessThan(36);
    expect(stopWidth).toBe(stop.props['style'].height);
    expect(stopHitSlop).toBe((36 - stopWidth) / 2);

    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, activity: 'idle' } },
      });
    });
    const send = findHost(r.root, byLabel('Send message'));
    expect(send.props['style'].width).toBe(stopWidth);
    expect(send.props['hitSlop']).toBe(stopHitSlop);
  });
});

describe('compactModelLabel', () => {
  it.each([
    ['claude-opus-5-5', undefined, 'Opus 5.5'],
    ['claude-opus-5-5', 'Claude Opus 5.5', 'Opus 5.5'],
    ['claude-sonnet-5', undefined, 'Sonnet 5'],
    ['claude-haiku-4-5-20251001', undefined, 'Haiku 4.5'],
    ['openai/gpt-6', undefined, 'openai/gpt-6'],
    ['claude-opus-5-5', 'Opus Preview', 'Opus Preview'],
  ])('%s (catalogue %s) → %s', (id, label, want) => {
    expect(compactModelLabel(id, label)).toBe(want);
  });
});
