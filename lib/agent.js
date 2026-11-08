// FeeGuard agent with tools that read PayPal data and act on the PayPal sandbox.
// Providers: groq, gemini, claude. Choose with AI_PROVIDER in .env (case does not matter).
const Anthropic = require('@anthropic-ai/sdk');
const analysis = require('./analysis');
const anomalies = require('./anomalies');

const SYSTEM = `You are FeeGuard, an assistant for freelancers and small sellers who get paid through PayPal.
You help them understand what PayPal really costs them and what to do about it.
Rules:
- Always call tools to get numbers. Never invent transaction data, fees, or exchange rates.
- If you need an exchange rate and the user has not given one, ask for it.
- Route comparisons use editable assumptions, so say they are assumptions.
- You work against the PayPal SANDBOX. Payment links and payouts you create use test money. Say so when you create one.
- Be short and concrete: lead with the number or the action, then one line of reasoning.
- When comparing fees, separate the fixed part from the percentage part, and say which part the seller can change.
- When you explain a fee, state the percentage rate and the fixed part separately, and do not turn a dollar amount into a percentage.
- Never state a PayPal fee percentage or fee schedule unless a tool result gave it. If you need the rate, call price_for_target_net or list_costliest_payments, or say the rate is set in the app.
- Do not assume a country's standard PayPal fees. Report only what the tools return.
- For a broad question such as "analyse my activity" or "how can I reduce my fees", first call get_fee_summary, list_costliest_payments and detect_fee_anomalies. Call price_for_target_net or compare_withdrawal_routes only when they help the answer. Then compare the results and give at most 3 recommendations, most valuable first. Tie each recommendation to a number the tools returned.
- Alerts from detect_fee_anomalies are signals to review, not proof of a problem. Give the reason in the alert and suggest checking the payment in PayPal. Never claim fraud or an error.
- Say which figures are real PayPal data (transactions and their fees) and which are estimates (pricing at the configured fee rate, withdrawal routes).
- When the user wants to receive an amount, for example "I want to receive $500", call price_for_target_net, show the price to charge, the expected fee and the net, then ask "Shall I create the payment link for that amount?" and wait. Call create_payment_link only after the user confirms. If the user already asked for a link for a stated amount, create it straight away.
- After creating a payment link, give the link and say it is a sandbox test payment. Do not state or estimate any fee, fee percentage or net amount for it: FeeGuard shows the real fee after the buyer pays. The seller, not the buyer, pays PayPal's fee.
- When comparing withdrawal routes, rank them only by the you_receive_local figure. A route is better than another only if its you_receive_local number is higher. Never say a route is cheaper or better without checking those numbers.
- Write numbers with commas, like 1,000.
- Reply in plain text. Do not use markdown symbols such as ** or #.`;

const TOOLS = [
  {
    name: 'get_fee_summary',
    description: 'Summarise fees from the PayPal account: totals, average fee rate, fees by month, and fees by client. Optionally limit to the last N days.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Only include the last N days' }, currency: { type: 'string' } } }
  },
  {
    name: 'list_costliest_payments',
    description: 'List received payments with the highest fee as a share of the amount.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } } }
  },
  {
    name: 'detect_fee_anomalies',
    description: 'Find unusual fee patterns in the account: payments whose fee rate is higher than the account\'s typical rate, small payments where the fixed fee dominates, single payments that account for a large share of all fees, month-on-month jumps in the fee rate, and repeated refunds. Returns alerts with reasons.',
    input_schema: { type: 'object', properties: { currency: { type: 'string' } } }
  },
  {
    name: 'price_for_target_net',
    description: 'Work out the price to charge so that after PayPal fees the seller keeps a target amount. Uses the account fee schedule unless overridden.',
    input_schema: {
      type: 'object',
      properties: { target_net: { type: 'number' }, fee_percent: { type: 'number' }, fee_fixed: { type: 'number' } },
      required: ['target_net']
    }
  },
  {
    name: 'compare_withdrawal_routes',
    description: 'Compare how much local currency arrives in the bank when moving money out via PayPal versus alternative routes. Needs the market rate; the PayPal rate is optional but makes the PayPal row accurate.',
    input_schema: {
      type: 'object',
      properties: { amount_usd: { type: 'number' }, market_rate: { type: 'number' }, paypal_rate: { type: 'number' } },
      required: ['amount_usd', 'market_rate']
    }
  },
  {
    name: 'create_payment_link',
    description: 'Create a PayPal sandbox checkout order and return the link a buyer opens to pay. Sandbox only, test money.',
    input_schema: {
      type: 'object',
      properties: { amount: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' } },
      required: ['amount']
    }
  }
];

function makeToolRunner(deps) {
  return async function run(name, input) {
    switch (name) {
      case 'get_fee_summary': {
        const txns = await deps.getTransactions();
        return analysis.summarize(txns, { days: input.days, currency: input.currency });
      }
      case 'list_costliest_payments': {
        const txns = await deps.getTransactions();
        return analysis.costliestPayments(txns, { limit: input.limit || 5 });
      }
      case 'detect_fee_anomalies': {
        const txns = await deps.getTransactions();
        return anomalies.detectAnomalies(txns, { feeFixed: deps.fees.fixed, currency: input.currency });
      }
      case 'price_for_target_net':
        return analysis.priceForTargetNet({
          targetNet: input.target_net,
          feePercent: input.fee_percent ?? deps.fees.percent,
          feeFixed: input.fee_fixed ?? deps.fees.fixed
        });
      case 'compare_withdrawal_routes':
        return analysis.compareWithdrawalRoutes({ amount: input.amount_usd, marketRate: input.market_rate, paypalRate: input.paypal_rate });
      case 'create_payment_link':
        return deps.createPaymentLink({ amount: input.amount, currency: input.currency || 'USD', description: input.description });
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };
}

// Removes markdown bold/heading symbols, since the chat shows plain text.
function plain(text) {
  return String(text || '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
}

// Which provider to use: AI_PROVIDER wins (groq, gemini or claude, any capitalisation),
// otherwise the first API key that is set.
function provider() {
  const p = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (p === 'groq' || p === 'gemini' || p === 'claude') return p;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'claude';
}

function aiConfigured() {
  switch (provider()) {
    case 'groq': return Boolean(process.env.GROQ_API_KEY);
    case 'gemini': return Boolean(process.env.GEMINI_API_KEY);
    default: return Boolean(process.env.ANTHROPIC_API_KEY);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Calls an HTTP API with a 20 second timeout. Retries up to 3 times on overload (503),
// rate limit (429), server errors (500) and timeouts or network drops.
async function apiRequest(name, url, options) {
  const attempts = 3;
  let lastMessage = `${name} did not respond.`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const message = data.error?.message || 'error';
      if ([429, 500, 503].includes(res.status) && attempt < attempts) {
        lastMessage = `${name} is busy right now (${res.status}).`;
        await sleep(2000 * attempt);
        continue;
      }
      if ([429, 500, 503].includes(res.status)) {
        throw new Error(`${name} is busy right now (${res.status}). Please try again in a minute.`);
      }
      throw new Error(`${name} request failed (${res.status}): ${message}`);
    } catch (e) {
      const transient = e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError;
      if (transient && attempt < attempts) {
        lastMessage = `${name} took too long to answer.`;
        await sleep(2000 * attempt);
        continue;
      }
      if (transient) throw new Error(`${lastMessage} Please try again in a minute.`);
      throw e;
    }
  }
  throw new Error(`${lastMessage} Please try again in a minute.`);
}

// Some Groq models send null for optional parameters, and Groq rejects that against a
// strict schema. So for Groq every optional parameter is allowed to be null, and nulls
// are removed before the tool runs.
function allowNulls(schema) {
  const required = schema.required || [];
  const properties = {};
  for (const [key, def] of Object.entries(schema.properties || {})) {
    properties[key] = required.includes(key) ? def : { ...def, type: [def.type, 'null'] };
  }
  return { ...schema, properties };
}

function dropNulls(args) {
  return Object.fromEntries(Object.entries(args || {}).filter(([, v]) => v !== null && v !== undefined));
}

// Groq uses an OpenAI-compatible chat API with function calling.
async function runGroq({ messages, deps }) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
  const base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const run = makeToolRunner(deps);
  const tools = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: allowNulls(t.input_schema) } }));
  const convo = [{ role: 'system', content: SYSTEM }, ...messages.map(m => ({ role: m.role, content: m.content }))];
  const used = [];

  for (let turn = 0; turn < 8; turn++) {
    const data = await apiRequest('Groq', `${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages: convo, tools, tool_choice: 'auto', max_tokens: 1200 })
    });
    const msg = data.choices?.[0]?.message;
    const calls = msg?.tool_calls || [];
    if (!calls.length) {
      return { reply: plain((msg?.content || '').trim()) || 'I could not produce an answer. Try rephrasing.', tools: used };
    }
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function.name;
      let args = {};
      try { args = dropNulls(JSON.parse(call.function.arguments || '{}')); } catch { args = {}; }
      used.push({ name, input: args });
      let content;
      try {
        content = JSON.stringify(await run(name, args));
      } catch (e) {
        content = `Error: ${e.message}`;
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  return { reply: 'I used too many steps on that. Try a narrower question.', tools: used };
}

// Same tools, same loop, using Google's Gemini REST API with function calling.
async function runGemini({ messages, deps }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const run = makeToolRunner(deps);
  const declarations = TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema }));
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const used = [];

  for (let turn = 0; turn < 8; turn++) {
    const data = await apiRequest('Gemini', `${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        tools: [{ functionDeclarations: declarations }],
        contents
      })
    });
    const content = data.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) {
      const text = parts.map(p => p.text || '').join('').trim();
      return { reply: plain(text) || 'I could not produce an answer. Try rephrasing.', tools: used };
    }
    contents.push(content);
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      used.push({ name, input: args || {} });
      try {
        responses.push({ functionResponse: { name, response: { result: await run(name, args || {}) } } });
      } catch (e) {
        responses.push({ functionResponse: { name, response: { error: e.message } } });
      }
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { reply: 'I used too many steps on that. Try a narrower question.', tools: used };
}

// messages: [{role:'user'|'assistant', content:string}]. Returns the final text and the tools used.
async function runAgent({ messages, deps, client }) {
  if (!client && provider() === 'groq') return runGroq({ messages, deps });
  if (!client && provider() === 'gemini') return runGemini({ messages, deps });
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
  }
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const run = makeToolRunner(deps);
  const convo = messages.map(m => ({ role: m.role, content: m.content }));
  const used = [];

  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({ model, max_tokens: 1200, system: SYSTEM, tools: TOOLS, messages: convo });
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { reply: plain(text), tools: used };
    }
    convo.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const block of res.content.filter(b => b.type === 'tool_use')) {
      used.push({ name: block.name, input: block.input });
      try {
        const out = await run(block.name, block.input || {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'I used too many steps on that. Try a narrower question.', tools: used };
}

module.exports = { runAgent, TOOLS, makeToolRunner, provider, aiConfigured };