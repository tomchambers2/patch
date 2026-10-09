// Reading an account's limits off Anthropic's own headers.
//
// These are the exact header values observed on 2026-09-11 from the two tokens
// this host held, which is also the incident that produced the module: the 429
// carried a complete, correct picture of an account that the app had spent a
// day describing wrongly from prose.

import { describe, it, expect, vi } from 'vitest';
import {
  readUsageHeaders,
  fetchClaudeUsage,
  fetchClaudeOrganizationId,
  ORGANIZATION_HEADER,
} from '../src/claude-usage.js';

/** The real header set from the incident, minus the ones nothing reads. */
const LIVE_429_HEADERS = {
  [ORGANIZATION_HEADER]: 'add21334-bb51-4fcd-8220-9badd3a4aeda',
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1.0',
  'anthropic-ratelimit-unified-5h-reset': '1789119600',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.62',
  'anthropic-ratelimit-unified-7d-reset': '1789444800',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled_until',
};

function res(status: number, headers: Record<string, string>, body = '{}'): Response {
  return new Response(body, { status, headers });
}

describe('readUsageHeaders', () => {
  it('reads all three windows, converting resets from seconds to ms', () => {
    const r = readUsageHeaders(new Headers(LIVE_429_HEADERS), 1_000);
    expect(r.organizationId).toBe('add21334-bb51-4fcd-8220-9badd3a4aeda');
    expect(r.windows.session).toEqual({
      status: 'rejected',
      utilization: 1,
      resetsAt: 1789119600 * 1000,
    });
    expect(r.windows.week).toEqual({
      status: 'allowed',
      utilization: 0.62,
      resetsAt: 1789444800 * 1000,
    });
    expect(r.representativeClaim).toBe('five_hour');
    expect(r.at).toBe(1_000);
  });

  it('keeps the overage window and its reason — the "monthly spend limit" wording', () => {
    const r = readUsageHeaders(new Headers(LIVE_429_HEADERS), 0);
    expect(r.windows.overage).toEqual({
      status: 'rejected',
      disabledReason: 'org_level_disabled_until',
    });
  });

  it('reports blocked when a spendable window is refusing', () => {
    expect(readUsageHeaders(new Headers(LIVE_429_HEADERS), 0).blocked).toBe(true);
  });

  // The header set probed live off the Default account on 2026-09-12, HTTP 200:
  // healthy on both pools it can spend, overage permanently rejected because
  // extra usage is a paid add-on that was never turned on. Reading that as a
  // refusal logged an account at 5% of its 5-hour pool as blocked, and put a
  // red "blocked" line in Settings for the life of the account.
  const HEALTHY_WITH_EXTRA_USAGE_OFF = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.05',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.44',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled_until',
  };

  it('does NOT report blocked when only the overage window is refusing', () => {
    const r = readUsageHeaders(new Headers(HEALTHY_WITH_EXTRA_USAGE_OFF), 0);
    expect(r.blocked).toBe(false);
  });

  it('still surfaces the refusing overage window and its reason on a healthy account', () => {
    const r = readUsageHeaders(new Headers(HEALTHY_WITH_EXTRA_USAGE_OFF), 0);
    expect(r.windows.overage).toEqual({
      status: 'rejected',
      disabledReason: 'org_level_disabled_until',
    });
    expect(r.windows.session).toEqual({ status: 'allowed', utilization: 0.05 });
    expect(r.windows.week).toEqual({ status: 'allowed', utilization: 0.44 });
  });

  // Anthropic's own verdict still wins: an account it calls rejected is
  // rejected, whatever the per-window headers look like.
  it("reports blocked on Anthropic's overall verdict even with every window allowed", () => {
    const r = readUsageHeaders(
      new Headers({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
      }),
      0,
    );
    expect(r.blocked).toBe(true);
  });

  it('reports not blocked when every window allows', () => {
    const r = readUsageHeaders(
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
      }),
      0,
    );
    expect(r.blocked).toBe(false);
  });

  it('omits a window that reports no status — half a window is not a fact', () => {
    const r = readUsageHeaders(
      new Headers({ 'anthropic-ratelimit-unified-5h-reset': '1789119600' }),
      0,
    );
    expect(r.windows.session).toBeUndefined();
  });

  // Todoist: "patch error is wrong" — the banner read "That was 20690 days 23
  // hours ago", i.e. `now - epoch 0`. `num()`'s `Number('')` is a finite 0, so
  // a present-but-empty reset header (or a literal "0") was kept as a "stated"
  // reset instead of being treated as absent — nobody's window resets in 1970.
  it('drops a reset of exactly epoch 0 rather than keeping it as a stated reset', () => {
    const r = readUsageHeaders(
      new Headers({
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-5h-reset': '0',
      }),
      0,
    );
    expect(r.windows.session).toEqual({ status: 'rejected', utilization: 1 });
    expect(r.windows.session?.resetsAt).toBeUndefined();
  });

  it("drops a reset header present but empty — Number('') is a finite 0", () => {
    const r = readUsageHeaders(
      new Headers({
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': '',
      }),
      0,
    );
    expect(r.windows.session?.resetsAt).toBeUndefined();
  });
});

describe('fetchClaudeUsage', () => {
  it('reads a 429 as a successful reading — that is when the numbers matter most', async () => {
    const fetchImpl = vi.fn(async () => res(429, LIVE_429_HEADERS));
    const out = await fetchClaudeUsage('tok', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 7,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') throw new Error('unreachable');
    expect(out.reading.blocked).toBe(true);
    expect(out.reading.windows.week?.utilization).toBe(0.62);
  });

  it('reads a 200 the same way', async () => {
    const fetchImpl = vi.fn(async () =>
      res(200, {
        ...LIVE_429_HEADERS,
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-overage-status': 'allowed',
      }),
    );
    const out = await fetchClaudeUsage('tok', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.kind).toBe('ok');
  });

  it('calls the messages endpoint as Claude Code, cheaply', async () => {
    const fetchImpl = vi.fn(async () => res(200, LIVE_429_HEADERS));
    await fetchClaudeUsage('tok-123', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { max_tokens: number; model: string };
    expect(body.max_tokens).toBe(1);
    expect(body.model).toContain('haiku');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-123');
  });

  it('a 401 is the CREDENTIAL being refused, not the account being spent', async () => {
    const fetchImpl = vi.fn(async () => res(401, {}, 'nope'));
    const out = await fetchClaudeUsage('tok', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.kind).toBe('rejected');
  });

  it('a 500 is unreachable — NOT a reading, and never a pass', async () => {
    const fetchImpl = vi.fn(async () => res(500, {}));
    const out = await fetchClaudeUsage('tok', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.kind).toBe('unreachable');
  });

  it('a network throw is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const out = await fetchClaudeUsage('tok', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.kind).toBe('unreachable');
    if (out.kind !== 'unreachable') throw new Error('unreachable');
    expect(out.message).toContain('ECONNRESET');
  });

  it('a 200 carrying no rate-limit headers at all is unreachable, not an empty reading', async () => {
    const fetchImpl = vi.fn(async () => res(200, {}));
    const out = await fetchClaudeUsage('tok', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.kind).toBe('unreachable');
  });
});

describe('fetchClaudeOrganizationId', () => {
  it('reads the organisation off the free models endpoint', async () => {
    const fetchImpl = vi.fn(async () => res(200, { [ORGANIZATION_HEADER]: 'org-1' }));
    await expect(
      fetchClaudeOrganizationId('tok', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe('org-1');
  });

  it('answers undefined — "not known" — rather than throwing when the call fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(
      fetchClaudeOrganizationId('tok', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });
});
