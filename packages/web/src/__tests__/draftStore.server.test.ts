// New-chat drafts are server-owned (spec/14 § New chat drafts): edits go to
// the server as new_chat_draft.set/remove, and the server's list/updated/
// removed come back into the store.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDraftStore, NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS } from '../stores/draftStore.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';

const sent: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  window.localStorage.clear();
  useDraftStore.setState({ drafts: {}, order: [] });
  setActiveWs({ send: (e: unknown) => void sent.push(e) } as unknown as PatchWs);
});
afterEach(() => {
  setActiveWs(null);
  vi.useRealTimers();
});

describe('draftStore — server owned', () => {
  it('sends a text draft once, debounced, and nothing for a blank one', () => {
    const id = useDraftStore.getState().create('/f');
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    useDraftStore.getState().update(id, { text: 'a' });
    useDraftStore.getState().update(id, { text: 'ab' });
    vi.advanceTimersByTime(NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS);
    expect(sent).toEqual([{ type: 'new_chat_draft.set', draft: { id, folder: '/f', text: 'ab' } }]);
  });

  it('emptying a synced draft and discarding one both send a remove', () => {
    const id = useDraftStore.getState().create('/f');
    useDraftStore.getState().update(id, { text: 'x' });
    vi.advanceTimersByTime(NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS);
    sent.length = 0;
    useDraftStore.getState().update(id, { text: '' });
    vi.advanceTimersByTime(NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS);
    expect(sent).toEqual([{ type: 'new_chat_draft.remove', id }]);
    sent.length = 0;
    useDraftStore.getState().remove(id);
    expect(sent).toEqual([{ type: 'new_chat_draft.remove', id }]);
  });

  it('a draft that arrives from the server is listed, and its removal drops it', () => {
    useDraftStore.getState().applyUpdated({ id: 'r1', folder: '/p', text: 'from phone' }, 5);
    expect(useDraftStore.getState().drafts['r1']).toMatchObject({
      text: 'from phone',
      folder: '/p',
    });
    expect(useDraftStore.getState().order).toContain('r1');
    useDraftStore.getState().applyRemoved('r1');
    expect(useDraftStore.getState().drafts['r1']).toBeUndefined();
    expect(useDraftStore.getState().order).not.toContain('r1');
  });

  it('the snapshot drops a text draft deleted elsewhere, keeps blank scratch and unsent edits', () => {
    const blank = useDraftStore.getState().create('/b');
    useDraftStore.setState({
      drafts: {
        ...useDraftStore.getState().drafts,
        stale: { id: 'stale', folder: '/s', text: 'old', updatedAt: 1 },
      },
      order: ['stale', blank],
    });
    const typing = useDraftStore.getState().create('/t');
    useDraftStore.getState().update(typing, { text: 'unsent' });
    useDraftStore.getState().applyList([{ id: 'k', folder: '/k', text: 'kept', updatedAt: 2 }]);
    const ids = Object.keys(useDraftStore.getState().drafts);
    expect(ids).toContain('k');
    expect(ids).toContain(blank);
    expect(ids).not.toContain('stale');
    expect(useDraftStore.getState().drafts[typing]).toBeDefined();
  });

  it('our own stale echo does not overwrite newer typing', () => {
    const id = useDraftStore.getState().create('/f');
    useDraftStore.getState().update(id, { text: 'a' });
    vi.advanceTimersByTime(NEW_CHAT_DRAFT_SEND_DEBOUNCE_MS);
    useDraftStore.getState().update(id, { text: 'ab' });
    useDraftStore.getState().applyUpdated({ id, folder: '/f', text: 'a' }, 9);
    expect(useDraftStore.getState().drafts[id]!.text).toBe('ab');
  });
});
