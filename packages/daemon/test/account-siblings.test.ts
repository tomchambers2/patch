// Two credentials for one Claude account are one account.
//
// The incident: this host stored "Default" and "work" as separate accounts.
// They were two `claude setup-token` tokens for the SAME organisation — one
// 5-hour pool, one weekly pool, one overage pool between them. The rotation
// walked from the first to the second on every exhaustion, spent a turn
// discovering the second was equally spent, and logged "every account is out of
// credit" having genuinely tried one. Every chat on the host paid for that
// discovery, every five hours, for a day.

import { describe, it, expect } from 'vitest';
import { AccountRotation, type FailoverAccount } from '../src/accountFailover.js';

const ORG = 'org-same';

/** The host as it actually was: two labels, one organisation. */
const twoTokensOneAccount: FailoverAccount[] = [
  { id: 'default', connected: true, organizationId: ORG },
  { id: 'work', connected: true, organizationId: ORG },
];

/** What the host SHOULD look like for failover to mean anything. */
const twoRealAccounts: FailoverAccount[] = [
  { id: 'default', connected: true, organizationId: 'org-a' },
  { id: 'personal', connected: true, organizationId: 'org-b' },
];

describe('markExhaustedWithSiblings', () => {
  it('sidelines the other token for the same account, so there is nowhere to fail over to', () => {
    const rotation = new AccountRotation(() => 0);
    const marked = rotation.markExhaustedWithSiblings(
      twoTokensOneAccount,
      'default',
      'spend limit',
      5_000,
    );

    expect(marked).toEqual(['default', 'work']);
    expect(rotation.isExhausted('work')).toBe(true);
    // The whole point: no usable account, so the caller waits for the reset
    // instead of burning a turn proving the same pool is still empty.
    expect(rotation.usableAccount(twoTokensOneAccount)).toBeUndefined();
  });

  it('says WHY the sibling was sidelined, so a log reader is not left guessing', () => {
    const rotation = new AccountRotation(() => 0);
    rotation.markExhaustedWithSiblings(twoTokensOneAccount, 'default', 'spend limit', 5_000);
    const sibling = rotation.snapshot().find((e) => e.accountId === 'work');
    expect(sibling?.reason).toContain('shares a Claude account');
    // It comes back at the same moment, because it is the same window.
    expect(sibling?.until).toBe(5_000);
  });

  it('leaves a genuinely different account alone — that IS a fallback', () => {
    const rotation = new AccountRotation(() => 0);
    rotation.markExhaustedWithSiblings(twoRealAccounts, 'default', 'spend limit', 5_000);

    expect(rotation.isExhausted('personal')).toBe(false);
    expect(rotation.usableAccount(twoRealAccounts)).toBe('personal');
  });

  it('an unknown organisation is not treated as a match — undefined is "not known", not "same"', () => {
    const rotation = new AccountRotation(() => 0);
    const unknown: FailoverAccount[] = [
      { id: 'a', connected: true },
      { id: 'b', connected: true },
    ];
    rotation.markExhaustedWithSiblings(unknown, 'a', 'spend limit', 5_000);

    expect(rotation.isExhausted('b')).toBe(false);
    expect(rotation.usableAccount(unknown)).toBe('b');
  });

  it('both come back together when the window resets', () => {
    let now = 0;
    const rotation = new AccountRotation(() => now);
    rotation.markExhaustedWithSiblings(twoTokensOneAccount, 'default', 'spend limit', 5_000);

    now = 5_000;
    expect(rotation.isExhausted('default')).toBe(false);
    expect(rotation.isExhausted('work')).toBe(false);
    expect(rotation.usableAccount(twoTokensOneAccount)).toBe('default');
  });

  it("still names an account to run on when everything is spent — the turn must fail with the provider's own message", () => {
    const rotation = new AccountRotation(() => 0);
    rotation.markExhaustedWithSiblings(twoTokensOneAccount, 'default', 'spend limit', 5_000);
    expect(rotation.effectiveAccount(twoTokensOneAccount)).toBe('default');
  });
});
