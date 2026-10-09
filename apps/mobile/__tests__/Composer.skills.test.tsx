// Composer — skill autocomplete (spec/15 § Composer). Typing `/` opens a list
// of the folder's skills (from `api.skills(folder)`), filtered as you type,
// anywhere it begins a word; tapping a row completes it. Active only while
// the token at the cursor is still open (no space yet).
//
// activeSlashToken/filterSkills themselves are pinned at 100% already in
// skillAutocomplete.test.ts — this file is only about how the COMPOSER wires
// the fetch-on-first-`/`, per-folder caching, and the stale-fetch race guard
// (an in-flight `api.skills` call from a folder/draft the user has since left
// must not clobber later state — the effect's own `live` flag guards this).

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  findHost,
  findAllHost,
  byType,
  byTestId,
  renderRN as renderRNRaw,
  update,
  actAsync,
  flush,
} from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import { lightColors as colors } from '../src/lib/theme';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';

const { skillsSpy } = vi.hoisted(() => ({ skillsSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: { skills: skillsSpy, uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

let submitSpy: ReturnType<typeof vi.spyOn>;

// Every renderer this file creates, unmounted in `afterEach` — otherwise a
// prior test's instance stays mounted and keeps subscribing to the (shared,
// module-level) chat store. That was harmless before the skill fetch read
// `row.daemonId`: no effect in this component depended on chat-store state.
// Now it does, so a lingering instance re-renders on the NEXT test's own
// `hydrate()` call and can fire an extra `api.skills` through the SAME
// `skillsSpy` mock the new test is asserting against. A test that already
// calls `.unmount()` itself (the "last used skill" describe block) still
// gets tracked here — unmounting twice is a no-op.
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
  // (and `c2`'s, for the per-folder test below) row to carry a daemonId.
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
    {
      chatId: 'c2',
      daemonId: 'd1',
      name: 'Chat',
      folder: 'elsewhere',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
    },
  ]);
  useUiStore.setState({ errors: [] });
  // Completing a skill now persists it as that folder's default (spec/15 §
  // Skill autocomplete) — start every test from an empty store.
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  skillsSpy.mockReset();
});

afterEach(() => {
  submitSpy.mockRestore();
  while (renderers.length > 0) {
    renderers.pop()?.unmount();
  }
});

describe('Composer — skill menu triggering', () => {
  it('a plain (non-slash) draft never fetches skills or shows the menu', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('hello');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(skillsSpy).not.toHaveBeenCalled();
    expect(() => findHost(r.root, byTestId('skill-menu'))).toThrow();
  });

  it('a bare "/" with no folder set (trimmedFolder === "") never fetches', () => {
    const r = renderRN(<Composer chatId="c1" />); // no folder prop
    findHost(r.root, byType('TextInput')).props['onChangeText']('/');
    update(r, <Composer chatId="c1" />);
    expect(skillsSpy).not.toHaveBeenCalled();
  });

  it('fetches on first "/" for the folder, shows all skills (empty query matches everything)', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant', 'deploy'] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(skillsSpy).toHaveBeenCalledWith('work', 'd1');
    expect(findHost(r.root, byTestId('skill-menu'))).toBeTruthy();
    expect(findHost(r.root, byTestId('skill-option-plant'))).toBeTruthy();
    expect(findHost(r.root, byTestId('skill-option-deploy'))).toBeTruthy();
  });

  it('a skills response missing `skills` falls back to an empty list (?? [])', async () => {
    skillsSpy.mockResolvedValue({});
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    // Fetched + cached, but the menu never shows (filteredSkills is empty).
    expect(skillsSpy).toHaveBeenCalledTimes(1);
    expect(() => findHost(r.root, byTestId('skill-menu'))).toThrow();
  });

  it('narrowing the query to no matches hides the menu even though slash-active', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant', 'deploy'] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('/zzz');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(() => findHost(r.root, byTestId('skill-menu'))).toThrow();
  });

  it('typing further within a single open does NOT re-fetch (the query is not a fetch input)', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant', 'plan-travel'] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(skillsSpy).toHaveBeenCalledTimes(1);

    findHost(r.root, byType('TextInput')).props['onChangeText']('/pl');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(skillsSpy).toHaveBeenCalledTimes(1); // still just the one call
    expect(findHost(r.root, byTestId('skill-option-plant'))).toBeTruthy();
    expect(findHost(r.root, byTestId('skill-option-plan-travel'))).toBeTruthy();
    expect(() => findHost(r.root, byTestId('skill-option-deploy'))).toThrow();
  });

  // spec/15 § Skill autocomplete — the list is re-read on every open, so a
  // skill added/renamed/removed on the host shows up on the next `/`.
  it('re-fetches on each re-open, so a list that changed on the host shows up', async () => {
    skillsSpy
      .mockResolvedValueOnce({ skills: ['plant'] })
      .mockResolvedValueOnce({ skills: ['plant', 'brand-new-skill'] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byTestId('skill-option-plant'))).toBeTruthy();
    expect(() => findHost(r.root, byTestId('skill-option-brand-new-skill'))).toThrow();

    // Close the menu (the draft stops matching `/token`), then re-open it.
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(skillsSpy).toHaveBeenCalledTimes(2);
    expect(findHost(r.root, byTestId('skill-option-brand-new-skill'))).toBeTruthy();
  });

  it('keeps the already-loaded list on screen while a re-open re-fetches', async () => {
    let resolveSecond: (v: { skills: string[] }) => void = () => {};
    skillsSpy.mockResolvedValueOnce({ skills: ['plant'] }).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSecond = res;
        }),
    );
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    // Second fetch still in flight: the menu stays open on the old list.
    expect(skillsSpy).toHaveBeenCalledTimes(2);
    expect(findHost(r.root, byTestId('skill-menu'))).toBeTruthy();
    expect(findHost(r.root, byTestId('skill-option-plant'))).toBeTruthy();

    await actAsync(async () => {
      resolveSecond({ skills: ['plant', 'deploy'] });
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byTestId('skill-option-deploy'))).toBeTruthy();
  });

  it('a failed fetch surfaces "skills unavailable: <message>" (NO FALLBACK to a silently empty list)', async () => {
    skillsSpy.mockRejectedValue(new Error('folder not found'));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /skills unavailable: folder not found/.test(m))).toBe(true);
  });

  it('tapping a skill row completes it (`/name `) and the menu closes (trailing space commits)', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant', 'deploy'] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    findHost(r.root, byTestId('skill-option-plant')).props['onPress']();
    update(r, <Composer chatId="c1" folder="work" />);
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('/plant ');
    expect(() => findHost(r.root, byTestId('skill-menu'))).toThrow();
  });

  it('a skill row exercises both pressed-style branches via onPressIn/onPressOut', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant'] });
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(r, <Composer chatId="c1" folder="work" />);
    const row = findHost(r.root, byTestId('skill-option-plant'));
    expect((row.props['style'] as { backgroundColor: string }).backgroundColor).toBe('transparent');
    row.props['onPressIn']();
    const pressedRow = findHost(r.root, byTestId('skill-option-plant'));
    expect((pressedRow.props['style'] as { backgroundColor: string }).backgroundColor).toBe(
      colors.divider,
    );
    pressedRow.props['onPressOut']();
  });
});

// spec/15 § Skill autocomplete — the list defaults to the last-used skill for
// the folder: completing one remembers it, and the next `/` puts it first.
describe('Composer — defaults to the last used skill', () => {
  it('sorts the last-completed skill first on the next `/` (same folder)', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant', 'plan-travel', 'deploy'] });
    const first = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(first.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(first, <Composer chatId="c1" folder="work" />);
    findHost(first.root, byTestId('skill-option-deploy')).props['onPress']();
    first.unmount();

    const next = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(next.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(next, <Composer chatId="c1" folder="work" />);
    const order = findAllHost(next.root, (n) =>
      String(n.props['testID'] ?? '').startsWith('skill-option-'),
    ).map((n) => String(n.props['testID']));
    expect(order).toEqual([
      'skill-option-deploy',
      'skill-option-plant',
      'skill-option-plan-travel',
    ]);
  });

  it('remembers per folder — a different folder keeps its natural order', async () => {
    skillsSpy.mockResolvedValue({ skills: ['plant', 'deploy'] });
    const first = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(first.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(first, <Composer chatId="c1" folder="work" />);
    findHost(first.root, byTestId('skill-option-deploy')).props['onPress']();
    first.unmount();

    const other = renderRN(<Composer chatId="c2" folder="elsewhere" />);
    await actAsync(async () => {
      findHost(other.root, byType('TextInput')).props['onChangeText']('/');
      await flush();
    });
    update(other, <Composer chatId="c2" folder="elsewhere" />);
    const order = findAllHost(other.root, (n) =>
      String(n.props['testID'] ?? '').startsWith('skill-option-'),
    ).map((n) => String(n.props['testID']));
    expect(order).toEqual(['skill-option-plant', 'skill-option-deploy']);
  });
});

describe("Composer — stale-fetch race guard (the effect's own `live` flag)", () => {
  it('a resolve from an ABANDONED fetch (folder changed mid-flight) is dropped, not applied', async () => {
    let resolveFirst: (v: { skills: string[] }) => void = () => {};
    skillsSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('/');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(skillsSpy).toHaveBeenCalledWith('work', 'd1');

    // Folder changes before the first fetch resolves — the effect's cleanup
    // sets `live = false` on the abandoned closure and a NEW effect fetches
    // for the new folder.
    skillsSpy.mockResolvedValueOnce({ skills: ['other-folder-skill'] });
    update(r, <Composer chatId="c1" folder="elsewhere" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('/');
    update(r, <Composer chatId="c1" folder="elsewhere" />);
    await actAsync(async () => {
      await flush();
    });
    update(r, <Composer chatId="c1" folder="elsewhere" />);
    expect(findHost(r.root, byTestId('skill-option-other-folder-skill'))).toBeTruthy();

    // Now resolve the ABANDONED first fetch — its `live` is false, so this
    // must NOT clobber the menu with the stale "work" folder's skills.
    await actAsync(async () => {
      resolveFirst({ skills: ['stale-work-skill'] });
      await flush();
    });
    update(r, <Composer chatId="c1" folder="elsewhere" />);
    expect(() => findHost(r.root, byTestId('skill-option-stale-work-skill'))).toThrow();
  });

  it('a rejection from an ABANDONED fetch is dropped — no stray error toast', async () => {
    let rejectFirst: (e: Error) => void = () => {};
    skillsSpy.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('/');
    update(r, <Composer chatId="c1" folder="work" />);

    skillsSpy.mockResolvedValueOnce({ skills: [] });
    update(r, <Composer chatId="c1" folder="elsewhere" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('/');
    update(r, <Composer chatId="c1" folder="elsewhere" />);
    await actAsync(async () => {
      await flush();
    });

    await actAsync(async () => {
      rejectFirst(new Error('abandoned folder blew up'));
      await flush();
    });
    const errors = useUiStore.getState().errors.map((e) => e.message);
    expect(errors.some((m) => /abandoned folder blew up/.test(m))).toBe(false);
  });
});
