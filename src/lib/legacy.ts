/**
 * The legacy core: one mutable balance per account plus an append-only journal.
 * The journal is what change data capture (CDC) tails during the migration.
 * Amounts are integer cents.
 */

export type AccountType = 'checking' | 'savings';

export interface LegacyAccount {
  id: string;
  holder: string;
  type: AccountType;
  balance: number;
}

export type Command =
  | { kind: 'open'; account: string; holder: string; type: AccountType; amount: number }
  | { kind: 'deposit'; account: string; amount: number }
  | { kind: 'withdrawal'; account: string; amount: number }
  | { kind: 'transfer'; from: string; to: string; amount: number };

export type LegacyEvent = Command & { seq: number };

export type Rejection = 'insufficient-funds' | 'unknown-account' | 'account-exists' | 'invalid-amount';

export type ExecResult = { ok: true; seq: number } | { ok: false; reason: Rejection };

export class LegacyCore {
  readonly accounts = new Map<string, LegacyAccount>();
  readonly journal: LegacyEvent[] = [];
  /** Last journal seq that touched each account, used to tell whether CDC has caught up for it. */
  readonly lastTouched = new Map<string, number>();
  readOnly = false;

  constructor(accounts: LegacyAccount[] = []) {
    for (const a of accounts) this.accounts.set(a.id, { ...a });
  }

  get lastSeq(): number {
    return this.journal.length;
  }

  /** Validates funds and applies a command, journaling it on success. */
  execute(cmd: Command): ExecResult {
    if (this.readOnly) throw new Error('Legacy core is decommissioned (read-only)');
    if (!Number.isInteger(cmd.amount) || cmd.amount < 0 || (cmd.kind !== 'open' && cmd.amount === 0)) return { ok: false, reason: 'invalid-amount' };
    const get = (id: string) => this.accounts.get(id);
    switch (cmd.kind) {
      case 'open':
        if (get(cmd.account)) return { ok: false, reason: 'account-exists' };
        this.accounts.set(cmd.account, { id: cmd.account, holder: cmd.holder, type: cmd.type, balance: cmd.amount });
        break;
      case 'deposit': {
        const a = get(cmd.account);
        if (!a) return { ok: false, reason: 'unknown-account' };
        a.balance += cmd.amount;
        break;
      }
      case 'withdrawal': {
        const a = get(cmd.account);
        if (!a) return { ok: false, reason: 'unknown-account' };
        if (a.balance < cmd.amount) return { ok: false, reason: 'insufficient-funds' };
        a.balance -= cmd.amount;
        break;
      }
      case 'transfer': {
        const from = get(cmd.from);
        const to = get(cmd.to);
        if (!from || !to || from === to) return { ok: false, reason: 'unknown-account' };
        if (from.balance < cmd.amount) return { ok: false, reason: 'insufficient-funds' };
        from.balance -= cmd.amount;
        to.balance += cmd.amount;
        break;
      }
    }
    const seq = this.journal.length + 1;
    this.journal.push({ ...cmd, seq } as LegacyEvent);
    for (const id of touched(cmd)) this.lastTouched.set(id, seq);
    return { ok: true, seq };
  }

  /** CDC read: up to `limit` journal events after `seq`. */
  eventsAfter(seq: number, limit: number): LegacyEvent[] {
    return this.journal.slice(seq, seq + limit);
  }

  balance(id: string): number | undefined {
    return this.accounts.get(id)?.balance;
  }
}

export function touched(cmd: Command): string[] {
  return cmd.kind === 'transfer' ? [cmd.from, cmd.to] : [cmd.account];
}
