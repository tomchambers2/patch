import { describe, it, expect } from 'vitest';
import { parseLoopCommand } from '../lib/loopCommand.js';

describe('parseLoopCommand (02-daemon.md § Self-wake — /loop)', () => {
  it('recognises `/loop <interval> <message>` and returns both, unparsed', () => {
    expect(parseLoopCommand('/loop 5m check on the build')).toEqual({
      isLoop: true,
      every: '5m',
      message: 'check on the build',
    });
  });

  it('is case-insensitive on the command word only', () => {
    expect(parseLoopCommand('/LOOP 10m Keep the Casing')).toEqual({
      isLoop: true,
      every: '10m',
      message: 'Keep the Casing',
    });
  });

  it('treats a bare `/loop` as a cancel (every + message both null)', () => {
    expect(parseLoopCommand('/loop')).toEqual({ isLoop: true, every: null, message: null });
    expect(parseLoopCommand('/loop   ')).toEqual({ isLoop: true, every: null, message: null });
  });

  it('an interval with no message is INCOMPLETE — every is set, message stays null (no guessed fallback)', () => {
    expect(parseLoopCommand('/loop 5m')).toEqual({ isLoop: true, every: '5m', message: null });
    expect(parseLoopCommand('/loop 5m   ')).toEqual({
      isLoop: true,
      every: '5m',
      message: null,
    });
  });

  it('preserves a multi-word message verbatim (only trimmed)', () => {
    expect(parseLoopCommand('/loop 1h30m   nag me about the deploy   ')).toEqual({
      isLoop: true,
      every: '1h30m',
      message: 'nag me about the deploy',
    });
  });

  it('tolerates leading/trailing whitespace around the whole message', () => {
    expect(parseLoopCommand('  /loop  30s  ping  ')).toEqual({
      isLoop: true,
      every: '30s',
      message: 'ping',
    });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseLoopCommand('let us loop back on this')).toEqual({
      isLoop: false,
      every: null,
      message: null,
    });
    expect(parseLoopCommand('/loopback 5m x')).toEqual({
      isLoop: false,
      every: null,
      message: null,
    });
    expect(parseLoopCommand('/goal the week')).toEqual({
      isLoop: false,
      every: null,
      message: null,
    });
  });
});
