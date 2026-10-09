import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexAccounts } from '../src/codexAccounts.js';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

// Opt-in subscription test. Refuses API-key authentication; never enables paid API billing.
describe('real OpenAI backend', () => {
  it.skipIf(process.env['PATCH_REAL_CODEX'] !== '1')(
    'uses a ChatGPT login for a file tool, persists history and resumes after process restart',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'patch-openai-e2e-'));
      let accounts = new CodexAccounts({
        root: join(root, 'accounts'),
        daemonId: 'test',
        executable: process.env['PATCH_CODEX_EXECUTABLE'] ?? 'codex',
        onChange: () => {},
      });
      const history = new CodexHistory(join(root, 'history'));
      try {
        // This machine's own Codex login, as the server would send it back (spec/01 § Settings).
        await accounts.applyShared([await accounts.exportMachineLogin()]);
        const resolved = await accounts.resolve();
        expect((await resolved.client.request('account/read')).account.type).toBe('chatgpt');
        const models = await accounts.models();
        expect(models.length).toBeGreaterThan(0);
        const model = models.find((m) => /mini|luna/.test(m.id)) ?? models[0]!;
        const collect = async (backend: CodexBackend, prompt: string, session?: string) => {
          const events: SdkEnvelope[] = [];
          const abortController = new AbortController();
          const timer = setTimeout(() => abortController.abort(), 90000);
          try {
            for await (const event of backend.run({
              prompt,
              cwd: root,
              chatId: 'test-chat',
              model: model.id,
              permissionMode: 'acceptEdits',
              oauthAccessToken: '',
              abortController,
              ...(session ? { resumeSessionId: session } : {}),
            }))
              events.push(event);
          } finally {
            clearTimeout(timer);
          }
          return events;
        };
        const first = await collect(
          new CodexBackend(accounts, history),
          'Write exactly PATCH_CODEX_OK to a file called result.txt in the working directory. Then reply exactly FILE_WRITTEN.',
        );
        expect(readFileSync(join(root, 'result.txt'), 'utf8').trim()).toBe('PATCH_CODEX_OK');
        expect(first.some((e) => e.type === 'tool_use')).toBe(true);
        expect(first.some((e) => e.type === 'assistant_delta')).toBe(true);
        const session = first.find((e) => e.sessionId)?.sessionId;
        if (!session) throw new Error('Codex did not return a session id');
        expect(session).toMatch(/^codex-/);
        expect(history.hasSession({ folder: root, sessionId: session })).toBe(true);
        await accounts.close();
        accounts = new CodexAccounts({
          root: join(root, 'accounts'),
          daemonId: 'test',
          executable: process.env['PATCH_CODEX_EXECUTABLE'] ?? 'codex',
          onChange: () => {},
        });
        await accounts.start();
        const second = await collect(
          new CodexBackend(accounts, history),
          'What exact string did you write to result.txt in the previous turn? Reply with that string alone.',
          session,
        );
        expect(
          second
            .filter((e) => e.type === 'assistant')
            .map((e) => e.content)
            .join(''),
        ).toContain('PATCH_CODEX_OK');
        const keys = new Map<string, number>();
        const replay = history.read({
          chatId: 'test-chat',
          folder: root,
          sessionId: session,
          fromSeq: -1,
          seqIndex: {
            resolve: (items) =>
              items.map((key) => {
                if (!keys.has(key)) keys.set(key, keys.size);
                return keys.get(key)!;
              }),
          },
        });
        expect(replay.filter((e) => e.type === 'chat.message' && e.role === 'user')).toHaveLength(
          2,
        );
      } finally {
        await accounts.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    210000,
  );
});

it.skipIf(process.env['PATCH_REAL_CODEX'] !== '1')(
  'interrupts a real tool turn without allowing its delayed write',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-openai-interrupt-'));
    const accounts = new CodexAccounts({
      root: join(root, 'accounts'),
      daemonId: 'test',
      executable: process.env['PATCH_CODEX_EXECUTABLE'] ?? 'codex',
      onChange: () => {},
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 60000);
    try {
      // This machine's own Codex login, as the server would send it back (spec/01 § Settings).
      await accounts.applyShared([await accounts.exportMachineLogin()]);
      const models = await accounts.models();
      const model = models.find((m) => /mini|luna/.test(m.id)) ?? models[0]!;
      const backend = new CodexBackend(accounts, new CodexHistory(join(root, 'history')));
      let toolSeen = false;
      let failure = '';
      try {
        for await (const event of backend.run({
          prompt:
            'Run this exact shell command once: sleep 10; touch should-not-exist. Do not use any other tools.',
          cwd: root,
          model: model.id,
          permissionMode: 'acceptEdits',
          oauthAccessToken: '',
          abortController: controller,
        })) {
          if (event.type === 'tool_use') {
            toolSeen = true;
            controller.abort();
          }
        }
      } catch (error) {
        failure = (error as Error).message;
      }
      expect(toolSeen).toBe(true);
      expect(failure).toMatch(/interrupt/);
      await new Promise((resolve) => setTimeout(resolve, 11000));
      expect(existsSync(join(root, 'should-not-exist'))).toBe(false);
    } finally {
      clearTimeout(deadline);
      await accounts.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  100000,
);
