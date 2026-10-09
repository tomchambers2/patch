// A host's half of the shared settings (spec/01 § Settings): how Claude Code's
// settings.json is written without trampling a change made on the machine, and
// how a Codex login is found to be sent up.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeSettingsFile,
  claudeSettingsFor,
  codexKeyringUser,
  readCodexAuth,
  sameSettings,
  settingsOs,
  writeCodexAuth,
} from '../src/sharedSettings.js';

let dir: string;
let claudeHome: string;
let patchHome: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-shared-settings-'));
  claudeHome = join(dir, 'claude');
  patchHome = join(dir, 'patch');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (): string => join(claudeHome, 'settings.json');
const read = (): string => (existsSync(file()) ? readFileSync(file(), 'utf8') : '');

describe('claudeSettingsFor', () => {
  it('lays the OS override’s top-level keys over the shared ones', () => {
    const text = claudeSettingsFor(
      { shared: '{"model":"opus","hooks":{"a":1}}', darwin: '{"hooks":{"b":2}}', linux: '' },
      'darwin',
    );
    expect(JSON.parse(text)).toEqual({ model: 'opus', hooks: { b: 2 } });
    expect(
      JSON.parse(
        claudeSettingsFor({ shared: '{"model":"opus"}', darwin: '{"x":1}', linux: '' }, 'linux'),
      ),
    ).toEqual({
      model: 'opus',
    });
  });

  it('is empty when nothing is set, so no file is written for a setting nobody made', () => {
    expect(claudeSettingsFor({ shared: '', darwin: '', linux: '' }, 'linux')).toBe('');
  });

  it('refuses text that is not a JSON object, naming the part', () => {
    expect(() => claudeSettingsFor({ shared: '[1]', darwin: '', linux: '' }, 'linux')).toThrow(
      /claudeSettings.shared is not a JSON object/,
    );
  });

  it('names only the platforms it can key an override by', () => {
    expect(settingsOs('darwin')).toBe('darwin');
    expect(settingsOs('linux')).toBe('linux');
    expect(() => settingsOs('win32')).toThrow(/no override/);
  });
});

describe('sameSettings', () => {
  it('compares what the text says, not how it is formatted', () => {
    expect(sameSettings('{"a":1,"b":[1,2]}', '{\n  "b": [1, 2],\n  "a": 1\n}')).toBe(true);
    expect(sameSettings('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameSettings('', '  ')).toBe(true);
  });
});

describe('ClaudeSettingsFile', () => {
  it('writes the shared text when the machine has no file', () => {
    const f = new ClaudeSettingsFile(claudeHome, patchHome);
    expect(f.apply('{"model":"opus"}\n')).toBeUndefined();
    expect(read()).toBe('{"model":"opus"}\n');
  });

  it('adopts a file that already says what the shared settings say, without rewriting it', () => {
    const f = new ClaudeSettingsFile(claudeHome, patchHome);
    f.apply('');
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(file(), '{ "model": "opus" }');
    const f2 = new ClaudeSettingsFile(claudeHome, patchHome);
    expect(f2.apply('{"model":"opus"}\n')).toBeUndefined();
    expect(read()).toBe('{ "model": "opus" }');
  });

  it('reports a file changed on the machine as drift and leaves it alone', () => {
    const f = new ClaudeSettingsFile(claudeHome, patchHome);
    f.apply('{"model":"opus"}\n');
    writeFileSync(file(), '{"model":"sonnet"}');
    expect(f.apply('{"model":"haiku"}\n')).toBe('{"model":"sonnet"}');
    expect(read()).toBe('{"model":"sonnet"}');
    expect(f.drift()).toBe('{"model":"sonnet"}');
  });

  it('treats a first-seen file that differs from the shared settings as drift, not something to overwrite', () => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(file(), '{"permissions":{"allow":["Bash"]}}');
    const f = new ClaudeSettingsFile(claudeHome, patchHome);
    expect(f.apply('{"model":"opus"}\n')).toBe('{"permissions":{"allow":["Bash"]}}');
    expect(read()).toBe('{"permissions":{"allow":["Bash"]}}');
  });

  it('discard rewrites the file from the shared settings and clears the drift', () => {
    const f = new ClaudeSettingsFile(claudeHome, patchHome);
    f.apply('{"model":"opus"}\n');
    writeFileSync(file(), '{"model":"sonnet"}');
    f.apply('{"model":"opus"}\n');
    f.discard();
    expect(read()).toBe('{"model":"opus"}\n');
    expect(f.drift()).toBeUndefined();
    // And the next snapshot writes again.
    expect(f.apply('{"model":"haiku"}\n')).toBeUndefined();
    expect(read()).toBe('{"model":"haiku"}\n');
  });

  it('once the machine’s change is taken into the shared settings, it is in step again', () => {
    const f = new ClaudeSettingsFile(claudeHome, patchHome);
    f.apply('{"model":"opus"}\n');
    writeFileSync(file(), '{"model":"sonnet"}');
    expect(f.apply('{"model":"opus"}\n')).toBeDefined();
    expect(f.apply('{"model":"sonnet"}\n')).toBeUndefined();
    expect(f.drift()).toBeUndefined();
  });
});

describe('Codex logins', () => {
  it('reads auth.json when Codex stores to a file, and writes one with mode 0600', () => {
    const home = join(dir, 'codex-a');
    writeCodexAuth(home, '{"tokens":{"access_token":"x"}}');
    expect(readCodexAuth(home)).toBe('{"tokens":{"access_token":"x"}}');
    expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('falls back to the keyring entry Codex keeps for that home, and says none when there is none', () => {
    const home = join(dir, 'codex-b');
    const calls: string[][] = [];
    const found = readCodexAuth(home, (cmd, args) => {
      calls.push([cmd, ...args]);
      return '{"tokens":{}}\n';
    });
    expect(found).toBe('{"tokens":{}}');
    expect(calls[0]).toContain(codexKeyringUser(home));
    expect(
      readCodexAuth(home, () => {
        throw new Error('no such secret');
      }),
    ).toBeUndefined();
  });

  it('names the keyring entry the way Codex does: a hash of the home path', () => {
    expect(
      codexKeyringUser('/home/claude-dev/.patch/openai/e8b86f06-3e98-4a17-86bd-a2e37938d479'),
    ).toBe('cli|3f5e791a694533dc');
  });
});
