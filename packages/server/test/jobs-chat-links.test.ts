// JobChatLinks — server-only chatId → jobId map backing the sidebar's
// Automations group (spec/14 § Sidebar, spec/08 § Action).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobChatLinks } from '../src/jobs/chat-links.js';

describe('JobChatLinks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-links-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records and looks up a chatId → jobId link', () => {
    const links = new JobChatLinks({ dataDir: dir });
    expect(links.get('c1')).toBeNull();
    links.record('c1', 'j_1');
    expect(links.get('c1')).toBe('j_1');
  });

  it('persists across a reload (survives a server restart)', () => {
    const links = new JobChatLinks({ dataDir: dir });
    links.record('c1', 'j_1');
    links.record('c2', 'j_2');
    const reloaded = new JobChatLinks({ dataDir: dir });
    expect(reloaded.get('c1')).toBe('j_1');
    expect(reloaded.get('c2')).toBe('j_2');
  });

  it('writes to <dataDir>/job-chat-links.json, not inside <dataDir>/jobs/ (JobStore scans that dir for job definitions)', () => {
    const links = new JobChatLinks({ dataDir: dir });
    links.record('c1', 'j_1');
    const raw = readFileSync(join(dir, 'job-chat-links.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ c1: 'j_1' });
  });

  it('evicts the oldest entry once past its cap', () => {
    const links = new JobChatLinks({ dataDir: dir, cap: 2 });
    links.record('c1', 'j_1');
    links.record('c2', 'j_2');
    links.record('c3', 'j_3');
    expect(links.get('c1')).toBeNull();
    expect(links.get('c2')).toBe('j_2');
    expect(links.get('c3')).toBe('j_3');
  });

  // An `ensure` action re-asserts its link on EVERY fire (dispatcher.ts), so a
  // busy per-subject job would otherwise rewrite the file once per run for no
  // change at all.
  it('re-recording an unchanged link does not rewrite the file', () => {
    const links = new JobChatLinks({ dataDir: dir });
    links.record('c1', 'j_1');
    const path = join(dir, 'job-chat-links.json');
    const before = statSync(path).mtimeMs;
    writeFileSync(path, 'SENTINEL', 'utf8');
    links.record('c1', 'j_1');
    // Untouched: the no-op returned before persist().
    expect(readFileSync(path, 'utf8')).toBe('SENTINEL');
    expect(before).toBeGreaterThan(0);
  });

  it('re-recording a chat under a DIFFERENT job still rewrites', () => {
    const links = new JobChatLinks({ dataDir: dir });
    links.record('c1', 'j_1');
    links.record('c1', 'j_2');
    expect(links.get('c1')).toBe('j_2');
    expect(JSON.parse(readFileSync(join(dir, 'job-chat-links.json'), 'utf8'))).toEqual({
      c1: 'j_2',
    });
  });

  // Re-recording must not reset a chat's position in the eviction queue either
  // — a long-lived ensure chat re-asserted on every fire would otherwise keep
  // pushing itself to the back and evict everything around it.
  it('re-recording does not disturb eviction order', () => {
    const links = new JobChatLinks({ dataDir: dir, cap: 2 });
    links.record('c1', 'j_1');
    links.record('c2', 'j_2');
    links.record('c1', 'j_1');
    links.record('c3', 'j_3');
    // c1 was oldest and stays oldest, so it is the one evicted.
    expect(links.get('c1')).toBeNull();
    expect(links.get('c2')).toBe('j_2');
    expect(links.get('c3')).toBe('j_3');
  });

  it('tolerates a missing file (fresh dataDir)', () => {
    const links = new JobChatLinks({ dataDir: join(dir, 'never-created') });
    expect(links.get('anything')).toBeNull();
  });

  it('tolerates a corrupt file rather than throwing', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'job-chat-links.json'), 'not json', 'utf8');
    const links = new JobChatLinks({ dataDir: dir, logger: { warn: () => undefined } });
    expect(links.get('c1')).toBeNull();
  });
});
