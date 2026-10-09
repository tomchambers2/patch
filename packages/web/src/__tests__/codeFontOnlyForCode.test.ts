// Todoist: the code font is for code only. Prose and labels — a patch_notify
// message, section chips, system context — use the body font; the tool name
// stays mono (it is an identifier) but is styled as a deliberate chip.
// Locked against the source of `index.css` (jsdom has no cascade).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function body(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for \`${selector}\` in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('code font is only for code', () => {
  it.each([
    '.tool-call-notify',
    '.tool-call-notify-message',
    '.question-header',
    '.unsaved-chip',
    '.job-lifecycle-chip',
    '.system-context-text',
  ])('%s uses the body font', (sel) => {
    const rule = body(sel);
    expect(rule).not.toMatch(/JetBrains Mono|monospace/);
    expect(rule).toMatch(/Figtree Variable/);
  });

  it('the notify tool name is mono, styled as a chip', () => {
    const rule = body('.tool-call-notify-label');
    expect(rule).toMatch(/JetBrains Mono/);
    expect(rule).toMatch(/background/);
    expect(rule).toMatch(/letter-spacing/);
  });
});
