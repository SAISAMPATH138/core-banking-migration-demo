import { LegacyCore, type Command, type LegacyAccount, type LegacyEvent } from './legacy';
import { isSystem, Ledger, SYS, type Leg } from './ledger';

export type Phase = 'ready' | 'change-capture' | 'backfill' | 'verify' | 'shadow-read' | 'cutover' | 'decommissioned';

export const PHASES: { id: Phase; label: string; blurb: string }[] = [
  { id: 'change-capture', label: 'Change capture', blurb: 'Start tailing the legacy journal before copying anything, so no write is missed.' },
  { id: 'backfill', label: 'Backfill', blurb: 'Copy balances in checkpointed batches while CDC keeps applying live writes.' },
  { id: 'verify', label: 'Verify', blurb: 'Wait for CDC to catch up, then reconcile every account and the suspense account.' },
  { id: 'shadow-read', label: 'Shadow reads', blurb: 'Serve reads from legacy, compare each one against the new ledger.' },
  { id: 'cutover', label: 'Cutover', blurb: 'Drain CDC, flip writes to the new ledger, mirror back to legacy for rollback.' },
  { id: 'decommissioned', label: 'Decommission', blurb: 'Soak period passed: legacy goes read-only.' }
];

export interface MigrationOptions {
  seed?: number;
  accounts?: number;
  batchSize?: number;
  cdcPerTick?: number;
  trafficPerTick?: number;
  shadowReadsPerTick?: number;
  shadowReadsRequired?: number;
  captureTicks?: number;
  soakTicks?: number;
}

export interface LogEntry {
  tick: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface Sample {
  served: number;
  lag: number;
}

export interface Mismatch {
  account: string;
  legacy: number;
  ledger: number;
}

const HOLDERS = ['A. Moreno', 'B. Osei', 'C. Novak', 'D. Iyer', 'E. Walsh', 'F. Haddad', 'G. Kim', 'H. Larsen', 'I. Costa', 'J. Mensah', 'K. Duarte', 'L. Fischer', 'M. Sato', 'N. Price', 'O. Brennan', 'P. Alvarez'];
const SLOW_CDC_PER_TICK = 12;
const BACKFILL_RESTART_TICKS = 4;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const accountId = (n: number) => `ACC-${String(n).padStart(6, '0')}`;

/** Ledger legs for a legacy command, before any migration routing. */
export function legsFor(cmd: Command): Leg[] {
  switch (cmd.kind) {
    case 'open':
    case 'deposit':
      return [{ account: cmd.account, amount: cmd.amount }, { account: SYS.clearing, amount: -cmd.amount }];
    case 'withdrawal':
      return [{ account: cmd.account, amount: -cmd.amount }, { account: SYS.clearing, amount: cmd.amount }];
    case 'transfer':
      return [{ account: cmd.from, amount: -cmd.amount }, { account: cmd.to, amount: cmd.amount }];
  }
}

export const describe = (cmd: Command) =>
  cmd.kind === 'transfer' ? `Transfer ${cmd.from} → ${cmd.to}` : `${cmd.kind[0].toUpperCase()}${cmd.kind.slice(1)} ${cmd.account}`;

/**
 * Zero-downtime migration from the legacy core to the double-entry ledger.
 *
 * The approach (CDC first, then backfill):
 *  1. Start change data capture at the journal's current position.
 *  2. Backfill each account's balance with the journal seq it was read at.
 *     CDC applies an event to an account only if the event is newer than that
 *     account's snapshot, so nothing is lost or counted twice. Legs for accounts
 *     not yet backfilled are parked in a suspense account and released at backfill.
 *  3. Reconcile continuously; any mismatch blocks cutover until repaired.
 *  4. Shadow-read, then drain CDC and flip writes to the new ledger, mirroring
 *     back to legacy during a soak period so rollback stays possible.
 */
export class Migration {
  readonly legacy: LegacyCore;
  readonly ledger = new Ledger();
  readonly opts: Required<MigrationOptions>;
  phase: Phase = 'ready';
  primary: 'legacy' | 'ledger' = 'legacy';
  tickCount = 0;

  cdcRunning = false;
  cdcPosition = 0;
  /** Account → journal seq its backfilled opening balance reflects. */
  readonly snapshotSeq = new Map<string, number>();
  /** Suspense amounts parked per not-yet-backfilled account. */
  private held = new Map<string, number>();
  backfillCursor = 0;
  checkpoint = 0;
  mismatches: Mismatch[] = [];

  private ids: string[] = [];
  private idSet = new Set<string>();
  /** Accounts the crashed worker copied before dying; re-reading them on resume is a replay. */
  private replayed = new Set<string>();
  private nextAccount: number;
  private random: () => number;
  private workerDownTicks = 0;
  private cdcSlowTicks = 0;
  private captureTicksLeft = 0;
  private soakLeft = 0;
  private txCounter = 0;
  private defectCounter = 0;
  private repairCounter = 0;
  private waitingLogged = false;
  private milestones = new Set<number>();

  readonly stats = {
    served: 0,
    rejected: 0,
    failed: 0,
    duringMigration: 0,
    eventsReplicated: 0,
    duplicatesSkipped: 0,
    driftDetected: 0,
    repairs: 0,
    shadowReads: 0,
    shadowMismatches: 0,
    cleanShadowReads: 0,
    peakLag: 0,
    accountsOpened: 0,
    mirrorFailures: 0,
    writePauseMs: 0
  };
  readonly log: LogEntry[] = [];
  readonly history: Sample[] = [];

  constructor(options: MigrationOptions = {}) {
    this.opts = {
      seed: 400,
      accounts: 2000,
      batchSize: 40,
      cdcPerTick: 80,
      trafficPerTick: 30,
      shadowReadsPerTick: 60,
      shadowReadsRequired: 600,
      captureTicks: 3,
      soakTicks: 25,
      ...options
    };
    this.random = rng(this.opts.seed);
    const accounts: LegacyAccount[] = [];
    for (let i = 1; i <= this.opts.accounts; i++) {
      const r = this.random();
      const dollars = r < 0.7 ? this.between(0, 5_000) : r < 0.95 ? this.between(5_000, 50_000) : this.between(50_000, 250_000);
      accounts.push({ id: accountId(i), holder: this.pick(HOLDERS), type: this.random() < 0.7 ? 'checking' : 'savings', balance: Math.round(dollars * 100) });
    }
    this.legacy = new LegacyCore(accounts);
    this.ids = accounts.map((a) => a.id);
    this.idSet = new Set(this.ids);
    this.nextAccount = this.opts.accounts + 1;
  }

  // ---------- derived state ----------

  get lag(): number {
    return this.cdcRunning ? this.legacy.lastSeq - this.cdcPosition : 0;
  }
  get totalAccounts(): number {
    return this.ids.length;
  }
  get migratedAccounts(): number {
    // After cutover, accounts are opened directly on the new ledger, so every account lives there.
    return this.primary === 'ledger' ? this.ids.length : this.snapshotSeq.size;
  }
  get suspenseBalance(): number {
    return this.ledger.balance(SYS.suspense);
  }
  get workerDown(): boolean {
    return this.workerDownTicks > 0;
  }
  get replicationSlowed(): boolean {
    return this.cdcSlowTicks > 0;
  }
  get soakRemaining(): number {
    return this.soakLeft;
  }
  accountIds(): readonly string[] {
    return this.ids;
  }

  // ---------- controls ----------

  start(): void {
    if (this.phase !== 'ready') return;
    this.cdcRunning = true;
    this.cdcPosition = this.legacy.lastSeq;
    this.captureTicksLeft = this.opts.captureTicks;
    this.phase = 'change-capture';
    this.note('info', `Change data capture started at journal seq ${this.cdcPosition.toLocaleString()}. Writes continue on legacy.`);
  }

  /** Kills the backfill worker halfway through a batch, before it records a checkpoint. */
  crashBackfill(): boolean {
    if (this.phase !== 'backfill' || this.workerDownTicks > 0) return false;
    const half = this.ids.slice(this.backfillCursor, this.backfillCursor + Math.ceil(this.opts.batchSize / 2));
    for (const id of half) {
      this.backfillAccount(id);
      this.replayed.add(id);
    }
    this.workerDownTicks = BACKFILL_RESTART_TICKS;
    this.note('error', `Backfill worker crashed after ${half.length} accounts of a batch. Checkpoint is still at ${this.checkpoint.toLocaleString()}; restarting.`);
    return true;
  }

  /** Simulates a transformation bug that credits one migrated account in the new ledger only. */
  injectDrift(): string | null {
    if (!['backfill', 'verify', 'shadow-read'].includes(this.phase)) return null;
    const migrated = [...this.snapshotSeq.keys()];
    if (!migrated.length) return null;
    const account = this.pick(migrated);
    const amount = Math.round(this.between(1, 500) * 100);
    this.ledger.post({ txId: `defect:${++this.defectCounter}`, legs: [{ account, amount }, { account: SYS.defect, amount: -amount }], memo: 'Simulated transformation defect' });
    this.note('warning', `Defect injected: ${account} credited ${money(amount)} in the new ledger only.`);
    return account;
  }

  slowReplication(): boolean {
    if (!this.cdcRunning) return false;
    this.cdcSlowTicks = 25;
    this.note('warning', `Replication throttled to ${SLOW_CDC_PER_TICK} events/tick (below incoming traffic). Lag will build.`);
    return true;
  }

  /** Re-derives each mismatched account from the source of truth with an auditable adjustment. */
  repair(): number {
    let fixed = 0;
    for (const m of this.mismatches) {
      const diff = (this.legacy.balance(m.account) ?? 0) - this.ledger.balance(m.account);
      if (!diff) continue;
      this.ledger.post({ txId: `repair:${m.account}:${++this.repairCounter}`, legs: [{ account: m.account, amount: diff }, { account: SYS.defect, amount: -diff }], memo: 'Reconciliation repair from legacy source of truth' });
      fixed++;
    }
    if (fixed) {
      this.stats.repairs += fixed;
      this.stats.cleanShadowReads = 0;
      this.note('success', `Repaired ${fixed} account${fixed === 1 ? '' : 's'} with audited adjustment postings. Shadow-read confidence resets.`);
    }
    this.mismatches = [];
    return fixed;
  }

  // ---------- simulation ----------

  tick(): void {
    this.tickCount++;
    const servedBefore = this.stats.served;
    this.traffic();
    if (this.cdcRunning) this.replicate();

    switch (this.phase) {
      case 'change-capture':
        if (--this.captureTicksLeft <= 0) {
          this.phase = 'backfill';
          this.note('info', `Backfill started: ${this.ids.length.toLocaleString()} accounts in batches of ${this.opts.batchSize}.`);
        }
        break;
      case 'backfill':
        this.backfillStep();
        break;
      case 'verify':
        this.verifyStep();
        break;
      case 'shadow-read':
        this.shadowStep();
        break;
      case 'cutover':
        this.soakStep();
        break;
    }

    if (['backfill', 'verify', 'shadow-read'].includes(this.phase) && this.lag === 0) this.continuousReconcile();
    this.stats.peakLag = Math.max(this.stats.peakLag, this.lag);
    this.history.push({ served: this.stats.served - servedBefore, lag: this.lag });
    if (this.history.length > 160) this.history.shift();
  }

  /** Runs until decommissioned (or a tick budget is spent). Used by tests. */
  runToCompletion(maxTicks = 5000): void {
    this.start();
    for (let i = 0; i < maxTicks && this.phase !== 'decommissioned'; i++) this.tick();
  }

  private traffic(): void {
    const n = Math.round(this.opts.trafficPerTick * (0.7 + this.random() * 0.6));
    for (let i = 0; i < n; i++) {
      const cmd = this.randomCommand();
      const result = this.primary === 'legacy' ? this.legacy.execute(cmd) : this.executeOnLedger(cmd);
      if (result.ok) {
        this.stats.served++;
        if (this.phase !== 'ready' && this.phase !== 'decommissioned') this.stats.duringMigration++;
        if (cmd.kind === 'open') {
          this.ids.push(cmd.account);
          this.idSet.add(cmd.account);
          this.stats.accountsOpened++;
        }
      } else {
        // Business rejections (e.g. insufficient funds) are normal; a migration-caused failure would land in stats.failed.
        this.stats.rejected++;
      }
    }
  }

  private randomCommand(): Command {
    const r = this.random();
    const amount = Math.round(Math.exp(Math.log(500) + this.random() * (Math.log(200_000) - Math.log(500))));
    if (r < 0.03) {
      return { kind: 'open', account: accountId(this.nextAccount++), holder: this.pick(HOLDERS), type: 'checking', amount: Math.round(this.between(0, 500) * 100) };
    }
    const a = this.pick(this.ids);
    if (r < 0.48) {
      let b = this.pick(this.ids);
      while (b === a) b = this.pick(this.ids);
      return { kind: 'transfer', from: a, to: b, amount };
    }
    return r < 0.78 ? { kind: 'deposit', account: a, amount } : { kind: 'withdrawal', account: a, amount };
  }

  /** After cutover: validate and post on the ledger, then mirror to legacy so rollback stays possible. */
  private executeOnLedger(cmd: Command): { ok: boolean } {
    const known = this.idSet;
    const debit = cmd.kind === 'withdrawal' ? cmd.account : cmd.kind === 'transfer' ? cmd.from : null;
    if (cmd.kind === 'open' ? known.has(cmd.account) : cmd.kind === 'transfer' ? !known.has(cmd.from) || !known.has(cmd.to) : !known.has(cmd.account)) return { ok: false };
    if (debit && this.ledger.balance(debit) < cmd.amount) return { ok: false };
    this.ledger.post({ txId: `tx:${++this.txCounter}`, legs: legsFor(cmd), memo: describe(cmd) });
    if (!this.legacy.readOnly) {
      const mirrored = this.legacy.execute(cmd);
      if (!mirrored.ok) {
        this.stats.mirrorFailures++;
        this.note('error', `Reverse sync to legacy failed for ${describe(cmd)} (${mirrored.reason}).`);
      }
    }
    return { ok: true };
  }

  private replicate(limit = this.cdcSlowTicks > 0 ? SLOW_CDC_PER_TICK : this.opts.cdcPerTick): void {
    if (this.cdcSlowTicks > 0 && --this.cdcSlowTicks === 0) this.note('info', 'Replication throughput restored. Lag is draining.');
    for (const e of this.legacy.eventsAfter(this.cdcPosition, limit)) {
      this.applyCdc(e);
      this.cdcPosition = e.seq;
      this.stats.eventsReplicated++;
    }
  }

  private applyCdc(e: LegacyEvent): void {
    // Accounts opened after CDC started have nothing to backfill: they begin at zero.
    if (e.kind === 'open' && !this.snapshotSeq.has(e.account)) this.snapshotSeq.set(e.account, e.seq - 1);
    const legs = legsFor(e).map((leg): Leg => {
      if (isSystem(leg.account)) return leg;
      const snap = this.snapshotSeq.get(leg.account);
      if (snap === undefined) {
        // Not backfilled yet: park it. The backfill snapshot already includes this event.
        this.held.set(leg.account, (this.held.get(leg.account) ?? 0) + leg.amount);
        return { account: SYS.suspense, amount: leg.amount };
      }
      // Already inside the account's opening balance: don't apply it twice.
      if (e.seq <= snap) return { account: SYS.opening, amount: leg.amount };
      return leg;
    });
    if (this.ledger.post({ txId: `cdc:${e.seq}`, legs, memo: describe(e) }) === 'duplicate') this.stats.duplicatesSkipped++;
  }

  private backfillAccount(id: string): void {
    if (this.snapshotSeq.has(id)) {
      // Either replayed after a crash, or opened after CDC started (CDC created it). Both are safe to skip.
      if (this.replayed.delete(id)) this.stats.duplicatesSkipped++;
      return;
    }
    const balance = this.legacy.balance(id) ?? 0;
    const held = this.held.get(id) ?? 0;
    const result = this.ledger.post({
      txId: `open:${id}`,
      legs: [
        { account: id, amount: balance },
        { account: SYS.suspense, amount: -held },
        { account: SYS.opening, amount: held - balance }
      ],
      memo: `Opening balance from legacy @ seq ${this.legacy.lastSeq}`
    });
    if (result === 'duplicate') this.stats.duplicatesSkipped++;
    this.snapshotSeq.set(id, this.legacy.lastSeq);
    this.held.delete(id);
  }

  private backfillStep(): void {
    if (this.workerDownTicks > 0) {
      if (--this.workerDownTicks === 0) {
        this.backfillCursor = this.checkpoint;
        this.note('info', `Backfill worker back up. Resuming from checkpoint ${this.checkpoint.toLocaleString()}; already-copied accounts are skipped.`);
      }
      return;
    }
    const batch = this.ids.slice(this.backfillCursor, this.backfillCursor + this.opts.batchSize);
    for (const id of batch) this.backfillAccount(id);
    this.backfillCursor += batch.length;
    this.checkpoint = this.backfillCursor;

    const pct = Math.floor((this.backfillCursor / this.ids.length) * 4) * 25;
    if (pct > 0 && pct < 100 && !this.milestones.has(pct)) {
      this.milestones.add(pct);
      this.note('info', `Backfill ${pct}% (${this.backfillCursor.toLocaleString()} accounts), checkpoint saved.`);
    }
    if (this.backfillCursor >= this.ids.length) {
      this.phase = 'verify';
      this.note('success', `Backfill complete: ${this.migratedAccounts.toLocaleString()} accounts copied while ${this.stats.duringMigration.toLocaleString()} customer transactions ran.`);
    }
  }

  private reconcileAll(): Mismatch[] {
    const out: Mismatch[] = [];
    for (const id of this.ids) {
      if (!this.snapshotSeq.has(id)) continue;
      const legacy = this.legacy.balance(id) ?? 0;
      const ledger = this.ledger.balance(id);
      if (legacy !== ledger) out.push({ account: id, legacy, ledger });
    }
    return out;
  }

  private continuousReconcile(): void {
    const found = this.reconcileAll();
    const fresh = found.filter((m) => !this.mismatches.some((x) => x.account === m.account));
    this.mismatches = found;
    if (fresh.length) {
      this.stats.driftDetected += fresh.length;
      this.note('error', `Reconciliation mismatch on ${fresh.map((m) => m.account).join(', ')} (new ledger ${money(fresh[0].ledger)} vs legacy ${money(fresh[0].legacy)}). Cutover blocked.`);
      if (this.phase === 'shadow-read') this.phase = 'verify';
    }
  }

  private verifyStep(): void {
    if (this.lag > 0) {
      if (!this.waitingLogged) this.note('info', `Verify waiting for CDC to catch up (${this.lag} events behind).`);
      this.waitingLogged = true;
      return;
    }
    this.waitingLogged = false;
    if (this.mismatches.length) return; // blocked until repaired
    const suspense = this.suspenseBalance;
    if (suspense !== 0 || this.held.size) {
      this.note('error', `Suspense account not clear (${money(suspense)}).`);
      return;
    }
    if (this.ledger.total() !== 0) {
      this.note('error', 'Ledger does not sum to zero.');
      return;
    }
    this.phase = 'shadow-read';
    this.note('success', `Full reconciliation passed: ${this.migratedAccounts.toLocaleString()} accounts match, suspense is $0.00, ledger sums to zero. Starting shadow reads.`);
  }

  private shadowStep(): void {
    const migrated = this.ids;
    for (let i = 0; i < this.opts.shadowReadsPerTick; i++) {
      const id = this.pick(migrated);
      // Skip accounts with writes CDC hasn't applied yet; comparing them would be a false alarm.
      if ((this.legacy.lastTouched.get(id) ?? 0) > this.cdcPosition) continue;
      this.stats.shadowReads++;
      if (this.legacy.balance(id) !== this.ledger.balance(id)) {
        this.stats.shadowMismatches++;
        this.stats.cleanShadowReads = 0;
      } else {
        this.stats.cleanShadowReads++;
      }
    }
    if (this.stats.cleanShadowReads >= this.opts.shadowReadsRequired && !this.mismatches.length) this.cutover();
  }

  private cutover(): void {
    while (this.lag > 0) this.replicate(Number.MAX_SAFE_INTEGER);
    const final = this.reconcileAll();
    if (final.length || this.suspenseBalance !== 0) {
      this.mismatches = final;
      this.phase = 'verify';
      this.note('error', 'Final pre-cutover reconciliation failed. Staying on legacy.');
      return;
    }
    this.primary = 'ledger';
    this.cdcRunning = false;
    this.soakLeft = this.opts.soakTicks;
    this.phase = 'cutover';
    this.note('success', `Cutover: the new ledger is now the system of record. Write pause ${this.stats.writePauseMs} ms, 0 failed requests. Legacy kept in sync for rollback.`);
  }

  private soakStep(): void {
    const drift = this.ids.filter((id) => this.legacy.balance(id) !== this.ledger.balance(id));
    if (drift.length) this.note('error', `Reverse-sync drift on ${drift.length} accounts.`);
    if (--this.soakLeft <= 0) {
      this.legacy.readOnly = true;
      this.phase = 'decommissioned';
      this.note('success', `Soak period clean. Legacy core set read-only and scheduled for retirement. ${this.stats.duringMigration.toLocaleString()} transactions served during the migration with ${this.stats.failed} failures.`);
    }
  }

  private note(level: LogEntry['level'], message: string): void {
    this.log.unshift({ tick: this.tickCount, level, message });
    if (this.log.length > 80) this.log.pop();
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }

  private between(min: number, max: number): number {
    return min + this.random() * (max - min);
  }
}

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
