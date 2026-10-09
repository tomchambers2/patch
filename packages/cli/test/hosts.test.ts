// `patch hosts *` (spec/17 § Hosts and the CLI).
//
// There was no `hosts` command group at all, so machines were unreachable from
// the machine a person was sitting on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerHostsCommands } from '../src/commands/hosts.js';

function build(): Command {
  const program = new Command();
  program.exitOverride();
  registerHostsCommands(program);
  return program;
}

function hostsCmd(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === 'hosts');
  assert.ok(cmd, 'hosts command group is registered');
  return cmd;
}

test('every hosts subcommand the spec names is registered', () => {
  const names = hostsCmd(build())
    .commands.map((c) => c.name())
    .sort();
  for (const expected of [
    'list',
    'get',
    'add',
    'rename',
    'set-home',
    'folders',
    'backends',
    'models',
    'install',
    'uninstall',
    'update',
    'claude-settings',
    'memory',
    'pair-device',
    'remove',
  ]) {
    assert.ok(
      names.includes(expected),
      `hosts ${expected} is registered (have: ${names.join(', ')})`,
    );
  }
});

test('hosts remove REQUIRES --host, so a revocation is never aimed by default', () => {
  const remove = hostsCmd(build()).commands.find((c) => c.name() === 'remove');
  assert.ok(remove);
  const hostOpt = remove.options.find((o) => o.long === '--host');
  assert.ok(hostOpt, '--host option exists');
  assert.equal(hostOpt.required, true, '--host is required on remove');
});

test('the host-scoped commands take --host, defaulting to this machine', () => {
  const hosts = hostsCmd(build());
  for (const name of ['get', 'backends', 'models', 'update']) {
    const cmd = hosts.commands.find((c) => c.name() === name);
    assert.ok(cmd, `${name} exists`);
    assert.ok(
      cmd.options.some((o) => o.long === '--host'),
      `hosts ${name} accepts --host`,
    );
  }
});

test('pair-device takes no --host — the host adopts the device itself', () => {
  const cmd = hostsCmd(build()).commands.find((c) => c.name() === 'pair-device');
  assert.ok(cmd);
  assert.ok(!cmd.options.some((o) => o.long === '--host'), 'pair-device has no --host');
});

test('folders has add and remove under it', () => {
  const folders = hostsCmd(build()).commands.find((c) => c.name() === 'folders');
  assert.ok(folders);
  const subs = folders.commands.map((c) => c.name());
  assert.ok(subs.includes('add'));
  assert.ok(subs.includes('remove'));
});

test('claude-settings has get (default) and discard under it, both taking --host', () => {
  const claudeSettings = hostsCmd(build()).commands.find((c) => c.name() === 'claude-settings');
  assert.ok(claudeSettings);
  const subs = claudeSettings.commands.map((c) => c.name());
  assert.ok(subs.includes('get'));
  assert.ok(subs.includes('discard'));
  for (const name of ['get', 'discard']) {
    const cmd = claudeSettings.commands.find((c) => c.name() === name);
    assert.ok(cmd);
    assert.ok(
      cmd.options.some((o) => o.long === '--host'),
      `claude-settings ${name} accepts --host`,
    );
  }
});

test('memory has remove under it, taking --host', () => {
  const memory = hostsCmd(build()).commands.find((c) => c.name() === 'memory');
  assert.ok(memory);
  const remove = memory.commands.find((c) => c.name() === 'remove');
  assert.ok(remove);
  assert.ok(
    remove.options.some((o) => o.long === '--host'),
    'memory remove accepts --host',
  );
});

// spec/01 § Settings: shared settings are not a machine's to change.
test('no hosts command changes a shared setting', () => {
  const names = hostsCmd(build()).commands.map((c) => c.name());
  for (const gone of ['permission-mode', 'connect', 'disconnect']) {
    assert.ok(!names.includes(gone), `hosts ${gone} is gone (have: ${names.join(', ')})`);
  }
});
