// Pads — the host half (spec/14 § Pads).
//
// The agent's `patch_pad_*` tools run here, where the design's files are. The
// server owns the Pad (its screens, Tom's changes, the pictures), so a create or
// an update ships the folder's files over `patch.pad.request` and parks the
// promise until `patch.pad.response` comes back — same shape as
// `ArtifactPublisher`. NO FALLBACK: a path outside the chat folder, an empty
// folder, a downed link or a server-side refusal all raise; nothing pretends.

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { PatchPadResponseEvent } from '@patch/wire';

/** A Pad's files, raw. The server caps the whole bundle too. */
export const MAX_PAD_BYTES = 25 * 1024 * 1024;

export class PadInputError extends Error {
  override readonly name = 'PadInputError';
}

export interface PadBundleFile {
  path: string;
  base64: string;
}

/**
 * Read `dir` (chat-folder-relative) into the file list a Pad is made of.
 * Dotfiles and node_modules are skipped; an absolute path or a `..` escape is
 * refused, as is a folder with nothing in it.
 */
export function bundleDir(folder: string, dir: string): PadBundleFile[] {
  if (!dir) throw new PadInputError('dir is required');
  if (isAbsolute(dir))
    throw new PadInputError(`dir must be relative to the chat folder (got ${dir})`);
  const root = resolve(folder, dir);
  const rel = relative(resolve(folder), root);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PadInputError(`dir must resolve inside the chat folder (got ${dir})`);
  }
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new PadInputError(`no such folder in the chat folder: ${dir}`);
  }
  if (!st.isDirectory()) throw new PadInputError(`not a folder: ${dir}`);
  const files: PadBundleFile[] = [];
  let total = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      const data = readFileSync(p);
      total += data.length;
      if (total > MAX_PAD_BYTES) {
        throw new PadInputError(
          `the folder is over ${MAX_PAD_BYTES} bytes — a Pad holds screens, not a whole project`,
        );
      }
      files.push({
        path: relative(root, p).split('\\').join('/'),
        base64: data.toString('base64'),
      });
    }
  };
  walk(root);
  if (files.length === 0) throw new PadInputError(`${dir} has no files to put in a Pad`);
  if (!existsSync(join(root, 'index.html')) && !existsSync(join(root, 'pad.json'))) {
    throw new PadInputError(`no index.html or pad.json in ${dir}`);
  }
  return files;
}

export interface PadRequestInput {
  op: 'create' | 'update' | 'reply' | 'list';
  chatId: string;
  padId?: string;
  name?: string;
  app?: string;
  device?: 'desktop' | 'phone';
  files?: PadBundleFile[];
  text?: string;
}

/** What `control.ts` calls; resolves with the server's `result`. */
export type PadRequest = (input: PadRequestInput) => Promise<unknown>;

export interface PadClientOptions {
  emit: (event: WireEvent) => void;
  isLinkOnline: () => boolean;
  requestTimeoutMs?: number;
  idGen?: () => string;
}

export class PadClient {
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly emit: (event: WireEvent) => void;
  private readonly isLinkOnline: () => boolean;
  private readonly timeoutMs: number;
  private readonly idGen: () => string;

  constructor(opts: PadClientOptions) {
    this.emit = opts.emit;
    this.isLinkOnline = opts.isLinkOnline;
    this.timeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.idGen = opts.idGen ?? ((): string => randomUUID());
  }

  /** Feed a `patch.pad.response` in. True when it matched a waiting request. */
  handleResponse(event: WireEvent): boolean {
    if (event.type !== 'patch.pad.response') return false;
    const parsed = PatchPadResponseEvent.safeParse(event);
    if (!parsed.success) return false;
    const waiter = this.pending.get(parsed.data.requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.pending.delete(parsed.data.requestId);
    if (parsed.data.ok) waiter.resolve(parsed.data.result);
    else
      waiter.reject(
        new Error(parsed.data.error?.message ?? 'the pad request failed on the server'),
      );
    return true;
  }

  request: PadRequest = (input) => {
    if (!this.isLinkOnline()) return Promise.reject(new Error('pad: host→server link is offline'));
    const requestId = this.idGen();
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`pad request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve: resolvePromise, reject, timer });
      this.emit({ type: 'patch.pad.request', requestId, ...input } as WireEvent);
    });
  };
}
