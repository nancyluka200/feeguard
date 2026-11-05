// Thin PayPal REST client (sandbox by default). Uses Node's built-in fetch.
const crypto = require('crypto');

function base() {
  return process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
}

function configured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

let cached = null;

async function getToken() {
  if (cached && cached.expires > Date.now() + 30000) return cached.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${data.error_description || data.error || 'check client id and secret'}`);
  cached = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cached.value;
}

async function api(path, { method = 'GET', body } = {}) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (method === 'POST') headers['PayPal-Request-Id'] = crypto.randomUUID();
  const res = await fetch(`${base()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) cached = null; // drop the saved token so the next call gets a fresh one
    const detail = data.details && data.details[0] ? ` ${data.details[0].issue || ''} ${data.details[0].description || ''}` : '';
    throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${data.message || data.name || 'error'}${detail}`);
  }
  return data;
}

// Orders API v2: create an order the buyer approves on PayPal, then capture it.
async function createOrder({ amount, currency = 'USD', description = 'FeeGuard test payment', returnUrl, cancelUrl }) {
  const order = await api('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ description, amount: { currency_code: currency, value: Number(amount).toFixed(2) } }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING'
          }
        }
      }
    }
  });
  const link = (order.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: order.id, status: order.status, approveUrl: link ? link.href : null };
}

async function captureOrder(orderId) {
  const data = await api(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', body: {} });
  const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    id: data.id,
    status: data.status,
    captureId: cap?.id,
    gross: cap?.seller_receivable_breakdown?.gross_amount?.value,
    fee: cap?.seller_receivable_breakdown?.paypal_fee?.value,
    net: cap?.seller_receivable_breakdown?.net_amount?.value,
    currency: cap?.amount?.currency_code
  };
}

// Transaction Search (Reporting API). Range must be 31 days or less. New transactions can take
// a few hours to appear, and the app needs the "Transaction Search" feature enabled.
function isoNoMs(d) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

async function searchTransactions({ days = 30 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(days, 31) * 86400000);
  const out = [];
  let page = 1, totalPages = 1;
  while (page <= totalPages && page <= 10) {
    const q = new URLSearchParams({
      start_date: isoNoMs(start), end_date: isoNoMs(end), fields: 'transaction_info,payer_info',
      page_size: '100', page: String(page)
    });
    const data = await api(`/v1/reporting/transactions?${q}`);
    totalPages = data.total_pages || 1;
    (data.transaction_details || []).forEach(t => out.push(t));
    page++;
  }
  return out;
}

// Payouts API: send money from the sandbox business account to an email.
async function createPayout({ email, amount, currency = 'USD', note = 'FeeGuard test payout' }) {
  const data = await api('/v1/payments/payouts', {
    method: 'POST',
    body: {
      sender_batch_header: { sender_batch_id: `fg_${Date.now()}`, email_subject: 'You have a payout', email_message: note },
      items: [{
        recipient_type: 'EMAIL', receiver: email, note,
        amount: { value: Number(amount).toFixed(2), currency }
      }]
    }
  });
  return { batchId: data.batch_header?.payout_batch_id, status: data.batch_header?.batch_status };
}

module.exports = { configured, createOrder, captureOrder, searchTransactions, createPayout };
