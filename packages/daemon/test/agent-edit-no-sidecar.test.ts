// spec/14 § Document editor — history: an agent Edit/Write on a `.md` the
// doc editor has never touched (a SKILL.md, a README) must not leave a
// `.<name>.patch-doc.json` sidecar behind. Versions are only kept for
// documents that already have one.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { sidecarPathFor, writeSidecar, defaultSidecar, readSidecar } from '../src/docSidecar.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-nosc-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-nosc-folder-')));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: () => {},
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, folder };
}

function enqueueEdit(sdk: ReturnType<typeof createMockSdkBackend>, file: string) {
  sdk.enqueue([
    {
      type: 'tool_use',
      tool: {
        name: 'Edit',
        args: { file_path: file, old_string: 'a', new_string: 'b' },
        callId: 'c1',
      },
    },
    { type: 'tool_result', toolResult: { name: 'Edit', callId: 'c1', result: 'ok' } },
    { type: 'result', sessionId: 'sess' },
  ]);
}

describe('agent edit of a .md file', () => {
  it('does not create a sidecar for a document that has none', async () => {
    const { daemon, sdk, folder } = setup();
    const md = join(folder, 'SKILL.md');
    writeFileSync(md, 'b\n');
    enqueueEdit(sdk, md);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(sidecarPathFor(md))).toBe(false);
  });

  it('still records a version when the document already has a sidecar', async () => {
    const { daemon, sdk, folder } = setup();
    const md = join(folder, 'notes.md');
    writeFileSync(md, 'b\n');
    writeSidecar(md, defaultSidecar());
    enqueueEdit(sdk, md);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 30));
    expect(readSidecar(md).versions.map((v) => v.savedBy)).toEqual(['agent']);
  });
});
