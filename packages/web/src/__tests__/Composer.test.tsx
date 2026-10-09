import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { clearHosts, reportAccount } from './presenceHelpers.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { composerMicFor } from '../lib/composerMic.js';
import { api } from '../api/rest.js';
import * as imageResizeModule from '../lib/imageResize.js';
import * as voiceRecorderModule from '../lib/voiceRecorder.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';
import type { startDictationPreview, DictationPreviewCallbacks } from '../lib/dictationPreview.js';

vi.mock('../lib/voiceController.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/voiceController.js')>();
  return { ...actual, startVoiceCall: vi.fn(async () => {}) };
});

// The real ImageAnnotator decodes via createImageBitmap + a real canvas, which
// jsdom can't back — it's exercised for real in ImageAnnotator.test.tsx and
// e2e/screenshot-markup.spec.ts. Here we only care that Composer wires the
// pencil button to it and applies whatever file it hands back.
vi.mock('../components/ImageAnnotator.js', () => ({
  ImageAnnotator: ({
    file,
    onDone,
    onCancel,
  }: {
    file: File;
    onDone: (f: File) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="mock-annotator">
      <span data-testid="mock-annotator-filename">{file.name}</span>
      <button
        type="button"
        data-testid="mock-annotator-done"
        onClick={() => onDone(new File(['x'], 'annotated.png', { type: 'image/png' }))}
      >
        done
      </button>
      <button type="button" data-testid="mock-annotator-cancel" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

describe('Composer', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    // Voice controls require an online host (audio can't be queued — spec/12).
    usePresenceStore.getState().setHostOnline('d1', true);
    // Default to a connected Claude — a missing credential now disables sending.
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    useUiStore.getState().clearToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Auto-grow overflow toggle (todo — "a scrollbar shows on the input; should
  // never show, should expand/contract"). jsdom can't lay out, so we stub the
  // layout getters to drive the resize effect's two branches. The real-browser
  // proof lives in e2e/composer-transcript-layout.spec.ts; these lock the branch
  // logic (under-cap = no scrollbar, over-cap = internal scroll).
  function stubLayout(el: HTMLElement, scrollHeight: number): void {
    // border delta of 2px (1px top + 1px bottom) so contentHeight = scrollHeight + 2.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 42 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 40 });
  }

  it('keeps overflow hidden and grows to fit while content is under the cap', () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    stubLayout(input, 80); // 80 + 2px border = 82px, well under the 200px cap
    fireEvent.change(input, { target: { value: 'a\nfew\nlines' } });
    expect(input.style.overflowY).toBe('hidden');
    expect(input.style.height).toBe('82px');
  });

  it('caps the height and reveals an internal scrollbar once content exceeds the cap', () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    stubLayout(input, 500); // 500 + 2 = 502px, far over the 200px cap
    fireEvent.change(input, { target: { value: 'lots\nand\nlots\nof\nlines' } });
    expect(input.style.overflowY).toBe('auto');
    expect(input.style.height).toBe('200px');
  });

  it('sends on form submit and clears the input', () => {
    const onSend = vi.fn();
    render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('sends on cmd+enter', () => {
    const onSend = vi.fn();
    render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('hi');
  });

  // spec/04 ## Message queueing — sending never interrupts a running turn.
  // 2026-09-29: every message Tom sent into a running turn killed it 1-2s
  // later, via ⌘↵'s send-and-promote or a second ↵ in the emptied composer
  // promoting the message just sent. Only Stop, Esc and a queued ↑ interrupt.
  describe('sending while a turn runs only queues', () => {
    function renderRunning(onSend = vi.fn(), onStop = vi.fn()) {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={onSend}
          onStartVoiceNote={() => {}}
          running
          onStop={onStop}
        />,
      );
      return { onSend, onStop, input: screen.getByTestId('composer-input') as HTMLTextAreaElement };
    }

    it('⌘↵ with text is a plain send — no promote rides along', () => {
      const { onSend, onStop, input } = renderRunning();
      fireEvent.change(input, { target: { value: 'jump the queue' } });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
      expect(onSend).toHaveBeenCalledWith('jump the queue');
      expect(onSend.mock.calls[0]).toHaveLength(1);
      expect(onStop).not.toHaveBeenCalled();
    });

    it('plain ↵ with text is a plain send', () => {
      const { onSend, input } = renderRunning();
      fireEvent.change(input, { target: { value: 'queue me' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledWith('queue me');
    });

    it('a double ↵ sends once and the second press does nothing', () => {
      const { onSend, onStop, input } = renderRunning();
      fireEvent.change(input, { target: { value: 'still slow' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onStop).not.toHaveBeenCalled();
    });

    it('⇧↵ still inserts a newline even with ⌘ held', () => {
      const { onSend, input } = renderRunning();
      fireEvent.change(input, { target: { value: 'line' } });
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true, shiftKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  // spec/04 ## Message queueing + Claude Code interrupt parity: while running, a
  // Stop control appears, sending still works (queues ahead), and Esc interrupts.
  it('shows a Stop button only while running, and Stop fires onStop', () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={false}
        onStop={onStop}
      />,
    );
    expect(screen.queryByTestId('stop-btn')).toBeNull();
    rerender(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByTestId('stop-btn'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  // Todo: "patch only show stop OR send, never both" — while a turn runs an
  // empty composer shows Stop; typing swaps it for Send (which queues).
  it('shows stop or send while running, never both', () => {
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={() => {}}
      />,
    );
    expect(screen.getByTestId('stop-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('send-btn')).toBeNull();
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'next' } });
    expect(screen.getByTestId('send-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('stop-btn')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('stop-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('send-btn')).toBeNull();
  });

  // Todo (Updates): "Focus the input after responding." When a turn finishes —
  // `running` flips true → false — the composer input takes focus so the user
  // can immediately type their next message without reaching for the mouse.
  it('focuses the input when a running turn finishes (running true → false)', () => {
    const { rerender } = render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={() => {}}
      />,
    );
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    // While running, the input is not force-focused — blur it to prove the
    // transition (not the mount) is what grabs focus.
    input.blur();
    expect(document.activeElement).not.toBe(input);

    rerender(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={false}
        onStop={() => {}}
      />,
    );
    expect(document.activeElement).toBe(input);
  });

  // Guard: the "focus after responding" effect must not steal focus on the
  // false → true transition (a turn STARTING), nor while offline.
  it('does not focus the input when a turn starts (running false → true)', () => {
    const { rerender } = render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={false}
        onStop={() => {}}
      />,
    );
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    input.blur();
    rerender(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={() => {}}
      />,
    );
    expect(document.activeElement).not.toBe(input);
  });

  it('Esc in the composer interrupts the running turn (parity with Claude Code)', () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={onSend}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={onStop}
      />,
    );
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('sending WHILE running is allowed (queues ahead — not blocked)', () => {
    const onSend = vi.fn();
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={onSend}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={() => {}}
      />,
    );
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'queue me' } });
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(onSend).toHaveBeenCalledWith('queue me');
  });

  // Regression (spec/07 ## Voice-input modes): the mic button's local
  // toggle-latch must not desync from the store. A toggle session committed by
  // the GLOBAL ⏎/Esc handler (AppShell) — not by clicking the mic again —
  // clears the store note but the composer never sees a mouseup. If the latch
  // stayed set, the NEXT tap would be swallowed (treated as "commit the open
  // toggle") and the overlay would never reopen — the mic appears dead.
  it('reopens a voice note on the next tap after a toggle session was ended externally', () => {
    const onStartVoiceNote = vi.fn((chatId: string, _gesture: 'ptt' | 'toggle') => {
      // Mirror the real controller: opening a note populates the store.
      useVoiceStore.getState().startNote(chatId, 'ptt');
    });
    render(
      <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={onStartVoiceNote} />,
    );
    const mic = screen.getByTestId('voice-note-btn');

    // First quick tap → toggle session opens.
    fireEvent.mouseDown(mic);
    fireEvent.mouseUp(mic);
    expect(onStartVoiceNote).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().note).not.toBeNull();

    // Global ⏎/Esc commits/cancels the note WITHOUT going through the mic.
    // Wrapped in act() so the store update flushes the latch-sync effect.
    act(() => {
      useVoiceStore.getState().endNote();
    });

    // Next tap must open a FRESH note (latch was reset by the store-sync effect).
    fireEvent.mouseDown(mic);
    fireEvent.mouseUp(mic);
    expect(onStartVoiceNote).toHaveBeenCalledTimes(2);
    expect(useVoiceStore.getState().note).not.toBeNull();
  });

  // spec/14 § Copy — no helper text: the placeholder is the empty field's
  // prompt, not a teaching surface. It used to trail the send convention
  // ("— Enter to send, Shift+Enter for a new line"); Tom asked for that back
  // out, so this locks the bare string against it creeping in again.
  it('shows a bare placeholder with no helper text', () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.placeholder).toBe('Type a message');
  });

  it('swaps the placeholder for connection state while offline', () => {
    // State, not instruction — the one permitted placeholder change.
    usePresenceStore.getState().setConnection('reconnecting');
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).placeholder).toBe(
      'Reconnecting…',
    );
  });

  it('keeps an existing chat typable AND sendable while offline — it queues (Todoist 6hWrcpCQFqXGJpF6)', () => {
    // The link being down must never eat what's half-typed, and (per the
    // widened ask) must not block sending either: it queues in-memory and
    // flushes on reconnect (spec/12 § Surface → server disconnect), same as
    // daemon-offline.
    const onSend = vi.fn();
    usePresenceStore.getState().setConnection('reconnecting');
    render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(input.value).toBe('hello');
    const send = screen.getByTestId('send-btn') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('blocks sending while offline for a brand-new, not-yet-spawned chat', () => {
    // spec/12 § Host-offline UX — spawning a new chat can't validate its
    // folder without a live link, so unlike an existing chat it's refused up
    // front rather than queued.
    const onSend = vi.fn();
    usePresenceStore.getState().setConnection('reconnecting');
    render(<Composer chatId="new" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'hello' } });
    const send = screen.getByTestId('send-btn') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('hello');
  });

  it('disables sending when Claude is disconnected, and says why', () => {
    // Distinct from daemon-offline, which deliberately KEEPS sending enabled
    // because those messages queue and deliver on reconnect. With no credential
    // the turn can never run, so accepting the message would be a lie — this is
    // the "new chat cannot work but doesn't say so" case.
    reportAccount('d1', false);
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.title).toMatch(/Claude isn’t connected/);
    expect((screen.getByTestId('send-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('attach-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps sending enabled while only the HOST is offline', () => {
    // Regression guard: the two states must not be conflated. Queued text is a
    // real feature (spec/12) and disabling it here would break it.
    usePresenceStore.getState().setHostOnline('d1', false);
    reportAccount('d1', true);
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('ignores ANOTHER host being logged out (the account-wide-report bug)', () => {
    // Three hosts report different credential states at once on the real rig.
    // With one account-wide slot, host-logged-out's report blocked sending in a
    // chat pinned to host-a, whose credential was fine (spec/10 § Backend
    // credentials — per host, per backend).
    reportAccount('host-a', true);
    reportAccount('host-logged-out', false);
    render(
      <Composer chatId="c1" daemonId="host-a" onSend={() => {}} onStartVoiceNote={() => {}} />,
    );
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('blocks sending in a chat on the host that IS logged out', () => {
    reportAccount('host-a', true);
    reportAccount('host-logged-out', false);
    render(
      <Composer
        chatId="c1"
        daemonId="host-logged-out"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
      />,
    );
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('does not pre-emptively disable before the host has reported', () => {
    clearHosts();
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  // Item 3 (desktop): the separate image + file buttons are collapsed into ONE
  // attach button that opens a single dialog accepting images AND any file.
  it('has a single attach button (no duplicate image button) on web', () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    expect(screen.getByTestId('attach-btn')).toBeInTheDocument();
    // The old image-only button + its input are gone.
    expect(screen.queryByTestId('attach-image-btn')).toBeNull();
    expect(screen.queryByTestId('composer-image-input')).toBeNull();
    // The single file input accepts anything (no image-only `accept`).
    const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
    expect(fileInput.getAttribute('accept')).toBeNull();
  });

  // Item 2: every action button shares ONE icon size (18) so they read as a
  // matched set on a single row.
  it('renders every action icon at one uniform size', () => {
    render(
      <Composer
        chatId="c1"
        daemonId="d1"
        onSend={() => {}}
        onStartVoiceNote={() => {}}
        running={true}
        onStop={() => {}}
      />,
    );
    const check = (id: string): void => {
      const svg = screen.getByTestId(id).querySelector('svg');
      expect(svg, `${id} icon`).not.toBeNull();
      expect(svg?.getAttribute('width'), `${id} icon width`).toBe('18');
    };
    for (const id of ['attach-btn', 'voice-note-btn', 'stop-btn']) check(id);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hi' } });
    check('send-btn');
  });

  // C2 (desktop review 2026-07-14): the editor/diff (pencil) entry-point was
  // confusing on the composer row — it read as a message tool but opened the
  // Monaco diff rail. It moved to the chat header ⋯ menu, so the composer must
  // NOT render it any more.
  it('does not render the editor button on the composer row (C2)', () => {
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    expect(screen.queryByTestId('editor-btn')).toBeNull();
  });

  // C3 (desktop review 2026-07-14): the screen-share/screenshot button was
  // removed entirely — it was repeatedly unclear and error-prone. Paste-image
  // (⌘V) and the attach paperclip remain the way to add visuals.
  it('does not render the screenshot button; attach remains (C3)', () => {
    // Even with getDisplayMedia available, the button is gone for good.
    const getDisplayMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } } as never);
    render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
    expect(screen.queryByTestId('screenshot-btn')).toBeNull();
    // Attach paperclip still there.
    expect(screen.getByTestId('attach-btn')).toBeInTheDocument();
  });

  // Item 4: typing `/` at the start opens a skill autocomplete for the folder;
  // it filters as you type and completes on ↓/Enter and on click.
  describe('skill autocomplete', () => {
    beforeEach(() => {
      // Completing a skill now persists it as the folder's default (spec/14 §
      // Skill autocomplete), so tests that assert the natural order start clean.
      localStorage.clear();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ skills: ['plant', 'plan-travel', 'deploy'] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
    });
    // Several of these spy on `api.skills`; restore centrally so a failing
    // assertion can't leak the spy into the next test.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('opens on `/`, filters, and completes with keyboard', async () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/pl' } });
      // Both `pl`-prefixed skills show, and they come FIRST: `deploy` matches
      // only loosely (its p and l are not adjacent), so it sorts below them.
      await waitFor(() => {
        expect(screen.getByTestId('composer-skill-option-plant')).toBeInTheDocument();
      });
      expect(screen.getByTestId('composer-skill-option-plan-travel')).toBeInTheDocument();
      expect(
        screen
          .getAllByRole('option')
          .map((el) => el.getAttribute('data-testid'))
          .filter((id) => id?.startsWith('composer-skill-option-')),
      ).toEqual([
        'composer-skill-option-plant',
        'composer-skill-option-plan-travel',
        'composer-skill-option-deploy',
      ]);
      // ↓ moves to the second option, Enter completes it with a trailing space.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(input.value).toBe('/plan-travel ');
      // Menu closed after completion.
      expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    });

    // spec/14 § Skill autocomplete — Tab also completes the highlighted skill
    // (parity with an editor's autocomplete), and must not move focus out.
    it('completes the highlighted skill on Tab', async () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/pl' } });
      await screen.findByTestId('composer-skill-option-plant');
      // Tab on the first (highlighted) option completes it with a trailing space.
      const ev = fireEvent.keyDown(input, { key: 'Tab' });
      // preventDefault was called so focus stays in the composer (return false).
      expect(ev).toBe(false);
      expect(input.value).toBe('/plant ');
      expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    });

    it('completes on click', async () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/plant' } });
      const opt = await screen.findByTestId('composer-skill-option-plant');
      fireEvent.mouseDown(opt);
      expect(input.value).toBe('/plant ');
    });

    it('Enter does NOT send while the skill menu is open', async () => {
      const onSend = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={onSend}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/plant' } });
      await screen.findByTestId('composer-skill-option-plant');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('ArrowDown/ArrowUp wrap around the option list', async () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/plan' } });
      await screen.findByTestId('composer-skill-option-plant');
      // Two matches: plant, plan-travel. ArrowUp from index 0 wraps to the last.
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(input.value).toBe('/plan-travel ');
    });

    it('Escape dismisses the menu without clearing the typed text', async () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/plant' } });
      await screen.findByTestId('composer-skill-option-plant');
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
      expect(input.value).toBe('/plant');
      // Editing again re-opens it (slashDismissed resets on change).
      fireEvent.change(input, { target: { value: '/plan' } });
      await screen.findByTestId('composer-skill-menu');
    });

    it('shows a skills-fetch error in the dropdown instead of a silently empty list', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network down');
        }),
      );
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/x' } });
      await waitFor(() => {
        expect(screen.getByTestId('composer-skill-error')).toHaveTextContent('network down');
      });
    });

    it('does not fetch skills when no folder is given, or the query is unchanged for the same folder', async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(JSON.stringify({ skills: ['plant'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/pl' } });
      // No folder prop → the skills-fetch effect's guard short-circuits.
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // spec/14 § Skill autocomplete — the list is re-read on every open, so a
    // skill added/renamed/removed on the host shows up on the next `/` rather
    // than requiring a reload.
    it('re-fetches on each re-open, so a list that changed on the host shows up', async () => {
      const apiSkillsSpy = vi
        .spyOn(api, 'skills')
        .mockResolvedValueOnce({ skills: ['plant'] })
        .mockResolvedValueOnce({ skills: ['plant', 'brand-new-skill'] });
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByTestId('composer-skill-option-plant');
      expect(screen.queryByTestId('composer-skill-option-brand-new-skill')).toBeNull();
      // Close the menu (the value stops matching `/token`), then re-open it.
      fireEvent.change(input, { target: { value: '' } });
      expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
      fireEvent.change(input, { target: { value: '/' } });
      await waitFor(() => {
        expect(screen.getByTestId('composer-skill-option-brand-new-skill')).toBeInTheDocument();
      });
      expect(apiSkillsSpy).toHaveBeenCalledTimes(2);
      apiSkillsSpy.mockRestore();
    });

    it('keeps the already-loaded list on screen while a re-open re-fetches', async () => {
      let resolveSecond!: (v: { skills: string[] }) => void;
      const apiSkillsSpy = vi
        .spyOn(api, 'skills')
        .mockResolvedValueOnce({ skills: ['plant'] })
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              resolveSecond = r;
            }),
        );
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByTestId('composer-skill-option-plant');
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.change(input, { target: { value: '/' } });
      // Second fetch is still in flight: the menu is open on the old list, with
      // no flash of "No skills in this project" and no closed-menu gap.
      await waitFor(() => expect(apiSkillsSpy).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('composer-skill-menu')).toBeInTheDocument();
      expect(screen.getByTestId('composer-skill-option-plant')).toBeInTheDocument();
      expect(screen.queryByTestId('composer-skill-empty')).toBeNull();
      resolveSecond({ skills: ['plant', 'deploy'] });
      await waitFor(() => {
        expect(screen.getByTestId('composer-skill-option-deploy')).toBeInTheDocument();
      });
      apiSkillsSpy.mockRestore();
    });

    it('typing further within a single open does not re-fetch', async () => {
      const apiSkillsSpy = vi
        .spyOn(api, 'skills')
        .mockResolvedValue({ skills: ['plant', 'plan-travel', 'deploy'] });
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByTestId('composer-skill-option-plant');
      expect(apiSkillsSpy).toHaveBeenCalledTimes(1);
      fireEvent.change(input, { target: { value: '/p' } });
      fireEvent.change(input, { target: { value: '/pl' } });
      fireEvent.change(input, { target: { value: '/pla' } });
      await new Promise((r) => setTimeout(r, 0));
      expect(apiSkillsSpy).toHaveBeenCalledTimes(1);
      apiSkillsSpy.mockRestore();
    });

    it('a fetch that resolves after the folder changed again is ignored (stale-response guard)', async () => {
      let resolveFirst!: (v: { skills: string[] }) => void;
      const apiSkillsSpy = vi.spyOn(api, 'skills').mockImplementation((folder: string) => {
        if (folder === '/proj-a') {
          return new Promise((r) => {
            resolveFirst = r;
          });
        }
        return Promise.resolve({ skills: ['b-skill'] });
      });
      const { rerender } = render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj-a"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      // A bare `/` matches every skill (empty query prefix-matches everything).
      fireEvent.change(input, { target: { value: '/' } });
      await waitFor(() => expect(apiSkillsSpy).toHaveBeenCalledWith('/proj-a', 'd1'));
      // Folder changes before the first fetch resolves — cleanup sets live=false.
      rerender(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj-b"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId('composer-skill-option-b-skill')).toBeInTheDocument();
      });
      // The stale first response now resolves — must not clobber the fresh list.
      resolveFirst({ skills: ['a-skill'] });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByTestId('composer-skill-option-b-skill')).toBeInTheDocument();
      expect(screen.queryByTestId('composer-skill-option-a-skill')).toBeNull();
      apiSkillsSpy.mockRestore();
    });

    it('a skills response with no `skills` field says so rather than rendering nothing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/x' } });
      await new Promise((r) => setTimeout(r, 0));
      // An empty result is a STATE the user is shown, not silence (Tom,
      // `patch/todo.md` — "typing / in a folder with no skills shows nothing at
      // all"). Rendering nothing made "this project has no skills" and "the
      // feature is broken" indistinguishable — the same trap the fetch-error
      // branch already avoids.
      expect(screen.getByTestId('composer-skill-menu')).toBeInTheDocument();
      expect(screen.getByTestId('composer-skill-empty')).toHaveTextContent(
        'No skills in this project',
      );
    });

    it('Enter still SENDS when the menu is open on an empty result', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ skills: ['plant'] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      const onSend = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={onSend}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      // `/zzz` matches no skill, so the menu shows "No matching skill".
      fireEvent.change(input, { target: { value: '/zzz' } });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByTestId('composer-skill-empty')).toHaveTextContent('No matching skill');
      // With nothing to complete, Enter must fall through to send rather than
      // being swallowed by the menu's key handling.
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledTimes(1);
    });
  });

  // spec/14 § Skill autocomplete — "the list defaults to the last-used skill":
  // completing a skill remembers it per folder, and the next `/` sorts it to
  // the top (so it is the highlighted default that Enter completes).
  describe('skill autocomplete — defaults to the last used skill', () => {
    beforeEach(() => {
      localStorage.removeItem('patch.skill.lastUsed:/proj');
      localStorage.removeItem('patch.skill.lastUsed:/other');
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ skills: ['plant', 'plan-travel', 'deploy'] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
    });

    it('sorts the last-completed skill first and completes it on Enter', async () => {
      const first = render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/deploy' } });
      fireEvent.mouseDown(await screen.findByTestId('composer-skill-option-deploy'));
      expect(input.value).toBe('/deploy ');
      first.unmount();

      // A fresh composer on the same folder: `/` now lists `deploy` first and
      // Enter (the highlight starts at index 0) completes it.
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const next = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(next, { target: { value: '/' } });
      await screen.findByTestId('composer-skill-option-deploy');
      const options = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => id?.startsWith('composer-skill-option-'));
      // The last-used skill leads, AHEAD of the built-in /clear: spec/14 says
      // `/` + Enter re-runs it. When built-ins sorted first, Enter cleared the
      // transcript instead.
      expect(options).toEqual([
        'composer-skill-option-deploy',
        'composer-skill-option-clear',
        'composer-skill-option-goal',
        'composer-skill-option-plant',
        'composer-skill-option-plan-travel',
      ]);
      fireEvent.keyDown(next, { key: 'Enter' });
      expect(next.value).toBe('/deploy ');
    });

    it('remembers per folder — another folder keeps its natural order', async () => {
      const first = render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/deploy' } });
      fireEvent.mouseDown(await screen.findByTestId('composer-skill-option-deploy'));
      first.unmount();

      render(
        <Composer
          chatId="c2"
          daemonId="d1"
          folder="/other"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const next = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(next, { target: { value: '/' } });
      await screen.findByTestId('composer-skill-option-plant');
      const options = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => id?.startsWith('composer-skill-option-'));
      // Nothing to hoist in this folder, so the built-in leads and the skills
      // keep the order they were fetched in — `deploy` is NOT pulled to the top
      // just because it was used in /proj.
      expect(options).toEqual([
        'composer-skill-option-clear',
        'composer-skill-option-goal',
        'composer-skill-option-plant',
        'composer-skill-option-plan-travel',
        'composer-skill-option-deploy',
      ]);
    });

    it('does not reorder when the last-used skill is filtered out by the typed query', async () => {
      localStorage.setItem('patch.skill.lastUsed:/proj', 'deploy');
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          folder="/proj"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      // `plan` excludes `deploy` outright (no `a` in it), so the last-used
      // skill really is filtered out — which is what this is about.
      fireEvent.change(input, { target: { value: '/plan' } });
      await screen.findByTestId('composer-skill-option-plant');
      const options = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('data-testid'))
        .filter((id) => id?.startsWith('composer-skill-option-'));
      expect(options).toEqual(['composer-skill-option-plant', 'composer-skill-option-plan-travel']);
    });

    it('does not persist anything when the composer has no folder', async () => {
      const apiSkillsSpy = vi.spyOn(api, 'skills');
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: '/' } });
      await new Promise((r) => setTimeout(r, 0));
      // No folder → no fetch, no menu, and nothing written for the '' folder.
      expect(apiSkillsSpy).not.toHaveBeenCalled();
      expect(localStorage.getItem('patch.skill.lastUsed:')).toBeNull();
      apiSkillsSpy.mockRestore();
    });
  });

  describe('attachments', () => {
    let createObjectURLSpy: ReturnType<typeof vi.fn>;
    let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      // jsdom doesn't implement these — stub them so makePending/removeAttachment
      // (which call URL.createObjectURL/revokeObjectURL for image previews) work.
      createObjectURLSpy = vi.fn(() => 'blob:mock-url');
      revokeObjectURLSpy = vi.fn();
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: createObjectURLSpy,
        revokeObjectURL: revokeObjectURLSpy,
      });
      // downscaleImageFile decodes via a real canvas/Image, which jsdom can't
      // back (no createImageBitmap, no auto-firing Image onload) — it's unit-
      // tested on its own in imageResize.test.ts. Default it to a fast
      // passthrough here; the "non-image" test asserts it's NOT called, and any
      // test that cares about the resize call itself re-spies explicitly.
      vi.spyOn(imageResizeModule, 'downscaleImageFile').mockImplementation(async (f) => f);
    });
    afterEach(() => {
      // Unmount (which fires the attachments-cleanup effect, still needing the
      // stubbed URL.revokeObjectURL) BEFORE un-stubbing globals.
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('attaching an image via the file input shows a thumbnail; a non-image shows a file icon', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const img = new File(['bytes'], 'photo.png', { type: 'image/png' });
      const doc = new File(['bytes'], 'notes.txt', { type: 'text/plain' });
      fireEvent.change(fileInput, { target: { files: [img, doc] } });
      const chips = screen.getAllByTestId('composer-attachment');
      expect(chips).toHaveLength(2);
      expect(chips[0]!.querySelector('img')).toBeTruthy();
      expect(chips[0]!.querySelector('.att-name')?.textContent).toBe('photo.png');
      expect(chips[1]!.querySelector('img')).toBeNull();
      expect(chips[1]!.querySelector('.att-name')?.textContent).toBe('notes.txt');
      // Re-selecting resets the input value so the same file can be re-picked.
      expect(fileInput.value).toBe('');
    });

    it('an unnamed image falls back to "image" as the display name', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const img = new File(['bytes'], '', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [img] } });
      expect(
        screen.getByTestId('composer-attachment').querySelector('.att-name')?.textContent,
      ).toBe('image');
    });

    it('an unnamed non-image file falls back to "file" as the display name', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const doc = new File(['bytes'], '', { type: 'application/octet-stream' });
      fireEvent.change(fileInput, { target: { files: [doc] } });
      expect(
        screen.getByTestId('composer-attachment').querySelector('.att-name')?.textContent,
      ).toBe('file');
    });

    it('the attach button opens the hidden file picker', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
      fireEvent.click(screen.getByTestId('attach-btn'));
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('selecting zero files (cancelled dialog) does not add an attachment chip', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
      fireEvent.change(fileInput, { target: { files: [] } });
      expect(screen.queryByTestId('composer-attachments')).toBeNull();
    });

    it('remove (×) drops the attachment and revokes its preview URL', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const fileInput = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const img = new File(['bytes'], 'photo.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [img] } });
      fireEvent.click(screen.getByTestId('composer-attachment-remove'));
      expect(screen.queryByTestId('composer-attachments')).toBeNull();
      expect(revokeObjectURLSpy).toHaveBeenCalled();
    });

    it('pasting a clipboard image attaches it and prevents the default paste', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      const file = new File(['bytes'], 'clip.png', { type: 'image/png' });
      const item = { kind: 'file', type: 'image/png', getAsFile: () => file };
      const evt = fireEvent.paste(input, {
        clipboardData: { items: [item] },
      });
      expect(evt).toBe(false); // preventDefault called → event "cancelled"
      expect(screen.getByTestId('composer-attachment')).toBeInTheDocument();
    });

    it('pasting non-image clipboard content is a no-op (text paste flows through normally)', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      const item = { kind: 'string', type: 'text/plain', getAsFile: () => null };
      const evt = fireEvent.paste(input, { clipboardData: { items: [item] } });
      expect(evt).toBe(true); // not prevented
      expect(screen.queryByTestId('composer-attachments')).toBeNull();
    });

    it('pasting a long block of text attaches it as a document instead of filling the input', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      const long = 'line of pasted text\n'.repeat(600);
      const evt = fireEvent.paste(input, {
        clipboardData: { items: [], getData: (t: string) => (t === 'text/plain' ? long : '') },
      });
      expect(evt).toBe(false);
      expect(input.value).toBe('');
      expect(screen.getByTestId('composer-attachment')).toBeInTheDocument();
      expect(screen.getByText('Pasted – line of pasted text line of.md')).toBeInTheDocument();
    });

    it('a 5,000-character paste (long dictation) stays in the input', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      const evt = fireEvent.paste(input, {
        clipboardData: { items: [], getData: () => 'word '.repeat(1000) },
      });
      expect(evt).toBe(true);
      expect(screen.queryByTestId('composer-attachments')).toBeNull();
    });

    it('pasting a short block of text is left to the input', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      const evt = fireEvent.paste(input, {
        clipboardData: { items: [], getData: () => 'a short note' },
      });
      expect(evt).toBe(true);
      expect(screen.queryByTestId('composer-attachments')).toBeNull();
    });

    it('pasting with no clipboardData.items at all does not throw', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      expect(() => fireEvent.paste(input, { clipboardData: {} })).not.toThrow();
    });

    describe('drag-and-drop', () => {
      it('dragging a file over shows the drop hint; dragleave hides it', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');
        expect(screen.queryByTestId('composer-drop-hint')).toBeNull();
        fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } });
        expect(screen.getByTestId('composer-drop-hint')).toHaveTextContent('Drop to attach');
        fireEvent.dragLeave(composer, { dataTransfer: { types: ['Files'] } });
        expect(screen.queryByTestId('composer-drop-hint')).toBeNull();
      });

      it('a dragenter/dragleave on a nested child does not flicker the hint off (depth counter)', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');
        fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } }); // enter composer
        fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } }); // enter a child element
        fireEvent.dragLeave(composer, { dataTransfer: { types: ['Files'] } }); // leave the child, back into composer
        expect(screen.getByTestId('composer-drop-hint')).toBeInTheDocument();
        fireEvent.dragLeave(composer, { dataTransfer: { types: ['Files'] } }); // leave the composer itself
        expect(screen.queryByTestId('composer-drop-hint')).toBeNull();
      });

      it('a drag carrying no Files (e.g. a text selection) is ignored — no hint, no preventDefault', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');
        const evt = fireEvent.dragEnter(composer, { dataTransfer: { types: ['text/plain'] } });
        expect(evt).toBe(true); // not prevented
        expect(screen.queryByTestId('composer-drop-hint')).toBeNull();
      });

      it('dropping plain files (no directory entries) attaches them, same as the file picker', async () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');
        const file = new File(['bytes'], 'report.pdf', { type: 'application/pdf' });
        fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } });
        const evt = fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [file] } });
        expect(evt).toBe(false); // preventDefault called
        await waitFor(() => expect(screen.getByTestId('composer-attachment')).toBeInTheDocument());
        expect(
          screen.getByTestId('composer-attachment').querySelector('.att-name')?.textContent,
        ).toBe('report.pdf');
        // The overlay clears the instant the drop lands, not just once the (async) files resolve.
        expect(screen.queryByTestId('composer-drop-hint')).toBeNull();
      });

      it('dropping a .zip attaches it as a single file, unexpanded', async () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');
        const zip = new File(['bytes'], 'archive.zip', { type: 'application/zip' });
        fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [zip] } });
        await waitFor(() => expect(screen.getByTestId('composer-attachment')).toBeInTheDocument());
        const chips = screen.getAllByTestId('composer-attachment');
        expect(chips).toHaveLength(1);
        expect(chips[0]!.querySelector('.att-name')?.textContent).toBe('archive.zip');
        expect(chips[0]!.querySelector('img')).toBeNull(); // file chip, not an image thumbnail
      });

      it('dropping a folder walks it recursively via webkitGetAsEntry, naming each file with its relative path', async () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');

        // Minimal fakes for the DOM FileSystemEntry API a real drop would hand
        // back — jsdom implements none of it, so the walk is exercised against
        // hand-built entries mirroring the readEntries()-until-empty contract.
        const readme = new File(['# hi'], 'README.md', { type: 'text/markdown' });
        const nested = new File(['x'], 'notes.txt', { type: 'text/plain' });
        const fileEntry = (file: File) => ({
          isFile: true,
          isDirectory: false,
          name: file.name,
          file: (cb: (f: File) => void) => cb(file),
        });
        const subDirEntry = {
          isFile: false,
          isDirectory: true,
          name: 'sub',
          createReader: () => {
            let done = false;
            return {
              readEntries: (cb: (entries: unknown[]) => void) => {
                if (done) return cb([]);
                done = true;
                cb([fileEntry(nested)]);
              },
            };
          },
        };
        const topDirEntry = {
          isFile: false,
          isDirectory: true,
          name: 'my-folder',
          createReader: () => {
            let done = false;
            return {
              readEntries: (cb: (entries: unknown[]) => void) => {
                if (done) return cb([]);
                done = true;
                cb([fileEntry(readme), subDirEntry]);
              },
            };
          },
        };
        const item = { kind: 'file', webkitGetAsEntry: () => topDirEntry };

        fireEvent.drop(composer, { dataTransfer: { types: ['Files'], items: [item], files: [] } });
        await waitFor(() => expect(screen.getAllByTestId('composer-attachment')).toHaveLength(2));
        const names = screen
          .getAllByTestId('composer-attachment')
          .map((c) => c.querySelector('.att-name')?.textContent)
          .sort();
        expect(names).toEqual(['my-folder/README.md', 'my-folder/sub/notes.txt']);
      });

      it('dropping while Claude is disconnected shows the blocked hint and does not attach', async () => {
        reportAccount('d1', false);
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        const composer = screen.getByTestId('composer');
        fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } });
        expect(screen.getByTestId('composer-drop-hint')).toHaveTextContent(
          'Can’t attach right now',
        );
        const file = new File(['bytes'], 'report.pdf', { type: 'application/pdf' });
        fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [file] } });
        // Give any (unwanted) async attach path a turn to run before asserting absence.
        await Promise.resolve();
        expect(screen.queryByTestId('composer-attachment')).toBeNull();
      });
    });

    // spec/15 § Composer → Attachments — the composer hands the files over at
    // once and clears; uploading them is the caller's (lib/sendQueue.ts), so
    // the message can be in the stream, pending, while they upload.
    it('sends text + attachments together at once: onSend gets the files and the chatId, nothing is uploaded here', () => {
      const uploadSpy = vi.spyOn(api, 'uploadAttachment');
      const onSend = vi.fn();
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const file = new File(['bytes'], 'photo.png', { type: 'image/png' });
      fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } });
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'see this' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(onSend).toHaveBeenCalledWith(
        'see this',
        [
          expect.objectContaining({
            file,
            name: 'photo.png',
            kind: 'image',
            previewUrl: expect.any(String),
          }),
        ],
        'c1',
      );
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId('composer-attachments')).toBeNull();
      expect(input.value).toBe('');
      // The preview now belongs to the message in the stream — not revoked.
      expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    });

    it('a false return from onSend puts the text and the files back', async () => {
      const onSend = vi.fn(async () => false);
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [new File(['b'], 'x.png', { type: 'image/png' })] },
      });
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'again' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() => expect(input.value).toBe('again'));
      expect(screen.getByTestId('composer-attachment')).toBeInTheDocument();
    });

    it('resolveChatId creates the real chat first, and the files go to the resolved id', async () => {
      const resolveChatId = vi.fn(async () => 'resolved-chat-id');
      const onSend = vi.fn();
      render(
        <Composer
          chatId="new"
          daemonId="d1"
          onSend={onSend}
          onStartVoiceNote={() => {}}
          resolveChatId={resolveChatId}
        />,
      );
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [new File(['b'], 'x.png', { type: 'image/png' })] },
      });
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() => expect(onSend).toHaveBeenCalled());
      expect(resolveChatId).toHaveBeenCalled();
      expect(onSend).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        'resolved-chat-id',
      );
    });

    it('resolveChatId returning null aborts the send and keeps text + attachments', async () => {
      const resolveChatId = vi.fn(async () => null);
      const onSend = vi.fn();
      render(
        <Composer
          chatId="new"
          daemonId="d1"
          onSend={onSend}
          onStartVoiceNote={() => {}}
          resolveChatId={resolveChatId}
        />,
      );
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'keep me' } });
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [new File(['b'], 'x.png', { type: 'image/png' })] },
      });
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() => expect(resolveChatId).toHaveBeenCalled());
      expect(onSend).not.toHaveBeenCalled();
      await waitFor(() =>
        expect((screen.getByTestId('attach-btn') as HTMLButtonElement).disabled).toBe(false),
      );
      expect(input.value).toBe('keep me');
      expect(screen.getByTestId('composer-attachment')).toBeInTheDocument();
    });

    it('while the new chat is being created the chips read as busy and attach is disabled', async () => {
      let resolve!: (id: string) => void;
      const resolveChatId = vi.fn(() => new Promise<string>((r) => (resolve = r)));
      render(
        <Composer
          chatId="new"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          resolveChatId={resolveChatId}
        />,
      );
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [new File(['b'], 'x.png', { type: 'image/png' })] },
      });
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('composer-attachment').className).toContain('uploading');
      });
      expect((screen.getByTestId('attach-btn') as HTMLButtonElement).disabled).toBe(true);
      await act(async () => resolve('c-made'));
      await waitFor(() => expect(screen.queryByTestId('composer-attachment')).toBeNull());
    });

    it('unmount keeps the chat s attachments (and their previews) for when you return', () => {
      const { unmount } = render(
        <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
      );
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [new File(['b'], 'x.png', { type: 'image/png' })] },
      });
      unmount();
      expect(revokeObjectURLSpy).not.toHaveBeenCalled();
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);
    });

    describe('markup', () => {
      it('shows a markup button on an image thumbnail but not on a non-image', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        fireEvent.change(screen.getByTestId('composer-file-input'), {
          target: {
            files: [
              new File(['b'], 'photo.png', { type: 'image/png' }),
              new File(['b'], 'notes.txt', { type: 'text/plain' }),
            ],
          },
        });
        const chips = screen.getAllByTestId('composer-attachment');
        expect(chips[0]!.querySelector('[data-testid="composer-attachment-markup"]')).toBeTruthy();
        expect(chips[1]!.querySelector('[data-testid="composer-attachment-markup"]')).toBeNull();
      });

      it('opens the annotator on the clicked attachment', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        fireEvent.change(screen.getByTestId('composer-file-input'), {
          target: { files: [new File(['b'], 'photo.png', { type: 'image/png' })] },
        });
        fireEvent.click(screen.getByTestId('composer-attachment-markup'));
        expect(screen.getByTestId('mock-annotator-filename').textContent).toBe('photo.png');
      });

      it('cancelling leaves the attachment unchanged', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        fireEvent.change(screen.getByTestId('composer-file-input'), {
          target: { files: [new File(['b'], 'photo.png', { type: 'image/png' })] },
        });
        fireEvent.click(screen.getByTestId('composer-attachment-markup'));
        fireEvent.click(screen.getByTestId('mock-annotator-cancel'));
        expect(screen.queryByTestId('mock-annotator')).toBeNull();
        expect(
          screen.getByTestId('composer-attachment').querySelector('.att-name')?.textContent,
        ).toBe('photo.png');
      });

      it('done replaces the attachment file/name and revokes the old preview URL', () => {
        render(
          <Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
        );
        fireEvent.change(screen.getByTestId('composer-file-input'), {
          target: { files: [new File(['b'], 'photo.png', { type: 'image/png' })] },
        });
        fireEvent.click(screen.getByTestId('composer-attachment-markup'));
        fireEvent.click(screen.getByTestId('mock-annotator-done'));
        expect(screen.queryByTestId('mock-annotator')).toBeNull();
        expect(
          screen.getByTestId('composer-attachment').querySelector('.att-name')?.textContent,
        ).toBe('annotated.png');
        expect(revokeObjectURLSpy).toHaveBeenCalled();
        // Still exactly one chip — the annotated file replaced the original in place.
        expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);
      });
    });
  });

  describe('misc composer behaviour', () => {
    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('Shift+Enter inserts a newline instead of sending', () => {
      const onSend = vi.fn();
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'line one' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('Enter during IME composition does not send', () => {
      const onSend = vi.fn();
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'こんにちは' } });
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('submitting with empty text and no attachments is a no-op', () => {
      const onSend = vi.fn();
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Enter with empty text and no attachments is also a no-op (bypasses the disabled send button)', () => {
      const onSend = vi.fn();
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Enter while the new chat is being created is a no-op (handleSubmit re-entrancy guard)', async () => {
      let resolve!: (id: string) => void;
      const resolveChatId = vi.fn(() => new Promise<string>((r) => (resolve = r)));
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:x'),
        revokeObjectURL: vi.fn(),
      });
      const onSend = vi.fn();
      render(
        <Composer
          chatId="new"
          daemonId="d1"
          onSend={onSend}
          onStartVoiceNote={() => {}}
          resolveChatId={resolveChatId}
        />,
      );
      fireEvent.change(screen.getByTestId('composer-file-input'), {
        target: { files: [new File(['b'], 'x.png', { type: 'image/png' })] },
      });
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'first' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(screen.getByTestId('composer-attachment').className).toContain('uploading');
      });
      // A second Enter while the chat is being created reaches handleSubmit's
      // own guard (the textarea is not disabled by it).
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(resolveChatId).toHaveBeenCalledTimes(1);
      await act(async () => resolve('c-made'));
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    });

    it('a synchronous false return from onSend restores the typed text', () => {
      const onSend = vi.fn(() => false);
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'retry me' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(input.value).toBe('retry me');
    });

    it('a Promise<false> return from onSend restores the typed text asynchronously', async () => {
      const onSend = vi.fn(async () => false);
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'retry me too' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(input.value).toBe(''); // cleared optimistically
      await waitFor(() => expect(input.value).toBe('retry me too'));
    });

    it('a Promise<false> return does NOT clobber text the user already retyped while it was in flight', async () => {
      let resolveSend!: (v: boolean) => void;
      const onSend = vi.fn(() => new Promise<boolean>((r) => (resolveSend = r)));
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'first attempt' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(input.value).toBe(''); // cleared optimistically
      // The user starts typing something new WHILE the send is still in flight.
      fireEvent.change(input, { target: { value: 'already typing the next thing' } });
      resolveSend(false);
      await new Promise((r) => setTimeout(r, 0));
      // Must NOT overwrite what the user is now typing with the failed 'first attempt'.
      expect(input.value).toBe('already typing the next thing');
    });

    it('a Promise<true> (success) leaves the input cleared', async () => {
      const onSend = vi.fn(async () => true);
      render(<Composer chatId="c1" daemonId="d1" onSend={onSend} onStartVoiceNote={() => {}} />);
      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'ok' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() => expect(onSend).toHaveBeenCalled());
      expect(input.value).toBe('');
    });

    it('the voice-note button title reflects daemon-offline unavailability vs the normal hint', () => {
      usePresenceStore.getState().setHostOnline('d1', false);
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      expect(screen.getByTestId('voice-note-btn').getAttribute('title')).toContain('unavailable');
      usePresenceStore.getState().setHostOnline('d1', true);
    });

    it('mic mousedown/up is a no-op while voice is disabled', () => {
      usePresenceStore.getState().setHostOnline('d1', false);
      const onStartVoiceNote = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={onStartVoiceNote}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      expect(onStartVoiceNote).not.toHaveBeenCalled();
      usePresenceStore.getState().setHostOnline('d1', true);
    });

    it('mic mouseUp without a preceding mousedown is a no-op', () => {
      const onStartVoiceNote = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={onStartVoiceNote}
        />,
      );
      expect(() => fireEvent.mouseUp(screen.getByTestId('voice-note-btn'))).not.toThrow();
      expect(onStartVoiceNote).not.toHaveBeenCalled();
    });

    it('mic mouseLeave while holding commits the note (release-sends via leave)', () => {
      const onStartVoiceNote = vi.fn((chatId: string) => {
        useVoiceStore.getState().startNote(chatId, 'ptt');
      });
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={onStartVoiceNote}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      expect(useVoiceStore.getState().note).not.toBeNull();
      fireEvent.mouseLeave(mic);
      // mouseLeave re-invokes onMicUp which, for a fresh press (no real hold
      // duration elapsed), promotes to a toggle session rather than sending.
      expect(
        useVoiceStore.getState().note?.gesture === 'toggle' ||
          useVoiceStore.getState().note === null,
      ).toBe(true);
    });

    it('a genuine long hold sends on mouseUp (release-sends)', () => {
      vi.useFakeTimers();
      const onStartVoiceNote = vi.fn((chatId: string) => {
        useVoiceStore.getState().startNote(chatId, 'ptt');
      });
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={onStartVoiceNote}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      vi.advanceTimersByTime(400); // well over TAP_THRESHOLD_MS
      fireEvent.mouseUp(mic);
      expect(useVoiceStore.getState().note).toBeNull();
      vi.useRealTimers();
    });

    it('mic mouseLeave with nothing pressed is a no-op', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      expect(() => fireEvent.mouseLeave(screen.getByTestId('voice-note-btn'))).not.toThrow();
    });

    it('a press while a toggle session is already open commits it (second tap)', () => {
      const onStartVoiceNote = vi.fn((chatId: string) => {
        useVoiceStore.getState().startNote(chatId, 'ptt');
      });
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={onStartVoiceNote}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      // Quick tap → toggle session.
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
      // A second press while toggled-open commits it immediately (no real
      // audio session backing it here, but the note clears).
      fireEvent.mouseDown(mic);
      expect(useVoiceStore.getState().note).toBeNull();
    });

    // ---- TRANSCRIBE mode (C1): default mic (no onStartVoiceNote) records and
    // drops the recognised text into the composer input, editable before send. --
    type Rec = {
      onLevel: (cb: (l: number) => void) => void;
      /** Captured live-preview tee; call `emitPcm` to drive it from a test. */
      onPcm: (cb: (pcm: Int16Array) => void) => void;
      emitPcm: (pcm: Int16Array) => void;
      stop: Mock;
      cancel: Mock;
    };
    function makeRec(): Rec {
      let pcmCb: ((pcm: Int16Array) => void) | null = null;
      return {
        onLevel: () => {},
        onPcm: (cb) => {
          pcmCb = cb;
        },
        emitPcm: (pcm) => pcmCb?.(pcm),
        stop: vi.fn(async () => new Blob(['x'], { type: 'audio/wav' })),
        cancel: vi.fn(),
      };
    }
    /**
     * A live-preview stand-in. Every dictation test injects one: without it the
     * composer opens a REAL audio session (token mint + WSS) mid-test.
     */
    function makePreview(): {
      factory: typeof startDictationPreview;
      emit: (text: string) => void;
      fail: (message: string) => void;
      pushed: Int16Array[];
      stopped: () => number;
      opened: () => number;
    } {
      let cbs: DictationPreviewCallbacks | null = null;
      const pushed: Int16Array[] = [];
      let stops = 0;
      let opens = 0;
      const factory: typeof startDictationPreview = (_chatId, callbacks) => {
        cbs = callbacks;
        opens += 1;
        return {
          push: (pcm: Int16Array) => {
            pushed.push(pcm);
          },
          stop: () => {
            stops += 1;
          },
        };
      };
      return {
        factory,
        emit: (text) => act(() => cbs?.onPartial(text)),
        fail: (message) => act(() => cbs?.onPreviewError(message)),
        pushed,
        stopped: () => stops,
        opened: () => opens,
      };
    }
    const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;
    let preview: ReturnType<typeof makePreview>;
    beforeEach(() => {
      preview = makePreview();
    });

    it('tap-toggle dictation lands the transcript in the composer input (editable, not sent)', async () => {
      const rec = makeRec();
      const recorderFactory = vi.fn(async () => rec as unknown as VoiceRecording);
      const transcribeClip = vi.fn(async () => ({ transcript: 'buy oat milk' }));
      const onSend = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={onSend}
          previewFactory={preview.factory}
          recorderFactory={recorderFactory}
          transcribeClip={transcribeClip}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      expect(mic.getAttribute('aria-label')).toBe('dictate into message');
      // Quick tap → starts a toggle recording session.
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(recorderFactory).toHaveBeenCalled());
      // A second press commits → transcribe → text lands in the input.
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('buy oat milk'));
      expect(transcribeClip).toHaveBeenCalledWith(expect.any(Blob));
      expect(rec.stop).toHaveBeenCalledOnce();
      // The turn is NOT auto-sent — it's editable in the box.
      expect(onSend).not.toHaveBeenCalled();
    });

    it('a hands-free toggle dictation keeps listening through a long silence — only a second tap ends it', async () => {
      vi.useFakeTimers();
      const rec = makeRec();
      const recorderFactory = vi.fn(async () => rec as unknown as VoiceRecording);
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={recorderFactory}
          transcribeClip={async () => ({ transcript: 'still listening' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      // Quick tap → hands-free toggle session (no hold to release).
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // let the recorder spin up
      });
      expect(recorderFactory).toHaveBeenCalled();
      // Sit in total silence — no input level ever reported — for two minutes.
      // The session must still be open: a pause to think is not the end of a
      // sentence, so nothing auto-commits.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(rec.stop).not.toHaveBeenCalled();
      expect(mic.getAttribute('aria-pressed')).toBe('true');
      expect(input().value).toBe('');
      vi.useRealTimers();
      // The second tap is the only thing that ends it.
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('still listening'));
      expect(rec.stop).toHaveBeenCalledOnce();
    });

    it('dictation appends to text already typed in the composer', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'and some bread' })}
        />,
      );
      fireEvent.change(input(), { target: { value: 'buy oat milk' } });
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(rec.stop).not.toHaveBeenCalled());
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('buy oat milk and some bread'));
    });

    it('press-and-hold then release commits the dictation (release-transcribes)', async () => {
      vi.useFakeTimers();
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'held dictation' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      vi.advanceTimersByTime(400); // well over the tap threshold → a real hold
      fireEvent.mouseUp(mic);
      vi.useRealTimers();
      await waitFor(() => expect(input().value).toBe('held dictation'));
    });

    it('Escape cancels an in-flight dictation without transcribing', async () => {
      const rec = makeRec();
      const transcribeClip = vi.fn(async () => ({ transcript: 'nope' }));
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={transcribeClip}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic); // toggle session recording
      await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
      fireEvent.keyDown(input(), { key: 'Escape' });
      await waitFor(() => expect(rec.cancel).toHaveBeenCalled());
      expect(transcribeClip).not.toHaveBeenCalled();
      expect(mic.getAttribute('aria-pressed')).toBe('false');
    });

    // ---- Send while dictating: ends the dictation and sends what it heard
    // (plus anything typed) as one turn. ----

    function renderDictating(opts: {
      onSend: Mock;
      transcribeClip: (clip: Blob) => Promise<{ transcript: string }>;
      rec: Rec;
    }): HTMLElement {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={opts.onSend}
          previewFactory={preview.factory}
          recorderFactory={async () => opts.rec as unknown as VoiceRecording}
          transcribeClip={opts.transcribeClip}
        />,
      );
      return screen.getByTestId('voice-note-btn');
    }

    it('send while dictating stops the mic and sends the transcript', async () => {
      const rec = makeRec();
      const onSend = vi.fn();
      const mic = renderDictating({
        onSend,
        rec,
        transcribeClip: async () => ({ transcript: 'buy oat milk' }),
      });
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      preview.emit('buy oat');
      // Nothing typed, but the send button is live while dictating.
      const send = screen.getByTestId('send-btn') as HTMLButtonElement;
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(onSend).toHaveBeenCalledWith('buy oat milk'));
      expect(onSend).toHaveBeenCalledOnce();
      expect(rec.stop).toHaveBeenCalledOnce();
      expect(preview.stopped()).toBe(1);
      expect(input().value).toBe('');
      expect(mic.getAttribute('aria-pressed')).toBe('false');
    });

    it('send while dictating joins typed text and the transcript', async () => {
      const rec = makeRec();
      const onSend = vi.fn();
      const mic = renderDictating({
        onSend,
        rec,
        transcribeClip: async () => ({ transcript: 'and some bread' }),
      });
      fireEvent.change(input(), { target: { value: 'buy oat milk' } });
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() => expect(onSend).toHaveBeenCalledWith('buy oat milk and some bread'));
      expect(input().value).toBe('');
    });

    it('Enter while dictating on an empty box sends the dictation', async () => {
      const rec = makeRec();
      const onSend = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={onSend}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'hello' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello'));
    });

    it('send pressed mid-transcription waits for the transcript, then sends', async () => {
      let resolveT: ((v: { transcript: string }) => void) | undefined;
      const rec = makeRec();
      const onSend = vi.fn();
      const mic = renderDictating({
        onSend,
        rec,
        transcribeClip: () => new Promise((r) => (resolveT = r)),
      });
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      fireEvent.mouseDown(mic); // commit → transcribing
      await waitFor(() => expect((mic as HTMLButtonElement).disabled).toBe(true));
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(onSend).not.toHaveBeenCalled();
      resolveT!({ transcript: 'late words' });
      await waitFor(() => expect(onSend).toHaveBeenCalledWith('late words'));
      expect(rec.stop).toHaveBeenCalledOnce();
      expect(input().value).toBe('');
    });

    it('send while dictating with nothing heard sends nothing and says so', async () => {
      const rec = makeRec();
      const onSend = vi.fn();
      const mic = renderDictating({
        onSend,
        rec,
        transcribeClip: async () => ({ transcript: '  ' }),
      });
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() =>
        expect(useUiStore.getState().errors.at(-1)?.message).toBe(
          'voice: nothing heard, nothing sent',
        ),
      );
      expect(onSend).not.toHaveBeenCalled();
      expect(mic.getAttribute('aria-pressed')).toBe('false');
    });

    it('a failed transcription on send keeps the typed text and sends nothing', async () => {
      const rec = makeRec();
      const onSend = vi.fn();
      const mic = renderDictating({
        onSend,
        rec,
        transcribeClip: async () => {
          throw new Error('groq 500');
        },
      });
      fireEvent.change(input(), { target: { value: 'typed first' } });
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      fireEvent.click(screen.getByTestId('send-btn'));
      await waitFor(() =>
        expect(useUiStore.getState().errors.at(-1)?.message).toBe(
          'Voice transcription failed. Try again.',
        ),
      );
      expect(onSend).not.toHaveBeenCalled();
      expect(input().value).toBe('typed first');
    });

    it('⌘; reaches this composer: first press dictates, second keeps the words in the box', async () => {
      const rec = makeRec();
      const onSend = vi.fn();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={onSend}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'from the hotkey' })}
        />,
      );
      const mic = composerMicFor('c1');
      expect(mic).toBeDefined();
      act(() => {
        mic!.down();
        mic!.up();
      });
      await waitFor(() => expect(preview.opened()).toBe(1));
      preview.emit('from the');
      await waitFor(() =>
        expect(screen.getByTestId('composer-live-partial').textContent).toBe('from the'),
      );
      act(() => {
        mic!.down();
        mic!.up();
      });
      await waitFor(() => expect(input().value).toBe('from the hotkey'));
      expect(onSend).not.toHaveBeenCalled();
    });

    it('a note-mode composer does not take ⌘; — it stays a voice note', () => {
      render(
        <Composer chatId="c-note" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />,
      );
      expect(composerMicFor('c-note')).toBeUndefined();
    });

    it('unmounting the composer releases ⌘;', () => {
      const { unmount } = render(
        <Composer
          chatId="c-gone"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
        />,
      );
      expect(composerMicFor('c-gone')).toBeDefined();
      unmount();
      expect(composerMicFor('c-gone')).toBeUndefined();
    });

    it('after Esc cancels a tap-toggle dictation, the next tap starts a new one', async () => {
      const recs = [makeRec(), makeRec()];
      let n = 0;
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => recs[n++] as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'second go' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(n).toBe(1));
      fireEvent.keyDown(input(), { key: 'Escape' });
      expect(recs[0]!.cancel).toHaveBeenCalled();
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(n).toBe(2));
      expect(mic.getAttribute('aria-pressed')).toBe('true');
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('second go'));
    });

    it('a transcription failure surfaces a toast (NO silent drop)', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => {
            throw new Error('groq 500');
          }}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(rec.stop).not.toHaveBeenCalled());
      fireEvent.mouseDown(mic);
      await waitFor(() =>
        expect(useUiStore.getState().errors.at(-1)?.message).toBe(
          'Voice transcription failed. Try again.',
        ),
      );
      expect(input().value).toBe('');
    });

    it('a recorder start failure surfaces a toast and clears the recording state', async () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => {
            throw new Error('mic denied');
          }}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      await waitFor(() =>
        expect(useUiStore.getState().errors.at(-1)?.message).toContain('could not start recording'),
      );
      expect(mic.getAttribute('aria-pressed')).toBe('false');
    });

    it('uses the default recorder + transcribe endpoint when no test seams are injected', async () => {
      const rec = makeRec();
      const startSpy = vi
        .spyOn(voiceRecorderModule, 'startRecording')
        .mockResolvedValue(rec as unknown as VoiceRecording);
      const apiSpy = vi
        .spyOn(api, 'voiceTranscribe')
        .mockResolvedValue({ ok: true, transcript: 'default path' });
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} />);
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(startSpy).toHaveBeenCalled());
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('default path'));
      expect(apiSpy).toHaveBeenCalledWith(expect.any(Blob));
      startSpy.mockRestore();
      apiSpy.mockRestore();
    });

    it('cancelling during mic spin-up cancels the late recording (success-stale guard)', async () => {
      let resolveStart: ((r: VoiceRecording) => void) | undefined;
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={() => new Promise<VoiceRecording>((r) => (resolveStart = r))}
          transcribeClip={async () => ({ transcript: 'x' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic); // toggle session, still spinning up
      fireEvent.keyDown(input(), { key: 'Escape' }); // cancel before the mic is ready
      resolveStart!(rec as unknown as VoiceRecording);
      await waitFor(() => expect(rec.cancel).toHaveBeenCalled());
    });

    it('a recorder start error after a cancel is swallowed (stale-gen guard)', async () => {
      let rejectStart: ((e: Error) => void) | undefined;
      useUiStore.getState().clearToasts();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={() => new Promise<VoiceRecording>((_r, rej) => (rejectStart = rej))}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      fireEvent.keyDown(input(), { key: 'Escape' }); // bump the generation
      rejectStart!(new Error('too late'));
      await Promise.resolve();
      // The stale error is swallowed — no toast for a recording the user abandoned.
      await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('false'));
      expect(useUiStore.getState().errors.some((e) => e.message.includes('too late'))).toBe(false);
    });

    it('committing with nothing recorded surfaces the "nothing recorded" toast', async () => {
      useUiStore.getState().clearToasts();
      vi.useFakeTimers();
      // The mic fails to start; a subsequent hold-release still tries to commit,
      // but there is no captured clip → the user is told (never a silent no-op).
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => {
            throw new Error('mic denied');
          }}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic); // beginRecording → factory rejects
      vi.advanceTimersByTime(400);
      fireEvent.mouseUp(mic); // hold-release → commitRecording with no recordingRef
      vi.useRealTimers();
      await waitFor(() =>
        expect(
          useUiStore.getState().errors.some((e) => e.message.includes('nothing recorded')),
        ).toBe(true),
      );
    });

    it('the mic is disabled while a transcription is in flight', async () => {
      let resolveT: ((v: { transcript: string }) => void) | undefined;
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={() => new Promise((r) => (resolveT = r))}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn') as HTMLButtonElement;
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(rec.stop).not.toHaveBeenCalled());
      fireEvent.mouseDown(mic); // commit → transcribing (pending)
      await waitFor(() => expect(mic.disabled).toBe(true));
      expect(mic.getAttribute('title')).toBe('Transcribing…');
      resolveT!({ transcript: 'done' });
      await waitFor(() => expect(mic.disabled).toBe(false));
    });

    // ---- Live dictation preview (spec/07 § Dictation into the composer): the
    // host's interim transcript paints GREYED into the input while the user
    // is still speaking, and is replaced by the authoritative one on commit. ---

    it('paints the interim transcript as a greyed preview while recording, leaving the input editable', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'buy oat milk please' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      // Nothing is drawn until there are words to draw.
      expect(screen.queryByTestId('composer-live-preview')).toBeNull();

      preview.emit('buy oat');
      await waitFor(() =>
        expect(screen.getByTestId('composer-live-partial').textContent).toBe('buy oat'),
      );
      // Greyed PREVIEW, not committed text: the real value is still empty, so
      // sending now would send nothing rather than a half-heard guess.
      expect(input().value).toBe('');
      expect(input().getAttribute('data-preview')).toBe('true');
      expect(input().disabled).toBe(false);

      // Each pass replaces the last — the text is allowed to rewrite itself.
      preview.emit('buy oat milk');
      await waitFor(() =>
        expect(screen.getByTestId('composer-live-partial').textContent).toBe('buy oat milk'),
      );

      // The authoritative transcript lands as real text and the preview goes.
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('buy oat milk please'));
      expect(screen.queryByTestId('composer-live-preview')).toBeNull();
      expect(input().getAttribute('data-preview')).toBeNull();
      expect(preview.stopped()).toBe(1);
    });

    it('draws the preview after text already typed, and tees the recorder PCM into it', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'and some bread' })}
        />,
      );
      fireEvent.change(input(), { target: { value: 'shopping:' } });
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));

      // The SAME capture feeds the preview — never a second getUserMedia.
      act(() => rec.emitPcm(new Int16Array([1, 2, 3])));
      expect(preview.pushed).toHaveLength(1);
      expect(Array.from(preview.pushed[0]!)).toEqual([1, 2, 3]);

      preview.emit('and some');
      await waitFor(() =>
        expect(screen.getByTestId('composer-live-preview').textContent).toBe('shopping: and some'),
      );
    });

    it('a broken preview leg is surfaced but the dictation still completes', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'still landed' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));

      preview.fail('wss closed');
      await waitFor(() =>
        expect(
          useUiStore
            .getState()
            .errors.some((e) => e.message.includes('live transcript unavailable')),
        ).toBe(true),
      );

      // The recording was never the preview's to kill.
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('still landed'));
    });

    it('a preview that cannot even open does not abort the recording', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={() => {
            throw new Error('no token');
          }}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'recorded anyway' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() =>
        expect(useUiStore.getState().errors.some((e) => e.message.includes('no token'))).toBe(true),
      );
      // Told about the preview, NOT told the mic failed — and the clip is real.
      expect(
        useUiStore.getState().errors.some((e) => e.message.includes('could not start recording')),
      ).toBe(false);
      fireEvent.mouseDown(mic);
      await waitFor(() => expect(input().value).toBe('recorded anyway'));
      expect(rec.stop).toHaveBeenCalledOnce();
    });

    it('cancelling a dictation closes the preview session and drops its text', async () => {
      const rec = makeRec();
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          previewFactory={preview.factory}
          recorderFactory={async () => rec as unknown as VoiceRecording}
          transcribeClip={async () => ({ transcript: 'never asked for' })}
        />,
      );
      const mic = screen.getByTestId('voice-note-btn');
      fireEvent.mouseDown(mic);
      fireEvent.mouseUp(mic);
      await waitFor(() => expect(preview.opened()).toBe(1));
      preview.emit('half a sentence');
      await waitFor(() => expect(screen.getByTestId('composer-live-preview')).toBeTruthy());

      fireEvent.keyDown(input(), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('composer-live-preview')).toBeNull());
      expect(preview.stopped()).toBe(1);
      expect(rec.cancel).toHaveBeenCalledOnce();
      expect(input().value).toBe('');
    });

    it('autoFocus focuses the input once the composer is not offline', () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          autoFocus
        />,
      );
      expect(document.activeElement).toBe(screen.getByTestId('composer-input'));
    });

    it('autoFocus does not steal focus while offline', () => {
      usePresenceStore.getState().setConnection('reconnecting');
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          autoFocus
        />,
      );
      expect(document.activeElement).not.toBe(screen.getByTestId('composer-input'));
      usePresenceStore.getState().setConnection('connected');
    });

    // Auto-focus is a courtesy, not a claim (spec/14 § Composer). Anything that
    // has ALREADY taken the cursor keeps it: the permission/question cards
    // focus themselves on mount for their own keys, and a field the user is
    // typing into is the whole reason not to yank.
    it('autoFocus declines the cursor to a card that already holds it', () => {
      const card = document.createElement('div');
      card.className = 'permission';
      card.tabIndex = 0;
      document.body.appendChild(card);
      card.focus();
      expect(document.activeElement).toBe(card);

      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          autoFocus
        />,
      );
      expect(document.activeElement).toBe(card);
      card.remove();
    });

    it('autoFocus declines the cursor to a field being typed into', () => {
      const field = document.createElement('input');
      document.body.appendChild(field);
      field.focus();

      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          autoFocus
        />,
      );
      expect(document.activeElement).toBe(field);
      field.remove();
    });

    // `offline` has to stay a dependency of the focus effect (the composer
    // routinely mounts before the socket connects), so without a once-only
    // latch every WS reconnect would drag the cursor back out of wherever the
    // user had moved it.
    it('a reconnect does not pull the cursor back into the composer', () => {
      render(
        <Composer
          chatId="c1"
          daemonId="d1"
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          autoFocus
        />,
      );
      expect(document.activeElement).toBe(screen.getByTestId('composer-input'));

      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      elsewhere.focus();

      act(() => {
        usePresenceStore.getState().setConnection('reconnecting');
      });
      act(() => {
        usePresenceStore.getState().setConnection('connected');
      });

      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });
  });

  // spec/14 § Composer — Call moved here from the chat header, sitting beside
  // attach and dictate: "attachment, dictate, call, side by side, same icon
  // size" (Tom, 30 Sep 2026).
  describe('Call button', () => {
    beforeEach(async () => {
      const { startVoiceCall } = await import('../lib/voiceController.js');
      vi.mocked(startVoiceCall).mockClear();
    });

    it('sits beside attach and the mic, sharing their icon size', () => {
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      const call = screen.getByTestId('call-btn');
      expect(call).toBeInTheDocument();
      const attachIcon = screen.getByTestId('attach-btn').querySelector('svg')!;
      const callIcon = call.querySelector('svg')!;
      expect(callIcon.getAttribute('width')).toBe(attachIcon.getAttribute('width'));
      expect(callIcon.getAttribute('height')).toBe(attachIcon.getAttribute('height'));
    });

    it('starts a call on this chat directly when the chat already exists', async () => {
      const { startVoiceCall } = await import('../lib/voiceController.js');
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      fireEvent.click(screen.getByTestId('call-btn'));
      await waitFor(() => expect(startVoiceCall).toHaveBeenCalledWith('c1'));
    });

    // A not-yet-spawned chat has no real id to call — `resolveChatId` (the
    // same create-then-act path attachments use) creates it first.
    it('on a new chat, creates the chat first and calls the resolved id', async () => {
      const { startVoiceCall } = await import('../lib/voiceController.js');
      const resolveChatId = vi.fn(async () => 'c-resolved');
      render(
        <Composer
          chatId="new"
          daemonId={null}
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          resolveChatId={resolveChatId}
        />,
      );
      fireEvent.click(screen.getByTestId('call-btn'));
      await waitFor(() => expect(resolveChatId).toHaveBeenCalled());
      await waitFor(() => expect(startVoiceCall).toHaveBeenCalledWith('c-resolved'));
    });

    it('does not call when resolveChatId aborts (returns null)', async () => {
      const { startVoiceCall } = await import('../lib/voiceController.js');
      const resolveChatId = vi.fn(async () => null);
      render(
        <Composer
          chatId="new"
          daemonId={null}
          onSend={() => {}}
          onStartVoiceNote={() => {}}
          resolveChatId={resolveChatId}
        />,
      );
      fireEvent.click(screen.getByTestId('call-btn'));
      await waitFor(() => expect(resolveChatId).toHaveBeenCalled());
      expect(startVoiceCall).not.toHaveBeenCalled();
    });

    it('is disabled while the agent is offline, same as the mic', () => {
      usePresenceStore.getState().setHostOnline('d1', false);
      render(<Composer chatId="c1" daemonId="d1" onSend={() => {}} onStartVoiceNote={() => {}} />);
      expect(screen.getByTestId('call-btn')).toBeDisabled();
      expect(screen.getByTestId('voice-note-btn')).toBeDisabled();
    });
  });
});
