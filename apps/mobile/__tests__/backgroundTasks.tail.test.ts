import { describe, it, expect } from 'vitest';
import { watchTailCommand } from '../src/lib/backgroundTasks';

describe('watchTailCommand', () => {
  it('quotes the path so a quote in it cannot break out', () => {
    expect(watchTailCommand("/a/it's")).toBe("tail -n 200 -f '/a/it'\\''s'");
  });
});
