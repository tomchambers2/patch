// Todoist: "Patch: render images inline in chat (Read tool results don't
// reach the UI)". `ChatToolResultEvent.result` is `z.unknown()` on purpose —
// most tool results are opaque (a Bash stdout string, an arbitrary JSON blob)
// and there is no single shape to constrain them to. The Claude Agent SDK's
// own `tool_result` content (spec/02) is itself already a well-known shape
// when the underlying tool (e.g. `Read` on an image file) returns Anthropic
// content blocks: an array mixing `{ type: 'text', text }` and
// `{ type: 'image', source: { type: 'base64', media_type, data } }`. These
// tests pin that `z.unknown()` round-trips that structure through
// encode/decode byte-for-byte — nothing in the wire codec strips, reorders,
// or truncates an image block's base64 payload — since the host
// (`chatRunner.ts`, `sdkBackend.ts`, `history.ts`) all pass the SDK's
// `tool_result` content straight through as this event's `result` field, and
// the web surface (`ChatRoute.tsx`'s `ToolFields`/`imageDataUri`) depends on
// receiving that exact shape to detect and render the image.

import { describe, it, expect } from 'vitest';
import { encode, decode, type ChatToolResultEvent } from '../src/index.js';

describe('chat.tool_result — Anthropic image content blocks', () => {
  it('round-trips a tool_result whose content is an array of text + image blocks unchanged', () => {
    const event: ChatToolResultEvent = {
      type: 'chat.tool_result',
      chatId: 'c1',
      tool: 'Read',
      callId: 'call-1',
      result: [
        { type: 'text', text: 'screenshot.png' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZS1wbmc=' },
        },
      ],
      seq: 3,
    };

    const decoded = decode(encode(event));
    expect(decoded).toEqual(event);
  });

  it('round-trips a single bare image content block (no wrapping array) unchanged', () => {
    // Some tools return the image block directly as `result`, not nested in
    // a `content` array — `imageDataUri` on the web side handles both.
    const event: ChatToolResultEvent = {
      type: 'chat.tool_result',
      chatId: 'c1',
      tool: 'SomeTool',
      callId: 'call-2',
      result: {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
      },
      seq: 4,
    };

    const decoded = decode(encode(event));
    expect(decoded).toEqual(event);
  });

  it('still round-trips a plain opaque result (string) unchanged — result stays z.unknown()', () => {
    const event: ChatToolResultEvent = {
      type: 'chat.tool_result',
      chatId: 'c1',
      tool: 'Bash',
      callId: 'call-3',
      result: 'file.txt\n',
      seq: 5,
    };

    const decoded = decode(encode(event));
    expect(decoded).toEqual(event);
  });
});
