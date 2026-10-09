// Read-watermark persistence (see lib/readState.ts header comment). Direct
// unit coverage of the load/save helpers, including the NO-FALLBACK error
// paths: corrupt JSON, non-object shapes, and localStorage access failures.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadReadState, saveReadWatermark } from '../lib/readState.js';

const STORAGE_KEY = 'patch.readState.v1';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('loadReadState', () => {
  it('returns {} when nothing is stored', () => {
    expect(loadReadState()).toEqual({});
  });

  it('parses a valid stored map, dropping non-finite/non-number entries', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'chat-1': 5, 'chat-2': 'nope', 'chat-3': Infinity, 'chat-4': 0 }),
    );
    expect(loadReadState()).toEqual({ 'chat-1': 5, 'chat-4': 0 });
  });

  it('returns {} for a JSON array (not an object map)', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadReadState()).toEqual({});
  });

  it('returns {} for a JSON primitive (not an object)', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    expect(loadReadState()).toEqual({});
  });

  it('returns {} for invalid JSON (parse throws)', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadReadState()).toEqual({});
  });

  it('returns {} when localStorage access itself throws', () => {
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadReadState()).toEqual({});
  });
});

describe('saveReadWatermark', () => {
  it('persists a new watermark for a chat', () => {
    saveReadWatermark('chat-1', 10);
    expect(loadReadState()).toEqual({ 'chat-1': 10 });
  });

  it('advances an existing watermark forward', () => {
    saveReadWatermark('chat-1', 10);
    saveReadWatermark('chat-1', 20);
    expect(loadReadState()).toEqual({ 'chat-1': 20 });
  });

  it('never lowers a persisted watermark (guards out-of-order writes)', () => {
    saveReadWatermark('chat-1', 20);
    saveReadWatermark('chat-1', 5);
    expect(loadReadState()).toEqual({ 'chat-1': 20 });
  });

  it('keeps the watermark unchanged when the new value equals the current one', () => {
    saveReadWatermark('chat-1', 20);
    saveReadWatermark('chat-1', 20);
    expect(loadReadState()).toEqual({ 'chat-1': 20 });
  });

  it('silently no-ops when localStorage write throws (private mode)', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveReadWatermark('chat-1', 10)).not.toThrow();
  });
});
