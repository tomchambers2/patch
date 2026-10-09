// readUserMessages: user messages straight from the chats' events.jsonl.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUserMessages } from '../src/userMessages.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-user-messages-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const msg = (chatId: string, role: string, content: string, createdAt: number) =>
  JSON.stringify({
    v: 1,
    seq: 0,
    at: createdAt,
    branchId: `${chatId}-b0`,
    rec: { k: 'event', event: { type: 'chat.message', chatId, role, content, seq: 0, createdAt } },
  });

function writeLog(chatId: string, lines: string[], mtime?: number): void {
  mkdirSync(join(root, chatId), { recursive: true });
  const p = join(root, chatId, 'events.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  if (mtime !== undefined) utimesSync(p, mtime / 1000, mtime / 1000);
}

describe('readUserMessages', () => {
  it('returns only user chat.messages inside the window, oldest first across chats', () => {
    writeLog('c1', [
      msg('c1', 'user', 'late', 5000),
      msg('c1', 'assistant', 'reply', 4000),
      msg('c1', 'user', 'too early', 100),
    ]);
    writeLog('c2', [msg('c2', 'user', 'middle', 3000), msg('c2', 'system', 'note', 3100)]);
    expect(readUserMessages(root, 1000, 9000, 10)).toEqual([
      { chatId: 'c2', text: 'middle', ts: 3000 },
      { chatId: 'c1', text: 'late', ts: 5000 },
    ]);
  });

  it('applies the limit to the oldest rows', () => {
    writeLog('c1', [
      msg('c1', 'user', 'a', 1000),
      msg('c1', 'user', 'b', 2000),
      msg('c1', 'user', 'c', 3000),
    ]);
    expect(readUserMessages(root, 0, 9000, 2).map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('reports a message a log holds twice once, and skips a torn last line', () => {
    writeLog('c1', [
      msg('c1', 'user', 'dup', 2000),
      msg('c1', 'user', 'dup', 2000),
      '{"rec":{"k":"ev"',
    ]);
    expect(readUserMessages(root, 0, 9000, 10)).toEqual([{ chatId: 'c1', text: 'dup', ts: 2000 }]);
  });

  it('skips a chat whose log was last written before the window, and a chat with no log', () => {
    writeLog('old', [msg('old', 'user', 'ancient', 2000)], 1500);
    mkdirSync(join(root, 'empty'));
    expect(readUserMessages(root, 2000, 9000, 10)).toEqual([]);
  });
});
