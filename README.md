# Allowance: a PayPal wallet with rules for AI agents

AI agents can now find what to buy. Letting them actually pay is the frightening part: hand an agent your card and one bad prompt can empty it.

**Allowance gives an agent a debit card with rules.** The agent never holds credentials. It asks the wallet to buy something, and the wallet decides:

- **Pay**: approved retailer, under the per-purchase limit, within today's budget. Sent through PayPal immediately.
- **Hold**: over the per-purchase limit. Waits for the owner to approve or reject on the dashboard.
- **Block**: retailer not approved, an offer the wallet has not seen in a recent search, or the daily budget would be exceeded.

The agent shops **real products** found through [Channel3](https://trychannel3.com) product search. The wallet charges the price of the offer Channel3 returned, never an amount the agent states.

A purchase only counts as **paid** when PayPal confirms the merchant received the money. If the merchant's PayPal email has no account, PayPal leaves the payment unclaimed; the wallet cancels it so the money comes straight back to the owner, and records the purchase as **returned**. Payments PayPal refuses or reverses are recorded as **failed**, with PayPal's reason. Payments not confirmed yet stay **processing** until a later check settles them.

Every request, decision, reason and PayPal reference lands in a ledger the owner can read.

Built for the PayPal AI Hackathon 2026.

## What is in the box

- **The wallet** (`src/wallet.ts`): policy, ledger and decision engine. Rules are enforced in code, so a prompt cannot talk its way past them.
- **Product search** (`src/channel3.ts`): real products and retailer offers from Channel3, with a small demo catalogue as a fallback when no Channel3 key is set.
- **An MCP server** (`src/mcp.ts`): plugs the wallet into any MCP-capable agent (Claude Desktop, Claude Code, Cursor and others) with five tools: `check_budget` (limits and remaining budget; the approved-retailer list stays private to the owner), `search_products`, `request_purchase`, `get_purchase_status`, `list_purchases`.
- **A built-in shopping agent** (`src/agent.ts`): so you can watch an agent hit the rules without installing anything else.
- **An owner dashboard**: set limits, approve or reject held purchases, read the ledger and watch the agent think.

## How PayPal is used

| PayPal API | Used for |
|---|---|
| Payouts: create | Paying the merchant from the owner's PayPal balance when the wallet allows a purchase or the owner approves one |
| Payouts: show batch details | Each payment's own `transaction_status` and transaction id, so a purchase is marked paid only on `SUCCESS` |
| Payouts: cancel unclaimed item | Returning money sent to an email with no PayPal account to the owner at once, instead of after PayPal's 30-day automatic refund |

An agent cannot click through a PayPal checkout, so the wallet pays merchants server-side from the owner's balance using Payouts. The owner funds one PayPal account; the agent only ever sees a budget. All calls go to the PayPal **sandbox**. The code cannot point at live PayPal.

## How it works

1. **Search.** The agent calls `search_products` with a query and an optional maximum price. The wallet calls Channel3's `POST /v1/search` and returns each product's in-stock US dollar offers: retailer domain and price. The wallet keeps every offer it returned for 30 minutes.
2. **Ask.** The agent calls `request_purchase` with a product id, the retailer domain of the offer it chose and a reason. There is no amount field.
3. **Decide.** The wallet looks up that offer and uses its price. It blocks an offer it has not returned in the last 30 minutes (the agent must search again), one not priced in USD or not in stock, and any retailer the owner has not approved. Then the per-purchase limit, daily budget and approval rules apply.
4. **Pay.** Each approved retailer domain settles to a sandbox PayPal payee chosen by the owner, for example `staples.com` settles to the payee PaperTrail Office Supply. The wallet pays that payee with PayPal Payouts.

**No real order is placed with the retailer.** This is a sandbox demo: the sandbox payee stands in for the approved retailer, and the ledger keeps the retailer's buy link for reference.

## How AI is used

The built-in agent is an LLM in a tool loop. Given a task, it checks its budget, searches real products, requests purchases, reads the wallet's decisions and adapts: when a cheaper offer from an unapproved retailer is blocked, it tries another; when a purchase is held, it leaves it with the owner and reports back.

Works with Claude (Anthropic), Groq, Gemini or OpenRouter: set `AI_PROVIDER`, `AI_API_KEY` and optionally `AI_MODEL`.

## Run it

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env    # then fill it in
npm run check           # confirms your PayPal sandbox, payees, Channel3 search and AI key
npm start               # http://localhost:3001
```

In `.env`:

- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: from a **sandbox** REST app at developer.paypal.com, belonging to a sandbox **business** account (the wallet owner). Payouts must be enabled for the app, and the account needs sandbox balance.
- `CHANNEL3_API_KEY`: a Channel3 API key for real product search. Without it the agent shops a small made-up demo catalogue, and the dashboard says "demo catalogue".
- `MERCHANT_EMAIL_PAPERTRAIL`, `MERCHANT_EMAIL_CLOUDBOX`: emails of two other sandbox accounts that act as the payees for approved retailers (by default `staples.com` settles to PaperTrail and `officedepot.com` to CloudBox). You can change the emails and the retailer domains on the dashboard.
- `AI_PROVIDER`, `AI_API_KEY`: your AI provider and key.

## Test it (about 2 minutes)

1. Open the dashboard. Under **Rules**, check each approved retailer settles to a payee with a PayPal sandbox email.
2. Click **Run agent** with the default task: buy the cheapest pack of printer paper and a 10-ream case of copy paper.
3. Watch the outcomes. Search results change over time, so the exact products and prices vary. In our runs:
   - The cheapest paper offers came from retailers that are not approved (cvs.com, target.com, cricut.com): **blocked**. Agents are told that only approved retailers can be paid, but not which ones, so they learn the rule from the wallet.
   - Printer paper from staples.com at $26.99: **paid via PayPal**, with PayPal's transaction id, once PayPal confirms delivery (a few seconds).
   - A case of copy paper from staples.com at $63.99, over the $50 per-purchase limit: **needs your approval**.
4. Click **Approve and pay** on the held purchase. Log in to the payee sandbox account to see the money arrive.
5. Optional: change a payee's email on the dashboard to one with no sandbox account and buy from one of its retailers. The purchase ends as **returned to you**, and the owner's balance gets the money back.

## Use it from your own agent (MCP)

With the wallet running, add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "allowance": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/this/repo",
      "env": { "WALLET_URL": "http://localhost:3001", "AGENT_TOKEN": "<the AGENT_TOKEN from your .env>" }
    }
  }
}
```

The agent API it wraps is plain HTTP under `/agent/*` with a bearer token, so non-MCP agents can use it too.

## Project layout

```
src/wallet.ts   Policy, ledger, decision engine
src/channel3.ts Channel3 product search, offer cache, demo catalogue fallback
src/server.ts   Agent API (/agent/*) and owner API (/api/*)
src/mcp.ts      MCP server (stdio)
src/agent.ts    Built-in demo shopping agent
src/paypal.ts   PayPal sandbox client (Payouts)
src/ai.ts       Provider-agnostic AI client
public/         Owner dashboard
```

## Limitations

- The owner dashboard has no login in this demo; put it behind authentication before real use.
- One wallet and one agent token per deployment, stored in a local JSON file.
- No order is placed with the retailer, and the payee is a sandbox account standing in for it. Turning this into real shopping would need a retailer checkout or a card issued per purchase.
- Offers from a search are kept in memory for 30 minutes. After that, or after a restart, the agent must search again before buying.
- Agents do not see which retailers are approved, so an agent may try several unapproved offers before it finds an approved one. Each try is a blocked row in the ledger.
- Payment confirmation is checked when a purchase is made (for about 15 seconds), when the agent asks for its status, and when the owner clicks **Refresh PayPal status**. There is no background poller, so a payment PayPal confirms later shows as processing until one of those happens.
- `PAYPAL_MOCK=1` runs the app without PayPal for offline development. It is not used in the demo. In mock mode, a merchant email containing `unclaimed`, `failed` or `pending` produces that payment outcome.

## AI tools used

See the Devpost submission for the full statement of AI tools and models used to build and run this project.

## Licence

MIT
