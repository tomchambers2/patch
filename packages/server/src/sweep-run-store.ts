// Persisted log of Manager sweep runs (spec/06 § Sweep — "Sweep runs are
// also listed like job runs"). One flat, append-only, bounded-read file —
// there is only ever one sweep loop, so unlike `jobs/logs.ts` this needs no
// per-job keying.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SweepRunRecord, SweepRunStore } from './manager-sweep.js';

export function createSweepRunStore(dataDir: string): SweepRunStore {
  const path = join(dataDir, 'sweep-runs.jsonl');
  mkdirSync(dirname(path), { recursive: true });

  return {
    append(record: SweepRunRecord): void {
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    },
    recent(limit = 50): SweepRunRecord[] {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0);
      const tail = lines.slice(Math.max(0, lines.length - limit));
      const out: SweepRunRecord[] = [];
      for (let i = tail.length - 1; i >= 0; i--) {
        try {
          out.push(JSON.parse(tail[i]!) as SweepRunRecord);
        } catch {
          // Skip a malformed line — observability log, not transactional state.
        }
      }
      return out;
    },
  };
}
