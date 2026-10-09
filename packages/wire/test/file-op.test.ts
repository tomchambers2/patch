import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { PatchFileOpRequestEvent, PatchFileOpResponseEvent } from '../src/events.js';

// spec/03 § Files — the file browser's create / rename / delete.
//
// The load-bearing property of the pair is that it IS a pair: these operations
// destroy or move real files, so the surface waits for an answer rather than
// firing and assuming. Every rejection therefore has to be expressible as a
// typed code on the response — a failure with no code would come out as
// "something happened", which is what the ack exists to prevent.

describe('patch.file_op.request', () => {
  it('round-trips a create through the codec', () => {
    const ev: PatchFileOpRequestEvent = {
      type: 'patch.file_op.request',
      requestId: 'r1',
      chatId: 'c1',
      op: 'create',
      path: 'src/new.ts',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('round-trips a rename carrying its destination', () => {
    const ev: PatchFileOpRequestEvent = {
      type: 'patch.file_op.request',
      requestId: 'r2',
      chatId: 'c1',
      op: 'rename',
      path: 'src/old.ts',
      to: 'src/new.ts',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('round-trips a delete and a create_dir', () => {
    for (const op of ['delete', 'create_dir'] as const) {
      const ev: PatchFileOpRequestEvent = {
        type: 'patch.file_op.request',
        requestId: 'r3',
        chatId: 'c1',
        op,
        path: 'src/thing',
      };
      expect(decode(encode(ev))).toEqual(ev);
    }
  });

  it('refuses an unknown op rather than guessing at one', () => {
    expect(
      PatchFileOpRequestEvent.safeParse({
        type: 'patch.file_op.request',
        requestId: 'r1',
        chatId: 'c1',
        op: 'chmod',
        path: 'a.ts',
      }).success,
    ).toBe(false);
  });

  it('refuses an empty path — the chat folder itself is never a target', () => {
    expect(
      PatchFileOpRequestEvent.safeParse({
        type: 'patch.file_op.request',
        requestId: 'r1',
        chatId: 'c1',
        op: 'delete',
        path: '',
      }).success,
    ).toBe(false);
  });

  it('refuses an empty rename destination', () => {
    expect(
      PatchFileOpRequestEvent.safeParse({
        type: 'patch.file_op.request',
        requestId: 'r1',
        chatId: 'c1',
        op: 'rename',
        path: 'a.ts',
        to: '',
      }).success,
    ).toBe(false);
  });

  it('is strict — an unknown key is not quietly carried', () => {
    expect(
      PatchFileOpRequestEvent.safeParse({
        type: 'patch.file_op.request',
        requestId: 'r1',
        chatId: 'c1',
        op: 'delete',
        path: 'a.ts',
        recursive: true,
      }).success,
    ).toBe(false);
  });
});

describe('patch.file_op.response', () => {
  it('round-trips a success naming where the operation landed', () => {
    const ev: PatchFileOpResponseEvent = {
      type: 'patch.file_op.response',
      requestId: 'r2',
      ok: true,
      path: 'src/new.ts',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('carries every rejection the host can make, each with a message', () => {
    const codes = [
      'chat_not_found',
      'path_escape',
      'not_found',
      'exists',
      'not_empty',
      'missing_target',
      'internal',
    ] as const;
    for (const code of codes) {
      const ev: PatchFileOpResponseEvent = {
        type: 'patch.file_op.response',
        requestId: 'r3',
        ok: false,
        error: { code, message: `refused: ${code}` },
      };
      expect(decode(encode(ev))).toEqual(ev);
    }
  });

  it('refuses an error with no code — a failure the surface cannot name', () => {
    expect(
      PatchFileOpResponseEvent.safeParse({
        type: 'patch.file_op.response',
        requestId: 'r3',
        ok: false,
        error: { message: 'nope' },
      }).success,
    ).toBe(false);
  });
});
