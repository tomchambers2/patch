// Every command the patch-cli skill tells an agent to run must exist.
//
// The skill documented `patch daemon status --json | patch daemon list --json`
// under Diagnostics; the CLI has no `daemon` group, so the first thing an agent
// ran to diagnose a problem died with "unknown command 'daemon'".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, '..', '..', 'daemon', 'skill', 'patch-cli', 'SKILL.md');
const entry = join(here, '..', 'src', 'index.ts');

function documentedCommands(): string[][] {
  const text = readFileSync(skillPath, 'utf8');
  const out: string[][] = [];
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split('\n')) {
      for (const seg of line.replace(/\s+#.*$/, '').split('|')) {
        const m = /^\s*patch\s+(.*)$/.exec(seg);
        if (!m) continue;
        const words: string[] = [];
        for (const w of m[1]!.trim().split(/\s+/)) {
          if (!/^[a-z][a-z-]*$/.test(w)) break;
          words.push(w);
        }
        if (words.length > 0) out.push(words);
      }
    }
  }
  return out;
}

const helpCache = new Map<string, string>();
function helpFor(path: string[]): string {
  const key = path.join(' ');
  let h = helpCache.get(key);
  if (h === undefined) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...path, '--help'], {
      encoding: 'utf8',
    });
    h = r.stdout + r.stderr;
    helpCache.set(key, h);
  }
  return h;
}

// Words after the command path may be positional arguments (`chats get <id>`),
// so walk only while the parent's help lists the next word as a subcommand.
function resolves(words: string[]): boolean {
  const top = helpFor([]);
  if (!new RegExp(`^  ${words[0]}[ \\n]`, 'm').test(top)) return false;
  let path = [words[0]!];
  for (const w of words.slice(1)) {
    const help = helpFor(path);
    const commands = help.split(/^Commands:\n/m)[1];
    if (commands === undefined) return true; // leaf: rest are arguments
    if (!new RegExp(`^  ${w}[ |\\n]`, 'm').test(commands)) return false;
    path = [...path, w];
  }
  return true;
}

test('the skill documents at least one command', () => {
  assert.ok(documentedCommands().length > 10);
});

test('every command the patch-cli skill documents exists in the CLI', () => {
  const missing = documentedCommands()
    .filter((w) => !resolves(w))
    .map((w) => `patch ${w.join(' ')}`);
  assert.deepEqual([...new Set(missing)], []);
});
