/**
 * The new core: an immutable, double-entry ledger. Every posting's legs sum to
 * zero, so the sum of all balances is always zero, and postings are idempotent by
 * transaction id, so replaying a message or re-running a batch can't double-count.
 */

export interface Leg {
  account: string;
  amount: number;
}

export interface Posting {
  txId: string;
  legs: Leg[];
  memo: string;
}

/** System accounts on the other side of customer balances. */
export const SYS = {
  /** Cash in/out of the bank (deposits and withdrawals). */
  clearing: 'sys:cash-clearing',
  /** Opening balances carried over from the legacy core. */
  opening: 'sys:migration-opening',
  /** Legs for accounts that CDC saw before they were backfilled. Must reach zero. */
  suspense: 'sys:migration-suspense',
  /** Where the simulated defect and its repairs land. */
  defect: 'sys:defect-adjustments'
} as const;

export const isSystem = (account: string) => account.startsWith('sys:');

export class UnbalancedPostingError extends Error {}

export class Ledger {
  private balances = new Map<string, number>();
  private ids = new Set<string>();
  private byAccount = new Map<string, Posting[]>();
  postingCount = 0;

  post(p: Posting): 'posted' | 'duplicate' {
    if (this.ids.has(p.txId)) return 'duplicate';
    const sum = p.legs.reduce((s, l) => s + l.amount, 0);
    if (sum !== 0 || p.legs.some((l) => !Number.isInteger(l.amount))) {
      throw new UnbalancedPostingError(`Posting ${p.txId} does not balance (sum ${sum})`);
    }
    this.ids.add(p.txId);
    this.postingCount++;
    for (const leg of p.legs) {
      this.balances.set(leg.account, (this.balances.get(leg.account) ?? 0) + leg.amount);
      const list = this.byAccount.get(leg.account) ?? [];
      list.push(p);
      // Keep a bounded per-account history for the inspector; balances are separate.
      if (list.length > 25) list.shift();
      this.byAccount.set(leg.account, list);
    }
    return 'posted';
  }

  has(txId: string): boolean {
    return this.ids.has(txId);
  }

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  /** Sum of every balance. Zero by construction; checked anyway as an invariant. */
  total(): number {
    let t = 0;
    for (const v of this.balances.values()) t += v;
    return t;
  }

  recent(account: string): Posting[] {
    return [...(this.byAccount.get(account) ?? [])].reverse();
  }
}
