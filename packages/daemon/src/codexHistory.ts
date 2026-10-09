import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import {
  eventIdentity,
  type HistoryReader,
  type ReadHistoryOptions,
  type ForkPointOptions,
} from './history.js';
import type { SdkEnvelope } from './sdkBackend.js';

type Entry = { turnId: string; event: WireEvent };
export class CodexHistory implements HistoryReader {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private path(id: string): string {
    if (!/^codex-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid Codex session id');
    return join(this.root, id + '.jsonl');
  }
  begin(id: string, providerPath?: string): void {
    appendFileSync(this.path(id), '', { mode: 0o600 });
    if (providerPath) writeFileSync(this.path(id) + '.path', providerPath, { mode: 0o600 });
  }
  providerPath(id: string): string | undefined {
    const path = this.path(id) + '.path';
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }
  pending(id: string): { id: string; prompt: string } | null {
    const path = this.path(id) + '.pending';
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  setPending(id: string, value: { id: string; prompt: string } | null): void {
    const path = this.path(id) + '.pending';
    writeFileSync(path + '.new', JSON.stringify(value), { mode: 0o600, flush: true });
    renameSync(path + '.new', path);
  }
  entries(id: string): Entry[] {
    return readFileSync(this.path(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  append(id: string, turnId: string, chatId: string, envelope: SdkEnvelope): void {
    let event: WireEvent | undefined;
    if ((envelope.type === 'assistant' || envelope.type === 'user') && envelope.content)
      event = {
        type: 'chat.message',
        chatId,
        role: envelope.type,
        content: envelope.content,
        seq: 0,
        // Stamped at write-time (Codex's envelope carries no timestamp of its
        // own) — this is the moment the turn actually happened, so it's still
        // a real creation time, not the later "now" a replaying surface would
        // otherwise see.
        createdAt: Date.now(),
      };
    if (envelope.type === 'tool_use' && envelope.tool)
      event = {
        type: 'chat.tool_call',
        chatId,
        tool: envelope.tool.name,
        args: envelope.tool.args,
        callId: envelope.tool.callId,
        seq: 0,
      };
    if (envelope.type === 'tool_result' && envelope.toolResult)
      event = {
        type: 'chat.tool_result',
        chatId,
        tool: envelope.toolResult.name,
        result: envelope.toolResult.result,
        callId: envelope.toolResult.callId,
        isError: envelope.toolResult.isError,
        seq: 0,
      };
    if (
      event &&
      this.entries(id).some(
        (e) => e.turnId === turnId && eventIdentity(e.event) === eventIdentity(event!),
      )
    )
      return;
    if (event)
      appendFileSync(this.path(id), JSON.stringify({ turnId, event }) + '\n', { flush: true });
  }
  read(opts: ReadHistoryOptions): WireEvent[] {
    const entries = this.entries(opts.sessionId);
    const seqs = opts.seqIndex.resolve(entries.map(({ event }) => eventIdentity(event)!));
    return entries
      .map(({ event }, i) => ({ ...event, chatId: opts.chatId, seq: seqs[i]! }) as WireEvent)
      .filter((e) => (e as { seq: number }).seq > opts.fromSeq);
  }
  hasSession(opts: { folder: string; sessionId: string }): boolean {
    return existsSync(this.path(opts.sessionId));
  }
  forkPoint(opts: ForkPointOptions): { resumeAtUuid: string | null } | null {
    const entries = this.entries(opts.sessionId);
    const seqs = opts.seqIndex.resolve(entries.map(({ event }) => eventIdentity(event)!));
    const entry = entries[seqs.indexOf(opts.seq)];
    return entry?.event.type === 'chat.message' && entry.event.role === 'user'
      ? { resumeAtUuid: 'before:' + entry.turnId }
      : null;
  }
  sidePoint(opts: ForkPointOptions): { resumeAtUuid: string | null } | null {
    const entries = this.entries(opts.sessionId);
    const seqs = opts.seqIndex.resolve(entries.map(({ event }) => eventIdentity(event)!));
    const index = seqs.indexOf(opts.seq);
    const entry = entries[index];
    // Codex forks at complete turn boundaries. Never include unseen later items.
    if (!entry || entries[index + 1]?.turnId === entry.turnId) return null;
    return { resumeAtUuid: 'through:' + entry.turnId };
  }
  fork(from: string, to: string, point: string): void {
    const [kind, turnId] = point.split(':');
    const entries = this.entries(from);
    const kept: Entry[] = [];
    let found = false;
    for (const entry of entries) {
      if (entry.turnId === turnId) {
        found = true;
        if (kind === 'before') break;
      } else if (found) break;
      kept.push(entry);
    }
    if (!found) throw new Error('Codex fork point is missing from history');
    writeFileSync(this.path(to), kept.map((e) => JSON.stringify(e) + '\n').join(''), {
      mode: 0o600,
    });
  }
}
