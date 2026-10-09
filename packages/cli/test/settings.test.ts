// `patch settings`, `patch accounts`, `patch keys` (spec/17 § Commands,
// spec/01 § Settings): the shared settings, changed through the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerSettingsCommands } from '../src/commands/settings.js';

function build(): Command {
  const program = new Command();
  program.exitOverride();
  registerSettingsCommands(program);
  return program;
}

const group = (name: string): Command => {
  const cmd = build().commands.find((c) => c.name() === name);
  assert.ok(cmd, `${name} is registered`);
  return cmd;
};

test('settings has show (default), set and claude', () => {
  const subs = group('settings').commands.map((c) => c.name());
  for (const name of ['show', 'set', 'claude']) assert.ok(subs.includes(name), `settings ${name}`);
  const claude = group('settings').commands.find((c) => c.name() === 'claude');
  assert.ok(
    claude?.options.some((o) => o.long === '--os'),
    'settings claude takes --os',
  );
});

test('accounts covers the whole account list: list, add, connect, disconnect, remove, order, strategy, adopt', () => {
  const subs = group('accounts').commands.map((c) => c.name());
  for (const name of [
    'list',
    'add',
    'connect',
    'disconnect',
    'remove',
    'order',
    'strategy',
    'adopt',
  ]) {
    assert.ok(subs.includes(name), `accounts ${name} (have: ${subs.join(', ')})`);
  }
});

test('keys has list (default), set and revoke', () => {
  const subs = group('keys').commands.map((c) => c.name());
  for (const name of ['list', 'set', 'revoke']) assert.ok(subs.includes(name), `keys ${name}`);
});

test('none of them takes a machine to change — only adopt and keys set name one to read from', () => {
  for (const name of ['settings', 'accounts', 'keys']) {
    for (const cmd of group(name).commands) {
      const takesHost = cmd.options.some((o) => o.long === '--host');
      const readsFromHost =
        (name === 'accounts' && cmd.name() === 'adopt') ||
        (name === 'keys' && cmd.name() === 'set');
      assert.equal(takesHost, readsFromHost, `${name} ${cmd.name()} --host`);
    }
  }
});
