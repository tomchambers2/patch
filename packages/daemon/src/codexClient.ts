import { CodexRuntime } from './codexRuntime.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';

export type RpcObject = Record<string, any>;

/** Strip terminal colour and anything shaped like a JWT or API key. */
export function redactCodexLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]')
    .replace(/\b(sk|rt|sess)-[\w-]{10,}/g, '[redacted-key]')
    .trim();
}
export type CodexNotification = { method: string; params: RpcObject; id?: string | number };

/** One isolated Codex process. Never logs protocol payloads: login contains secrets. */
export class CodexClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: RpcObject) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(message: CodexNotification) => void>();
  private started: Promise<void> | undefined;
  get processId(): number | undefined {
    return this.child?.pid;
  }
  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }
  constructor(
    private readonly options: {
      home: string;
      executable?: string;
      credentialStore?: 'keyring' | 'ephemeral' | 'existing' | 'file';
      timeoutMs?: number;
      externalAuth?: () => { accessToken: string; chatgptAccountId: string };
      /** Each stderr line, ANSI-stripped and with token-shaped strings redacted. */
      onStderr?: (line: string) => void;
    },
  ) {}

  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.boot();
    return this.started;
  }
  private async boot(): Promise<void> {
    mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.options.home,
      // Codex is silent on stderr by default; sign-in failures must reach daemon.log.
      RUST_LOG: process.env['RUST_LOG'] ?? 'warn,codex_login=info,codex_login::auth::manager=warn',
    };
    // The selected account must never inherit another provider's billing credentials.
    for (const name of [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'CHATGPT_ACCESS_TOKEN',
      'CODEX_API_KEY',
    ])
      delete env[name];
    const executable =
      this.options.executable ??
      process.env['PATCH_CODEX_EXECUTABLE'] ??
      (await new CodexRuntime(join(homedir(), '.patch/backends/codex')).ensure());
    const child = spawn(
      executable,
      [
        'app-server',
        '--stdio',
        ...(this.options.externalAuth
          ? ['-c', 'cli_auth_credentials_store="ephemeral"']
          : this.options.credentialStore === 'existing'
            ? []
            : ['-c', `cli_auth_credentials_store="${this.options.credentialStore ?? 'keyring'}"`]),
      ],
      { env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    // Always drain stderr so its pipe never fills; hand lines on only redacted.
    const onStderr = this.options.onStderr;
    if (onStderr)
      createInterface({ input: child.stderr }).on('line', (line) => {
        const clean = redactCodexLine(line);
        if (clean) onStderr(clean);
      });
    else child.stderr.resume();
    child.stdin.on('error', (error) => this.fail(error));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) =>
      this.fail(new Error(`Codex process exited (${signal ?? code})`)),
    );
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let msg: RpcObject;
      try {
        msg = JSON.parse(line);
      } catch {
        this.fail(new Error('Codex returned invalid JSON'));
        this.signal(child, 'SIGTERM');
        return;
      }
      if (typeof msg.method === 'string') {
        if (msg.method === 'account/chatgptAuthTokens/refresh' && this.options.externalAuth) {
          try {
            this.respond(msg.id, this.options.externalAuth());
          } catch (error) {
            this.respond(msg.id, undefined, (error as Error).message);
          }
          return;
        }
        const notification = msg as CodexNotification;
        for (const listener of this.listeners) listener(notification);
        if (msg.id !== undefined && this.listeners.size === 0)
          this.respond(msg.id, undefined, 'No handler for Codex request');
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`Codex RPC ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result ?? {});
    });
    await this.request('initialize', {
      clientInfo: { name: 'patch', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    if (this.options.externalAuth) {
      await this.request('account/login/start', {
        type: 'chatgptAuthTokens',
        ...this.options.externalAuth(),
      });
    }
  }
  request(
    method: string,
    params: RpcObject = {},
    timeoutMs = this.options.timeoutMs ?? 20000,
  ): Promise<RpcObject> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  subscribe(listener: (message: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  respond(id: string | number, result?: RpcObject, error?: string): void {
    this.write(error ? { id, error: { code: -32601, message: error } } : { id, result });
  }
  private write(message: RpcObject): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed)
      throw new Error('Codex is not running');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private fail(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: 'patch/processFailed', params: { message: error.message } });
  }
  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  async descendants(): Promise<number[]> {
    if (!this.child?.pid || process.platform === 'win32') return [];
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=']);
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([this.child.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows)
        if (pid && parent && owned.has(parent) && !owned.has(pid)) {
          owned.add(pid);
          changed = true;
        }
    }
    owned.delete(this.child.pid);
    return [...owned].reverse();
  }
  terminateDescendants(pids: number[]): void {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  async close(): Promise<void> {
    this.fail(new Error('Codex connection closed'));
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.signal(child, 'SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.signal(child, 'SIGTERM');
    });
    // The npm launcher may exit before native children acknowledge termination.
    this.signal(child, 'SIGKILL');
  }
}
