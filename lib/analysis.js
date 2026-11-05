// Fee analysis: normalise PayPal transactions and compute what they really cost.
const fs = require('fs');
const path = require('path');

// PayPal transaction event codes (subset). T00xx are payments, T04xx withdrawals, T11xx reversals.
function kindOf(code = '') {
  if (/^T04/.test(code)) return 'withdrawal';
  if (/^T11/.test(code)) return 'refund';
  if (/^T00/.test(code)) return 'payment';
  return 'other';
}

function normalize(details) {
  return details.map(d => {
    const i = d.transaction_info || {};
    const amt = Number(i.transaction_amount?.value || 0);
    const fee = Math.abs(Number(i.fee_amount?.value || 0));
    const payer = d.payer_info?.payer_name;
    return {
      id: i.transaction_id,
      date: (i.transaction_initiation_date || '').slice(0, 10),
      kind: kindOf(i.transaction_event_code),
      name: payer?.alternate_full_name || d.payer_info?.email_address || 'Unknown',
      currency: i.transaction_amount?.currency_code || 'USD',
      gross: amt,
      fee,
      net: Number((amt - fee).toFixed(2))
    };
  });
}

const r2 = n => Math.round(n * 100) / 100;

function summarize(txns, { currency, days } = {}) {
  let data = txns;
  if (days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    data = data.filter(t => t.date >= cutoff);
  }
  if (!currency) {
    const count = {};
    data.forEach(t => { count[t.currency] = (count[t.currency] || 0) + 1; });
    currency = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || 'USD';
  }
  data = data.filter(t => t.currency === currency);
  const payments = data.filter(t => t.kind === 'payment' && t.gross > 0);
  const withdrawals = data.filter(t => t.kind === 'withdrawal');
  const gross = payments.reduce((s, t) => s + t.gross, 0);
  const fees = payments.reduce((s, t) => s + t.fee, 0);
  const wdFees = withdrawals.reduce((s, t) => s + t.fee, 0);
  const months = {};
  data.forEach(t => { const k = t.date.slice(0, 7); months[k] = (months[k] || 0) + t.fee; });
  const byClient = {};
  payments.forEach(t => {
    const c = byClient[t.name] || (byClient[t.name] = { name: t.name, payments: 0, gross: 0, fees: 0 });
    c.payments++; c.gross += t.gross; c.fees += t.fee;
  });
  const clients = Object.values(byClient).map(c => ({
    name: c.name, payments: c.payments, gross: r2(c.gross), fees: r2(c.fees),
    fee_rate_percent: c.gross ? r2((c.fees / c.gross) * 100) : 0
  })).sort((a, b) => b.fees - a.fees);
  return {
    currency,
    transactions: data.length,
    payments_received: payments.length,
    gross_received: r2(gross),
    fees_on_payments: r2(fees),
    average_fee_rate_percent: gross ? r2((fees / gross) * 100) : 0,
    kept_after_fees: r2(gross - fees),
    withdrawals: withdrawals.length,
    withdrawal_fees: r2(wdFees),
    total_fees: r2(data.reduce((s, t) => s + t.fee, 0)),
    fees_by_month: Object.keys(months).sort().map(k => ({ month: k, fees: r2(months[k]) })),
    fees_by_client: clients
  };
}

function costliestPayments(txns, { limit = 5, currency } = {}) {
  return txns
    .filter(t => t.kind === 'payment' && t.gross > 0 && (!currency || t.currency === currency))
    .map(t => ({ id: t.id, date: t.date, from: t.name, amount: r2(t.gross), fee: r2(t.fee), fee_rate_percent: r2((t.fee / t.gross) * 100), currency: t.currency }))
    .sort((a, b) => b.fee_rate_percent - a.fee_rate_percent)
    .slice(0, limit);
}

// Price to charge so that, after PayPal's percent + fixed fee, you keep targetNet.
function priceForTargetNet({ targetNet, feePercent, feeFixed }) {
  const p = feePercent / 100;
  if (p >= 1) throw new Error('fee percent must be below 100');
  const price = (targetNet + feeFixed) / (1 - p);
  return { price: r2(price), fee: r2(price - targetNet), you_keep: targetNet, fee_percent: feePercent, fee_fixed: feeFixed };
}

function loadRoutes() {
  const file = path.join(__dirname, '..', 'config', 'routes.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// How much local currency lands in your bank for each route.
function compareWithdrawalRoutes({ amount, marketRate, paypalRate }) {
  const { routes, _note } = loadRoutes();
  const ppMarkup = paypalRate && marketRate ? ((marketRate - paypalRate) / marketRate) * 100 : 0;
  const fair = amount * marketRate;
  const results = routes.map(r => {
    const markup = r.fx_markup_percent == null ? ppMarkup : r.fx_markup_percent;
    const fee = (amount * r.fee_percent) / 100 + r.fee_fixed;
    const received = (amount - fee) * marketRate * (1 - markup / 100);
    return {
      route: r.name, fee_usd: r2(fee), fx_markup_percent: r2(markup),
      you_receive_local: r2(received), lost_vs_market_local: r2(fair - received),
      lost_percent: r2(((fair - received) / fair) * 100), note: r.note
    };
  }).sort((a, b) => b.you_receive_local - a.you_receive_local);
  return { amount_usd: amount, market_rate: marketRate, assumptions_note: _note, routes: results };
}

// Demo data in PayPal's transaction_details shape, so the demo path exercises the same code.
function demoDetails() {
  const names = ['Amina Co.', 'Northwind Ltd', 'J. Okafor', 'Brightside Studio', 'Lena K.', 'Delta Retail', 'M. Rossi', 'Kijani Goods'];
  const amounts = [25, 60, 120, 18, 250, 40, 90, 15, 75, 180];
  const out = [];
  for (let i = 0; i < 34; i++) {
    const d = new Date(Date.now() - (i * 0.85 + 1) * 86400000).toISOString();
    const g = amounts[i % amounts.length];
    const intl = i % 3 !== 0;
    const fee = Number((g * (intl ? 0.054 : 0.044) + 0.30).toFixed(2));
    out.push({
      transaction_info: {
        transaction_id: `DEMO${1000 + i}`, transaction_event_code: 'T0006', transaction_initiation_date: d,
        transaction_amount: { currency_code: 'USD', value: String(g) }, fee_amount: { currency_code: 'USD', value: String(-fee) }
      },
      payer_info: { payer_name: { alternate_full_name: names[i % names.length] } }
    });
  }
  [[6, 400], [14, 350], [24, 500]].forEach(([age, amt], k) => {
    out.push({
      transaction_info: {
        transaction_id: `DEMOW${k}`, transaction_event_code: 'T0400',
        transaction_initiation_date: new Date(Date.now() - age * 86400000).toISOString(),
        transaction_amount: { currency_code: 'USD', value: String(-amt) }, fee_amount: { currency_code: 'USD', value: '-3.5' }
      }
    });
  });
  return out;
}

module.exports = { normalize, summarize, costliestPayments, priceForTargetNet, compareWithdrawalRoutes, demoDetails, kindOf };
