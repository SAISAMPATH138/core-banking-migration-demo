import './styles.css';
import { isSystem } from './lib/ledger';
import { Migration, money, PHASES, type Phase } from './lib/migration';

const TICK_MS = 250;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const n = (v: number) => v.toLocaleString('en-US');

let m = new Migration();
let paused = false;
let speed = 1;
let inspected = 'ACC-000042';

const order: Phase[] = ['ready', ...PHASES.map((p) => p.id)];
const phaseIndex = (p: Phase) => order.indexOf(p);

// ---------- controls ----------

$('start').addEventListener('click', () => {
  m.start();
  render();
});
$('pause').addEventListener('click', () => {
  paused = !paused;
  render();
});
$('reset').addEventListener('click', () => {
  m = new Migration();
  paused = false;
  render();
});
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) =>
  b.addEventListener('click', () => {
    speed = Number(b.dataset.speed);
    document.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  })
);
$('f-crash').addEventListener('click', () => {
  m.crashBackfill();
  render();
});
$('f-drift').addEventListener('click', () => {
  const victim = m.injectDrift();
  if (victim) inspected = victim;
  render();
});
$('f-slow').addEventListener('click', () => {
  m.slowReplication();
  render();
});
$('f-repair').addEventListener('click', () => {
  m.repair();
  render();
});
$('inspect-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $<HTMLInputElement>('inspect-id').value.trim().toUpperCase();
  const digits = raw.replace(/\D/g, '');
  inspected = raw.startsWith('ACC-') ? raw : digits ? `ACC-${digits.padStart(6, '0')}` : inspected;
  render();
});
$('random-account').addEventListener('click', () => {
  const ids = m.accountIds();
  inspected = ids[Math.floor(Math.random() * ids.length)];
  render();
});

// ---------- rendering ----------

function gates(): { label: string; ok: boolean; detail?: string }[] {
  const lag = m.lag;
  switch (m.phase) {
    case 'ready':
      return [{ label: 'Bank open, customers transacting on legacy', ok: true }];
    case 'change-capture':
      return [{ label: 'CDC connector tailing the journal', ok: true, detail: `from seq ${n(m.cdcPosition)}` }];
    case 'backfill':
      return [
        { label: 'Accounts copied', ok: m.backfillCursor >= m.totalAccounts, detail: `${n(m.migratedAccounts)} / ${n(m.totalAccounts)}` },
        { label: 'Worker healthy', ok: !m.workerDown, detail: m.workerDown ? 'restarting' : `checkpoint ${n(m.checkpoint)}` },
        { label: 'Migrated accounts match legacy', ok: !m.mismatches.length, detail: m.mismatches.length ? `${m.mismatches.length} mismatched` : undefined }
      ];
    case 'verify':
      return [
        { label: 'CDC caught up', ok: lag === 0, detail: `${n(lag)} events behind` },
        { label: 'Every account reconciles', ok: !m.mismatches.length, detail: m.mismatches.length ? `${m.mismatches.length} mismatched` : undefined },
        { label: 'Suspense account cleared', ok: m.suspenseBalance === 0, detail: money(m.suspenseBalance) },
        { label: 'Ledger sums to zero', ok: m.ledger.total() === 0 }
      ];
    case 'shadow-read':
      return [
        { label: 'Clean shadow reads', ok: m.stats.cleanShadowReads >= m.opts.shadowReadsRequired, detail: `${n(Math.min(m.stats.cleanShadowReads, m.opts.shadowReadsRequired))} / ${n(m.opts.shadowReadsRequired)}` },
        { label: 'No mismatches', ok: !m.mismatches.length },
        { label: 'CDC caught up', ok: lag === 0, detail: `${n(lag)} behind` }
      ];
    case 'cutover':
      return [
        { label: 'Writes on new ledger', ok: true },
        { label: 'Reverse sync to legacy healthy', ok: m.stats.mirrorFailures === 0 },
        { label: 'Soak period', ok: false, detail: `${m.soakRemaining} ticks left` }
      ];
    case 'decommissioned':
      return [
        { label: 'Migration complete', ok: true },
        { label: 'Failed customer requests', ok: m.stats.failed === 0, detail: String(m.stats.failed) },
        { label: 'Legacy core read-only', ok: m.legacy.readOnly }
      ];
  }
}

function renderPhases() {
  const idx = phaseIndex(m.phase);
  $('phase-steps').innerHTML = PHASES.map((p, i) => {
    const pi = i + 1;
    const state = pi < idx || m.phase === 'decommissioned' ? 'done' : pi === idx ? 'active' : 'todo';
    const blocked = state === 'active' && m.mismatches.length > 0;
    return `<li class="${state} ${blocked ? 'blocked' : ''}"><span class="dot">${state === 'done' ? '✓' : pi}</span><span>${p.label}</span></li>`;
  }).join('');
  const current = PHASES.find((p) => p.id === m.phase);
  $('phase-title').textContent = m.phase === 'ready' ? 'Ready to migrate' : current!.label;
  $('phase-blurb').textContent =
    m.phase === 'ready'
      ? `${n(m.totalAccounts)} accounts on the legacy core and customers are transacting right now. Start the migration; nobody should notice.`
      : current!.blurb;
  $('gates').innerHTML = gates()
    .map((g) => `<li class="${g.ok ? 'ok' : 'wait'}"><span>${g.ok ? '✓' : '…'}</span>${esc(g.label)}${g.detail ? ` <em>${esc(g.detail)}</em>` : ''}</li>`)
    .join('');
}

function renderArch() {
  const legacyPrimary = m.primary === 'legacy';
  const set = (id: string, badge: string, figure: string, cls: string) => {
    const el = $(id);
    el.className = `system ${cls}`;
    el.querySelector('[data-badge]')!.textContent = badge;
    el.querySelector('[data-figure]')!.textContent = figure;
  };
  set('sys-legacy', m.legacy.readOnly ? 'Read-only' : legacyPrimary ? 'System of record' : 'Mirror (rollback)', `${n(m.legacy.lastSeq)} journal events`, legacyPrimary ? 'primary' : m.legacy.readOnly ? 'retired' : 'secondary');
  set('sys-ledger', legacyPrimary ? (m.phase === 'ready' ? 'Empty' : 'Replica') : 'System of record', `${n(m.ledger.postingCount)} postings`, legacyPrimary ? (m.phase === 'ready' ? 'idle' : 'secondary') : 'primary');
  const flow = (id: string, active: boolean, label: string) => {
    const el = $(id);
    el.classList.toggle('active', active);
    el.querySelector('[data-label]')!.textContent = label;
  };
  flow('flow-cdc', m.cdcRunning, m.cdcRunning ? `CDC · ${m.replicationSlowed ? 'throttled' : 'streaming'}${m.lag ? ` · ${m.lag} behind` : ''}` : 'CDC · off');
  flow('flow-backfill', m.phase === 'backfill' && !m.workerDown, m.phase === 'backfill' ? (m.workerDown ? 'Backfill · worker restarting' : `Backfill · ${Math.round((m.backfillCursor / m.totalAccounts) * 100)}%`) : 'Backfill · idle');
  flow('flow-mirror', m.phase === 'cutover', m.phase === 'cutover' ? 'Reverse sync · rollback safety' : 'Reverse sync · off');
  $('traffic-note').innerHTML = `Customer writes → <strong>${legacyPrimary ? 'Legacy core' : 'New ledger'}</strong>${m.phase === 'shadow-read' ? ' · reads compared on both' : ''}`;
}

function renderKpis() {
  const s = m.stats;
  const pct = m.totalAccounts ? (m.migratedAccounts / m.totalAccounts) * 100 : 0;
  const tiles = [
    { label: 'Accounts migrated', value: `${n(m.migratedAccounts)}<small>/${n(m.totalAccounts)}</small>`, bar: pct },
    { label: 'Transactions during migration', value: n(s.duringMigration), sub: `${n(s.rejected)} declined for funds (normal)` },
    { label: 'Failed customer requests', value: String(s.failed), tone: s.failed ? 'bad' : 'good' },
    { label: 'Write downtime', value: `${s.writePauseMs}<small> ms</small>`, tone: 'good' },
    { label: 'Replication lag', value: `${n(m.lag)}<small> events</small>`, sub: `peak ${n(s.peakLag)}`, tone: m.lag > 60 ? 'warn' : '' },
    { label: 'Reconciliation', value: m.mismatches.length ? `${m.mismatches.length} mismatch${m.mismatches.length > 1 ? 'es' : ''}` : m.migratedAccounts ? 'In sync' : '—', tone: m.mismatches.length ? 'bad' : m.migratedAccounts ? 'good' : '', sub: `${n(s.driftDetected)} caught · ${n(s.repairs)} repaired` },
    { label: 'Suspense balance', value: money(m.suspenseBalance), sub: 'must reach $0.00 before verify' },
    { label: 'Ledger total', value: money(m.ledger.total()), sub: 'double-entry: always $0.00', tone: m.ledger.total() === 0 ? 'good' : 'bad' }
  ];
  $('kpis').innerHTML = tiles
    .map(
      (t) => `<div class="kpi" ${t.tone ? `data-tone="${t.tone}"` : ''}><span>${t.label}</span><strong>${t.value}</strong>${t.bar !== undefined ? `<div class="bar"><i style="width:${t.bar.toFixed(1)}%"></i></div>` : ''}${t.sub ? `<small class="sub">${t.sub}</small>` : ''}</div>`
    )
    .join('');
}

function renderChart() {
  const W = 600, H = 170, PL = 34, PB = 18, PT = 8;
  const data = m.history;
  const slots = 160;
  const maxServed = Math.max(40, ...data.map((d) => d.served));
  const maxLag = Math.max(50, ...data.map((d) => d.lag));
  const bw = (W - PL - 6) / slots;
  const x = (i: number) => PL + (slots - data.length + i) * bw;
  const yS = (v: number) => H - PB - (v / maxServed) * (H - PB - PT);
  const yL = (v: number) => H - PB - (v / maxLag) * (H - PB - PT);
  const bars = data.map((d, i) => `<rect x="${x(i).toFixed(1)}" y="${yS(d.served).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${(H - PB - yS(d.served)).toFixed(1)}" class="b"/>`).join('');
  const line = data.map((d, i) => `${(x(i) + bw / 2).toFixed(1)},${yL(d.lag).toFixed(1)}`).join(' ');
  $('chart').innerHTML = `
    <line x1="${PL}" x2="${W - 6}" y1="${H - PB}" y2="${H - PB}" class="axis-line"/>
    <line x1="${PL}" x2="${W - 6}" y1="${PT}" y2="${PT}" class="grid"/>
    <text x="${PL - 6}" y="${PT + 4}" text-anchor="end" class="t">${maxServed}</text>
    <text x="${PL - 6}" y="${H - PB}" text-anchor="end" class="t">0</text>
    <text x="${W - 6}" y="${PT + 10}" text-anchor="end" class="t lag-t">lag max ${maxLag}</text>
    ${bars}
    ${data.length > 1 ? `<polyline points="${line}" class="l"/>` : ''}
    <text x="${PL}" y="${H - 4}" class="t">${data.length ? `tick ${Math.max(1, m.tickCount - data.length + 1)}` : ''}</text>
    <text x="${W - 6}" y="${H - 4}" text-anchor="end" class="t">tick ${m.tickCount}</text>`;
}

function renderFaults() {
  const canCrash = m.phase === 'backfill' && !m.workerDown;
  const canDrift = ['backfill', 'verify', 'shadow-read'].includes(m.phase) && m.migratedAccounts > 0;
  const canSlow = m.cdcRunning && !m.replicationSlowed;
  $<HTMLButtonElement>('f-crash').disabled = !canCrash;
  $<HTMLButtonElement>('f-drift').disabled = !canDrift;
  $<HTMLButtonElement>('f-slow').disabled = !canSlow;
  $('f-repair').hidden = !m.mismatches.length;
  $('f-repair').textContent = `Repair ${m.mismatches.length} mismatched account${m.mismatches.length === 1 ? '' : 's'} from source`;
}

function renderLog() {
  $('log').innerHTML = m.log
    .slice(0, 40)
    .map((l) => `<li data-level="${l.level}"><time>t${l.tick}</time><span>${esc(l.message)}</span></li>`)
    .join('') || '<li class="muted">Nothing yet. Press <strong>Start migration</strong>.</li>';
}

function renderInspector() {
  const id = inspected;
  const input = $<HTMLInputElement>('inspect-id');
  if (document.activeElement !== input) input.value = id;
  const legacy = m.legacy.balance(id);
  if (legacy === undefined) {
    $('inspect-result').innerHTML = `<p class="muted">No account ${esc(id)}.</p>`;
    return;
  }
  const ledger = m.ledger.balance(id);
  const snap = m.snapshotSeq.get(id);
  const inflight = (m.legacy.lastTouched.get(id) ?? 0) > m.cdcPosition && m.cdcRunning;
  const match = legacy === ledger;
  const status = snap === undefined ? 'Not migrated yet' : `Migrated (snapshot @ seq ${n(snap)})`;
  const holder = m.legacy.accounts.get(id)!;
  $('inspect-result').innerHTML = `
    <p class="muted small">${esc(holder.holder)} · ${holder.type} · ${status}</p>
    <div class="compare">
      <div><span>Legacy</span><strong>${money(legacy)}</strong></div>
      <div class="${snap === undefined ? '' : match ? 'ok' : inflight ? 'pending' : 'bad'}"><span>New ledger</span><strong>${snap === undefined ? '—' : money(ledger)}</strong>
        <em>${snap === undefined ? 'waiting for backfill' : match ? '✓ matches' : inflight ? 'write in flight via CDC' : '✗ mismatch'}</em></div>
    </div>
    <h3>Recent postings</h3>
    <ul class="postings">${m.ledger
      .recent(id)
      .slice(0, 6)
      .map((p) => `<li><code>${esc(p.txId)}</code><span>${esc(p.memo)}</span><span class="legs">${p.legs
        .filter((l) => l.amount !== 0)
        .map((l) => `<b class="${isSystem(l.account) ? 'sys' : ''}">${esc(l.account)} ${l.amount > 0 ? '+' : '−'}${money(Math.abs(l.amount))}</b>`)
        .join('')}</span></li>`)
      .join('') || '<li class="muted small">No postings yet.</li>'}</ul>`;
}

function render() {
  $<HTMLButtonElement>('start').disabled = m.phase !== 'ready';
  $<HTMLButtonElement>('start').textContent = m.phase === 'ready' ? 'Start migration' : m.phase === 'decommissioned' ? 'Migration complete' : 'Migrating…';
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('pause').setAttribute('aria-pressed', String(paused));
  renderPhases();
  renderArch();
  renderKpis();
  renderChart();
  renderFaults();
  renderLog();
  renderInspector();
}

setInterval(() => {
  if (paused) return;
  for (let i = 0; i < speed; i++) m.tick();
  render();
}, TICK_MS);
render();
