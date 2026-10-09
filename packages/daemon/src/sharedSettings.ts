// A host's half of the shared settings (spec/01 § Settings).
//
// The server owns every setting that is not tied to one machine and sends each
// host a `settings.snapshot`. This module holds the pieces of applying one that
// are not wiring: how Claude Code's `settings.json` is written without trampling
// a change made on the machine, and how a login this host already held is read
// back out so it can be sent to the server once.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeSettingsSetting } from '@patch/wire';
import { readClaudeSettingsJson, writeClaudeSettingsJson } from './claudeSettings.js';

/** `darwin` / `linux` — the OS an override in `claudeSettings` is keyed by. */
export type SettingsOs = 'darwin' | 'linux';

export function settingsOs(platform: NodeJS.Platform = process.platform): SettingsOs {
  if (platform === 'darwin' || platform === 'linux') return platform;
  throw new Error(`Claude Code settings have no override for platform ${platform}`);
}

function parseObject(text: string, what: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The `settings.json` text this OS should have: the shared object with the
 * OS override's top-level keys replacing the shared ones. `''` when both are
 * empty — no file is written for a setting nobody made.
 */
export function claudeSettingsFor(setting: ClaudeSettingsSetting, os: SettingsOs): string {
  const shared = parseObject(setting.shared, 'claudeSettings.shared');
  const override = parseObject(setting[os], `claudeSettings.${os}`);
  const merged = { ...shared, ...override };
  if (Object.keys(merged).length === 0) return '';
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** Whether two settings texts say the same thing, whatever their formatting. */
export function sameSettings(a: string, b: string): boolean {
  if (a.trim() === '' || b.trim() === '') return a.trim() === b.trim();
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return a === b;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Claude Code's `settings.json` on this machine, written from the snapshot —
 * except when the file has been changed here since patch last wrote it
 * (spec/02 § Claude Code settings). Claude Code itself writes this file, and so
 * can a person, so a snapshot that simply overwrote it would silently throw
 * their change away. A drifted file is left alone and reported until the change
 * is taken into the shared settings or discarded.
 */
export class ClaudeSettingsFile {
  private readonly statePath: string;
  private desired = '';
  private drifted: string | undefined;

  constructor(
    private readonly claudeHome: string,
    patchHome: string,
  ) {
    this.statePath = join(patchHome, 'claude-settings-written.json');
  }

  private lastWritten(): string | undefined {
    if (!existsSync(this.statePath)) return undefined;
    return (JSON.parse(readFileSync(this.statePath, 'utf8')) as { text: string }).text;
  }

  private record(text: string): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ text }), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  /** Bring the file to `desired`, unless it has drifted. Returns the drift, if any. */
  apply(desired: string): string | undefined {
    this.desired = desired;
    return this.check();
  }

  /** Re-read the file: a change made on the machine since the last apply shows as drift. */
  check(): string | undefined {
    const current = readClaudeSettingsJson(this.claudeHome);
    const written = this.lastWritten();
    // Never written by patch: a file that already says what the snapshot says
    // is simply adopted as written; an absent one is written; anything else was
    // made on this machine and is not patch's to replace.
    const base = written ?? (current.trim() === '' ? '' : undefined);
    if (base === undefined || !sameSettings(current, base)) {
      if (sameSettings(current, this.desired)) {
        this.record(current);
        this.drifted = undefined;
        return undefined;
      }
      this.drifted = current;
      return current;
    }
    if (!sameSettings(current, this.desired)) {
      writeClaudeSettingsJson(this.claudeHome, this.desired);
      this.record(this.desired);
    } else if (written === undefined) {
      this.record(current);
    }
    this.drifted = undefined;
    return undefined;
  }

  drift(): string | undefined {
    return this.drifted;
  }

  /** Throw the machine's change away: rewrite the file from the snapshot. */
  discard(): void {
    writeClaudeSettingsJson(this.claudeHome, this.desired);
    this.record(this.desired);
    this.drifted = undefined;
  }

  /** The file as it is on this machine, for sending up. */
  text(): string {
    return readClaudeSettingsJson(this.claudeHome);
  }
}

/** The keyring entry name Codex keeps a CODEX_HOME's login under. */
export function codexKeyringUser(home: string): string {
  return `cli|${createHash('sha256').update(home).digest('hex').slice(0, 16)}`;
}

/**
 * A Codex login's `auth.json` as Codex holds it for `home`: the file when Codex
 * stores to files, the OS keyring when it does not. Undefined when there is
 * none. The keyring is read with the platform's own tool, because the value is
 * Codex's and patch holds no copy of its own.
 */
export function readCodexAuth(
  home: string,
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }),
): string | undefined {
  const file = join(home, 'auth.json');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const user = codexKeyringUser(home);
  try {
    const out =
      process.platform === 'darwin'
        ? run('security', ['find-generic-password', '-s', 'Codex Auth', '-a', user, '-w'])
        : run('secret-tool', ['lookup', 'service', 'Codex Auth', 'username', user]);
    return out.trim() === '' ? undefined : out.trim();
  } catch {
    return undefined;
  }
}

/** Write a Codex login where a file-store Codex reads it. */
export function writeCodexAuth(home: string, authJson: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'auth.json');
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, authJson, { mode: 0o600 });
  renameSync(tmp, file);
}
