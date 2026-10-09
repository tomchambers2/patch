import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// todo.md § Updates: "make the delete/close icons bigger nicer and clearer."
// The fix is a single shared icons module; every delete/close control must
// route through it rather than hand-rolling a tiny <X size={12|13|14}> or a
// bare "×". These source-level assertions lock that consistency in — the
// rendered look is verified on prod, but the wiring is guarded here.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

describe('delete/close icons come from the shared module', () => {
  it('ChatHeader delete uses the fun bin (DeleteIcon), not lucide Trash2', () => {
    const src = read('src/components/ChatHeader.tsx');
    expect(src).toMatch(/DeleteIcon/);
    // The delete button must not fall back to the flat lucide trash glyph.
    expect(src).not.toMatch(/<Trash2\b/);
  });

  it('dismiss buttons use CloseIcon, not ad-hoc tiny <X size={12|13|14}>', () => {
    const files = [
      'src/components/ReminderBanner.tsx',
      'src/components/BatchPanel.tsx',
      'src/components/Composer.tsx',
      'src/components/Sidebar.tsx',
      'src/routes/ChatRoute.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      expect.soft(src, `${f} should use CloseIcon`).toMatch(/CloseIcon/);
      // No more sub-shared-size raw close glyphs.
      expect
        .soft(src, `${f} should not hand-roll a tiny <X size={12|13|14}>`)
        .not.toMatch(/<X\s+size=\{1[234]\}/);
    }
  });

  it('the ShortcutCheatSheet close is a real glyph, not a bare "×" text node', () => {
    const src = read('src/components/ShortcutCheatSheet.tsx');
    expect(src).toMatch(/CloseIcon/);
    // The literal multiplication-sign character must be gone from the button.
    expect(src).not.toContain('×');
  });
});
