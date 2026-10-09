import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
export const CODEX_VERSION = '0.154.0';
/** Pinned, managed runtime; never substitutes an arbitrary version from PATH. */
export class CodexRuntime {
  private installing: Promise<string> | undefined;
  constructor(private root: string) {}
  get version(): string | null {
    const manifest = join(this.root, 'node_modules/@openai/codex/package.json');
    if (!existsSync(manifest) || !existsSync(this.executable)) return null;
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
    return version === CODEX_VERSION ? version : null;
  }
  get executable(): string {
    return join(this.root, 'node_modules/.bin/codex');
  }
  ensure(): Promise<string> {
    if (this.version) return Promise.resolve(this.executable);
    if (!this.installing)
      this.installing = this.install().finally(() => {
        this.installing = undefined;
      });
    return this.installing;
  }
  private async install(): Promise<string> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    await run(
      'npm',
      [
        'install',
        '--prefix',
        this.root,
        '--no-audit',
        '--no-fund',
        `@openai/codex@${CODEX_VERSION}`,
      ],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    );
    if (!this.version)
      throw new Error(`Codex ${CODEX_VERSION} installation did not produce its executable`);
    return this.executable;
  }
}
