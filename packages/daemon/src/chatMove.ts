// Moving a chat to another host (spec/04 § Moving a chat to another host) —
// the on-disk half. `ChatRunner` owns the in-memory half (refusing a busy chat,
// freezing it, loading it on the target, dropping it on the source); this file
// only turns a chat's files into a bundle and a bundle back into files.
//
// What a chat IS on disk, and so what a bundle carries:
//   - `~/.patch/chats/<id>/` — the history log, meta, seq index and the native
//     Claude session mirror (`native/claude/<sessionId>.jsonl`), which is what
//     the next turn on the target resumes from.
//   - the blobs its log references (`~/.patch/blobs/sha256/..`), since a large
//     tool result is only a `$blob` pointer in the log.
//   - the attachments its turns carried (`<folder>/.patch/attachments/`), with
//     their manifest entries, so the transcript still renders them.
//   - Claude Code's own transcript for each of its sessions, the resume source
//     of last resort when the mirror is missing or started late.
//
// The folder is the one thing that changes: the same work usually lives at a
// different path on another machine (`/Users/tom/wpp/Unite` → `/home/tom/Unite`),
// so every place the old folder is recorded as the session's working directory
// is rewritten to the new one.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ChatMoveBundle, ChatMoveFile } from '@patch/wire';
import { encodeFolder } from './history.js';
import { expandHome } from './expandHome.js';
import { ChatMeta } from './meta.js';

/**
 * The most a bundle may carry, in raw bytes. Base64 grows it by a third and the
 * frame has to fit under the link's 100 MiB WebSocket payload limit on both
 * hops, so this leaves room for the encoding and the JSON around it.
 */
export const MAX_MOVE_BUNDLE_BYTES = 48 * 1024 * 1024;

export class ChatMoveError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'busy'
      | 'unsupported'
      | 'folder_not_found'
      | 'already_exists'
      | 'too_large'
      | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'ChatMoveError';
  }
}

export interface ChatMovePaths {
  /** `~/.patch/chats`. */
  chatsRoot: string;
  /** `~/.patch/blobs`. */
  blobsDir: string;
  /** `~/.claude/projects`. */
  claudeProjectsRoot: string;
  /** `~/.patch/moved` — where a moved-away chat's directory is kept. */
  movedRoot: string;
}

const BLOB_REF = /"\$blob":"([0-9a-f]{64})"/g;
/** A temp file a crashed atomic write left behind — never part of the chat. */
const TEMP_FILE = /\.tmp\.\d+\.\d+$/;

function blobPath(blobsDir: string, sha: string): string {
  return join(blobsDir, 'sha256', sha.slice(0, 2), sha.slice(2));
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && !TEMP_FILE.test(name)) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** Every Claude session this chat has ever had, on any of its tracks. */
function claudeSessionIds(meta: ChatMeta): string[] {
  const ids = new Set<string>();
  if (meta.claudeSessionId && !meta.claudeSessionId.startsWith('codex-')) {
    ids.add(meta.claudeSessionId);
  }
  for (const b of meta.branches ?? []) {
    if (b.sessionId && !b.sessionId.startsWith('codex-')) ids.add(b.sessionId);
    const prior = b.harnessSessions?.claude?.sessionId;
    if (prior) ids.add(prior);
  }
  return [...ids];
}

/**
 * The chat's own entries from its folder's attachment manifest: the ones whose
 * stored file name appears in its history. The manifest is shared by every chat
 * in the folder, so taking all of it would copy other chats' files along.
 */
function ownAttachments(
  folder: string,
  historyText: string,
): { refs: Record<string, unknown>; files: string[] } {
  const dir = join(folder, '.patch', 'attachments');
  const manifestPath = join(dir, 'manifest.json');
  const refs: Record<string, unknown> = {};
  const files: string[] = [];
  if (!existsSync(manifestPath)) return { refs, files };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    { id: string; name: string }
  >;
  for (const [id, ref] of Object.entries(manifest)) {
    const base = ref.name.split(/[/\\]/).pop() ?? ref.name;
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'file';
    const fileName = `${id}-${safe}`;
    if (!historyText.includes(fileName)) continue;
    refs[id] = ref;
    if (existsSync(join(dir, fileName))) files.push(fileName);
  }
  return { refs, files };
}

/** Read everything the chat is on disk into one bundle. The caller has flushed the log. */
export function buildMoveBundle(chatId: string, paths: ChatMovePaths): ChatMoveBundle {
  const chatDir = join(paths.chatsRoot, chatId);
  const metaPath = join(chatDir, 'meta.json');
  if (!existsSync(metaPath)) throw new ChatMoveError('not_found', `no chat ${chatId} on this host`);
  const meta = ChatMeta.parse(JSON.parse(readFileSync(metaPath, 'utf8')));

  const files: ChatMoveFile[] = [];
  let total = 0;
  const add = (path: string, bytes: Buffer): void => {
    total += bytes.length;
    if (total > MAX_MOVE_BUNDLE_BYTES) {
      throw new ChatMoveError(
        'too_large',
        `this chat is over ${MAX_MOVE_BUNDLE_BYTES / 1024 / 1024} MB on disk, too big to move`,
      );
    }
    files.push({ path, data: bytes.toString('base64') });
  };

  for (const abs of filesUnder(chatDir)) {
    add(`chat/${relative(chatDir, abs).split(sep).join('/')}`, readFileSync(abs));
  }

  const logPath = join(chatDir, 'events.jsonl');
  const historyText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const shas = new Set<string>();
  for (const m of historyText.matchAll(BLOB_REF)) shas.add(m[1]!);
  for (const sha of shas) {
    const p = blobPath(paths.blobsDir, sha);
    // A log pointing at a blob this host does not have is a chat that is
    // already damaged; moving it would hide where the damage happened.
    if (!existsSync(p)) {
      throw new ChatMoveError('internal', `blob ${sha} referenced by the history is missing`);
    }
    add(`blob/${sha}`, readFileSync(p));
  }

  for (const sessionId of claudeSessionIds(meta)) {
    const p = join(paths.claudeProjectsRoot, encodeFolder(meta.folder), `${sessionId}.jsonl`);
    if (existsSync(p)) add(`transcript/${sessionId}.jsonl`, readFileSync(p));
  }

  const own = ownAttachments(meta.folder, historyText);
  for (const name of own.files) {
    add(`attachment/${name}`, readFileSync(join(meta.folder, '.patch', 'attachments', name)));
  }

  return { chatId, sourceFolder: meta.folder, files, attachments: own.refs };
}

/**
 * A session transcript with every entry that recorded the old folder as its
 * working directory pointed at the new one. Lines that are not JSON are kept
 * as they are — this is a copy, not a repair.
 */
function rehomeJsonl(text: string, from: string, to: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length === 0) return line;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry['cwd'] !== from) return line;
        return JSON.stringify({ ...entry, cwd: to });
      } catch {
        return line;
      }
    })
    .join('\n');
}

/** A path inside a bundle that would land outside where it belongs. */
function safeRel(rel: string): string {
  if (
    rel.length === 0 ||
    rel.startsWith('/') ||
    rel.split('/').some((p) => p === '..' || p === '')
  ) {
    throw new ChatMoveError('internal', `bundle path is not safe: ${rel}`);
  }
  return rel;
}

/**
 * Write a bundle onto this host as a chat that runs in `folder`, and return its
 * rewritten meta. Staged in a sibling directory and renamed into place, so a
 * failure part-way leaves no half-chat behind for the next restart to load.
 */
export function writeMoveBundle(
  bundle: ChatMoveBundle,
  requestedFolder: string,
  paths: ChatMovePaths,
  now: number,
): ChatMeta {
  // Typed the way a shell accepts a path — `~/projects/x` — but this never
  // goes through a shell, so expand it before any fs call.
  const folder = expandHome(requestedFolder);
  const chatDir = join(paths.chatsRoot, bundle.chatId);
  if (existsSync(chatDir)) {
    throw new ChatMoveError('already_exists', `this host already has chat ${bundle.chatId}`);
  }
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new ChatMoveError('folder_not_found', `${requestedFolder} is not a folder on this host`);
  }
  const from = bundle.sourceFolder;
  const stage = join(paths.chatsRoot, `.incoming-${bundle.chatId}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    let metaSeen = false;
    const transcripts: Array<{ sessionId: string; text: string }> = [];
    const attachments: Array<{ name: string; bytes: Buffer }> = [];
    for (const f of bundle.files) {
      const bytes = Buffer.from(f.data, 'base64');
      const slash = f.path.indexOf('/');
      const kind = f.path.slice(0, slash);
      const rel = safeRel(f.path.slice(slash + 1));
      if (kind === 'chat') {
        const dest = join(stage, ...rel.split('/'));
        mkdirSync(dirname(dest), { recursive: true });
        if (rel === 'meta.json') {
          metaSeen = true;
          const meta = ChatMeta.parse(JSON.parse(bytes.toString('utf8')));
          const moved: ChatMeta = {
            ...meta,
            folder,
            // What happened on the old host is not a fact about this one: an
            // errored chat arrives ready to take a turn, and a turn that was
            // owed there is not silently re-run here.
            ...(meta.status === 'errored' ? { status: 'active' as const } : {}),
            lastError: null,
            pendingTurns: [],
            updatedAt: now,
          };
          writeFileSync(dest, JSON.stringify(moved, null, 2));
        } else if (rel.startsWith('native/claude/') && rel.endsWith('.jsonl')) {
          writeFileSync(dest, rehomeJsonl(bytes.toString('utf8'), from, folder));
        } else {
          writeFileSync(dest, bytes);
        }
      } else if (kind === 'blob') {
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (sha !== rel) throw new ChatMoveError('internal', `blob ${rel} arrived corrupted`);
        const dest = blobPath(paths.blobsDir, sha);
        if (!existsSync(dest)) {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, bytes);
        }
      } else if (kind === 'transcript') {
        transcripts.push({ sessionId: rel.replace(/\.jsonl$/, ''), text: bytes.toString('utf8') });
      } else if (kind === 'attachment') {
        attachments.push({ name: rel, bytes });
      } else {
        throw new ChatMoveError('internal', `bundle carries an unknown kind of file: ${f.path}`);
      }
    }
    if (!metaSeen) throw new ChatMoveError('internal', 'bundle has no meta.json');

    const projectDir = join(paths.claudeProjectsRoot, encodeFolder(folder));
    for (const t of transcripts) {
      const dest = join(projectDir, `${t.sessionId}.jsonl`);
      const text = rehomeJsonl(t.text, from, folder);
      // A chat coming BACK finds its own older copy of the transcript here;
      // the one that travelled has every turn since, so it wins. A longer one
      // already here is left alone rather than cut short.
      if (existsSync(dest) && statSync(dest).size >= Buffer.byteLength(text)) continue;
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(dest, text);
    }

    const attachDir = join(folder, '.patch', 'attachments');
    if (attachments.length > 0 || Object.keys(bundle.attachments).length > 0) {
      mkdirSync(attachDir, { recursive: true });
      for (const a of attachments) {
        const dest = join(attachDir, a.name);
        if (!existsSync(dest)) writeFileSync(dest, a.bytes);
      }
      const manifestPath = join(attachDir, 'manifest.json');
      const manifest = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
        : {};
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...bundle.attachments }));
    }

    renameSync(stage, chatDir);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  return ChatMeta.parse(JSON.parse(readFileSync(join(chatDir, 'meta.json'), 'utf8')));
}

/**
 * Take a moved-away chat's directory out of the set this host loads, keeping
 * it under `~/.patch/moved/` so the move can be undone by hand. Returns where
 * it went.
 */
export function setAsideMovedChat(chatId: string, paths: ChatMovePaths, now: number): string {
  const chatDir = join(paths.chatsRoot, chatId);
  mkdirSync(paths.movedRoot, { recursive: true });
  const dest = join(paths.movedRoot, `${chatId}-${now}`);
  renameSync(chatDir, dest);
  return dest;
}
