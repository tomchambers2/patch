// Messages a surface sent to a chat whose host was offline (spec/04 § Host,
// spec/12 § Host-offline UX). The server holds them and delivers them when the
// host reconnects. Held in memory alone, a server restart would lose every one,
// so each is also written to `<dataDir>/held-input.json` and put back on boot.
//
// Only a person's message is held this way (`chat.input`). Every other frame a
// surface sends to an offline host is a control the surface sends again when it
// matters.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';

/** A message nobody picked up for this long is not what the sender wants delivered now. */
export const HELD_INPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface HeldInput {
  daemonId: string;
  surfaceId: string;
  event: WireEvent;
  at: number;
}

export interface HeldInputStoreOptions {
  /** Where `held-input.json` lives. Absent keeps the messages in memory only. */
  dataDir?: string;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
}

export class HeldInputStore {
  private readonly path: string | null;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly now: () => number;
  private held: HeldInput[] = [];

  constructor(opts: HeldInputStoreOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.path = opts.dataDir ? join(opts.dataDir, 'held-input.json') : null;
    if (this.path !== null && existsSync(this.path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
        if (Array.isArray(parsed)) this.held = parsed as HeldInput[];
      } catch (err) {
        // NO FALLBACK: say so, then start empty rather than guess at a damaged file.
        this.logger.warn({ err }, 'held-input: could not read the held messages; starting empty');
      }
    }
  }

  /** Messages still worth delivering, oldest first. */
  all(): HeldInput[] {
    const cutoff = this.now() - HELD_INPUT_MAX_AGE_MS;
    return this.held.filter((h) => h.at >= cutoff);
  }

  add(daemonId: string, surfaceId: string, event: WireEvent): void {
    this.held.push({ daemonId, surfaceId, event, at: this.now() });
    this.save();
  }

  /** The host took everything held for it, or the message was delivered another way. */
  clearHost(daemonId: string): void {
    const before = this.held.length;
    this.held = this.held.filter((h) => h.daemonId !== daemonId);
    if (this.held.length !== before) this.save();
  }

  private save(): void {
    if (this.path === null) return;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.held));
      renameSync(tmp, this.path);
    } catch (err) {
      this.logger.warn({ err }, 'held-input: could not write the held messages');
    }
  }
}
