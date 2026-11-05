// Runs the real code against local mock servers that imitate the PayPal and Anthropic APIs.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

function mockServer(handler) {
  return new Promise(resolve => {
    const calls = [];
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const call = { method: req.method, url: req.url, headers: req.headers, body: body ? safe(body) : null };
        calls.push(call);
        const out = handler(call);
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    s.listen(0, () => resolve({ s, calls, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
function safe(b) { try { return JSON.parse(b); } catch { return b; } }

const analysis = require('../lib/analysis');

test('priceForTargetNet keeps the target after fees', () => {
  const r = analysis.priceForTargetNet({ targetNet: 100, feePercent: 4.4, feeFixed: 0.3 });
  const keep = r.price - (r.price * 0.044 + 0.3);
  assert.ok(Math.abs(keep - 100) < 0.02, `kept ${keep}`);
});

test('summarize and costliest work on demo data', () => {
  const txns = analysis.normalize(analysis.demoDetails());
  const s = analysis.summarize(txns);
  assert.equal(s.currency, 'USD');
  assert.ok(s.payments_received > 20);
  assert.ok(s.average_fee_rate_percent > 4 && s.average_fee_rate_percent < 12);
  assert.equal(s.withdrawals, 3);
  assert.equal(s.withdrawal_fees, 10.5);
  const top = analysis.costliestPayments(txns, { limit: 3 });
  assert.equal(top.length, 3);
  assert.ok(top[0].fee_rate_percent >= top[2].fee_rate_percent);
});

test('compareWithdrawalRoutes ranks cheapest first and uses the PayPal rate markup', () => {
  const r = analysis.compareWithdrawalRoutes({ amount: 500, marketRate: 129, paypalRate: 125.5 });
  assert.equal(r.routes.length, 3);
  assert.ok(r.routes[0].you_receive_local >= r.routes[2].you_receive_local);
  const pp = r.routes.find(x => /PayPal/.test(x.route));
  assert.ok(Math.abs(pp.fx_markup_percent - 2.71) < 0.05);
});

test('PayPal client: token, order, capture, search, payout', async () => {
  const mock = await mockServer(c => {
    if (c.url === '/v1/oauth2/token') return { json: { access_token: 'tok', expires_in: 3600 } };
    if (c.url === '/v2/checkout/orders') return { json: { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.com/pay?token=ORD1' }] } };
    if (c.url.startsWith('/v2/checkout/orders/ORD1/capture')) return { json: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', amount: { currency_code: 'USD' }, seller_receivable_breakdown: { gross_amount: { value: '50.00' }, paypal_fee: { value: '2.50' }, net_amount: { value: '47.50' } } }] } }] } };
    if (c.url.startsWith('/v1/reporting/transactions')) return { json: { total_pages: 1, transaction_details: analysis.demoDetails().slice(0, 3) } };
    if (c.url === '/v1/payments/payouts') return { json: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } } };
    return { status: 404, json: { name: 'NOT_FOUND', message: c.url } };
  });
  process.env.PAYPAL_BASE = mock.url;
  process.env.PAYPAL_CLIENT_ID = 'id';
  process.env.PAYPAL_CLIENT_SECRET = 'secret';
  const pp = require('../lib/paypal');
  assert.ok(pp.configured());

  const order = await pp.createOrder({ amount: 50, returnUrl: 'http://x/return', cancelUrl: 'http://x/cancel' });
  assert.equal(order.id, 'ORD1');
  assert.ok(order.approveUrl.includes('ORD1'));
  const orderCall = mock.calls.find(c => c.url === '/v2/checkout/orders');
  assert.equal(orderCall.body.purchase_units[0].amount.value, '50.00');
  assert.equal(orderCall.headers.authorization, 'Bearer tok');
  assert.ok(orderCall.headers['paypal-request-id']);

  const cap = await pp.captureOrder('ORD1');
  assert.equal(cap.fee, '2.50');
  assert.equal(cap.net, '47.50');

  const tx = await pp.searchTransactions({ days: 30 });
  assert.equal(tx.length, 3);
  const q = mock.calls.find(c => c.url.startsWith('/v1/reporting'));
  assert.match(q.url, /start_date=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}Z/);

  const po = await pp.createPayout({ email: 'a@b.com', amount: 10 });
  assert.equal(po.batchId, 'B1');
  mock.s.close();
});

test('Claude agent loop calls a tool, feeds back the result, and returns text', async () => {
  let n = 0;
  const seen = [];
  const mock = await mockServer(c => {
    n++;
    seen.push(c.body);
    if (n === 1) {
      return { json: { id: 'm1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'tu1', name: 'price_for_target_net', input: { target_net: 100 } }] } };
    }
    return { json: { id: 'm2', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'Charge about $105.' }] } };
  });
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.ANTHROPIC_BASE_URL = mock.url;
  const { runAgent } = require('../lib/agent');
  const out = await runAgent({
    messages: [{ role: 'user', content: 'What should I charge to keep 100?' }],
    deps: { getTransactions: async () => [], createPaymentLink: async () => ({}), fees: { percent: 4.4, fixed: 0.3 } }
  });
  assert.equal(out.reply, 'Charge about $105.');
  assert.equal(out.tools[0].name, 'price_for_target_net');
  const second = seen[1];
  const toolResult = second.messages[second.messages.length - 1].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.ok(JSON.parse(toolResult.content).price > 104);
  assert.ok(seen[0].tools.length === 5);
  mock.s.close();
});

test('HTTP server: status, summary, payment link, return capture, payout, agent', async () => {
  const mock = await mockServer(c => {
    if (c.url === '/v1/oauth2/token') return { json: { access_token: 'tok', expires_in: 3600 } };
    if (c.url === '/v2/checkout/orders') return { json: { id: 'ORD2', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.com/pay?token=ORD2' }] } };
    if (c.url.includes('/capture')) return { json: { id: 'ORD2', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C', amount: { currency_code: 'USD' }, seller_receivable_breakdown: { gross_amount: { value: '75.00' }, paypal_fee: { value: '3.60' }, net_amount: { value: '71.40' } } }] } }] } };
    if (c.url.startsWith('/v1/reporting')) return { json: { total_pages: 1, transaction_details: analysis.demoDetails() } };
    if (c.url === '/v1/payments/payouts') return { json: { batch_header: { payout_batch_id: 'B2', batch_status: 'PENDING' } } };
    return { status: 404, json: { message: c.url } };
  });
  process.env.PAYPAL_BASE = mock.url;
  process.env.PAYPAL_CLIENT_ID = 'id';
  process.env.PAYPAL_CLIENT_SECRET = 'secret';
  process.env.BASE_URL = 'http://localhost:3000';
  const { createApp } = require('../server');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => (await fetch(base + p, { redirect: 'manual' }));
  const post = async (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

  const st = await (await get('/api/status')).json();
  assert.equal(st.paypalConfigured, true);
  assert.equal(st.demoMode, false);

  const sum = await (await get('/api/summary')).json();
  assert.equal(sum.source, 'sandbox');
  assert.ok(sum.summary.payments_received > 20);

  const link = await (await post('/api/payment-link', { amount: 75, currency: 'USD' })).json();
  assert.equal(link.order_id, 'ORD2');
  assert.ok(link.pay_url.includes('ORD2'));

  const bad = await post('/api/payment-link', { amount: 0 });
  assert.equal(bad.status, 400);

  const ret = await get('/paypal/return?token=ORD2');
  assert.equal(ret.status, 302);
  assert.match(ret.headers.get('location'), /paid=ORD2.*fee=3.60/);

  const po = await (await post('/api/payout', { email: 'x@y.com', amount: 5 })).json();
  assert.equal(po.batchId, 'B2');

  const html = await (await get('/')).text();
  assert.match(html, /FeeGuard/);

  server.close();
  mock.s.close();
});

test('demo mode works with no credentials', async () => {
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  const { createApp } = require('../server');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const sum = await (await fetch(base + '/api/summary')).json();
  assert.equal(sum.source, 'demo');
  const r = await fetch(base + '/api/payment-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 5 }) });
  assert.equal(r.status, 500);
  server.close();
});
