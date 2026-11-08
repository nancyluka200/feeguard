require('dotenv').config();
const express = require('express');
const path = require('path');
const paypal = require('./lib/paypal');
const analysis = require('./lib/analysis');
const anomalies = require('./lib/anomalies');
const { runAgent, provider, aiConfigured } = require('./lib/agent');
const { createGuard } = require('./lib/guard');
const store = require('./lib/store');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const guard = createGuard();
  const agentGuard = guard('agent', { perHour: 20, dailyCap: 300 });
  const paymentGuard = guard('payment', { perHour: 10, dailyCap: 100 });
  const payoutGuard = guard('payout', { perHour: 5, dailyCap: 50 });
  app.use(express.static(path.join(__dirname, 'public')));

  const baseUrl = () => process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const fees = () => ({ percent: Number(process.env.FEE_PERCENT || 4.4), fixed: Number(process.env.FEE_FIXED || 0.3) });
  const useDemo = () => process.env.DEMO_MODE === '1' || !paypal.configured();

  // Optional extra for the dashboard. A problem here never affects the existing numbers.
  const alertsFor = txns => { try { return anomalies.detectAnomalies(txns, { feeFixed: fees().fixed }); } catch (e) { return null; } };

  let cache = { at: 0, value: null };

  // Returns normalised transactions plus where they came from.
  async function loadTransactions({ fresh = false } = {}) {
    if (!fresh && cache.value && Date.now() - cache.at < 60000) return cache.value;
    let value;
    if (useDemo()) {
      value = { source: 'demo', warning: null, transactions: analysis.normalize(analysis.demoDetails()) };
    } else {
      const local = () => store.loadDetails();
      try {
        const details = await paypal.searchTransactions({ days: 30 });
        // Add payments captured through FeeGuard that Transaction Search has not listed yet.
        const seen = new Set(details.map(d => d.transaction_info && d.transaction_info.transaction_id));
        const extra = local().filter(d => !seen.has(d.transaction_info.transaction_id));
        const found = details.concat(extra);
        value = { source: details.length ? 'sandbox' : (found.length ? 'sandbox-local' : 'sandbox'), warning: null, transactions: analysis.normalize(found) };
        if (extra.length) {
          value.warning = `${extra.length} recent payment${extra.length > 1 ? 's' : ''} captured through FeeGuard ${extra.length > 1 ? 'are' : 'is'} included before Transaction Search lists ${extra.length > 1 ? 'them' : 'it'}.`;
        } else if (!found.length) {
          value.warning = 'Your sandbox account has no transactions in the last 30 days. Create a test payment below. New ones can take a few hours to appear in Transaction Search.';
        }
      } catch (e) {
        const found = local();
        if (found.length) {
          value = { source: 'sandbox-local', warning: `Transaction Search is not available yet, so this shows payments captured through FeeGuard. ${e.message}`, transactions: analysis.normalize(found) };
        } else {
          value = { source: 'demo', warning: `Could not read sandbox transactions, showing demo data. Create and pay a test payment below and it will appear here. ${e.message}`, transactions: analysis.normalize(analysis.demoDetails()) };
        }
      }
    }
    cache = { at: Date.now(), value };
    return value;
  }

  async function createPaymentLink({ amount, currency, description }) {
    if (!paypal.configured()) throw new Error('PayPal sandbox credentials are not set, so payment links are unavailable in demo mode.');
    const order = await paypal.createOrder({
      amount, currency, description,
      returnUrl: `${baseUrl()}/paypal/return`, cancelUrl: `${baseUrl()}/paypal/cancel`
    });
    return { order_id: order.id, status: order.status, pay_url: order.approveUrl, note: 'Sandbox only. Open the link and pay with a sandbox personal account.' };
  }

  app.get('/api/status', (req, res) => {
    res.json({
      paypalConfigured: paypal.configured(),
      claudeConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      ai: { provider: provider(), configured: aiConfigured() },
      demoMode: useDemo(),
      accessRequired: Boolean(process.env.ACCESS_CODE),
      fees: fees()
    });
  });

  app.get('/api/summary', async (req, res) => {
    try {
      const data = await loadTransactions({ fresh: req.query.fresh === '1' });
      const days = req.query.days ? Number(req.query.days) : undefined;
      res.json({
        source: data.source, warning: data.warning,
        summary: analysis.summarize(data.transactions, { days }),
        costliest: analysis.costliestPayments(data.transactions, { limit: 20 }),
        alerts: alertsFor(data.transactions)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/payment-link', paymentGuard, async (req, res) => {
    try {
      const amount = Number(req.body.amount);
      if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount above 0.' });
      res.json(await createPaymentLink({ amount, currency: (req.body.currency || 'USD').toUpperCase(), description: req.body.description }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Buyer returns here after approving on PayPal. Capture the order, then go back to the app.
  app.get('/paypal/return', async (req, res) => {
    try {
      const out = await paypal.captureOrder(req.query.token);
      if (out.fee != null && out.gross != null) {
        store.addCapture({ orderId: out.id, captureId: out.captureId, gross: out.gross, fee: out.fee, net: out.net, currency: out.currency });
      }
      cache = { at: 0, value: null };
      const q = new URLSearchParams({ paid: out.id, gross: out.gross || '', fee: out.fee || '', net: out.net || '', cur: out.currency || '' });
      res.redirect(`/?${q}`);
    } catch (e) { res.redirect(`/?error=${encodeURIComponent(e.message)}`); }
  });
  app.get('/paypal/cancel', (req, res) => res.redirect('/?cancelled=1'));

  app.post('/api/payout', payoutGuard, async (req, res) => {
    try {
      const { email, amount, currency } = req.body;
      if (!email || !(Number(amount) > 0)) return res.status(400).json({ error: 'Enter an email and an amount above 0.' });
      if (!paypal.configured()) return res.status(400).json({ error: 'PayPal sandbox credentials are not set.' });
      res.json(await paypal.createPayout({ email, amount, currency: (currency || 'USD').toUpperCase() }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agent', agentGuard, async (req, res) => {
    try {
      const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [];
      if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Send a user message.' });
      const out = await runAgent({
        messages,
        deps: { getTransactions: async () => (await loadTransactions()).transactions, createPaymentLink, fees: fees() }
      });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`FeeGuard running on http://localhost:${port}`));
}

module.exports = { createApp };