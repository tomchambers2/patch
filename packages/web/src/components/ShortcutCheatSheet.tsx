// ShortcutCheatSheet — modal opened by ⌘?. Renders SHORTCUT_TABLE per
// spec/14 § Discoverability ("⌘? opens a modal cheat-sheet").

import type { JSX } from 'react';
import { useEffect } from 'react';
import { SHORTCUT_TABLE, shortcutLabel, shortcutScopeLabel } from '../lib/shortcuts.js';
import { chordGlyphs } from '../lib/dictateChord.js';
import { useUiStore } from '../stores/uiStore.js';
import { CloseIcon } from './icons.js';

export function ShortcutCheatSheet(): JSX.Element | null {
  const open = useUiStore((s) => s.cheatSheetOpen);
  const setOpen = useUiStore((s) => s.setCheatSheetOpen);
  const dictateChord = useUiStore((s) => s.dictateChord);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="cheat-sheet-overlay" data-testid="cheat-sheet" role="dialog" aria-modal>
      <div className="cheat-sheet-backdrop" onClick={() => setOpen(false)} aria-hidden />
      <div className="cheat-sheet-card">
        <header className="cheat-sheet-head">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="cheat-sheet-close"
            aria-label="close"
            onClick={() => setOpen(false)}
          >
            <CloseIcon />
          </button>
        </header>
        <table className="cheat-sheet-table">
          <thead>
            <tr>
              <th>Keys</th>
              <th>Action</th>
              <th>Scope</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUT_TABLE.map((row) => (
              <tr key={`${row.keys}-${row.action}`}>
                {/* The table is written in macOS glyphs; the sheet draws it for
                    the keyboard reading it (spec/14 § Discoverability). */}
                <td className="kbd">
                  {shortcutLabel(row.dictate ? chordGlyphs(dictateChord) : row.keys)}
                </td>
                <td>{row.action}</td>
                <td className="scope">{shortcutScopeLabel(row.scope)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
