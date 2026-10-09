// What the composer's `/` picker offers (spec/14 § Composer — skill
// autocomplete), against the layouts real projects actually use.
//
// The picker read exactly one directory: `<folder>/.claude/skills`. It misses
// the MACHINE's own skills, in `~/.claude/skills`, which apply in every folder
// on it — so a project with none showed nothing at all, while the agent behind
// the composer would happily run several.
//
// Skills only. `.claude/commands` is a different thing and is not offered here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { handleSkillsRequest } from '../src/index.js';

const silent = pino({ level: 'silent' });

let home: string;
let folder: string;
let priorHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-skills-home-'));
  folder = join(home, 'project');
  mkdirSync(folder, { recursive: true });
  priorHome = process.env['HOME'];
  process.env['HOME'] = home;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  rmSync(home, { recursive: true, force: true });
});

function skill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}\n`);
}

function skillWithFrontmatter(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function respond(): Promise<{
  ok: boolean;
  skills?: string[];
  paths?: Record<string, string>;
  descriptions?: Record<string, string>;
  frontmatter?: Record<string, Record<string, string>>;
}> {
  const sent: WireEvent[] = [];
  await handleSkillsRequest(
    { type: 'patch.skills.request', requestId: 'r', folder, daemonId: 'd1' },
    (e) => sent.push(e),
    silent,
  );
  const res = sent[0] as {
    ok: boolean;
    skills?: string[];
    paths?: Record<string, string>;
    descriptions?: Record<string, string>;
    frontmatter?: Record<string, Record<string, string>>;
  };
  expect(res.ok).toBe(true);
  return res;
}

async function list(): Promise<string[]> {
  return (await respond()).skills ?? [];
}

async function paths(): Promise<Record<string, string>> {
  return (await respond()).paths ?? {};
}

async function descriptions(): Promise<Record<string, string>> {
  return (await respond()).descriptions ?? {};
}

async function frontmatter(): Promise<Record<string, Record<string, string>>> {
  return (await respond()).frontmatter ?? {};
}

describe('the skills a folder offers', () => {
  it('offers the machine’s own skills too — they apply in every folder', async () => {
    skill(join(home, '.claude', 'skills'), 'patch-cli');
    skill(join(folder, '.claude', 'skills'), 'local-thing');

    expect(await list()).toEqual(['local-thing', 'patch-cli']);
  });

  it('names each skill once when the project and the machine both have it', async () => {
    skill(join(home, '.claude', 'skills'), 'plan');
    skill(join(folder, '.claude', 'skills'), 'plan');

    expect(await list()).toEqual(['plan']);
  });

  it('still says nothing when there is genuinely nothing', async () => {
    expect(await list()).toEqual([]);
  });

  it('does NOT offer commands — they are not skills', async () => {
    const commands = join(folder, '.claude', 'commands');
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(commands, 'deploy.md'), 'ship it\n');
    skill(commands, 'build');

    expect(await list()).toEqual([]);
  });

  it('follows a skills directory that is a symlink to where the repo keeps them', async () => {
    const real = join(folder, '.ai', 'skills');
    skill(real, 'plan');
    mkdirSync(join(folder, '.claude'), { recursive: true });
    symlinkSync(join('..', '.ai', 'skills'), join(folder, '.claude', 'skills'));

    expect(await list()).toEqual(['plan']);
  });
});

// Naming the file each skill is defined in is what lets a surface link to it
// (spec/14 § Jobs view — the Skill field's Edit link). A surface must never
// have to guess the path: the two layouts and the two directories put the same
// skill name in four different places.
describe('the file each skill is defined in', () => {
  it('names a directory-shaped skill’s SKILL.md', async () => {
    skill(join(folder, '.claude', 'skills'), 'forage');

    expect(await paths()).toEqual({
      forage: join(folder, '.claude', 'skills', 'forage', 'SKILL.md'),
    });
  });

  it('names a flat skill’s own .md file', async () => {
    mkdirSync(join(folder, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(folder, '.claude', 'skills', 'plan.md'), '# plan\n');

    expect(await paths()).toEqual({ plan: join(folder, '.claude', 'skills', 'plan.md') });
  });

  it('names the machine-wide skill’s file under the home directory', async () => {
    skill(join(home, '.claude', 'skills'), 'patch-cli');

    expect(await paths()).toEqual({
      'patch-cli': join(home, '.claude', 'skills', 'patch-cli', 'SKILL.md'),
    });
  });

  it('names the project’s copy, not the machine’s, when both define the skill', async () => {
    skill(join(home, '.claude', 'skills'), 'plan');
    skill(join(folder, '.claude', 'skills'), 'plan');

    expect(await paths()).toEqual({ plan: join(folder, '.claude', 'skills', 'plan', 'SKILL.md') });
  });

  it('names a symlinked skill through the folder, so it stays reachable under it', async () => {
    const real = join(folder, '.ai', 'skills');
    skill(real, 'plan');
    mkdirSync(join(folder, '.claude'), { recursive: true });
    symlinkSync(join('..', '.ai', 'skills'), join(folder, '.claude', 'skills'));

    expect(await paths()).toEqual({ plan: join(folder, '.claude', 'skills', 'plan', 'SKILL.md') });
  });

  it('names nothing when there is nothing', async () => {
    expect(await paths()).toEqual({});
  });
});

// A skill's frontmatter `description:` is what a surface shows as a tooltip
// (spec/14 ## Main chat panel — the Skill tool-call link). Parsed the same
// lenient way a memory file's frontmatter is (`parseFrontmatter` in
// `claudeSettings.ts`), reused rather than duplicated.
describe('the description each skill declares', () => {
  it('reads a directory-shaped skill’s frontmatter description', async () => {
    skillWithFrontmatter(join(folder, '.claude', 'skills'), 'forage', 'Find wild food nearby.');

    expect(await descriptions()).toEqual({ forage: 'Find wild food nearby.' });
  });

  it('reads a flat skill’s frontmatter description', async () => {
    mkdirSync(join(folder, '.claude', 'skills'), { recursive: true });
    writeFileSync(
      join(folder, '.claude', 'skills', 'plan.md'),
      '---\nname: plan\ndescription: Plan a trip.\n---\n\n# plan\n',
    );

    expect(await descriptions()).toEqual({ plan: 'Plan a trip.' });
  });

  it('leaves out a skill with no frontmatter at all', async () => {
    skill(join(folder, '.claude', 'skills'), 'forage');

    expect(await descriptions()).toEqual({});
  });

  it('leaves out a skill whose frontmatter has no description field', async () => {
    mkdirSync(join(folder, '.claude', 'skills', 'forage'), { recursive: true });
    writeFileSync(
      join(folder, '.claude', 'skills', 'forage', 'SKILL.md'),
      '---\nname: forage\n---\n\n# forage\n',
    );

    expect(await descriptions()).toEqual({});
  });

  it('names the machine-wide skill’s description too', async () => {
    skillWithFrontmatter(join(home, '.claude', 'skills'), 'patch-cli', 'Drive the patch CLI.');

    expect(await descriptions()).toEqual({ 'patch-cli': 'Drive the patch CLI.' });
  });

  it('names nothing when there is nothing', async () => {
    expect(await descriptions()).toEqual({});
  });
});

// The composer's skill preview panel (spec/14 § Skill autocomplete) shows
// the REST of a skill's frontmatter beyond its description — every field the
// file declares, not just the ones the host already had a use for.
describe('the whole frontmatter each skill declares', () => {
  it('reports every field a skill declares, hyphenated keys included', async () => {
    mkdirSync(join(folder, '.claude', 'skills', 'sync'), { recursive: true });
    writeFileSync(
      join(folder, '.claude', 'skills', 'sync', 'SKILL.md'),
      '---\nname: sync\ndescription: Sync everything.\nuser-invocable: true\n---\n\n# sync\n',
    );

    expect(await frontmatter()).toEqual({
      sync: { name: 'sync', description: 'Sync everything.', 'user-invocable': 'true' },
    });
  });

  it('leaves out a skill with no frontmatter at all', async () => {
    skill(join(folder, '.claude', 'skills'), 'forage');

    expect(await frontmatter()).toEqual({});
  });

  it('names nothing when there is nothing', async () => {
    expect(await frontmatter()).toEqual({});
  });
});
