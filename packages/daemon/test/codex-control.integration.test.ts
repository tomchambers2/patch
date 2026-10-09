import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import pino from 'pino';
import { expect, it } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { codexIdentity } from '../src/codexIdentity.js';
import { CodexAccounts } from '../src/codexAccounts.js';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { buildControl } from '../src/control.js';

it.skipIf(process.env['PATCH_REAL_CODEX'] !== '1')(
  'runs an OpenAI chat through the real HTTP control endpoint and host runner',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-openai-control-'));
    // A previous Patch login has expired, but the same subscription can sign
    // in again. Exercise reconnection through to a real HTTP chat response.
    const identity = await codexIdentity(
      process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
      true,
    );
    expect(identity).toBeTruthy();
    mkdirSync(join(root, 'accounts'));
    writeFileSync(
      join(root, 'accounts/accounts.json'),
      JSON.stringify([
        {
          id: 'expired-account',
          label: 'Subscription',
          home: join(root, 'expired'),
          adopted: false,
          kind: 'chatgpt',
          identity,
        },
      ]),
    );
    const accounts = new CodexAccounts({
      root: join(root, 'accounts'),
      daemonId: 'test',
      executable: process.env['PATCH_CODEX_EXECUTABLE'] ?? 'codex',
      onChange: () => {},
    });
    let app: Awaited<ReturnType<typeof buildControl>> | undefined;
    try {
      await accounts.add({
        type: 'host.backend_add_account',
        daemonId: 'test',
        backendId: 'codex',
        authMethod: 'existing',
      });
      expect(accounts.report().activeAccountId).toBe('expired-account');
      const { client } = await accounts.resolve();
      expect((await client.request('account/read')).account.type).toBe('chatgpt');
      const models = await accounts.models();
      const model = models.find((m) => /mini|luna/.test(m.id)) ?? models[0]!;
      const history = new CodexHistory(join(root, 'history'));
      const events: WireEvent[] = [];
      const daemon = new Daemon({
        daemonId: 'test',
        metaStore: createMetaStore(join(root, 'chats')),
        sdkBackend: new CodexBackend(accounts, history),
        historyReader: history,
        resolveOAuth: async () => {
          const selected = await accounts.resolve();
          return { ok: true, accessToken: '', accountId: selected.accountId };
        },
        emit: (e) => {
          events.push(e);
        },
        logger: pino({ level: 'silent' }),
        now: Date.now,
      });
      app = await buildControl({ localKey: 'test-control-key', daemon });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/spawn-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-control-key' },
        body: JSON.stringify({
          folder: root,
          model: model.id,
          prompt: 'Reply exactly PATCH_HTTP_OK.',
          permissionMode: 'default',
        }),
      });
      expect(response.status).toBe(200);
      const { chatId } = (await response.json()) as { chatId: string };
      await expect
        .poll(
          () =>
            events.some(
              (e) =>
                e.type === 'chat.message' &&
                e.chatId === chatId &&
                e.role === 'assistant' &&
                e.content.includes('PATCH_HTTP_OK'),
            ),
          { timeout: 90000 },
        )
        .toBe(true);
      expect(events.filter((e) => e.type === 'chat.error')).toEqual([]);
      expect(daemon.list().find((c) => c.chatId === chatId)?.permissionMode).toBe('default');
    } finally {
      await app?.close();
      await accounts.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
