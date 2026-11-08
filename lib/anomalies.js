// Fee anomaly detection: finds payments and patterns whose fees look unusual, with plain reasons.
// Works on the normalised transactions from analysis.normalize(). Alerts are signals to review,
// not proof of a problem.
const r2 = n => Math.round(n * 100) / 100;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function detectAnomalies(txns, { feeFixed = 0.3, currency } = {}) {
  if (!currency) {
    const count = {};
    txns.forEach(t => { count[t.currency] = (count[t.currency] || 0) + 1; });
    currency = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || 'USD';
  }
  const data = txns.filter(t => t.currency === currency);
  const payments = data.filter(t => t.kind === 'payment' && t.gross > 0);
  const refunds = data.filter(t => t.kind === 'refund');

  const gross = payments.reduce((s, t) => s + t.gross, 0);
  const fees = payments.reduce((s, t) => s + t.fee, 0);
  const avgRate = gross ? (fees / gross) * 100 : 0;
  const alerts = [];
  const notes = [];

  // The fixed-fee based rules assume the configured fixed fee, which is in USD.
  const usd = currency === 'USD';
  if (!usd) notes.push(`Fixed-fee checks are skipped because the configured fixed fee is in USD and these payments are in ${currency}.`);

  const rateOf = t => (t.gross ? (t.fee / t.gross) * 100 : 0);
  const baseline = payments.filter(t => t.gross >= 5);
  const impliedPct = t => ((t.fee - feeFixed) / t.gross) * 100;
  const typicalPct = median(baseline.map(impliedPct));

  // 1. Payments whose percentage part is higher than the account's typical percentage part.
  if (usd && baseline.length >= 4) {
    baseline.forEach(t => {
      const implied = impliedPct(t);
      const diff = implied - typicalPct;
      if (diff >= 0.5) {
        alerts.push({
          type: 'unusual_fee_rate',
          severity: diff >= 1.5 ? 'high' : 'medium',
          id: t.id, date: t.date, amount: r2(t.gross), fee: r2(t.fee), fee_rate_percent: r2(rateOf(t)),
          message: `The fee on this ${r2(t.gross)} ${currency} payment is ${r2(rateOf(t))}% of the amount. After the fixed ${feeFixed}, about ${r2(implied)}% is the percentage part, against a typical ${r2(typicalPct)}% on your other payments. PayPal may have applied a different rate, for example for an international or different payment type. Review the fee breakdown in PayPal.`
        });
      }
    });
  }

  // 2. Small payments where the fixed fee is at least half of the whole fee.
  if (usd && feeFixed > 0) {
    payments
      .filter(t => t.fee > 0 && feeFixed / t.fee >= 0.5)
      .sort((a, b) => rateOf(b) - rateOf(a))
      .slice(0, 5)
      .forEach(t => {
        const share = Math.round((feeFixed / t.fee) * 100);
        alerts.push({
          type: 'fixed_fee_heavy',
          severity: rateOf(t) >= 10 ? 'medium' : 'low',
          id: t.id, date: t.date, amount: r2(t.gross), fee: r2(t.fee), fee_rate_percent: r2(rateOf(t)),
          message: `The fixed fee of ${feeFixed} is ${share}% of the fee on this ${r2(t.gross)} ${currency} payment, so the fee takes ${r2(rateOf(t))}% of it. A minimum charge, or bundling small payments, would reduce this.`
        });
      });
  }

  // 3. A single payment that accounts for a large share of all fees.
  if (payments.length >= 3 && fees > 0) {
    payments.forEach(t => {
      const share = (t.fee / fees) * 100;
      if (share >= 40) {
        alerts.push({
          type: 'fee_concentration',
          severity: 'low',
          id: t.id, date: t.date, amount: r2(t.gross), fee: r2(t.fee), fee_rate_percent: r2(rateOf(t)),
          message: `This one ${r2(t.gross)} ${currency} payment accounts for ${Math.round(share)}% of your fees (${r2(t.fee)} of ${r2(fees)}). Large payments carry large fees even at a normal rate.`
        });
      }
    });
  }

  // 4. The fee rate rose from one month to the next.
  const byMonth = {};
  payments.forEach(t => {
    const k = t.date.slice(0, 7);
    const m = byMonth[k] || (byMonth[k] = { gross: 0, fee: 0, n: 0 });
    m.gross += t.gross; m.fee += t.fee; m.n++;
  });
  const months = Object.keys(byMonth).sort();
  if (months.length >= 2) {
    const prev = byMonth[months[months.length - 2]];
    const last = byMonth[months[months.length - 1]];
    if (prev.n >= 2 && last.n >= 2 && prev.gross && last.gross) {
      const prevRate = (prev.fee / prev.gross) * 100;
      const lastRate = (last.fee / last.gross) * 100;
      if (lastRate - prevRate >= 1) {
        alerts.push({
          type: 'monthly_rate_jump',
          severity: 'medium',
          month: months[months.length - 1],
          message: `Fees were ${r2(lastRate)}% of payments received in ${months[months.length - 1]}, up from ${r2(prevRate)}% in ${months[months.length - 2]}. More small payments or a different payment type can cause this.`
        });
      }
    }
  }

  // 5. Repeated refunds or reversals.
  if (refunds.length >= 2) {
    const total = refunds.reduce((s, t) => s + Math.abs(t.gross), 0);
    alerts.push({
      type: 'refunds',
      severity: 'medium',
      count: refunds.length,
      message: `${refunds.length} refunds or reversals were found, totalling ${r2(total)} ${currency}. Check whether the original fees were returned to you.`
    });
  }

  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    currency,
    payments_checked: payments.length,
    baseline: {
      average_fee_rate_percent: r2(avgRate),
      typical_percentage_part_percent: baseline.length >= 4 ? r2(typicalPct) : null,
      fixed_fee_assumed: feeFixed,
      notes
    },
    alert_count: alerts.length,
    alerts,
    summary: alerts.length
      ? `${alerts.length} item${alerts.length > 1 ? 's' : ''} to review.`
      : 'No unusual fee patterns found.'
  };
}

module.exports = { detectAnomalies };
