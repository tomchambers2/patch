import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);

// Codex rust-v0.154.0 login/src/auth/storage.rs: DirectKeyringAuthStorage.
export function codexStoreKey(home: string): string {
  return 'cli|' + createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16);
}
/** Read only account identity from the selected credential store; never return tokens. */
export async function codexIdentity(home: string, adopted: boolean): Promise<string | undefined> {
  let contents: string;
  if (adopted && existsSync(join(home, 'auth.json')))
    contents = readFileSync(join(home, 'auth.json'), 'utf8');
  else {
    const key = codexStoreKey(home);
    const command = process.platform === 'darwin' ? '/usr/bin/security' : 'secret-tool';
    const args =
      process.platform === 'darwin'
        ? ['find-generic-password', '-s', 'Codex Auth', '-a', key, '-w']
        : ['lookup', 'service', 'Codex Auth', 'username', key];
    try {
      contents = (await run(command, args, { timeout: 5000, maxBuffer: 128 * 1024 })).stdout;
    } catch {
      return undefined;
    } // Identity is unknown, never assumed to be a different pool.
  }
  try {
    const value = JSON.parse(contents);
    return typeof value.tokens?.account_id === 'string' ? value.tokens.account_id : undefined;
  } catch {
    return undefined;
  }
}
