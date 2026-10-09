// Pads — the shared, always-editable design spaces (spec/14 § Pads).
//
// A Pad is a set of screens (static HTML + assets the server stores) and the
// list of changes Tom has made on them: moves, resizes, text edits, deletions,
// notes, drawings. Every device reads the same state, so pending changes are
// shared. Each change is also appended to a journal so a stray delete never
// loses anything. Persisted as JSON under `<dataDir>/pads/<id>/`.
//
// The primary store: a corrupt `pad.json` throws loudly rather than reading as
// an empty Pad — Tom's changes are not recoverable otherwise.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class PadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const KINDS = ['move', 'resize', 'text', 'delete', 'note', 'draw', 'duplicate'] as const;
export type ChangeKind = (typeof KINDS)[number];
// Repeat edits of one element while pending fold into one change; notes,
// drawings and deletions never do.
const FOLDS: ChangeKind[] = ['move', 'resize', 'text'];
const COLOR = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function slugify(name: string): string {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return s || 'pad';
}

const newHex = (): string => randomBytes(6).toString('hex');

export type Device = 'desktop' | 'phone';

export interface Change {
  id: string;
  kind: ChangeKind;
  screen: string;
  status: 'pending' | 'sent' | 'done';
  createdAt: number;
  updatedAt?: number;
  batch?: string;
  target: { selector: string; label: string; context?: string };
  viewport?: { w: number; h: number };
  [k: string]: any;
}

export interface Batch {
  id: string;
  sentAt: number;
  changeIds: string[];
  status: 'sending' | 'sent' | 'done';
  pictures?: { name: string; numbers: number[] }[];
  reply?: string;
  repliedAt?: number;
}

export interface PadRecord {
  id: string;
  name: string;
  /** The app this Pad designs for ('Patch', 'Dog Log'…), or null for a blank one. */
  app: string | null;
  /** The chat Send delivers into, and the agent that owns the Pad's contents. */
  chatId: string;
  device: Device;
  createdAt: number;
  updatedAt: number;
  /** Bumped whenever the design's files change; open editors reload on it. */
  filesRev: number;
  changes: Change[];
  batches: Batch[];
  /** Why the card thumbnail could not be drawn, when it could not. */
  thumbError?: string;
  thumbRev?: number;
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export class PadStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  dir(id: string): string {
    return join(this.root, id);
  }
  filesDir(id: string): string {
    return join(this.dir(id), 'files');
  }
  picturesDir(id: string): string {
    return join(this.dir(id), 'pictures');
  }
  thumbFile(id: string): string {
    return join(this.dir(id), 'thumb.png');
  }
  private file(id: string): string {
    return join(this.dir(id), 'pad.json');
  }

  /**
   * Append-only record of every change as it was added, edited or removed, so
   * nothing Tom made can be lost to a stray delete.
   */
  journal(id: string, op: 'add' | 'update' | 'remove', change: Change): void {
    appendFileSync(
      join(this.dir(id), 'journal.jsonl'),
      `${JSON.stringify({ at: Date.now(), op, change })}\n`,
    );
  }

  journalFor(id: string): { at: number; op: string; change: Change }[] {
    const p = join(this.dir(id), 'journal.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { at: number; op: string; change: Change });
  }

  ids(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, 'pad.json')))
      .map((e) => e.name);
  }

  list(): PadRecord[] {
    return this.ids()
      .map((id) => this.get(id))
      .filter((p): p is PadRecord => p !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): PadRecord | null {
    if (!validId(id)) return null;
    const p = this.file(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as PadRecord;
  }

  mustGet(id: string): PadRecord {
    const p = this.get(id);
    if (!p) throw new PadError(404, `no pad "${id}"`);
    return p;
  }

  save(pad: PadRecord): PadRecord {
    pad.updatedAt = Date.now();
    mkdirSync(this.dir(pad.id), { recursive: true });
    writeJson(this.file(pad.id), pad);
    return pad;
  }

  /** Persist a record exactly as given — `updatedAt` included (an import keeps its history). */
  import(pad: PadRecord): void {
    mkdirSync(this.dir(pad.id), { recursive: true });
    writeJson(this.file(pad.id), pad);
  }

  create(input: { name: string; app: string | null; chatId: string; device: Device }): PadRecord {
    if (!input.name?.trim()) throw new PadError(400, 'a pad needs a name');
    if (!input.chatId)
      throw new PadError(400, 'chatId is required: Send delivers changes into this chat');
    let id = slugify(input.name);
    while (existsSync(this.dir(id)))
      id = `${slugify(input.name).slice(0, 44)}-${newHex().slice(0, 4)}`;
    const now = Date.now();
    return this.save({
      id,
      name: input.name.trim(),
      app: input.app,
      chatId: input.chatId,
      device: input.device,
      createdAt: now,
      updatedAt: now,
      filesRev: now,
      changes: [],
      batches: [],
    });
  }

  remove(id: string): void {
    this.mustGet(id);
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  touchFiles(id: string): PadRecord {
    const pad = this.mustGet(id);
    pad.filesRev = Math.max(Date.now(), pad.filesRev + 1);
    return this.save(pad);
  }

  /**
   * Record a change. Moves, resizes and text edits on the same element while
   * still pending fold into the one change, so dragging a thing three times
   * reads as one move rather than three.
   */
  addChange(id: string, input: unknown): Change {
    const pad = this.mustGet(id);
    const change = validateChange(input);
    if (FOLDS.includes(change.kind)) {
      const prior = pad.changes.find(
        (c) =>
          c.status === 'pending' &&
          c.kind === change.kind &&
          c.screen === change.screen &&
          c.target.selector === change.target.selector,
      );
      if (prior) {
        if (change.kind === 'text') change['before'] = prior['before'];
        if (change.kind === 'resize') {
          change['fromWidth'] = prior['fromWidth'];
          change['fromHeight'] = prior['fromHeight'];
        }
        Object.assign(prior, change, {
          id: prior.id,
          createdAt: prior.createdAt,
          updatedAt: Date.now(),
        });
        this.save(pad);
        this.journal(id, 'update', prior);
        return prior;
      }
    }
    const full: Change = { ...change, id: newHex(), status: 'pending', createdAt: Date.now() };
    pad.changes.push(full);
    this.save(pad);
    this.journal(id, 'add', full);
    return full;
  }

  updateChange(id: string, changeId: string, patch: Record<string, unknown>): Change {
    const pad = this.mustGet(id);
    const c = pad.changes.find((x) => x.id === changeId);
    if (!c) throw new PadError(404, `no change "${changeId}"`);
    if (c.status !== 'pending') throw new PadError(409, 'only a pending change can be edited');
    for (const key of ['text', 'offset', 'dx', 'dy', 'width', 'height', 'after']) {
      if (patch[key] !== undefined) c[key] = patch[key];
    }
    c.updatedAt = Date.now();
    this.save(pad);
    this.journal(id, 'update', c);
    return c;
  }

  removeChange(id: string, changeId: string): void {
    const pad = this.mustGet(id);
    const i = pad.changes.findIndex((x) => x.id === changeId);
    if (i < 0) throw new PadError(404, `no change "${changeId}"`);
    const target = pad.changes[i] as Change;
    if (target.status !== 'pending')
      throw new PadError(409, 'only a pending change can be removed');
    pad.changes.splice(i, 1);
    this.save(pad);
    this.journal(id, 'remove', target);
  }

  /** Start a batch of every pending change. Nothing is marked sent until `commitBatch`. */
  openBatch(id: string): { pad: PadRecord; batch: Batch; pending: Change[] } {
    const pad = this.mustGet(id);
    const pending = pad.changes.filter((c) => c.status === 'pending');
    if (pending.length === 0) throw new PadError(400, 'nothing to send');
    const batch: Batch = {
      id: newHex(),
      sentAt: Date.now(),
      changeIds: pending.map((c) => c.id),
      status: 'sending',
    };
    return { pad, batch, pending };
  }

  /**
   * Mark the batch sent. Reloads the Pad first: pictures take seconds to draw,
   * and Tom may have added or removed changes meanwhile — only the changes the
   * batch was opened with are marked, nothing else is overwritten.
   */
  commitBatch(id: string, batch: Batch): Batch {
    const pad = this.mustGet(id);
    batch.status = 'sent';
    batch.changeIds = batch.changeIds.filter((cid) => pad.changes.some((c) => c.id === cid));
    for (const c of pad.changes) {
      if (batch.changeIds.includes(c.id)) {
        c.status = 'sent';
        c.batch = batch.id;
      }
    }
    pad.batches.push(batch);
    this.save(pad);
    return batch;
  }

  /** The chat's answer: closes the oldest open batch and marks its changes done. */
  reply(id: string, text: string): PadRecord {
    if (!text || typeof text !== 'string') throw new PadError(400, 'reply text is required');
    const pad = this.mustGet(id);
    const open = pad.batches.find((b) => b.status === 'sent');
    if (!open) {
      throw new PadError(
        409,
        'no open batch for this pad — a reply answers a [Pad] message, and none is waiting',
      );
    }
    open.status = 'done';
    open.reply = text;
    open.repliedAt = Date.now();
    for (const c of pad.changes) if (c.batch === open.id) c.status = 'done';
    return this.save(pad);
  }
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new PadError(400, `${name} must be a number`);
  return Math.round(v);
}

export type NewChange = Pick<Change, 'kind' | 'screen' | 'target'> & Record<string, any>;

export function validateChange(input: unknown): NewChange {
  if (!input || typeof input !== 'object') throw new PadError(400, 'change must be an object');
  const inp = input as Record<string, any>;
  const { kind, target } = inp;
  if (!KINDS.includes(kind)) throw new PadError(400, `kind must be one of ${KINDS.join(', ')}`);
  if (!target || typeof target.selector !== 'string' || typeof target.label !== 'string') {
    throw new PadError(400, 'target.selector and target.label are required');
  }
  if (typeof inp['screen'] !== 'string' || !ID_RE.test(inp['screen'])) {
    throw new PadError(400, 'screen is required: every change belongs to one screen');
  }
  const out: Record<string, any> = {
    kind,
    screen: inp['screen'],
    target: { selector: target.selector, label: target.label.slice(0, 120) },
  };
  if (typeof target.context === 'string' && target.context)
    out['target'].context = target.context.slice(0, 300);
  if (inp['viewport'] !== undefined) {
    const w = num(inp['viewport'].w, 'viewport.w');
    const h = num(inp['viewport'].h, 'viewport.h');
    if (w < 200 || w > 4000 || h < 200 || h > 4000)
      throw new PadError(400, 'viewport must be 200–4000px each way');
    out['viewport'] = { w, h };
  }
  if (kind === 'move') {
    out['dx'] = num(inp['dx'], 'dx');
    out['dy'] = num(inp['dy'], 'dy');
  } else if (kind === 'resize') {
    out['fromWidth'] = num(inp['fromWidth'], 'fromWidth');
    out['fromHeight'] = num(inp['fromHeight'], 'fromHeight');
    out['width'] = num(inp['width'], 'width');
    out['height'] = num(inp['height'], 'height');
  } else if (kind === 'text') {
    if (typeof inp['before'] !== 'string' || typeof inp['after'] !== 'string') {
      throw new PadError(400, 'text changes need before and after');
    }
    out['before'] = inp['before'];
    out['after'] = inp['after'];
  } else if (kind === 'note') {
    if (typeof inp['text'] !== 'string' || !inp['text'].trim())
      throw new PadError(400, 'a note needs text');
    out['text'] = inp['text'].trim();
    const o = inp['offset'] ?? {};
    out['offset'] = { x: num(o.x ?? 0, 'offset.x'), y: num(o.y ?? 0, 'offset.y') };
  } else if (kind === 'draw') {
    out['points'] = points(inp['points'], 'points');
    if (typeof inp['color'] !== 'string' || !COLOR.test(inp['color']))
      throw new PadError(400, 'color must be #rrggbb');
    out['color'] = inp['color'];
    out['width'] = num(inp['width'], 'width');
    if (out['width'] < 1 || out['width'] > 24) throw new PadError(400, 'width must be 1–24');
    out['over'] = Array.isArray(inp['over'])
      ? inp['over']
          .filter((x: unknown) => typeof x === 'string')
          .slice(0, 8)
          .map((x: string) => x.slice(0, 120))
      : [];
  }
  return out as NewChange;
}

function points(list: unknown, name: string): [number, number][] {
  if (!Array.isArray(list) || list.length < 2 || list.length > 2000) {
    throw new PadError(400, `${name} needs 2–2000 points`);
  }
  return list.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2)
      throw new PadError(400, `${name}[${i}] must be [x, y]`);
    return [num(p[0], `${name}[${i}].x`), num(p[1], `${name}[${i}].y`)] as [number, number];
  });
}
