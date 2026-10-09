// Typing speed: one keystroke is one render of the composer, and it must not
// wake the route around it. The draft store write that each keystroke makes
// used to re-render the composer a second time (hook selector) and, on the
// new-chat route, the whole route (subscription to the drafts map).

import { Profiler } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

describe('Composer — typing renders', () => {
  beforeEach(() => {
    useComposerDraftStore.getState()._reset();
  });

  it('a keystroke commits once, even though it writes the draft store', () => {
    let commits = 0;
    render(
      <Profiler id="c" onRender={() => (commits += 1)}>
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onValueChange={(t) => useComposerDraftStore.getState().setDraft('c1', t)}
        />
      </Profiler>,
    );
    const box = screen.getByTestId('composer-input');
    fireEvent.change(box, { target: { value: 'a' } });
    const before = commits;
    fireEvent.change(box, { target: { value: 'ab' } });
    expect(commits - before).toBe(1);
    expect(useComposerDraftStore.getState().drafts.c1).toBe('ab');
  });
});
