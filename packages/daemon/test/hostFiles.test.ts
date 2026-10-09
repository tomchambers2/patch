// Host files RPC on the host (spec/03 § Host files).
//
// Real files in a temp dir — the handler's whole job is what lands on disk, so
// nothing about the filesystem is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { PatchHostFilesRequestEvent, WireEvent } from '@patch/wire';
import {
  HOST_FILE_MAX_BYTES,
  contentVersion,
  handleHostFilesRequest,
  isCanonicalAbsolute,
  isUtf8Text,
} from '../src/hostFiles.js';

type Response = Extract<WireEvent, { type: 'patch.host_files.response' }>;

const logger = pino({ level: 'silent' });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-hostfiles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function ask(
  req: Omit<PatchHostFilesRequestEvent, 'type' | 'requestId' | 'daemonId'>,
  opts: Parameters<typeof handleHostFilesRequest>[4] = {},
): Promise<Response> {
  const sent: WireEvent[] = [];
  await handleHostFilesRequest(
    { type: 'patch.host_files.request', requestId: 'r1', daemonId: 'd1', ...req },
    (e) => sent.push(e),
    logger,
    'd1',
    opts,
  );
  expect(sent).toHaveLength(1);
  const res = sent[0] as Response;
  expect(res).toMatchObject({ type: 'patch.host_files.response', requestId: 'r1', daemonId: 'd1' });
  return res;
}

describe('isCanonicalAbsolute', () => {
  it('accepts only absolute, already-normal paths', () => {
    expect(isCanonicalAbsolute('/')).toBe(true);
    expect(isCanonicalAbsolute('/home/tom/.claude')).toBe(true);
    for (const bad of ['rel/path', '', '/a/../b', '/a/./b', '/a//b', '/a/', '~/x']) {
      expect(isCanonicalAbsolute(bad), bad).toBe(false);
    }
  });
});

describe('isUtf8Text', () => {
  it('tells text from binary', () => {
    expect(isUtf8Text(Buffer.from('héllo ☃\n'))).toBe(true);
    expect(isUtf8Text(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(isUtf8Text(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
  });
});

describe('list', () => {
  it('lists a directory, directories first then by name, with file sizes and the parent', async () => {
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'b.md'), 'bb');
    writeFileSync(join(dir, '.hidden'), 'x');
    mkdirSync(join(dir, 'a-dir'));
    const res = await ask({ op: 'list', path: dir });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(dir);
    expect(res.parent).toBe(join(dir, '..').replace(/\/$/, ''));
    expect(res.entries).toEqual([
      { name: 'a-dir', type: 'dir' },
      { name: 'skills', type: 'dir' },
      { name: '.hidden', type: 'file', size: 1 },
      { name: 'b.md', type: 'file', size: 2 },
    ]);
  });

  it('lists a symlink as what it points at, and a dangling one as other', async () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'linked'));
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
    const res = await ask({ op: 'list', path: dir });
    expect(res.entries).toEqual([
      { name: 'linked', type: 'dir' },
      { name: 'real', type: 'dir' },
      { name: 'dangling', type: 'other' },
    ]);
  });

  it('with NO path lists the home directory and says where that is', async () => {
    writeFileSync(join(dir, 'profile'), 'x');
    const res = await ask({ op: 'list' }, { home: dir });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(dir);
    expect(res.entries?.map((e) => e.name)).toEqual(['profile']);
  });

  it('the root has no parent', async () => {
    const res = await ask({ op: 'list', path: '/' });
    expect(res.ok).toBe(true);
    expect(res.parent).toBeNull();
  });

  it('refuses a file, a missing path, and a relative path — each with its own code', async () => {
    writeFileSync(join(dir, 'f.txt'), 'x');
    expect((await ask({ op: 'list', path: join(dir, 'f.txt') })).error?.code).toBe(
      'not_a_directory',
    );
    expect((await ask({ op: 'list', path: join(dir, 'nope') })).error?.code).toBe('not_found');
    expect((await ask({ op: 'list', path: 'relative/dir' })).error?.code).toBe('path_invalid');
    expect((await ask({ op: 'list', path: `${dir}/../x` })).error?.code).toBe('path_invalid');
  });
});

describe('read', () => {
  it('returns the content, its size and a version that is the hash of the bytes', async () => {
    writeFileSync(join(dir, 'SKILL.md'), '# plant ☃\n');
    const res = await ask({ op: 'read', path: join(dir, 'SKILL.md') });
    expect(res).toMatchObject({
      ok: true,
      path: join(dir, 'SKILL.md'),
      content: '# plant ☃\n',
      size: Buffer.byteLength('# plant ☃\n'),
      version: contentVersion(Buffer.from('# plant ☃\n')),
    });
  });

  it('refuses a directory, a binary file, an oversized file and a missing path', async () => {
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'bin'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(dir, 'big'), 'x'.repeat(HOST_FILE_MAX_BYTES + 1));
    expect((await ask({ op: 'read', path: join(dir, 'd') })).error?.code).toBe('not_a_file');
    expect((await ask({ op: 'read', path: join(dir, 'bin') })).error?.code).toBe('binary');
    expect((await ask({ op: 'read', path: join(dir, 'big') })).error?.code).toBe('too_large');
    expect((await ask({ op: 'read', path: join(dir, 'none') })).error?.code).toBe('not_found');
    expect((await ask({ op: 'read' })).error?.code).toBe('path_invalid');
  });

  it('says permission_denied when the host user cannot read it', async () => {
    if (process.getuid?.() === 0) return; // root reads everything
    writeFileSync(join(dir, 'secret'), 'x');
    chmodSync(join(dir, 'secret'), 0o000);
    expect((await ask({ op: 'read', path: join(dir, 'secret') })).error?.code).toBe(
      'permission_denied',
    );
  });
});

describe('write', () => {
  it('saves over the version it was opened at, keeps the mode, and reports the new version', async () => {
    const file = join(dir, 'run.sh');
    writeFileSync(file, 'echo old\n');
    chmodSync(file, 0o755);
    const onWritten = vi.fn();
    const res = await ask(
      {
        op: 'write',
        path: file,
        content: 'echo new\n',
        baseVersion: contentVersion('echo old\n'),
      },
      { onWritten },
    );
    expect(res).toMatchObject({ ok: true, path: file, version: contentVersion('echo new\n') });
    expect(readFileSync(file, 'utf8')).toBe('echo new\n');
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(onWritten).toHaveBeenCalledWith(file);
    // No temp file left behind.
    expect(readdirSync(dir)).toEqual(['run.sh']);
  });

  it('refuses a save whose base is no longer what is on disk, and writes nothing', async () => {
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, 'v1');
    const opened = contentVersion('v1');
    writeFileSync(file, 'v2 from the agent');
    const onWritten = vi.fn();
    const res = await ask(
      { op: 'write', path: file, content: 'v1 edited', baseVersion: opened },
      { onWritten },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('conflict');
    expect(readFileSync(file, 'utf8')).toBe('v2 from the agent');
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('writes THROUGH a symlink, leaving the link a link', async () => {
    const real = join(dir, 'real.md');
    writeFileSync(real, 'a');
    symlinkSync(real, join(dir, 'link.md'));
    const onWritten = vi.fn();
    const res = await ask(
      { op: 'write', path: join(dir, 'link.md'), content: 'b', baseVersion: contentVersion('a') },
      { onWritten },
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('b');
    expect(onWritten).toHaveBeenCalledWith(real);
    expect(readdirSync(dir).sort()).toEqual(['link.md', 'real.md']);
  });

  it('never creates a file: a missing target is not_found', async () => {
    const res = await ask({
      op: 'write',
      path: join(dir, 'new.md'),
      content: 'x',
      baseVersion: contentVersion(''),
    });
    expect(res.error?.code).toBe('not_found');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a write missing content or base, and content over the cap', async () => {
    const file = join(dir, 'f');
    writeFileSync(file, 'x');
    expect((await ask({ op: 'write', path: file, content: 'y' })).error?.code).toBe('path_invalid');
    expect(
      (await ask({ op: 'write', path: file, baseVersion: contentVersion('x') })).error?.code,
    ).toBe('path_invalid');
    expect(
      (
        await ask({
          op: 'write',
          path: file,
          content: 'y'.repeat(HOST_FILE_MAX_BYTES + 1),
          baseVersion: contentVersion('x'),
        })
      ).error?.code,
    ).toBe('too_large');
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('a write the directory refuses is permission_denied, and leaves no temp file', async () => {
    if (process.getuid?.() === 0) return;
    const sub = join(dir, 'locked');
    mkdirSync(sub);
    const file = join(sub, 'f');
    writeFileSync(file, 'x');
    chmodSync(sub, 0o555);
    try {
      const res = await ask({
        op: 'write',
        path: file,
        content: 'y',
        baseVersion: contentVersion('x'),
      });
      expect(res.error?.code).toBe('permission_denied');
      expect(readdirSync(sub)).toEqual(['f']);
    } finally {
      chmodSync(sub, 0o755);
    }
  });
});
