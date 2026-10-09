// Composer layout (spec/15 § Composer): the text input owns the FULL width of
// its own row and every action button lives on a SECOND row beneath it, with
// send pushed to the right edge.
//
// This is a structural test, not a pixel one: it asserts the parentage and the
// ordering of the two rows, which is exactly what "the buttons moved below the
// text box, send stays right" means in a flexbox tree. A screenshot cannot run
// in the suite; this can.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { findHost, findAllHost, byLabel, byTestId, byType, renderRN } from './testUtils/render';
import {
  usePresenceStore,
  type ConnectionState,
  type DaemonPresence,
} from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT } from '../src/lib/composerHeight';

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
  },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

function setPresence(connection: ConnectionState, daemon: DaemonPresence): void {
  usePresenceStore.setState({ connection, daemon, accountId: null, surfaceId: null });
}

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  setPresence('connected', 'online');
  useVoiceStore.setState({
    voiceNoteChatId: null,
    voiceNoteState: 'idle',
    voiceNoteMode: 'tap',
    voiceNoteTranscript: '',
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
});

/** True when `needle` is `root` or sits somewhere beneath it. */
function contains(root: ReactTestInstance, needle: ReactTestInstance): boolean {
  if (root === needle) return true;
  return root.findAll((i) => i === needle).length > 0;
}

const ACTION_LABELS = [
  'Take photo',
  'Attach photo or image',
  'Attach any file',
  'Dictate into message',
  'Send message',
];

describe('Composer — two-row layout', () => {
  it('renders an input row and a separate actions row, in that order', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const inputRow = findHost(r.root, byTestId('composer-input-row'));
    const actionsRow = findHost(r.root, byTestId('composer-actions-row'));

    // Siblings, not nested: the actions row is NOT inside the input row.
    expect(contains(inputRow, actionsRow)).toBe(false);
    expect(contains(actionsRow, inputRow)).toBe(false);

    // The actions row is rendered AFTER the input row — i.e. below it in a
    // column-flow container.
    const rows = findAllHost(
      r.root,
      (i) =>
        i.props['testID'] === 'composer-input-row' || i.props['testID'] === 'composer-actions-row',
    );
    expect(rows.map((i) => i.props['testID'])).toEqual([
      'composer-input-row',
      'composer-actions-row',
    ]);
  });

  it('puts the text input on its own row with no action button beside it', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const inputRow = findHost(r.root, byTestId('composer-input-row'));
    const input = findHost(r.root, byType('TextInput'));

    expect(contains(inputRow, input)).toBe(true);
    for (const label of ACTION_LABELS) {
      const button = findHost(r.root, byLabel(label));
      expect(contains(inputRow, button)).toBe(false);
    }
  });

  it('puts every action button on the actions row', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const actionsRow = findHost(r.root, byTestId('composer-actions-row'));
    const input = findHost(r.root, byType('TextInput'));

    expect(contains(actionsRow, input)).toBe(false);
    for (const label of ACTION_LABELS) {
      const button = findHost(r.root, byLabel(label));
      expect(contains(actionsRow, button)).toBe(true);
    }
  });

  it('keeps Send at the RIGHT of the actions row, behind a flexible spacer', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const actionsRow = findHost(r.root, byTestId('composer-actions-row'));
    const send = findHost(r.root, byLabel('Send message'));
    const spacer = findHost(r.root, byTestId('composer-actions-spacer'));

    // The spacer grows, so everything after it is flush right.
    expect(spacer.props['style']).toMatchObject({ flex: 1 });

    // Order within the row: every other control, then the spacer, then send.
    const ordered = actionsRow.findAll(
      (i) =>
        typeof i.type === 'string' &&
        (i.props['testID'] === 'composer-actions-spacer' ||
          ACTION_LABELS.includes(i.props['accessibilityLabel'] as string)),
    );
    const names = ordered.map(
      (i) => (i.props['accessibilityLabel'] as string) ?? (i.props['testID'] as string),
    );
    expect(names).toEqual([
      'Take photo',
      'Attach photo or image',
      'Attach any file',
      'Dictate into message',
      'composer-actions-spacer',
      'Send message',
    ]);
    expect(contains(actionsRow, send)).toBe(true);
  });

  // The Android nav bar rule (never hide it; pad past the bottom inset exactly
  // ONCE): the chat-detail screen's window is not edge-to-edge, so nothing in
  // this app draws under the system bar and the composer must NOT add a bottom
  // inset of its own. Moving the buttons to the bottom row does not change
  // that — the composer's own padding is still the last thing before the
  // window edge.
  it('adds no safe-area bottom inset of its own', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const actionsRow = findHost(r.root, byTestId('composer-actions-row'));
    expect(actionsRow.props['style']).not.toHaveProperty('paddingBottom');
    expect(actionsRow.props['style']).not.toHaveProperty('marginBottom');
  });
});

// The input grows UPWARD as the message gets long (spec/15 § Composer). In a
// column-flow screen whose transcript list is `flex: 1`, that is exactly what
// a height-bounded multiline field does: the height it takes comes out of the
// list above it, so the composer's own bottom edge never moves.
//
// React Native does the growing natively, between `minHeight` and `maxHeight`,
// so those two props ARE the behaviour — there is no measuring code to test.
describe('Composer — the input grows with its content', () => {
  it('is a multiline field with no fixed height to pin it at one line', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findHost(r.root, byType('TextInput'));

    expect(input.props['multiline']).toBe(true);
    // A `height` would defeat the min/max bounds entirely and freeze the field.
    expect(input.props['style']).not.toHaveProperty('height');
    expect(input.props['style']).not.toHaveProperty('numberOfLines');
  });

  it('starts one line tall and grows to the cap, then scrolls inside', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findHost(r.root, byType('TextInput'));

    expect(input.props['style']).toMatchObject({
      minHeight: COMPOSER_MIN_HEIGHT,
      maxHeight: COMPOSER_MAX_HEIGHT,
    });
    // The cap has to be worth having: 120 stopped the field at about four
    // lines of 16px type, which is where Tom's messages were being hidden
    // ("need to be able to expand text box upwards if its long").
    expect(COMPOSER_MAX_HEIGHT).toBeGreaterThanOrEqual(200);
    // ...and it must still be a cap, so a long paste cannot take the screen.
    expect(COMPOSER_MAX_HEIGHT).toBeLessThanOrEqual(240);
    expect(COMPOSER_MIN_HEIGHT).toBeLessThan(COMPOSER_MAX_HEIGHT);
  });
});
