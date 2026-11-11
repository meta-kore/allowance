# Allowance: a PayPal wallet with rules for AI agents

AI agents can now find what to buy. Letting them actually pay is the frightening part: hand an agent your card and one bad prompt can empty it.

**Allowance gives an agent a debit card with rules.** The agent never holds credentials. It asks the wallet to buy something, and the wallet decides:

- **Pay**: approved merchant, under the per-purchase limit, within today's budget. Paid through PayPal immediately.
- **Hold**: over the per-purchase limit. Waits for the owner to approve or reject on the dashboard.
- **Block**: merchant not approved, or the daily budget would be exceeded.

Every request, decision, reason and PayPal reference lands in a ledger the owner can read.

Built for the PayPal AI Hackathon 2026.

## What is in the box

- **The wallet** (`src/wallet.ts`): policy, ledger and decision engine. Rules are enforced in code, so a prompt cannot talk its way past them.
- **An MCP server** (`src/mcp.ts`): plugs the wallet into any MCP-capable agent (Claude Desktop, Claude Code, Cursor and others) with five tools: `check_budget` (limits and remaining budget; the approved-merchant list stays private to the owner), `browse_catalog`, `request_purchase`, `get_purchase_status`, `list_purchases`.
- **A built-in shopping agent** (`src/agent.ts`): so you can watch an agent hit the rules without installing anything else.
- **An owner dashboard**: set limits, approve or reject held purchases, read the ledger and watch the agent think.

## How PayPal is used

| PayPal API | Used for |
|---|---|
| Payouts: create | Paying the merchant from the owner's PayPal balance when the wallet allows a purchase or the owner approves one |
| Payouts: get | Settlement status in the ledger |

An agent cannot click through a PayPal checkout, so the wallet pays merchants server-side from the owner's balance using Payouts. The owner funds one PayPal account; the agent only ever sees a budget. All calls go to the PayPal **sandbox**. The code cannot point at live PayPal.

## How AI is used

The built-in agent is an LLM in a tool loop. Given a task, it checks its budget, browses a marketplace, requests purchases, reads the wallet's decisions and adapts: when a cheaper but unapproved merchant is blocked, it buys from an approved one; when a purchase is held, it leaves it with the owner and reports back.

Works with Claude (Anthropic), Groq, Gemini or OpenRouter: set `AI_PROVIDER`, `AI_API_KEY` and optionally `AI_MODEL`.

## Run it

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env    # then fill it in
npm run check           # confirms your PayPal sandbox, merchants and AI key
npm start               # http://localhost:3001
```

In `.env`:

- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: from a **sandbox** REST app at developer.paypal.com, belonging to a sandbox **business** account (the wallet owner). Payouts must be enabled for the app, and the account needs sandbox balance.
- `MERCHANT_EMAIL_PAPERTRAIL`, `MERCHANT_EMAIL_CLOUDBOX`: emails of two other sandbox accounts that play the approved merchants. You can also set these on the dashboard.
- `AI_PROVIDER`, `AI_API_KEY`: your AI provider and key.

## Test it (about 2 minutes)

1. Open the dashboard. Check both merchants have a PayPal sandbox email under **Rules**.
2. Click **Run agent** with the default task (get the cheapest printer paper on the marketplace, renew hosting).
3. Watch the outcomes:
   - The cheapest paper is from BargainBin, which is not approved: **blocked**. Agents are told that only approved merchants can be paid, but not which ones, so they learn the rule from the wallet.
   - The agent buys from PaperTrail at $18: **paid via PayPal**.
   - Hosting is $60, over the $50 per-purchase limit: **needs your approval**.
4. Click **Approve and pay** on the hosting purchase. Log in to the merchant sandbox accounts to see the money arrive.

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
- The marketplace catalogue is a fixed demo list. The agent names an item by sku and the wallet charges the catalogue price, so an agent cannot under-state a price to dodge a limit.
- `PAYPAL_MOCK=1` runs the app without PayPal for offline development. It is not used in the demo.

## AI tools used

See the Devpost submission for the full statement of AI tools and models used to build and run this project.

## Licence

MIT
