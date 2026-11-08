const test = require('node:test');
const assert = require('node:assert');
const { detectAnomalies } = require('../lib/anomalies');

const fee = g => Math.round((g * 0.034 + 0.3) * 100) / 100;
const mk = (id, date, gross, f, kind = 'payment', currency = 'USD') =>
  ({ id, date, kind, name: 'Buyer', currency, gross, fee: f, net: gross - f });

const normal = () => [15, 25, 50, 100, 200].map((g, i) => mk(`N${i}`, `2026-10-2${i}`, g, fee(g)));

test('anomalies: consistent 3.4% + 0.30 payments raise no rate alerts', () => {
  const out = detectAnomalies(normal(), { feeFixed: 0.3 });
  assert.strictEqual(out.alerts.filter(a => a.type === 'unusual_fee_rate').length, 0);
  assert.strictEqual(out.alerts.filter(a => a.type === 'fixed_fee_heavy').length, 0);
});

test('anomalies: a payment charged 4.4% + 0.30 among 3.4% payments is flagged', () => {
  const txns = normal().concat(mk('ODD', '2026-11-04', 75, 3.6));
  const out = detectAnomalies(txns, { feeFixed: 0.3 });
  const hit = out.alerts.find(a => a.type === 'unusual_fee_rate');
  assert.ok(hit, 'expected an unusual_fee_rate alert');
  assert.strictEqual(hit.id, 'ODD');
  assert.strictEqual(hit.fee_rate_percent, 4.8);
});

test('anomalies: a $1 payment is flagged as fixed-fee heavy', () => {
  const txns = normal().concat(mk('TINY', '2026-10-26', 1, 0.33));
  const out = detectAnomalies(txns, { feeFixed: 0.3 });
  const hit = out.alerts.find(a => a.type === 'fixed_fee_heavy');
  assert.ok(hit);
  assert.strictEqual(hit.id, 'TINY');
  assert.strictEqual(hit.fee_rate_percent, 33);
});

test('anomalies: two refunds are reported', () => {
  const txns = normal().concat([mk('R1', '2026-10-27', -10, 0, 'refund'), mk('R2', '2026-10-28', -20, 0, 'refund')]);
  const out = detectAnomalies(txns, { feeFixed: 0.3 });
  const hit = out.alerts.find(a => a.type === 'refunds');
  assert.ok(hit);
  assert.strictEqual(hit.count, 2);
});

test('anomalies: fixed-fee rules are skipped for non-USD payments', () => {
  const txns = [15, 25, 50, 100, 200].map((g, i) => mk(`K${i}`, `2026-10-2${i}`, g, fee(g), 'payment', 'KES'));
  txns.push(mk('KODD', '2026-11-04', 75, 3.6, 'payment', 'KES'));
  const out = detectAnomalies(txns, { feeFixed: 0.3 });
  assert.strictEqual(out.alerts.filter(a => a.type === 'unusual_fee_rate' || a.type === 'fixed_fee_heavy').length, 0);
  assert.ok(out.baseline.notes.length > 0);
});

test('anomalies: too few payments gives no baseline-based alerts', () => {
  const out = detectAnomalies([mk('A', '2026-10-20', 50, 2.0), mk('B', '2026-10-21', 75, 3.6)], { feeFixed: 0.3 });
  assert.strictEqual(out.alerts.filter(a => a.type === 'unusual_fee_rate').length, 0);
  assert.strictEqual(out.baseline.typical_percentage_part_percent, null);
});

test('anomalies: the fee rate rising month on month is flagged', () => {
  const txns = [
    mk('M1', '2026-09-05', 100, 3.7), mk('M2', '2026-09-10', 100, 3.7),
    mk('M3', '2026-10-05', 20, 1.5), mk('M4', '2026-10-10', 20, 1.5)
  ];
  const out = detectAnomalies(txns, { feeFixed: 0.3 });
  const hit = out.alerts.find(a => a.type === 'monthly_rate_jump');
  assert.ok(hit);
  assert.strictEqual(hit.month, '2026-10');
});