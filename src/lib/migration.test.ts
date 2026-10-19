import { describe, expect, it } from 'vitest';
import { LegacyCore } from './legacy';
import { Ledger, SYS, UnbalancedPostingError } from './ledger';
import { Migration } from './migration';

const small = (extra = {}) =>
  new Migration({ accounts: 300, batchSize: 20, shadowReadsRequired: 200, soakTicks: 5, ...extra });

/** Every account must match between legacy and the new ledger. */
function assertConsistent(m: Migration) {
  for (const id of m.accountIds()) expect(m.ledger.balance(id), id).toBe(m.legacy.balance(id));
  expect(m.ledger.total()).toBe(0);
  expect(m.suspenseBalance).toBe(0);
}

/** Ticks until a predicate holds, failing loudly if it never does. */
function tickUntil(m: Migration, done: () => boolean, max = 3000) {
  for (let i = 0; i < max && !done(); i++) m.tick();
  expect(done()).toBe(true);
}

describe('LegacyCore', () => {
  it('rejects overdrafts and journals only successful commands', () => {
    const core = new LegacyCore([{ id: 'A', holder: 'x', type: 'checking', balance: 1000 }]);
    expect(core.execute({ kind: 'withdrawal', account: 'A', amount: 1500 })).toEqual({ ok: false, reason: 'insufficient-funds' });
    expect(core.execute({ kind: 'withdrawal', account: 'A', amount: 400 }).ok).toBe(true);
    expect(core.balance('A')).toBe(600);
    expect(core.journal).toHaveLength(1);
    expect(core.eventsAfter(0, 10)[0]).toMatchObject({ seq: 1, kind: 'withdrawal' });
  });
});

describe('Ledger', () => {
  it('refuses unbalanced postings and ignores duplicate transaction ids', () => {
    const l = new Ledger();
    expect(() => l.post({ txId: 't1', legs: [{ account: 'A', amount: 100 }], memo: '' })).toThrow(UnbalancedPostingError);
    const p = { txId: 't2', legs: [{ account: 'A', amount: 100 }, { account: SYS.clearing, amount: -100 }], memo: '' };
    expect(l.post(p)).toBe('posted');
    expect(l.post(p)).toBe('duplicate');
    expect(l.balance('A')).toBe(100);
    expect(l.total()).toBe(0);
  });
});

describe('Migration', () => {
  it('migrates every account under live traffic with no failures', () => {
    const m = small();
    m.runToCompletion();
    expect(m.phase).toBe('decommissioned');
    expect(m.primary).toBe('ledger');
    expect(m.stats.failed).toBe(0);
    expect(m.stats.duringMigration).toBeGreaterThan(500);
    expect(m.stats.accountsOpened).toBeGreaterThan(0);
    assertConsistent(m);
    expect(m.legacy.readOnly).toBe(true);
    expect(m.migratedAccounts).toBe(m.totalAccounts);
  });

  it('orders the phases: CDC first, then backfill, verify, shadow reads, cutover', () => {
    const m = small();
    const seen: string[] = [];
    m.start();
    for (let i = 0; i < 3000 && m.phase !== 'decommissioned'; i++) {
      if (seen[seen.length - 1] !== m.phase) seen.push(m.phase);
      m.tick();
    }
    expect(seen).toEqual(['change-capture', 'backfill', 'verify', 'shadow-read', 'cutover']);
  });

  it('keeps migrated accounts exact while backfill is still running', () => {
    const m = small();
    m.start();
    tickUntil(m, () => m.phase === 'backfill' && m.migratedAccounts > 100);
    tickUntil(m, () => m.lag === 0);
    for (const id of m.accountIds()) {
      if (m.snapshotSeq.has(id)) expect(m.ledger.balance(id)).toBe(m.legacy.balance(id));
    }
    // Unmigrated accounts' activity is parked in suspense, never lost.
    expect(m.ledger.total()).toBe(0);
  });

  it('resumes a crashed backfill from its checkpoint without double-copying', () => {
    const m = small();
    m.start();
    tickUntil(m, () => m.phase === 'backfill' && m.migratedAccounts > 60);
    const checkpoint = m.checkpoint;
    expect(m.crashBackfill()).toBe(true);
    expect(m.workerDown).toBe(true);
    expect(m.checkpoint).toBe(checkpoint);
    m.runToCompletion();
    expect(m.phase).toBe('decommissioned');
    expect(m.stats.duplicatesSkipped).toBe(10);
    assertConsistent(m);
  });

  it('detects injected drift, blocks cutover, and completes after repair', () => {
    const m = small();
    m.start();
    tickUntil(m, () => m.phase === 'backfill' && m.migratedAccounts > 50);
    const victim = m.injectDrift()!;
    expect(victim).toBeTruthy();
    tickUntil(m, () => m.mismatches.some((x) => x.account === victim));
    expect(m.stats.driftDetected).toBe(1);

    // Blocked: never reaches cutover while the mismatch stands.
    for (let i = 0; i < 400; i++) m.tick();
    expect(m.primary).toBe('legacy');
    expect(m.phase).toBe('verify');

    expect(m.repair()).toBe(1);
    expect(m.ledger.balance(SYS.defect)).toBe(0);
    m.runToCompletion();
    expect(m.phase).toBe('decommissioned');
    assertConsistent(m);
  });

  it('waits for replication lag to drain before verifying and cutting over', () => {
    const m = small();
    m.start();
    tickUntil(m, () => m.phase === 'backfill');
    m.slowReplication();
    for (let i = 0; i < 10; i++) m.tick();
    expect(m.lag).toBeGreaterThan(50);
    expect(m.replicationSlowed).toBe(true);
    m.runToCompletion();
    expect(m.stats.peakLag).toBeGreaterThan(50);
    expect(m.phase).toBe('decommissioned');
    assertConsistent(m);
  });

  it('keeps legacy in sync during the soak so rollback stays possible', () => {
    const m = small({ soakTicks: 40 });
    m.start();
    tickUntil(m, () => m.phase === 'cutover');
    const before = m.legacy.lastSeq;
    for (let i = 0; i < 20; i++) m.tick();
    expect(m.legacy.lastSeq).toBeGreaterThan(before);
    expect(m.stats.mirrorFailures).toBe(0);
    for (const id of m.accountIds()) expect(m.legacy.balance(id)).toBe(m.ledger.balance(id));
  });

  it('is deterministic for a seed', () => {
    const a = small({ seed: 9 });
    const b = small({ seed: 9 });
    a.runToCompletion();
    b.runToCompletion();
    expect(a.tickCount).toBe(b.tickCount);
    expect(a.stats).toEqual(b.stats);
  });
});
