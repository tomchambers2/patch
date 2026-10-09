import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts, selectCodexAccount, codexUsage } from '../src/codexAccounts.js';
describe('OpenAI credit selection', () => {
  it('skips disconnected, exhausted and paid accounts without permission', () => {
    expect(
      selectCodexAccount(
        [
          { id: 'off', connected: false },
          { id: 'spent', connected: true, blockedUntil: 200 },
          { id: 'paid', connected: true, kind: 'apiKey' },
          { id: 'ready', connected: true },
        ],
        100,
      )?.id,
    ).toBe('ready');
  });
  it('keeps explicitly selected paid credit separate from subscription credit', () => {
    const accounts = [
      { id: 'subscription', connected: true, kind: 'chatgpt' },
      { id: 'paid', connected: true, kind: 'apiKey' },
    ];
    expect(selectCodexAccount(accounts, 100, 'apiKey')?.id).toBe('paid');
    expect(selectCodexAccount(accounts.slice(0, 1), 100, 'apiKey')).toBeUndefined();
    expect(selectCodexAccount(accounts.slice(1), 100)).toBeUndefined();
  });
  it('returns to the first account after its reset', () => {
    expect(selectCodexAccount([{ id: 'first', connected: true, blockedUntil: 200 }], 200)?.id).toBe(
      'first',
    );
  });
  it('does not treat unknown reset as immediately available', () => {
    expect(
      selectCodexAccount([{ id: 'first', connected: true, blockedUntil: null }], 200),
    ).toBeUndefined();
  });
  it('converts percentage and seconds and retains absent windows', () => {
    expect(
      codexUsage(
        { rateLimits: { primary: { usedPercent: 25, resetsAt: 100, windowDurationMins: 300 } } },
        123,
      ),
    ).toEqual({ session: { status: 'allowed', utilization: 0.25, resetsAt: 100000 }, at: 123 });
    expect(codexUsage({}, 123)).toBeUndefined();
  });
  it('labels a window by its length, so a weekly-only plan is not shown as 5-hour', () => {
    expect(
      codexUsage(
        { rateLimits: { primary: { usedPercent: 4, resetsAt: 100, windowDurationMins: 10080 } } },
        123,
      ),
    ).toEqual({ week: { status: 'allowed', utilization: 0.04, resetsAt: 100000 }, at: 123 });
  });
  it('reports both windows when a plan has a 5-hour and a weekly limit together', () => {
    expect(
      codexUsage(
        {
          rateLimits: {
            primary: { usedPercent: 25, resetsAt: 100, windowDurationMins: 300 },
            secondary: { usedPercent: 16, resetsAt: 200, windowDurationMins: 10080 },
          },
        },
        123,
      ),
    ).toEqual({
      session: { status: 'allowed', utilization: 0.25, resetsAt: 100000 },
      week: { status: 'allowed', utilization: 0.16, resetsAt: 200000 },
      at: 123,
    });
  });
  it('drops resetsAt at 0% used — OpenAI reports it as now + full window, which is not a real reset instant', () => {
    expect(
      codexUsage(
        { rateLimits: { primary: { usedPercent: 0, resetsAt: 100, windowDurationMins: 10080 } } },
        123,
      ),
    ).toEqual({ week: { status: 'allowed', utilization: 0 }, at: 123 });
  });
});

describe('CodexAccounts — the list is the server’s (spec/01 § Settings)', () => {
  function boot(): { accounts: CodexAccounts; root: string; changes: () => number } {
    const root = join(mkdtempSync(join(tmpdir(), 'patch-codex-shared-')), 'openai');
    let changes = 0;
    // A Codex that cannot start: nothing here may reach the network.
    const accounts = new CodexAccounts({
      root,
      daemonId: 'd1',
      executable: '/bin/false',
      onChange: () => void changes++,
    });
    return { accounts, root, changes: () => changes };
  }
  const login = (token: string): string =>
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } });

  it('takes the snapshot’s accounts in its order, each login written where Codex reads it', async () => {
    const { accounts, root } = boot();
    await accounts.applyShared([
      { id: 'b', label: 'B', kind: 'chatgpt', authJson: login('tb') },
      {
        id: 'a',
        label: 'A',
        kind: 'apiKey',
        authJson: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }),
      },
    ]);
    expect(accounts.report().accounts?.map((a) => a.id)).toEqual(['b', 'a']);
    expect(readFileSync(join(root, 'b', 'auth.json'), 'utf8')).toBe(login('tb'));
    expect(statSync(join(root, 'b', 'auth.json')).mode & 0o777).toBe(0o600);
    await accounts.close();
  });

  it('drops an account the server no longer holds, and lists a disconnected one without a login', async () => {
    const { accounts } = boot();
    await accounts.applyShared([
      { id: 'a', label: 'A', kind: 'chatgpt', authJson: login('ta') },
      { id: 'b', label: 'B', kind: 'chatgpt', authJson: login('tb') },
    ]);
    await accounts.applyShared([{ id: 'a', label: 'A', kind: 'chatgpt', authJson: null }]);
    const report = accounts.report().accounts ?? [];
    expect(report.map((a) => a.id)).toEqual(['a']);
    expect(report[0]?.connected).toBe(false);
    await accounts.close();
  });

  it('hands up a login Codex refreshed on this host, once', async () => {
    const { accounts, root } = boot();
    await accounts.applyShared([{ id: 'a', label: 'A', kind: 'chatgpt', authJson: login('old') }]);
    expect(accounts.refreshedLogins()).toEqual([]);
    writeFileSync(join(root, 'a', 'auth.json'), login('new'));
    expect(accounts.refreshedLogins()).toEqual([{ accountId: 'a', authJson: login('new') }]);
    expect(accounts.refreshedLogins()).toEqual([]);
    await accounts.close();
  });

  it('refuses the import rather than send a login it cannot read', async () => {
    const { accounts, root } = boot();
    await accounts.applyShared([{ id: 'a', label: 'A', kind: 'chatgpt', authJson: login('ta') }]);
    rmSync(join(root, 'a', 'auth.json'));
    expect(() => accounts.exportAll()).toThrow(/could not read the Codex login for A/);
    await accounts.close();
  });

  it('exports every login it holds for the one import', async () => {
    const { accounts } = boot();
    await accounts.applyShared([{ id: 'a', label: 'A', kind: 'chatgpt', authJson: login('ta') }]);
    expect(accounts.exportAll()).toEqual([
      { id: 'a', label: 'A', kind: 'chatgpt', authJson: login('ta') },
    ]);
    await accounts.close();
  });
});
