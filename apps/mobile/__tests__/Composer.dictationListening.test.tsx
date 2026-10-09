// Composer dictation — keyboard away, listening state visible (spec/07 §
// Dictation into the composer, spec/15 § Composer). Starting a dictation puts
// the soft keyboard away (there is nothing to type while talking); a listening
// strip above the input names the state, pulses, and counts the time; it reads
// "Transcribing…" while the clip is transcribed and goes when the words land.
//
// Drives the Composer against a fake dictation session (`dictationFactory`),
// exactly as Composer.voice.test.tsx does.

import React from 'react';
import { Keyboard } from 'react-native';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actAsync,
  actSync,
  byLabel,
  byTestId,
  byType,
  findHost,
  queryHost,
  renderRN,
  textOf,
} from './testUtils/render';
import { lightColors as colors } from '../src/lib/theme';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { __clearAllMmkv } from './stubs/mmkv';
import type { DictationHandle, DictationOutcome } from '../src/lib/dictation';
import type * as dictationModule from '../src/lib/dictation';

vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

const T0 = new Date('2026-09-24T10:00:00Z').getTime();

function makeFactory(): {
  factory: typeof dictationModule.startDictation;
  finish: ReturnType<typeof vi.fn>;
} {
  const finish = vi.fn(async (_send: boolean) => ({ kind: 'no-audio' }) as DictationOutcome);
  const factory = vi.fn(
    (): DictationHandle => ({ finish }),
  ) as unknown as typeof dictationModule.startDictation;
  return { factory, finish };
}

let dismissSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  dismissSpy = vi.spyOn(Keyboard, 'dismiss');
});

afterEach(() => {
  dismissSpy.mockRestore();
  vi.useRealTimers();
});

const mic = (r: ReturnType<typeof renderRN>): Record<string, () => void> =>
  findHost(r.root, byLabel('Dictate into message')).props as Record<string, () => void>;

describe('Composer — starting a dictation puts the keyboard away', () => {
  it('a tap-started dictation dismisses the keyboard', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    expect(dismissSpy).not.toHaveBeenCalled();
    await actAsync(() => mic(r)['onPress']!());
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('a hold-started dictation dismisses the keyboard', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onLongPress']!());
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('the input stays editable — tapping it can bring the keyboard back', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    expect(findHost(r.root, byType('TextInput')).props['editable']).toBe(true);
  });
});

describe('Composer — the listening strip', () => {
  it('is absent at rest', () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    expect(queryHost(r.root, byTestId('dictation-status'))).toBeNull();
  });

  it('reads "Listening" with a pulsing red dot and a clock that counts up', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    const strip = findHost(r.root, byTestId('dictation-status'));
    expect(textOf(strip)).toContain('Listening');
    const dot = findHost(r.root, byTestId('call-status-dot'));
    expect((dot.props['style'] as { backgroundColor: string }).backgroundColor).toBe(colors.red);
    expect(textOf(findHost(r.root, byTestId('dictation-timer')))).toBe('0:00');
    actSync(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(textOf(findHost(r.root, byTestId('dictation-timer')))).toBe('0:07');
  });

  it('reads "Transcribing…" (no clock) while the clip is transcribed, then goes', async () => {
    const { factory, finish } = makeFactory();
    let resolve!: (o: DictationOutcome) => void;
    finish.mockReturnValueOnce(
      new Promise<DictationOutcome>((res) => {
        resolve = res;
      }),
    );
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    await actAsync(() => {
      mic(r)['onPress']!();
    });
    expect(textOf(findHost(r.root, byTestId('dictation-status')))).toContain('Transcribing…');
    expect(queryHost(r.root, byTestId('dictation-timer'))).toBeNull();

    await actAsync(() => resolve({ kind: 'text', text: 'buy oat milk' }));
    expect(queryHost(r.root, byTestId('dictation-status'))).toBeNull();
    // The words land in the input, ready to send; nothing re-opened the
    // keyboard (the only dismiss was the one at the start).
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('buy oat milk');
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('goes the moment the dictation is cleared', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    await actAsync(() => findHost(r.root, byLabel('Clear dictation')).props['onPress']());
    expect(queryHost(r.root, byTestId('dictation-status'))).toBeNull();
  });
});
