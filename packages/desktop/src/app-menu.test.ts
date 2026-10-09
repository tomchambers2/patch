// The application menu exists for Reload. The UI is a remote page, so when the
// window and the deployed SPA disagree, re-fetching it is the only way back —
// and with no menu the app had no binding for it at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppMenuTemplate } from './app-menu';

const deps = { openExternal: () => {}, switchServer: () => {} };

function roles(template: ReturnType<typeof buildAppMenuTemplate>, label: string): string[] {
  const menu = template.find((m) => m.label === label);
  assert.ok(menu, `no ${label} menu`);
  const items = (menu.submenu ?? []) as { role?: string }[];
  return items.map((i) => i.role).filter((r): r is string => typeof r === 'string');
}

test('View carries both reload and force reload', () => {
  const view = roles(buildAppMenuTemplate('Patch', deps), 'View');
  assert.ok(view.includes('reload'), 'no Reload — the app cannot re-fetch its own UI');
  assert.ok(view.includes('forceReload'), 'no Force Reload');
});

test('Edit keeps the clipboard roles a custom menu would otherwise drop', () => {
  const edit = roles(buildAppMenuTemplate('Patch', deps), 'Edit');
  for (const role of ['cut', 'copy', 'paste', 'selectAll']) {
    assert.ok(edit.includes(role), `replacing the default menu lost ${role}`);
  }
});

test('the app menu is named after the app, and can quit', () => {
  // Asserted for macOS explicitly rather than skipped off it: the test gate
  // runs on Linux, where a platform-sniffing test would silently cover nothing.
  const template = buildAppMenuTemplate('Patch', { ...deps, platform: 'darwin' });
  assert.equal(template[0]?.label, 'Patch');
  assert.ok(roles(template, 'Patch').includes('quit'));
});

test('the menu needs no electron runtime — the Linux test gate has none', () => {
  // Importing this module must not pull in electron. If it ever does, the whole
  // deploy fails here rather than on the box, where the error reads as
  // "Electron failed to install correctly".
  const opened: string[] = [];
  const template = buildAppMenuTemplate('Patch', {
    ...deps,
    openExternal: (u) => opened.push(u),
    webUrl: 'https://patch.example.com/app/',
  });
  const help = template.find((m) => m.role === 'help');
  const item = ((help?.submenu ?? []) as { click?: () => void }[])[0];
  item?.click?.();
  assert.deepEqual(opened, ['https://patch.example.com/app/']);
});

test('no web address is built in: Help offers one only when the server has one', () => {
  const help = buildAppMenuTemplate('Patch', deps).find((m) => m.role === 'help');
  assert.deepEqual(help?.submenu, []);
});

test('Switch Server… is in the app menu and asks the shell to switch', () => {
  let switched = 0;
  const template = buildAppMenuTemplate('Patch', {
    ...deps,
    platform: 'darwin',
    switchServer: () => switched++,
  });
  const app = (template[0]?.submenu ?? []) as { label?: string; click?: () => void }[];
  const item = app.find((i) => i.label === 'Switch Server…');
  assert.ok(item, 'no Switch Server… item');
  item.click?.();
  assert.equal(switched, 1);
});
