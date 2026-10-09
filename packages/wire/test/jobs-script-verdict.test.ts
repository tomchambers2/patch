// A `script` job's stdout is its decision log (spec/08 § Action — `script`).
//
// These jobs are GATES: they fire on a tight cron, decide whether there is work
// worth an agent turn, and mostly decide there is not. Every one of those fires
// records the same thing — `ok`, exit 0 — so a gate that quietly broke three
// days ago is indistinguishable from one correctly holding, and "why has
// nothing happened?" has no answer anywhere in the app. The two parsers here
// are how the app gets one: the verdict the command printed, and the chat it
// says it started.

import { describe, test, expect } from 'vitest';
import { SCRIPT_CHAT_MARKER, parseScriptChatId, scriptVerdictLine } from '../src/jobs.js';

describe('parseScriptChatId', () => {
  test('lifts the chat a gate announced', () => {
    expect(parseScriptChatId('4 new photos\npatch:chat 01M2ABCDEF\n')).toBe('01M2ABCDEF');
  });

  test('a gate that held announces nothing', () => {
    expect(parseScriptChatId('not due (next wake in 420s) — holding\n')).toBeNull();
  });

  test('empty output is not an announcement', () => {
    expect(parseScriptChatId('')).toBeNull();
  });

  test('tolerates leading whitespace and a tab separator', () => {
    expect(parseScriptChatId('  patch:chat\t01M2XYZ  ')).toBe('01M2XYZ');
  });

  test('the LAST announcement wins — a fire that spawned twice', () => {
    expect(parseScriptChatId('patch:chat first\nmore work\npatch:chat second')).toBe('second');
  });

  // NO FALLBACK: a link to a chat that may not exist is worse than no link, so
  // only a whole line of exactly `patch:chat <id>` counts.
  test('a chat id mentioned in passing is not an announcement', () => {
    expect(parseScriptChatId('resuming patch:chat 01M2ABC after the timeout')).toBeNull();
  });

  test('the marker with no id is not half an announcement', () => {
    expect(parseScriptChatId('patch:chat')).toBeNull();
    expect(parseScriptChatId('patch:chat   ')).toBeNull();
  });

  test('the marker name is the one the docs and the gates agree on', () => {
    expect(SCRIPT_CHAT_MARKER).toBe('patch:chat');
  });
});

describe('scriptVerdictLine', () => {
  test('is the last line — where a gate prints its decision', () => {
    const out = ['checked the queue', '4 waiting', '4 new -> spawned 01M2ABC'].join('\n');
    expect(scriptVerdictLine(out)).toBe('4 new -> spawned 01M2ABC');
  });

  test('ignores the trailing newline a shell `echo` leaves behind', () => {
    expect(scriptVerdictLine('holding: nothing new\n')).toBe('holding: nothing new');
  });

  test('skips the chat announcement — that is machinery, not the verdict', () => {
    expect(scriptVerdictLine('4 new -> spawned\npatch:chat 01M2ABC\n')).toBe('4 new -> spawned');
  });

  test('a command that printed nothing has no verdict to show', () => {
    expect(scriptVerdictLine('')).toBeNull();
    expect(scriptVerdictLine('\n\n  \n')).toBeNull();
  });

  test('output that is ONLY an announcement has no verdict', () => {
    expect(scriptVerdictLine('patch:chat 01M2ABC')).toBeNull();
  });
});
