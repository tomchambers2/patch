// spec/15 § Skill autocomplete — a completed `/<skill>` becomes a chip
// anywhere in the message (Patch Updates: "patch skill becomes a chip
// anywhere in the composer, with preview").

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  findHost,
  queryHost,
  byType,
  byTestId,
  byLabel,
  renderRN as renderRNRaw,
  update,
  actAsync,
  flush,
} from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useComposerDraftStore } from '../src/lib/composerDraft';
import { deliveryTracker } from '../src/lib/deliveryTracker';

const { skillsSpy } = vi.hoisted(() => ({ skillsSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: { skills: skillsSpy, uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';

let submitSpy: ReturnType<typeof vi.spyOn>;

// Tracked so `afterEach` can unmount every instance — a lingering one from a
// prior test re-renders on THIS test's own `hydrate()` call below and, now
// that the skill fetch reads `row.daemonId`, can fire an extra `api.skills`
// through the same shared `skillsSpy` mock (see Composer.skills.test.tsx).
const renderers: ReactTestRenderer[] = [];
function renderRN(element: React.ReactElement): ReactTestRenderer {
  const r = renderRNRaw(element);
  renderers.push(r);
  return r;
}

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  // Skills are per-host (Todoist 6hfrrmrhG6GM3V36) — the fetch needs `c1`'s
  // row to carry a daemonId.
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      name: 'Chat',
      folder: 'work',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
    },
  ]);
  useUiStore.setState({ errors: [] });
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  skillsSpy.mockReset();
  skillsSpy.mockResolvedValue({
    skills: ['plant'],
    descriptions: { plant: 'Sow what is in season.' },
  });
});

afterEach(() => {
  submitSpy.mockRestore();
  while (renderers.length > 0) {
    renderers.pop()?.unmount();
  }
});

describe('Composer — skill chips (mobile)', () => {
  it('opens the skill list mid-draft, not only at the start', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('please run /pl');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byTestId('skill-option-plant'))).toBeTruthy();
  });

  it('completing a skill mid-draft splices it in, leaving the rest of the text alone', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('please run /pl now');
      await flush();
    });
    // Cursor sits right after "pl" (the point the token was typed to) —
    // typing "now" afterwards without moving the cursor back wouldn't open
    // the menu for "/pl" at all (real typing puts the cursor where you type).
    findHost(r.root, byType('TextInput')).props['onSelectionChange']({
      nativeEvent: { selection: { start: 14, end: 14 } },
    });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byTestId('skill-option-plant')).props['onPress']();
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('please run /plant  now');
    expect(findHost(r.root, byTestId('composer-chip')).props['children']).toBe('/plant');
  });

  it('typing the exact name then a space makes a chip without the menu', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/plant ');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byTestId('composer-chip'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('skill-menu'))).toBeNull();
  });

  it('does not chip a name still being typed (no trailing space yet)', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/plant');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(queryHost(r.root, byTestId('composer-chip'))).toBeNull();
  });

  it('tapping a chip opens the same preview the list would show', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/plant ');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byTestId('composer-chip')).props['onPress']();
    update(r, <Composer chatId="c1" folder="work" />);
    const sheet = findHost(r.root, byTestId('skill-preview-sheet'));
    expect(sheet).toBeTruthy();
    expect(findHost(r.root, byTestId('skill-preview-desc')).props['children']).toBe(
      'Sow what is in season.',
    );
    findHost(r.root, byTestId('skill-preview-backdrop')).props['onPress']();
    update(r, <Composer chatId="c1" folder="work" />);
    expect(queryHost(r.root, byTestId('skill-preview-sheet'))).toBeNull();
  });

  it('Backspace right after a chip removes it whole, not one character', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('run /plant now');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byTestId('composer-chip'))).toBeTruthy();
    const input = findHost(r.root, byType('TextInput'));
    // Cursor right after "/plant " (position 11), collapsed selection.
    input.props['onSelectionChange']({ nativeEvent: { selection: { start: 11, end: 11 } } });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onKeyPress']({
      nativeEvent: { key: 'Backspace' },
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('run now');
  });

  it('sends exactly what is in the box, chip or not', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('please run /plant now');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byLabel('Send message')).props['onPress']();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [, text] = submitSpy.mock.calls[0] as [string, string];
    expect(text).toBe('please run /plant now');
  });

  it('a chip in the initial draft renders on mount, without opening `/` first', async () => {
    useComposerDraftStore.getState()._reset();
    const { setComposerDraft } = await import('../src/lib/composerDraft');
    setComposerDraft('c1', 'please run /plant today');
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byTestId('composer-chip'))).toBeTruthy();
  });
});
