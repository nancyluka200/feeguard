# FeeGuard

An AI agent for freelancers and small sellers that reads their PayPal account, shows what each payment really costs, and acts on it. Built for the PayPal AI Hackathon on the PayPal sandbox and the Claude API.

## The problem

PayPal fees, fixed per-transaction charges and currency-conversion markups are hard to see and add up quickly, especially on small cross-border payments and withdrawals to local banks. Most sellers never calculate their true cost per client.

## What it does

- **Fee dashboard.** Pulls transactions from the PayPal Transaction Search API and shows total fees, average fee rate, fees by month, fees by client and the costliest payments.
- **Claude agent with tools.** Ask in plain language. Claude calls five tools and answers from the results, never from guesses:
  - `get_fee_summary`: totals, fees by month and client
  - `list_costliest_payments`: payments with the highest fee share
  - `price_for_target_net`: what to charge so you keep a target amount after fees
  - `compare_withdrawal_routes`: how much local currency arrives via PayPal versus alternative routes, including PayPal's exchange-rate markup
  - `create_payment_link`: creates a real PayPal sandbox checkout order and returns the pay link
- **Sandbox checkout.** Create an order (Orders API v2), approve it with a sandbox buyer, and FeeGuard captures it on return and shows gross, fee and net.
- **Sandbox payouts.** Send a payout by email with the Payouts API.
- **Demo mode.** With no credentials, or if the sandbox has no data yet, the app runs on built-in demo transactions that use the same code path as real PayPal responses.

## PayPal APIs used

| API | Endpoint | Used for |
|---|---|---|
| OAuth 2.0 | `POST /v1/oauth2/token` | Access token |
| Orders v2 | `POST /v2/checkout/orders`, `POST /v2/checkout/orders/{id}/capture` | Payment links and capture |
| Transaction Search | `GET /v1/reporting/transactions` | Fee data for the dashboard and agent |
| Payouts | `POST /v1/payments/payouts` | Sandbox payouts |

## AI

Claude (default `claude-sonnet-5-5`, set with `CLAUDE_MODEL`) through the Anthropic SDK, using tool use in a loop of up to 8 steps. The system prompt requires tool calls for every number, asks for missing exchange rates instead of inventing them, and labels route comparisons as assumptions.

## Run it

Requires Node 18 or newer.

```bash
git clone <this repo>
cd feeguard
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. With an empty `.env` it runs in demo mode. The chat needs `ANTHROPIC_API_KEY`.

### Connect your PayPal sandbox

1. Log in at https://developer.paypal.com and make sure **Sandbox** is selected.
2. Open **Apps & Credentials** and create (or open) an app.
3. In the app's features, enable **Transaction Search**, and save.
4. Copy the Client ID and Secret into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
5. Under **Testing Tools > Sandbox Accounts**, note your sandbox **personal** (buyer) account email and password. You use it to approve test payments.
6. Add `ANTHROPIC_API_KEY` from https://console.anthropic.com.
7. Restart. The badge at the top should say "PayPal: sandbox connected".

Then use **Create a sandbox payment**, open the link, log in with the sandbox buyer account and pay. You are redirected back and FeeGuard shows the captured gross, fee and net. Transaction Search can take a few hours to list new sandbox transactions, so the dashboard may show demo data until they appear.

### Deploy on Render

`render.yaml` is included. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY` and `BASE_URL` (your Render URL) as environment variables.

## Configuration

| Variable | Purpose |
|---|---|
| `FEE_PERCENT`, `FEE_FIXED` | Your PayPal fee schedule, used by the pricing tool. Defaults are placeholders, so set your own. |
| `config/routes.json` | Fees and FX markups for the withdrawal comparison. These are illustrative assumptions. Replace them with real quotes. |
| `DEMO_MODE=1` | Force demo data |

## Tests

```bash
npm test
```

Seven tests run the real code against local mock servers that imitate PayPal (token, orders, capture, transaction search, payouts) and the Anthropic API (a tool-use turn followed by a final answer).

## Limits

- Sandbox only. Do not point it at live credentials without adding authentication to the app: it has no user login.
- Transaction Search covers up to 31 days per request, and the app reads the last 30 days.
- Event-code mapping covers payments (`T00xx`), withdrawals (`T04xx`) and reversals (`T11xx`). Other types are counted but not classified.
- Route comparisons and default fees are assumptions, not quotes.

## Demo video script (under 3 minutes)

1. **0:00** The problem: a Kenyan freelancer paid by clients abroad, losing money to fees and rates nobody shows them.
2. **0:20** Dashboard on sandbox data: total fees, average rate, costliest payments.
3. **0:50** Create a $75 sandbox payment, pay it as the buyer, return to FeeGuard and show the captured fee and net.
4. **1:30** Ask: "Which client costs me the most?" then "What should I charge to keep $100 after fees?" Show the tool chips under each answer.
5. **2:00** Ask: "I withdraw $500, PayPal gives 125.5 KES per USD, the market is 129. Compare my options."
6. **2:30** Ask Claude to create a payment link, open it, and close with the repo link.

## License

MIT
