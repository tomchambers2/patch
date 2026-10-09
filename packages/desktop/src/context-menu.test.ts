// Unit tests for the webContents context-menu template (right-click menu).
//
// buildContextMenuTemplate is deliberately electron-runtime-free: it takes the
// `context-menu` event params + injected deps and returns a plain
// MenuItemConstructorOptions[] we can assert on WITHOUT booting Electron.
// main.ts wires it into win.webContents.on('context-menu', …) and pops it up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContextMenuTemplate, type ContextMenuDeps } from './context-menu';

/** A default set of editFlags (everything allowed) unless a test overrides. */
function flags(over = {}) {
  return {
    canCut: true,
    canCopy: true,
    canPaste: true,
    canSelectAll: true,
    ...over,
  };
}

/** No-op deps (override the ones a given test cares about). */
function deps(over: Partial<ContextMenuDeps> = {}): ContextMenuDeps {
  return { openExternal: () => {}, openInPatch: () => {}, writeText: () => {}, ...over };
}

/** Find a menu item by label anywhere in the (possibly nested) template. */
function labels(template: readonly { label?: string; role?: string; type?: string }[]): string[] {
  return template.map((i) => i.label ?? i.role ?? i.type ?? '').filter(Boolean);
}

test('general context menu (editable field) exposes cut/copy/paste + select all', () => {
  const t = buildContextMenuTemplate({ isEditable: true, editFlags: flags() }, deps());
  const roles = t.map((i) => i.role).filter(Boolean);
  assert.ok(roles.includes('cut'), 'missing cut role');
  assert.ok(roles.includes('copy'), 'missing copy role');
  assert.ok(roles.includes('paste'), 'missing paste role');
  assert.ok(roles.includes('selectAll'), 'missing selectAll role');
});

test('no link items when the click is not on a link', () => {
  const t = buildContextMenuTemplate({ isEditable: true, editFlags: flags() }, deps());
  const ls = labels(t);
  assert.ok(
    !ls.some((l) => /^Open Link/.test(l)),
    'an Open Link item should not appear off a link',
  );
  assert.ok(!ls.includes('Copy Link Address'), 'Copy Link Address should not appear off a link');
});

test('right-clicking a link names BOTH routes, Patch first, then Copy Link Address', () => {
  // spec/14 § Links and the web panel: the right-click menu is where the choice
  // is discoverable, so both destinations are spelled out. Patch leads because
  // it is what a plain click does.
  const t = buildContextMenuTemplate(
    { linkURL: 'https://example.com/x', isEditable: false, editFlags: flags() },
    deps(),
  );
  const ls = labels(t);
  assert.ok(ls.includes('Open Link in Patch'), 'missing Open Link in Patch');
  assert.ok(ls.includes('Open Link in Browser'), 'missing Open Link in Browser');
  assert.ok(ls.includes('Copy Link Address'), 'missing Copy Link Address');
  assert.ok(
    ls.indexOf('Open Link in Patch') < ls.indexOf('Open Link in Browser'),
    'the plain-click default (Patch) must be the first of the two',
  );
});

test('Open Link in Browser routes the URL to the real browser (shell.openExternal)', () => {
  const external: string[] = [];
  const panel: string[] = [];
  const t = buildContextMenuTemplate(
    { linkURL: 'https://example.com/x', isEditable: false, editFlags: flags() },
    deps({ openExternal: (u) => external.push(u), openInPatch: (u) => panel.push(u) }),
  );
  const item = t.find((i) => i.label === 'Open Link in Browser');
  assert.ok(item?.click, 'Open Link in Browser has no click handler');
  (item!.click as () => void)();
  assert.deepEqual(external, ['https://example.com/x']);
  assert.deepEqual(panel, [], 'the browser route must not also open the panel');
});

test('Open Link in Patch routes the URL to the embedded web panel, not the browser', () => {
  const external: string[] = [];
  const panel: string[] = [];
  const t = buildContextMenuTemplate(
    { linkURL: 'https://example.com/x', isEditable: false, editFlags: flags() },
    deps({ openExternal: (u) => external.push(u), openInPatch: (u) => panel.push(u) }),
  );
  const item = t.find((i) => i.label === 'Open Link in Patch');
  assert.ok(item?.click, 'Open Link in Patch has no click handler');
  (item!.click as () => void)();
  assert.deepEqual(panel, ['https://example.com/x']);
  assert.deepEqual(external, [], 'the Patch route must not leak to the real browser');
});

test('Copy Link Address copies the URL to the clipboard', () => {
  const copied: string[] = [];
  const t = buildContextMenuTemplate(
    { linkURL: 'https://example.com/x', isEditable: false, editFlags: flags() },
    deps({ writeText: (s) => copied.push(s) }),
  );
  const item = t.find((i) => i.label === 'Copy Link Address');
  assert.ok(item?.click, 'Copy Link Address has no click handler');
  (item!.click as () => void)();
  assert.deepEqual(copied, ['https://example.com/x']);
});

test('paste is disabled when the field cannot be pasted into', () => {
  const t = buildContextMenuTemplate(
    { isEditable: true, editFlags: flags({ canPaste: false }) },
    deps(),
  );
  const paste = t.find((i) => i.role === 'paste');
  assert.ok(paste, 'no paste item');
  assert.equal(paste!.enabled, false, 'paste should be disabled when canPaste is false');
});

test('copy is enabled when there is a selection, disabled otherwise', () => {
  const withSel = buildContextMenuTemplate(
    { selectionText: 'hi', editFlags: flags({ canCopy: true }) },
    deps(),
  );
  const noSel = buildContextMenuTemplate(
    { selectionText: '', editFlags: flags({ canCopy: false }) },
    deps(),
  );
  assert.equal(withSel.find((i) => i.role === 'copy')!.enabled, true);
  assert.equal(noSel.find((i) => i.role === 'copy')!.enabled, false);
});

test('an empty context (nothing actionable) still returns a non-empty menu', () => {
  // Off a link, non-editable, no selection: at minimum Select All is offered so
  // the user always gets a usable menu rather than nothing on right-click.
  const t = buildContextMenuTemplate(
    {
      isEditable: false,
      selectionText: '',
      editFlags: flags({ canCut: false, canCopy: false, canPaste: false }),
    },
    deps(),
  );
  assert.ok(t.length > 0, 'context menu template is empty');
  assert.ok(
    t.some((i) => i.role === 'selectAll'),
    'select all should always be available',
  );
});
