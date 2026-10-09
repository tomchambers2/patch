// Archiving a chat parked on a usage limit stops the owed turn, but the notice
// saying WHY the reply never came (which account, when it resets) is the second
// message in the conversation and must not vanish with the archive.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const RESETS_AT = NOW + 3 * 3_600_000;

const backend: SdkBackend = {
  run: (): AsyncGenerator<SdkEnvelope> => {
    async function* gen(): AsyncGenerator<SdkEnvelope> {
      throw new TurnFailedError('weekly limit hit', {
        kind: 'rate_limit',
        status: 'rejected',
        rateLimitType: 'seven_day',
        resetsAt: RESETS_AT,
      });
    }
    return gen();
  },
};

describe('archiving a chat parked on a usage limit', () => {
  it('keeps the limit notice (account + reset) on the archived chat state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-arch-rl-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-arch-rl-f-')));
    const events: WireEvent[] = [];
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => NOW,
      generateChatId: () => 'chat-1',
      accountLimitInfo: () => ({ label: 'Work', scope: 'week' as const, resetsAt: RESETS_AT }),
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const states = (): ChatStateEvent[] =>
      events.filter((e): e is ChatStateEvent => e.type === 'chat.state');
    expect(states().at(-1)?.limitBlock?.accountLabel).toBe('Work');

    await daemon.setArchived(chatId, true);

    const last = states().at(-1);
    expect(last?.status).toBe('archived');
    expect(last?.limitBlock?.accountLabel).toBe('Work');
    expect(last?.limitBlock?.resetsAt).toBe(RESETS_AT);
    daemon.shutdown();
  });
});
