// I-native: REAL end-to-end proof for each harness-switch direction (spec/04
// § History — a seamless provider switch via native session reconstruction,
// not a pasted handoff).
//
// Each test synthesizes a chat's own log — a track that was never actually
// run on the target harness — into that harness's native resume shape, then
// resumes/injects it for real and asks the model to quote something back
// that only exists in the synthesized turn. A mock backend can't prove this:
// the assertion IS "the real SDK/app-server accepted the reconstruction and
// treated it as its own prior turn."
//
// Gating: OPT-IN, same as real-backend.integration.test.ts /
// codex-backend.integration.test.ts. Runs only with PATCH_REAL_CLAUDE=1 /
// PATCH_REAL_CODEX=1 against a live subscription login (never a paid API
// key) and skips (never fails) when the credential doesn't resolve.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadClaudeOAuth } from '@patch/auth';
import type { LoggedEvent } from '@patch/wire';
import { createRealSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';
import { CodexAccounts } from '../src/codexAccounts.js';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import type { TrackEntry } from '../src/nativeReconstruct.js';
import { REAL_CLAUDE_SKIP_REASON, realClaudeEnabled } from './helpers/real-claude.js';

function resolveOAuthOrUndefined(): string | undefined {
  try {
    const cred = loadClaudeOAuth();
    if (cred.expiresAt !== undefined && Date.now() >= cred.expiresAt) return undefined;
    return cred.accessToken;
  } catch {
    return undefined;
  }
}

function msg(role: 'user' | 'assistant', content: string): LoggedEvent {
  return { type: 'chat.message', chatId: 'reseed-test', role, content, seq: 0 };
}

const CODEWORD = `mongoose-${randomUUID().slice(0, 8)}`;

function plantedTrack(): TrackEntry[] {
  return [
    {
      record: { seq: 0, at: 1_700_000_000_000 },
      event: msg(
        'user',
        `Remember this codeword: ${CODEWORD}. Just say OK, don't repeat it back yet.`,
      ),
    },
    { record: { seq: 1, at: 1_700_000_000_001 }, event: msg('assistant', 'OK.') },
  ];
}

const claudeToken = realClaudeEnabled() ? resolveOAuthOrUndefined() : undefined;
const maybeClaude = claudeToken ? it : it.skip;

describe(`I-native Claude reseed (live OAuth)${realClaudeEnabled() ? '' : ` — SKIPPED, ${REAL_CLAUDE_SKIP_REASON}`}`, () => {
  maybeClaude(
    'a synthesized Claude session resumes for real and the model can quote an earlier turn',
    async () => {
      const nativeDir = mkdtempSync(join(tmpdir(), 'patch-reseed-claude-native-'));
      const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-reseed-claude-projects-'));
      try {
        const backend = createRealSdkBackend();
        const freshSessionId = randomUUID();
        const events: SdkEnvelope[] = [];
        for await (const ev of backend.run({
          prompt:
            'What was the codeword I gave you earlier? Reply with just that word, nothing else.',
          cwd: '/tmp',
          chatId: 'reseed-test',
          resumeSessionId: freshSessionId,
          claudeSessionStore: {
            nativeDir,
            claudeProjectsRoot: projectsRoot,
            logger: (await import('pino')).default({ level: 'silent' }),
            reseed: { events: plantedTrack(), model: null },
          },
          abortController: new AbortController(),
          oauthAccessToken: claudeToken!,
        })) {
          events.push(ev);
        }
        const assistantText = events
          .filter((e) => e.type === 'assistant')
          .map((e) => e.content ?? '')
          .join('');
        expect(assistantText).toContain(CODEWORD);
      } finally {
        rmSync(nativeDir, { recursive: true, force: true });
        rmSync(projectsRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe('I-native Codex inject (live ChatGPT login)', () => {
  it.skipIf(process.env['PATCH_REAL_CODEX'] !== '1')(
    'an injected Codex thread continues for real and the model can quote an earlier turn',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'patch-reseed-codex-'));
      const accounts = new CodexAccounts({
        root: join(root, 'accounts'),
        daemonId: 'test',
        executable: process.env['PATCH_CODEX_EXECUTABLE'] ?? 'codex',
        onChange: () => {},
      });
      try {
        // This machine's own Codex login, as the server would send it back (spec/01 § Settings).
        await accounts.applyShared([await accounts.exportMachineLogin()]);
        const models = await accounts.models();
        const model = models.find((m) => /mini|luna/.test(m.id)) ?? models[0]!;
        const backend = new CodexBackend(accounts, new CodexHistory(join(root, 'history')));
        const events: SdkEnvelope[] = [];
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), 90_000);
        try {
          for await (const event of backend.run({
            prompt:
              'What was the codeword I told you earlier? Reply with just that word, nothing else.',
            cwd: root,
            chatId: 'reseed-test',
            model: model.id,
            permissionMode: 'acceptEdits',
            oauthAccessToken: '',
            abortController,
            codexReseed: { events: plantedTrack() },
          })) {
            events.push(event);
          }
        } finally {
          clearTimeout(timer);
        }
        const assistantText = events
          .filter((e) => e.type === 'assistant')
          .map((e) => e.content ?? '')
          .join('');
        expect(assistantText).toContain(CODEWORD);
      } finally {
        await accounts.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
