// lib/messageText.ts — the text each transcript row gives up to Copy text /
// Select text (spec/15 § Chat detail — Copying message text).

import { describe, it, expect } from 'vitest';
import { copyableText } from '../src/lib/messageText';
import type { ChatEventEntry } from '../src/stores/chatStore';

const e = (partial: Partial<ChatEventEntry>): ChatEventEntry =>
  ({ seq: 1, kind: 'message', ...partial }) as ChatEventEntry;

describe('copyableText', () => {
  it('a message is its markdown source, verbatim', () => {
    expect(copyableText(e({ role: 'assistant', content: '# Title\n\n**bold** `x`' }))).toBe(
      '# Title\n\n**bold** `x`',
    );
  });

  it('a message with no text (attachments only) has nothing to copy', () => {
    expect(copyableText(e({ role: 'user', content: '' }))).toBeNull();
    expect(copyableText(e({ role: 'user' }))).toBeNull();
  });

  it('a tool call is its summary, arguments and result', () => {
    const text = copyableText(
      e({ kind: 'tool_call', tool: 'Bash', toolArgs: { command: 'ls' }, toolResult: 'a\nb' }),
    );
    expect(text).toContain('ls');
    expect(text).toContain('"command": "ls"');
    expect(text?.endsWith('a\nb')).toBe(true);
  });

  it('a tool call with no arguments or result is just its summary', () => {
    expect(copyableText(e({ kind: 'tool_call', tool: 'Bash' }))).not.toContain('\n');
  });

  it('a tool result is its output, structured output as JSON', () => {
    expect(copyableText(e({ kind: 'tool_result', toolResult: 'out' }))).toBe('out');
    expect(copyableText(e({ kind: 'tool_result', toolResult: { ok: true } }))).toBe(
      '{\n  "ok": true\n}',
    );
  });

  it('a tool result with no output names the tool, or is nothing', () => {
    expect(copyableText(e({ kind: 'tool_result', tool: 'Read' }))).toBe('Read done');
    expect(copyableText(e({ kind: 'tool_result' }))).toBeNull();
  });

  it('an unserialisable result still reads as something', () => {
    expect(copyableText(e({ kind: 'tool_result', toolResult: undefined, tool: 'X' }))).toBe(
      'X done',
    );
    // JSON.stringify(() => {}) is undefined — the String() form stands in.
    expect(copyableText(e({ kind: 'tool_result', toolResult: () => 1 }))).toContain('1');
  });

  it('an error is its message plus its code', () => {
    expect(copyableText(e({ kind: 'error', content: 'turn failed', errorCode: 'sdk_error' }))).toBe(
      'turn failed\nsdk_error',
    );
    expect(copyableText(e({ kind: 'error', content: 'turn failed' }))).toBe('turn failed');
    expect(copyableText(e({ kind: 'error' }))).toBeNull();
  });
});
