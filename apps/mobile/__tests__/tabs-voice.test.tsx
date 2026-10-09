// Render coverage for the Voice tab (app/(tabs)/voice.tsx) — a trivial
// redirect that reuses chat-detail rendering for the Manager thread rather
// than having its own screen.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderRN, findHost, byType } from './testUtils/render';
import VoiceTab from '../app/(tabs)/voice';

describe('VoiceTab', () => {
  it('redirects to the Manager thread (/chats/thread_manager)', () => {
    const r = renderRN(<VoiceTab />);
    const redirect = findHost(r.root, byType('Redirect'));
    expect(redirect.props.href).toBe('/chats/thread_manager');
  });
});
