// Host files (spec/03 § Host files, spec/15 § Host files and terminal).
//
// List, read and write files on THIS machine by absolute path, with no chat in
// between. The chat-scoped file browser (`patch.files.*`) resolves everything
// against a chat's pinned folder, so a file outside every chat — a skill in
// `~/.claude/skills`, a dotfile — could not be reached without opening a chat
// first. This is the host-level counterpart the phone's Files screen uses.
//
// NOT confined to the project roots, on purpose: the same surface can already
// open a shell here (`terminal.ts`), which reaches every file the host's user
// can. A narrower file API would guard nothing and make the common case — a
// file under $HOME — unreachable. The gate is the host-addressed one every RPC
// has: an authenticated surface naming a registered host.
//
// NO FALLBACK anywhere: a relative or un-normalised path is refused rather than
// resolved against something the surface did not name; a binary or oversized
// file is refused rather than opened mangled or truncated; and a save whose
// base is no longer what is on disk is refused rather than silently
// overwriting someone else's change.

import { createHash, randomBytes } from 'node:crypto';
import { open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import type { Logger } from 'pino';
import type { HostFilesEntry, PatchHostFilesRequestEvent, WireEvent } from '@patch/wire';

/**
 * The editor's size cap. A phone editing a file bigger than this is not editing
 * it, and the whole content rides one JSON frame each way.
 */
export const HOST_FILE_MAX_BYTES = 1024 * 1024;

type ErrorCode = NonNullable<
  Extract<WireEvent, { type: 'patch.host_files.response' }>['error']
>['code'];

class HostFileError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** SHA-256 hex of some bytes — the `version` a write must echo back. */
export function contentVersion(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Absolute and already normal: `posix.normalize` would change nothing, and no
 * trailing slash except on `/` itself. Anything else is ambiguous about which
 * file it means, so it is refused instead of guessed at.
 */
export function isCanonicalAbsolute(path: string): boolean {
  if (!isAbsolute(path)) return false;
  if (posix.normalize(path) !== path) return false;
  return path === '/' || !path.endsWith('/');
}

/** Is this buffer text the editor can show and save back byte-for-byte? */
export function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Map a node:fs failure onto the response's typed codes. */
function fsError(err: unknown, path: string): HostFileError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new HostFileError('not_found', `nothing at ${path}`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new HostFileError('permission_denied', `permission denied: ${path}`);
  }
  return new HostFileError('internal', `${path}: ${(err as Error).message}`);
}

export interface HostFilesOptions {
  /** Where a path-less `list` starts. The host user's home directory. */
  home?: string;
  /**
   * Told the real path of every file a `write` committed, so chats whose folder
   * holds it can tell their surfaces it changed (spec/14 § File browser — live
   * updates).
   */
  onWritten?: (absPath: string) => void;
}

type Ok = Omit<
  Extract<WireEvent, { type: 'patch.host_files.response' }>,
  'type' | 'requestId' | 'daemonId' | 'ok' | 'error'
>;

async function list(path: string): Promise<Ok> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    throw fsError(err, path);
  }
  if (!info.isDirectory()) {
    throw new HostFileError('not_a_directory', `not a directory: ${path}`);
  }
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    throw fsError(err, path);
  }
  const entries: HostFilesEntry[] = [];
  for (const d of dirents) {
    const full = join(path, d.name);
    // A symlink is listed as what it points at (a linked skills dir is a dir
    // to the person browsing), and a dangling one as `other` rather than
    // dropped — it is really there.
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    let size: number | undefined;
    if (d.isSymbolicLink() || isFile) {
      try {
        const s = await stat(full);
        isDir = s.isDirectory();
        isFile = s.isFile();
        if (isFile) size = s.size;
      } catch {
        isDir = false;
        isFile = false;
      }
    }
    const type = isDir ? 'dir' : isFile ? 'file' : 'other';
    entries.push({ name: d.name, type, ...(size !== undefined ? { size } : {}) });
  }
  entries.sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path, parent: path === '/' ? null : dirname(path), entries };
}

/** Stat a path that must be an existing regular file within the size cap. */
async function requireEditableFile(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    throw fsError(err, path);
  }
  if (!info.isFile()) throw new HostFileError('not_a_file', `not a file: ${path}`);
  if (info.size > HOST_FILE_MAX_BYTES) {
    throw new HostFileError(
      'too_large',
      `${path} is ${info.size} bytes; the editor opens files up to ${HOST_FILE_MAX_BYTES}`,
    );
  }
}

async function read(path: string): Promise<Ok> {
  await requireEditableFile(path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw fsError(err, path);
  }
  if (!isUtf8Text(bytes)) {
    throw new HostFileError('binary', `${path} is not UTF-8 text`);
  }
  return {
    path,
    content: bytes.toString('utf8'),
    size: bytes.length,
    version: contentVersion(bytes),
  };
}

async function write(
  path: string,
  content: string,
  baseVersion: string,
  onWritten: ((absPath: string) => void) | undefined,
): Promise<Ok> {
  if (Buffer.byteLength(content, 'utf8') > HOST_FILE_MAX_BYTES) {
    throw new HostFileError('too_large', `content is over ${HOST_FILE_MAX_BYTES} bytes`);
  }
  await requireEditableFile(path);
  // Write to what the path REALLY is: renaming a temp file over a symlink would
  // replace the link with a plain file and leave its target unedited.
  let target: string;
  try {
    target = await realpath(path);
  } catch (err) {
    throw fsError(err, path);
  }
  let current: Buffer;
  let mode: number;
  try {
    current = await readFile(target);
    mode = (await stat(target)).mode & 0o7777;
  } catch (err) {
    throw fsError(err, path);
  }
  if (contentVersion(current) !== baseVersion) {
    throw new HostFileError(
      'conflict',
      `${path} changed on disk since it was opened; reopen it to see the new version`,
    );
  }
  const bytes = Buffer.from(content, 'utf8');
  // Atomic: temp file beside the target (same filesystem, so the rename is
  // atomic), fsynced, then renamed over it — a reader sees the whole old file
  // or the whole new one, never half.
  const tmp = join(
    dirname(target),
    `.${basename(target)}.patch-tmp-${randomBytes(6).toString('hex')}`,
  );
  try {
    const fh = await open(tmp, 'wx', mode);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw fsError(err, path);
  }
  onWritten?.(target);
  return { path, size: bytes.length, version: contentVersion(bytes) };
}

/**
 * Answer one `patch.host_files.request`. Every outcome — success or a typed
 * refusal — goes back as exactly one `patch.host_files.response`.
 */
export async function handleHostFilesRequest(
  event: PatchHostFilesRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
  daemonId: string,
  opts: HostFilesOptions = {},
): Promise<void> {
  const base = {
    type: 'patch.host_files.response' as const,
    requestId: event.requestId,
    daemonId,
  };
  try {
    let result: Ok;
    if (event.op === 'list' && event.path === undefined) {
      result = await list(opts.home ?? homedir());
    } else {
      const path = event.path;
      if (path === undefined || !isCanonicalAbsolute(path)) {
        throw new HostFileError(
          'path_invalid',
          `path must be absolute and normalised: ${path ?? '(none)'}`,
        );
      }
      if (event.op === 'list') result = await list(path);
      else if (event.op === 'read') result = await read(path);
      else {
        if (event.content === undefined || event.baseVersion === undefined) {
          throw new HostFileError('path_invalid', 'a write needs content and baseVersion');
        }
        result = await write(path, event.content, event.baseVersion, opts.onWritten);
      }
    }
    sender({ ...base, ok: true, ...result });
  } catch (err) {
    const e =
      err instanceof HostFileError ? err : new HostFileError('internal', (err as Error).message);
    if (e.code === 'internal') {
      logger.warn({ op: event.op, path: event.path, err: e.message }, 'host files request failed');
    }
    sender({ ...base, ok: false, error: { code: e.code, message: e.message } });
  }
}
