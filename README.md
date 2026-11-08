FeeGuard

An AI agent for freelancers and small sellers that reads their PayPal account, shows what each payment really costs, and acts on it. Built for the PayPal AI Hackathon ("Build What's Next with PayPal and AI") on the PayPal sandbox, with Groq, Gemini or Claude as the AI.

The problem

PayPal fees combine a percentage with a fixed per-transaction charge, so small payments lose a much larger share than big ones. In the sandbox a $1 payment loses 33% to fees while a $1,000 payment loses 3.43%. Currency-conversion markups on withdrawals to local banks add more, especially for cross-border payments. Most sellers never calculate their true cost per client or per payment size.

What it does
Fee dashboard. Pulls transactions from the PayPal Transaction Search API and shows total fees, average fee rate, fees by month, fees by client and the costliest payments (ranked by fee as a share of the amount).
AI agent with tools. Ask in plain language. The agent calls five tools and answers from the results, never from guesses:
get_fee_summary: totals, fees by month and client
list_costliest_payments: payments with the highest fee share
price_for_target_net: what to charge so you keep a target amount after fees
compare_withdrawal_routes: how much local currency arrives via PayPal versus alternative routes, including PayPal's exchange-rate markup
create_payment_link: creates a real PayPal sandbox checkout order and returns the pay link
Sandbox checkout. Create an order (Orders API v2), approve it with a sandbox buyer, and FeeGuard captures it on return and shows gross, fee and net. Captured payments are saved to data/captured.json, so they show on the dashboard straight away, before Transaction Search lists them.
Sandbox payouts. Send a payout by email with the Payouts API.
Demo mode. With no PayPal credentials, or if the sandbox has no data yet, the app runs on built-in demo transactions that use the same code path as real PayPal responses.
PayPal APIs used
API	Endpoint	Used for
OAuth 2.0	POST /v1/oauth2/token	Access token
Orders v2	POST /v2/checkout/orders, POST /v2/checkout/orders/{id}/capture	Payment links and capture
Transaction Search	GET /v1/reporting/transactions	Fee data for the dashboard and agent
Payouts	POST /v1/payments/payouts	Sandbox payouts
AI

- **Fee dashboard.** Pulls transactions from the PayPal Transaction Search API and shows total fees, average fee rate, fees by month, fees by client and the costliest payments (ranked by fee as a share of the amount).
- **AI agent with tools.** Ask in plain language. The agent calls six tools and answers from the results, never from guesses:
  - `get_fee_summary`: totals, fees by month and client
  - `list_costliest_payments`: payments with the highest fee share
  - `detect_fee_anomalies`: flags unusual fee patterns with a reason (a payment charged at a higher rate than your others, small payments where the fixed fee dominates, one payment driving most of your fees, a month-on-month rise in the fee rate, repeated refunds). These are signals to review, and they also appear in a "Fee alerts" panel on the dashboard
  - `price_for_target_net`: what to charge so you keep a target amount after fees
  - `compare_withdrawal_routes`: how much local currency arrives via PayPal versus alternative routes, including PayPal's exchange-rate markup
  - `create_payment_link`: creates a real PayPal sandbox checkout order and returns the pay link
- **Sandbox checkout.** Create an order (Orders API v2), approve it with a sandbox buyer, and FeeGuard captures it on return and shows gross, fee and net. Captured payments are saved to `data/captured.json`, so they show on the dashboard straight away, before Transaction Search lists them.
- **Sandbox payouts.** Send a payout by email with the Payouts API.
- **Demo mode.** With no PayPal credentials, or if the sandbox has no data yet, the app runs on built-in demo transactions that use the same code path as real PayPal responses.

Provider	AI_PROVIDER	Key	Default model
Groq (default)	groq	GROQ_API_KEY	openai/gpt-oss-120b (override with GROQ_MODEL)
Google Gemini	gemini	GEMINI_API_KEY	gemini-3.8-flash (override with GEMINI_MODEL)
Anthropic Claude	claude	ANTHROPIC_API_KEY	claude-sonnet-5-5 (override with CLAUDE_MODEL)

The system prompt requires tool calls for every number, asks for missing exchange rates instead of inventing them, labels route comparisons as assumptions, and stops the model from stating a fee schedule that no tool returned. Requests to the AI providers retry on timeouts and busy responses.

## AI

The agent uses LLM tool calling in a loop of up to 8 steps. Choose the provider with `AI_PROVIDER` in `.env`:

| Provider | `AI_PROVIDER` | Key | Default model |
|---|---|---|---|
| Groq (default) | `groq` | `GROQ_API_KEY` | `openai/gpt-oss-120b` (override with `GROQ_MODEL`) |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-3.8-flash` (override with `GEMINI_MODEL`) |
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` (override with `CLAUDE_MODEL`) |

The system prompt requires tool calls for every number, asks for missing exchange rates instead of inventing them, labels route comparisons as assumptions, and stops the model from stating a fee schedule that no tool returned. Requests to the AI providers retry on timeouts and busy responses.

## Run it

Requires Node 18 or newer.

```bash
git clone https://github.com/nancyluka200/feeguard.git
cd feeguard
npm install
```

Then copy `.env.example` to `.env`:

- macOS, Linux or Git Bash: `cp .env.example .env`
- Windows PowerShell: `copy .env.example .env`

Fill in the keys (see below), then:

```bash
npm start

Open http://localhost:3000. With no PayPal credentials it runs in demo mode. The chat needs an AI key (`GROQ_API_KEY` by default). A free Groq key is available at https://console.groq.com.

Connect your PayPal sandbox
Log in at https://developer.paypal.com and make sure Sandbox is selected.
Open Apps & Credentials and create (or open) an app.
In the app's features, enable Transaction Search, and save.
Copy the Client ID and Secret into .env as PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.
Under Testing Tools > Sandbox Accounts, note your sandbox personal (buyer) account email and password. You use it to approve test payments.
Add your AI key to .env (for example GROQ_API_KEY).
Restart. The badge at the top should say "PayPal: sandbox connected" and "AI (groq)".

1. Log in at https://developer.paypal.com and make sure **Sandbox** is selected.
2. Open **Apps & Credentials** and create (or open) an app.
3. In the app's features, enable **Transaction Search**, and save.
4. Copy the Client ID and Secret into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
5. Under **Testing Tools > Sandbox Accounts**, note your sandbox **personal** (buyer) account email and password. You use it to approve test payments.
6. Add your AI key to `.env` (for example `GROQ_API_KEY`).
7. Restart. The badge at the top should say "PayPal: sandbox connected" and "AI (groq)".

Then use **Create a sandbox payment**, open the link, log in with the sandbox buyer account and pay. You are redirected back and FeeGuard shows the captured gross, fee and net. Transaction Search can take a few hours to list new sandbox transactions, so FeeGuard also keeps its own record of payments it captured.

### Try these questions

- "Which payments cost me the most in fees?"
- "What should I charge so I keep $100 after fees?"
- "I withdraw $500 and PayPal gives 125.5 KES per USD, market is 129. Compare my options."
- "Create a payment link for $40 for logo design."

render.yaml is included. Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, AI_PROVIDER, your AI key (for example GROQ_API_KEY) and BASE_URL (your Render URL) as environment variables.

`render.yaml` is included. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `AI_PROVIDER`, your AI key (for example `GROQ_API_KEY`) and `BASE_URL` (your Render URL) as environment variables.

## Configuration

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `groq`, `gemini` or `claude` |
| `FEE_PERCENT`, `FEE_FIXED` | Your PayPal fee schedule, used by the pricing tool. The PayPal sandbox charges 3.4% + $0.30. Real rates depend on your country and payment type, so set your own. |
| `config/routes.json` | Fees and FX markups for the withdrawal comparison. These are illustrative assumptions. Replace them with real quotes. |
| `DEMO_MODE=1` | Force demo data |
| `FEEGUARD_DATA_DIR` | Where captured payments are saved (default `data/`) |

## Tests

```bash
npm test

Fourteen tests run the real code: seven against local mock servers that imitate PayPal (token, orders, capture, transaction search, payouts) and the Anthropic API (a tool-use turn followed by a final answer), and seven cover the fee anomaly detection. Test runs save captured payments to a temporary folder, not to `data/`. The Groq and Gemini paths are not covered by automated tests.

## Limits

- Sandbox only. Do not point it at live credentials without adding authentication to the app: it has no user login.
- Transaction Search covers up to 31 days per request, and the app reads the last 30 days.
- Event-code mapping covers payments (`T00xx`), withdrawals (`T04xx`) and reversals (`T11xx`). Other types are counted but not classified.
- Route comparisons and default fees are assumptions, not quotes.
- Fees shown come from PayPal's own records; the pricing tool uses the configured `FEE_PERCENT` and `FEE_FIXED`.

## License

MIT