// Composer — the `?? 'disconnected'` / `?? 'Disconnected…'` defensive
// fallbacks on the daemon/link disabled-reason strings.
//
// These fallbacks are UNREACHABLE via any real conn/daemon combination:
// Composer only reads a null `disabledReason`/`linkReason` when `disabled`/
// `linkDown` is ALSO false (see src/lib/connection.ts's
// daemonControlDisabledReason — its only `return null` is the
// `conn === 'connected' && host === 'online'` case, which is exactly the
// case where `disabled`/`linkDown` are false too) — so in the real app the
// ternary branch that reads the fallback never fires. They exist purely as a
// belt-and-braces guard against `disabled`/`linkDown` and the reason function
// ever drifting out of sync.
//
// To exercise them for coverage without touching Composer.tsx, this file
// mocks '../src/lib/connection' to deliberately break that invariant —
// `disabled`/`linkDown` say "unavailable" while the reason function returns
// null — which is the only way to reach the fallback text.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findAllHost, byType, hasText, renderRN } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';

vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

vi.mock('../src/lib/connection', () => ({
  daemonControlsDisabled: () => true,
  daemonControlDisabledReason: () => null,
}));

import { Composer } from '../src/components/Composer';

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'offline',
    daemon: 'unknown',
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
  useUiStore.setState({ errors: [] });
});

describe('Composer — disabled-reason fallback text (defensive, normally unreachable)', () => {
  it('placeholder falls back to "Disconnected…" when linkReason resolves to null', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const input = findAllHost(r.root, byType('TextInput'))[0]!;
    expect(input.props['placeholder']).toBe('Disconnected…');
  });

  it('attach buttons\' label falls back to "disconnected" when disabledReason resolves to null', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    expect(hasText(r.root, 'Attach unavailable — disconnected')).toBe(false); // Text nodes don't carry a11y labels
    const attachButtons = findAllHost(r.root, byType('Pressable')).filter(
      (p) => p.props['accessibilityLabel'] === 'Attach unavailable — disconnected',
    );
    expect(attachButtons).toHaveLength(2);
  });

  it('the mic label falls back to "disconnected"', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const mic = findAllHost(r.root, byType('Pressable')).find(
      (p) => p.props['accessibilityLabel'] === 'Dictate unavailable — disconnected',
    );
    expect(mic).toBeTruthy();
  });

  it('the Send label never reads the fallback — send has no "unavailable" reason text, only "queued"', () => {
    // Unlike attach/mic, Send doesn't branch on `linkReason`/`disabledReason`
    // at all (Todoist 6hWrcpCQFqXGJpF6 — sending queues rather than being
    // named-unavailable), so this file's mocked-null reason has nothing to
    // fall back to here.
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    const send = findAllHost(r.root, byType('Pressable')).find(
      (p) => p.props['accessibilityLabel'] === 'Send message (queued until the agent reconnects)',
    );
    expect(send).toBeTruthy();
  });
});
