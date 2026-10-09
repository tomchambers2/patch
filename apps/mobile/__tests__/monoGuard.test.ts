// spec/15 § Visual language — monospace is for code, and only code.
//
// The phone used JetBrains Mono for section headers, folder crumbs, status
// words, timestamps, ids, paths and settings values, and it read like a 90s
// terminal next to the desktop app. This gate fails on any mono face named
// outside the components that genuinely render code. A new entry here needs a
// reason that names the code it draws, and the count is exact — so a file that
// is allowed mono for its code block cannot quietly grow a mono label too.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCANNED = ['app', 'src'];

/** Every way a file can put text in a monospace face. */
const MONO = /fonts\.mono\b|typography\.code\b|['"`]monospace['"`]|JetBrainsMono/g;

/** file → [exact number of mono references, what code they render]. */
const ALLOWED: Record<string, [number, string]> = {
  'src/lib/theme.ts': [2, 'defines the mono face and the `code` type style'],
  'app/_layout.tsx': [2, 'loads the JetBrains Mono font file'],
  'src/components/ChatMarkdown.tsx': [3, 'inline code, code blocks and fences'],
  'src/components/UnifiedDiff.tsx': [1, 'diff lines'],
  'app/chats/[chatId].tsx': [
    4,
    "a tool call's raw args, its folded result, a background task's raw block, " +
      "and a patch_delegate row's own raw-args fallback before its ack lands",
  ],
  'src/components/BackgroundTaskBar.tsx': [
    2,
    'the shell command a background task is running or a monitor is watching (row preview and modal)',
  ],
  'app/hosts/[daemonId]/edit.tsx': [1, 'the file editor'],
  'app/hosts/[daemonId]/terminal.tsx': [1, 'terminal key buttons (Esc, Tab, ^C)'],
  'src/lib/terminalPage.ts': [1, 'the xterm terminal'],
  'app/settings/job-editor.tsx': [2, 'the gate script and the command script bodies'],
  'src/components/settings/ui.tsx': [1, "Field's `code` variant, for JSON input"],
  'src/components/settings/HostsSection.tsx': [1, 'the add-host shell command'],
  'src/components/ToolsList.tsx': [1, "a tool's definition"],
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** file → number of mono references outside comments. */
function monoUses(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const root of SCANNED) {
    for (const file of sources(join(ROOT, root))) {
      let n = 0;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) continue;
        n += (line.match(MONO) ?? []).length;
      }
      if (n > 0) found[relative(ROOT, file)] = n;
    }
  }
  return found;
}

describe('spec/15 § Visual language — mono is for code only', () => {
  const uses = monoUses();

  it('scans a real tree', () => {
    expect(Object.keys(uses).length).toBeGreaterThan(3);
  });

  it('no file outside the code-rendering allowlist names a mono face', () => {
    const offenders = Object.keys(uses).filter((f) => ALLOWED[f] === undefined);
    expect(offenders).toEqual([]);
  });

  it('an allowed file uses mono exactly as often as its code needs', () => {
    const drift = Object.entries(ALLOWED)
      .filter(([file, [count]]) => uses[file] !== count)
      .map(([file, [count]]) => `${file}: expected ${count}, found ${uses[file] ?? 0}`);
    expect(drift).toEqual([]);
  });
});
