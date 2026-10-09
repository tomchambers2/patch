// spec/07 § Call cost — every costed voice session, kept on disk, and the
// per-host totals reported on `daemon.host.voiceUsage`.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { callTotalUsd, type CallCosting } from './voiceCost.js';

export interface VoiceUsageTotals {
  monthUsd: number;
  monthCalls: number;
  allUsd: number;
  allCalls: number;
}

export interface VoiceLedger {
  record(c: CallCosting): void;
  totals(now: number): VoiceUsageTotals;
}

/** Calendar month of `ms` in UTC, e.g. `2026-10`. */
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export function createVoiceLedger(path: string): VoiceLedger {
  const entries: CallCosting[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      // A line that does not parse is a corrupt ledger — fail loudly at boot
      // rather than reporting totals that silently leave a call out.
      entries.push(JSON.parse(line) as CallCosting);
    }
  }
  return {
    record(c: CallCosting): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(c)}\n`);
      entries.push(c);
    },
    totals(now: number): VoiceUsageTotals {
      const month = monthOf(now);
      const t: VoiceUsageTotals = { monthUsd: 0, monthCalls: 0, allUsd: 0, allCalls: 0 };
      for (const e of entries) {
        const usd = callTotalUsd(e);
        t.allUsd += usd;
        t.allCalls += 1;
        if (monthOf(e.endedAt) === month) {
          t.monthUsd += usd;
          t.monthCalls += 1;
        }
      }
      return t;
    },
  };
}
