import { codexIdentity } from './codexIdentity.js';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodexRuntime } from './codexRuntime.js';
import type {
  DaemonAccountEvent,
  HostBackendAddAccountEvent,
  SharedCodexAccount,
} from '@patch/wire';
import { readCodexAuth, writeCodexAuth } from './sharedSettings.js';
import { AccountRotation, type RouteOptions } from './accountFailover.js';
import type { AccountStrategy } from '@patch/wire';
import { CodexClient, type RpcObject } from './codexClient.js';
import type { Logger } from 'pino';

export const CODEX_BACKEND_ID = 'codex';
export const isCodexModel = (model?: string): boolean => model?.startsWith('openai/') === true;
/**
 * Backstop only. Codex's device code lives 15 minutes and Codex itself reports
 * its expiry through `account/login/completed`; giving up any sooner throws
 * away an approval made in the code's last minutes.
 */
export const CODEX_LOGIN_DEADLINE_MS = 16 * 60_000;
interface EligibleAccount {
  id: string;
  connected: boolean;
  kind?: string;
  blockedUntil?: number | null;
}
export function selectCodexAccount<T extends EligibleAccount>(
  accounts: readonly T[],
  now: number,
  kind: 'chatgpt' | 'apiKey' = 'chatgpt',
): T | undefined {
  return accounts.find(
    (a) =>
      a.connected &&
      (a.kind ?? 'chatgpt') === kind &&
      a.blockedUntil !== null &&
      (a.blockedUntil === undefined || a.blockedUntil <= now),
  );
}
export function codexUsage(result: RpcObject, at: number): DaemonAccountEvent['usage'] {
  const limits = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  if (!limits?.primary && !limits?.secondary) return undefined;
  const usage: NonNullable<DaemonAccountEvent['usage']> = { at };
  // Which window is which comes from its own length, not its position: a plan
  // with only a weekly limit reports that week as `primary`.
  for (const value of [limits.primary, limits.secondary]) {
    if (!value || typeof value.usedPercent !== 'number') continue;
    if (typeof value.windowDurationMins !== 'number') continue;
    const key = value.windowDurationMins <= 24 * 60 ? 'session' : 'week';
    usage[key] = {
      status: value.usedPercent >= 100 ? 'rejected' : 'allowed',
      utilization: Math.min(1, Math.max(0, value.usedPercent / 100)),
      // At 0% used, nothing has anchored this window yet, and OpenAI reports
      // resetsAt as exactly "now + windowDurationMins" — which slides forward
      // by however long it has been since the last poll rather than naming a
      // fixed instant. Kept, it reads as "resets in 7 days" for ever, which is
      // indistinguishable from "resets whenever this was last checked" because
      // that is what it is. Dropped once real usage anchors the window.
      ...(typeof value.resetsAt === 'number' && value.usedPercent > 0
        ? { resetsAt: value.resetsAt * 1000 }
        : {}),
    };
  }
  return usage;
}
interface Account extends EligibleAccount {
  label: string;
  home: string;
  adopted: boolean;
  /**
   * Where Codex keeps this login. `file` for every account the server sent
   * (spec/01 § Settings): the login is the account's, so it travels as
   * `auth.json`. `keyring` / `existing` only for a login this host held before
   * settings were shared, until its snapshot replaces it.
   */
  store: 'file' | 'keyring' | 'existing';
  kind: 'chatgpt' | 'apiKey';
  email?: string;
  usage?: DaemonAccountEvent['usage'];
  error?: string;
  identity?: string;
}

/**
 * The Codex logins this host runs turns on. The list is the server's (spec/01 §
 * Settings): `applyShared` replaces it from each snapshot, and a login made or
 * refreshed here is sent up rather than kept.
 */
export class CodexAccounts {
  private accounts: Account[] = [];
  /** Orders the logins by the strategy; only its round-robin position is used. */
  private readonly rotation = new AccountRotation();
  private clients = new Map<string, CodexClient>();
  private turnClients = new Set<CodexClient>();
  private login: DaemonAccountEvent['login'];
  private pending:
    | {
        account: Account;
        client: CodexClient;
        loginId?: string;
        unsubscribe: () => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private file: string;
  readonly runtime: CodexRuntime;
  constructor(
    private readonly opts: {
      root: string;
      daemonId: string;
      onChange: () => void;
      executable?: string;
      logger?: Logger;
      loginDeadlineMs?: number;
      /** A sign-in run on this host completed: the login goes to the server. */
      onSignedIn?: (requestId: string, account: SharedCodexAccount) => void;
    },
  ) {
    this.runtime = new CodexRuntime(join(dirname(opts.root), 'backends/codex'));
    mkdirSync(opts.root, { recursive: true, mode: 0o700 });
    this.file = join(opts.root, 'accounts.json');
    if (existsSync(this.file)) {
      const stored: (Omit<Account, 'store'> & { store?: Account['store'] })[] = JSON.parse(
        readFileSync(this.file, 'utf8'),
      );
      this.accounts = stored.map((a) => ({
        ...a,
        store: a.store ?? (a.adopted ? 'existing' : 'keyring'),
        connected: false,
      }));
    }
  }
  private save(): void {
    const metadata = this.accounts.map(
      ({ id, label, home, adopted, store, kind, email, identity }) => ({
        id,
        label,
        home,
        adopted,
        store,
        kind,
        email,
        identity,
      }),
    );
    writeFileSync(this.file + '.new', JSON.stringify(metadata), { mode: 0o600 });
    renameSync(this.file + '.new', this.file);
  }
  private stderrLogger(accountId: string): ((line: string) => void) | undefined {
    const logger = this.opts.logger;
    return logger ? (line) => logger.warn({ accountId, codex: line }, 'codex: stderr') : undefined;
  }
  private externalAuth(
    account: Account,
  ): (() => { accessToken: string; chatgptAccountId: string }) | undefined {
    const raw = readCodexAuth(account.home);
    if (!raw || JSON.parse(raw).auth_mode !== 'chatgptAuthTokens') return undefined;
    return () => {
      const auth = JSON.parse(readCodexAuth(account.home) ?? '{}');
      if (!auth.tokens?.access_token || !auth.tokens?.account_id)
        throw new Error('ChatGPT sign-in is unavailable. Sign in once in Settings.');
      return { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id };
    };
  }
  private async client(account: Account): Promise<CodexClient> {
    let client = this.clients.get(account.id);
    if (client && !client.alive) {
      await client.close();
      this.clients.delete(account.id);
      client = undefined;
    }
    if (!client) {
      client = new CodexClient({
        executable: this.opts.executable ?? (await this.runtime.ensure()),
        home: account.home,
        credentialStore: account.store,
        externalAuth: this.externalAuth(account),
        onStderr: this.stderrLogger(account.id),
      });
      this.clients.set(account.id, client);
      try {
        await client.start();
      } catch (error) {
        this.clients.delete(account.id);
        await client.close();
        throw error;
      }
    }
    await client.start();
    return client;
  }
  report(): DaemonAccountEvent {
    const first =
      selectCodexAccount(this.accounts, Date.now()) ?? this.accounts.find((a) => a.connected);
    return {
      type: 'daemon.account',
      daemonId: this.opts.daemonId,
      backendId: CODEX_BACKEND_ID,
      connected: Boolean(first),
      accountEmail: first?.email ?? null,
      ...(first ? { activeAccountId: first.id } : {}),
      ...(first?.usage ? { usage: first.usage } : {}),
      ...(this.login ? { login: this.login } : {}),
      accounts: this.accounts.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        connected: a.connected,
        accountEmail: a.email ?? null,
        ...(a.error ? { error: a.error } : {}),
        ...(a.usage ? { usage: a.usage } : {}),
      })),
    };
  }
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 10 * 60_000);
    this.timer.unref();
  }
  async refresh(): Promise<void> {
    for (const account of this.accounts) {
      try {
        const client = await this.client(account);
        const result = await client
          .request('account/read', { refreshToken: false })
          .catch((error) => {
            account.connected = false;
            throw error;
          });
        account.connected = Boolean(result.account) && result.account.type === account.kind;
        if (result.account && !account.connected)
          throw new Error('The login type changed. Reconnect this account in Settings.');
        delete account.error;
        if (result.account?.email) account.email = result.account.email;
        if (account.connected && account.kind === 'chatgpt') {
          const usage = codexUsage(await client.request('account/rateLimits/read'), Date.now());
          account.usage = usage;
          const blocked = [usage?.session, usage?.week].filter((w) => w?.status === 'rejected');
          if (blocked.length)
            account.blockedUntil = blocked.some((w) => w?.resetsAt === undefined)
              ? null
              : Math.max(...blocked.map((w) => w!.resetsAt!));
          else if (usage?.session || usage?.week) delete account.blockedUntil;
        }
      } catch (error) {
        account.error = (error as Error).message;
      }
    }
    this.opts.onChange();
  }
  async add(event: HostBackendAddAccountEvent): Promise<void> {
    const requestId = event.requestId ?? randomUUID();
    if (event.authMethod === 'cancel') {
      await this.cancel();
      return;
    }
    if (this.pending || this.login?.status === 'pending')
      throw new Error('A ChatGPT sign-in is already in progress on this host');
    // A ChatGPT sign-in is the one account change that has to run on a machine:
    // Codex does the device flow. Its login is the account's, so it is stored
    // to a file and sent to the server (spec/01 § Settings); an API key and an
    // existing login are added through the server instead.
    const adopted = false;
    const id = randomUUID();
    const account: Account = {
      id,
      label: event.label ?? 'ChatGPT',
      home: join(this.opts.root, id),
      adopted,
      store: 'file',
      kind: 'chatgpt',
      connected: false,
    };
    this.login = { requestId, status: 'pending' };
    this.opts.logger?.info(
      { requestId, authMethod: event.authMethod, accountId: account.id },
      'codex: sign-in started',
    );
    this.opts.onChange();
    let client: CodexClient;
    try {
      client = await this.client(account);
    } catch (e) {
      this.login = { requestId, status: 'failed', error: (e as Error).message };
      this.opts.logger?.error(
        { requestId, err: (e as Error).message },
        'codex: sign-in failed to start Codex',
      );
      this.opts.onChange();
      return;
    }
    if (this.login?.status !== 'pending') {
      this.clients.delete(account.id);
      await client.close();
      return;
    }
    let finishing = false;
    const finish = async (success: boolean, error?: string): Promise<void> => {
      if (finishing || this.login?.requestId !== requestId || this.login.status !== 'pending') {
        this.opts.logger?.warn(
          { requestId, success, err: error, finishing, current: this.login },
          'codex: sign-in result ignored',
        );
        return;
      }
      finishing = true;
      if (success) {
        try {
          const result = await client.request('account/read', { refreshToken: false });
          if (!result.account) throw new Error('Codex completed sign-in without an account');
          if (adopted && result.account.type !== 'chatgpt')
            throw new Error(
              'The existing login is not a ChatGPT subscription. Add its API key explicitly.',
            );
          const identity = await codexIdentity(account.home, true);
          const duplicate = identity
            ? this.accounts.find((a) => a.identity === identity)
            : undefined;
          if (duplicate?.connected)
            throw new Error(`This ChatGPT credit pool is already connected as ${duplicate.label}`);
          if (identity) account.identity = identity;
          account.connected = true;
          if (result.account.email) {
            account.email = result.account.email;
            if (!event.label) account.label = result.account.email;
          }
          if (duplicate) {
            // Reauthentication repairs the same credit source. Keep references
            // from saved chats and the user's priority/label intact.
            const temporaryId = account.id;
            const oldClient = this.clients.get(duplicate.id);
            await oldClient?.close();
            this.clients.delete(temporaryId);
            account.id = duplicate.id;
            account.label = event.label ?? duplicate.label;
            this.clients.set(account.id, client);
            this.accounts[this.accounts.indexOf(duplicate)] = account;
          } else {
            this.accounts.push(account);
          }
          this.save();
          const authJson = readCodexAuth(account.home);
          if (!authJson) throw new Error('Codex signed in but wrote no auth.json');
          this.authSeen.set(account.id, authJson);
          this.opts.onSignedIn?.(requestId, {
            id: account.id,
            label: account.label,
            kind: account.kind,
            ...(account.email ? { email: account.email } : {}),
            ...(account.identity ? { identity: account.identity } : {}),
            authJson,
          });
        } catch (e) {
          success = false;
          error = (e as Error).message;
        }
      }
      this.login = {
        requestId,
        status: success ? 'complete' : 'failed',
        ...(error ? { error } : {}),
      };
      if (success)
        this.opts.logger?.info({ requestId, accountId: account.id }, 'codex: sign-in complete');
      else this.opts.logger?.error({ requestId, err: error }, 'codex: sign-in failed');
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.unsubscribe();
        this.pending = undefined;
      }
      if (!success) {
        if (!adopted && client.alive) {
          try {
            await client.request('account/logout');
          } catch {
            /* The failed connection is closed below. */
          }
        }
        this.clients.delete(account.id);
        await client.close();
      }
      this.opts.onChange();
      if (success) void this.refresh();
    };
    // Codex sends login/completed BEFORE its auth manager reloads the new
    // credential, and account/updated after (app-server account_processor.rs).
    // Reading the account on login/completed finds none, so a successful
    // sign-in only finishes once account/updated reports it loaded.
    let signedIn = false;
    const unsubscribe = client.subscribe((msg) => {
      if (msg.method === 'account/login/completed') {
        this.opts.logger?.info(
          {
            requestId,
            loginId: msg.params.loginId,
            success: msg.params.success,
            err: msg.params.error,
          },
          'codex: login completed notification',
        );
        if (msg.params.success === true) signedIn = true;
        else void finish(false, msg.params.error ?? 'Codex reported the sign-in failed');
      }
      if (msg.method === 'account/updated' && signedIn) {
        this.opts.logger?.info(
          { requestId, authMode: msg.params.authMode },
          'codex: account updated notification',
        );
        if (msg.params.authMode) void finish(true);
        else void finish(false, 'Codex completed sign-in but loaded no account');
      }
      if (msg.method === 'patch/processFailed') void finish(false, msg.params.message);
      if (msg.id !== undefined) client.respond(msg.id, undefined, 'No turn is running');
    });
    const timer = setTimeout(() => {
      // The sign-in is already reported expired before Codex is told; a Codex
      // that dies or is closed before answering must not become an unhandled
      // rejection in the host.
      this.cancel('Sign-in expired. Start again.').catch((e: Error) =>
        this.opts.logger?.error({ err: e.message }, 'codex: expired sign-in cancel failed'),
      );
    }, this.opts.loginDeadlineMs ?? CODEX_LOGIN_DEADLINE_MS);
    this.pending = { account, client, unsubscribe, timer };
    try {
      if (adopted) {
        await finish(true);
        return;
      }
      const result = await client.request('account/login/start', {
        type: event.authMethod === 'browser' ? 'chatgpt' : 'chatgptDeviceCode',
      });
      if (this.pending) this.pending.loginId = result.loginId;
      this.opts.logger?.info(
        { requestId, loginId: result.loginId },
        'codex: sign-in awaiting approval',
      );
      if (this.login?.status === 'pending')
        this.login = {
          requestId,
          status: 'pending',
          url: result.authUrl ?? result.verificationUrl,
          ...(result.userCode ? { code: result.userCode } : {}),
        };
      this.opts.onChange();
    } catch (e) {
      await finish(false, (e as Error).message);
    }
  }
  async cancel(error?: string): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      if (this.login?.status === 'pending') {
        this.login = { requestId: this.login.requestId, status: 'cancelled' };
        this.opts.onChange();
      }
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.unsubscribe();
    if (error) this.opts.logger?.error({ err: error }, 'codex: sign-in abandoned');
    else this.opts.logger?.info('codex: sign-in cancelled');
    if (this.login)
      this.login = {
        requestId: this.login.requestId,
        status: error ? 'failed' : 'cancelled',
        ...(error ? { error } : {}),
      };
    try {
      if (pending.loginId)
        await pending.client.request('account/login/cancel', { loginId: pending.loginId });
    } finally {
      this.clients.delete(pending.account.id);
      await pending.client.close();
      this.opts.onChange();
    }
  }
  /**
   * Replace the list with the server's (spec/01 § Settings). Each login is
   * written where a file-store Codex reads it; a client whose login changed is
   * restarted so its next request uses the new one, and one for an account the
   * server no longer holds is closed.
   */
  async applyShared(shared: readonly SharedCodexAccount[]): Promise<void> {
    const previous = new Map(this.accounts.map((a) => [a.id, a]));
    const next: Account[] = [];
    for (const s of shared) {
      const before = previous.get(s.id);
      const home = join(this.opts.root, s.id);
      const changed = s.authJson !== null && readCodexAuth(home) !== s.authJson;
      if (before && before.home !== home && existsSync(join(before.home, 'auth.json')))
        unlinkSync(join(before.home, 'auth.json'));
      if (s.authJson === null && existsSync(join(home, 'auth.json')))
        unlinkSync(join(home, 'auth.json'));
      if (s.authJson !== null && changed) writeCodexAuth(home, s.authJson);
      if (s.authJson !== null) this.authSeen.set(s.id, s.authJson);
      if (changed || s.authJson === null || before?.store !== 'file') await this.closeClient(s.id);
      next.push({
        id: s.id,
        label: s.label,
        home,
        adopted: false,
        store: 'file',
        kind: s.kind,
        ...(s.email ? { email: s.email } : {}),
        ...(s.identity ? { identity: s.identity } : {}),
        // A disconnected account stays listed and resolves nothing.
        connected: s.authJson !== null && (before?.connected ?? false),
        ...(before?.usage ? { usage: before.usage } : {}),
        ...(before?.blockedUntil !== undefined ? { blockedUntil: before.blockedUntil } : {}),
        ...(s.authJson === null ? { error: 'Disconnected' } : {}),
      });
    }
    for (const id of previous.keys()) {
      if (!next.some((a) => a.id === id)) await this.closeClient(id);
    }
    this.accounts = next;
    this.save();
    this.opts.onChange();
    await this.refresh();
  }

  private async closeClient(id: string): Promise<void> {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client) await client.close();
  }

  /** Last `auth.json` this host sent or received per account, to spot a refresh. */
  private readonly authSeen = new Map<string, string>();

  /**
   * Logins Codex refreshed on this host since they were last sent or received.
   * Each is returned once; the caller sends it to the server.
   */
  refreshedLogins(): { accountId: string; authJson: string; email?: string }[] {
    const out: { accountId: string; authJson: string; email?: string }[] = [];
    for (const a of this.accounts) {
      if (a.store !== 'file') continue;
      const current = readCodexAuth(a.home);
      if (current === undefined || current === this.authSeen.get(a.id)) continue;
      if (JSON.parse(current).auth_mode === 'chatgptAuthTokens') continue;
      this.authSeen.set(a.id, current);
      out.push({ accountId: a.id, authJson: current, ...(a.email ? { email: a.email } : {}) });
    }
    return out;
  }

  /** Every login this host holds, for its one import into the server. */
  exportAll(): SharedCodexAccount[] {
    return this.accounts.map((a) => {
      const authJson = readCodexAuth(a.home);
      // NO FALLBACK: sending it up without its login would come back in the
      // snapshot as a disconnected account and sign this host out of it. The
      // import fails instead, naming it; the host keeps running on its own
      // logins and the server asks again on the next connect.
      if (authJson === undefined) {
        throw new Error(
          `could not read the Codex login for ${a.label} (${a.store === 'file' ? a.home : `${a.store} store`})`,
        );
      }
      return {
        id: a.id,
        label: a.label,
        kind: a.kind,
        ...(a.email ? { email: a.email } : {}),
        ...(a.identity ? { identity: a.identity } : {}),
        authJson,
      };
    });
  }

  /** This machine's own Codex login (`~/.codex`), for adopting as a shared account. */
  async exportMachineLogin(): Promise<SharedCodexAccount> {
    const home = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
    const authJson = readCodexAuth(home);
    if (!authJson) throw new Error(`No Codex login on this machine (${home})`);
    const identity = await codexIdentity(home, true);
    const parsed = JSON.parse(authJson) as { auth_mode?: string };
    return {
      id: randomUUID(),
      label: 'ChatGPT',
      kind: parsed.auth_mode === 'apikey' ? 'apiKey' : 'chatgpt',
      ...(identity ? { identity } : {}),
      authJson,
    };
  }

  /**
   * The login a call runs on: the first in the strategy's order (spec/10 §
   * Backend credentials — account strategy) that is connected and not blocked.
   * `starting` marks a turn actually starting, the one call that moves a
   * round-robin on; `preferred` is the chat's own account, put first.
   */
  async resolve(
    route: { strategy?: AccountStrategy; preferred?: string; starting?: boolean } = {},
    allowExhausted = false,
    kind: 'chatgpt' | 'apiKey' = 'chatgpt',
  ): Promise<{ accountId: string; client: CodexClient }> {
    const all = this.accounts.filter((a) => a.kind === kind);
    const routeOptions: RouteOptions = {
      strategy: route.strategy ?? 'priority',
      ...(route.preferred !== undefined ? { preferred: route.preferred } : {}),
      weekResetsAt: (id) => all.find((a) => a.id === id)?.usage?.week?.resetsAt,
      utilization: (id) => {
        const u = all.find((a) => a.id === id)?.usage;
        const values = [u?.session?.utilization, u?.week?.utilization].filter(
          (v): v is number => v !== undefined,
        );
        return values.length ? Math.max(...values) : undefined;
      },
    };
    const candidates = this.rotation
      .order(all, routeOptions)
      .map((f) => all.find((a) => a.id === f.id)!);
    const account =
      selectCodexAccount(candidates, Date.now(), kind) ??
      (allowExhausted ? candidates.find((a) => a.connected) : undefined);
    if (account && route.starting) this.rotation.noteStart(account.id, routeOptions);
    if (!account && kind === 'apiKey')
      throw new Error(
        'No available OpenAI API key. Add one in Settings and explicitly select an OpenAI API model.',
      );
    if (!account)
      throw new Error(
        candidates.some((a) => a.connected && a.kind === 'chatgpt')
          ? 'ChatGPT usage limit exceeded. Refresh usage or wait for the account reset.'
          : 'No ChatGPT credit source is connected. Add an account in Settings. Paid API execution requires spending authorization.',
      );
    return { accountId: account.id, client: await this.client(account) };
  }
  /**
   * The login a turn's gate already chose (`resolve` with `starting`), checked
   * again as the turn starts; no id resolves afresh by the stored order.
   */
  async resolveChosen(
    id: string | undefined,
    kind: 'chatgpt' | 'apiKey',
  ): Promise<{ accountId: string; client: CodexClient }> {
    if (id === undefined) return this.resolve({}, false, kind);
    const account = selectCodexAccount(
      this.accounts.filter((a) => a.id === id),
      Date.now(),
      kind,
    );
    if (!account) throw new Error('The OpenAI account chosen for this turn is no longer available');
    return { accountId: account.id, client: await this.client(account) };
  }
  async turnClient(id: string): Promise<CodexClient> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) throw new Error('OpenAI account was disconnected');
    const client = new CodexClient({
      executable: this.opts.executable ?? (await this.runtime.ensure()),
      home: account.home,
      credentialStore: account.store,
      externalAuth: this.externalAuth(account),
      onStderr: this.stderrLogger(account.id),
    });
    try {
      await client.start();
      this.turnClients.add(client);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  async releaseTurnClient(client: CodexClient): Promise<void> {
    this.turnClients.delete(client);
    await client.close();
  }
  async models(): Promise<{ id: string; label: string }[]> {
    const models: { id: string; label: string }[] = [];
    for (const kind of ['chatgpt', 'apiKey'] as const) {
      if (!this.accounts.some((a) => a.connected && a.kind === kind)) continue;
      const { client } = await this.resolve({}, true, kind);
      const result = await client.request('model/list', { includeHidden: false });
      models.push(
        ...result.data.map((m: RpcObject) => ({
          id: (kind === 'apiKey' ? 'openai/api/' : 'openai/') + m.model,
          label: m.displayName + (kind === 'apiKey' ? ' · OpenAI API (paid)' : ' · ChatGPT'),
        })),
      );
    }
    return models;
  }

  markExhausted(id: string | undefined): string | undefined {
    const account = this.accounts.find((a) => a.id === id);
    if (account) {
      const windows = [account.usage?.session, account.usage?.week].filter(
        (w) => w?.status === 'rejected',
      );
      account.blockedUntil =
        windows.length && windows.every((w) => w?.resetsAt !== undefined)
          ? Math.max(...windows.map((w) => w!.resetsAt!))
          : null;
    }
    if (account?.identity)
      for (const sibling of this.accounts) {
        if (sibling.identity === account.identity) sibling.blockedUntil = account.blockedUntil;
      }
    this.opts.onChange();
    return selectCodexAccount(this.accounts, Date.now(), account?.kind ?? 'chatgpt')?.id;
  }
  limitInfo(id: string) {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return undefined;
    const scope =
      account.usage?.week?.status === 'rejected'
        ? ('week' as const)
        : account.usage?.session?.status === 'rejected'
          ? ('session' as const)
          : ('unknown' as const);
    const window = scope === 'unknown' ? undefined : account.usage?.[scope];
    return {
      label: account.label,
      ...(scope !== 'unknown' ? { scope } : {}),
      ...(window?.resetsAt ? { resetsAt: window.resetsAt } : {}),
      ...(window?.utilization !== undefined ? { utilization: window.utilization } : {}),
    };
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.cancel();
    await Promise.all(
      [...this.turnClients].map(async (c) => {
        const pids = await c.descendants();
        c.terminateDescendants(pids);
        await c.close();
      }),
    );
    this.turnClients.clear();
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
