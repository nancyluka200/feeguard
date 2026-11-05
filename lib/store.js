// Remembers payments captured through FeeGuard, so the dashboard and agent still have real
// sandbox data when Transaction Search is unavailable or slow to list new transactions.
const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir() {
  if (process.env.FEEGUARD_DATA_DIR) return process.env.FEEGUARD_DATA_DIR;
  // `npm test` (node --test) runs each test file in a child process that has NODE_TEST_CONTEXT set.
  // Keep test payments in a throwaway folder so they never land in the real dashboard data.
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `feeguard-test-${process.pid}`);
  return path.join(__dirname, '..', 'data');
}

function file() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'captured.json');
}

function readAll() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return []; }
}

function addCapture({ orderId, captureId, gross, fee, net, currency, description }) {
  const all = readAll();
  const id = captureId || orderId;
  if (all.some(r => r.id === id)) return;
  all.push({ id, date: new Date().toISOString(), gross: Number(gross), fee: Number(fee), net: Number(net), currency: currency || 'USD', description: description || '' });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

// Returned in PayPal's transaction_details shape so it goes through the same analysis code.
function loadDetails() {
  return readAll().map(r => ({
    transaction_info: {
      transaction_id: r.id, transaction_event_code: 'T0006', transaction_initiation_date: r.date,
      transaction_amount: { currency_code: r.currency, value: String(r.gross) },
      fee_amount: { currency_code: r.currency, value: String(-Math.abs(r.fee)) }
    },
    payer_info: { payer_name: { alternate_full_name: 'John Doe' } }
  }));
}

module.exports = { addCapture, loadDetails };
