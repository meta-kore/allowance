# Allowance: notes for Claude Code

Allowance is a PayPal spending wallet with rules for AI agents, built for the PayPal AI Hackathon 2026 (deadline Thu 12 Nov 2026, 20:00 UTC). Read README.md first. It is the second entry; the first, Kitty, lives in a separate repo and shares `src/paypal.ts`, `src/ai.ts` and `src/store.ts` with this one.

## Before anything else

`src/paypal.ts` and `src/ai.ts` here are the untested originals. If they were fixed in the Kitty repo during its sandbox testing, port those fixes here first (compare the files; do not blindly overwrite, Kitty's `paypal.ts` may have diverged). Allowance only uses the Payouts functions from `paypal.ts`: `createPayout`, `getPayoutBatch` and `cancelPayoutItem`.

## Payment states

A purchase is `paid` only when its payout item's `transaction_status` is `SUCCESS` (a batch can be SUCCESS while its item is UNCLAIMED). `settle()` in `src/wallet.ts` maps the item: SUCCESS → `paid`; UNCLAIMED → cancel the item, then `returned`; FAILED, BLOCKED, RETURNED, REFUNDED, REVERSED or a DENIED/CANCELED batch → `failed`; PENDING, ONHOLD → stays `processing`. `pay()` polls for about 15 s after creating the payout; `refreshPayouts()` and `get_purchase_status` settle the rest. Budget: `paid` is spent; `processing` and `pending_approval` hold budget; `returned`, `failed`, `blocked` and `rejected` cost nothing.

## Commands

- `npm install` then `npm start` (http://localhost:3001). `npm run dev` restarts on change.
- `npm run check`: sandbox preflight. Verifies PayPal credentials, the Payouts scope, merchant emails, the agent token, and that the AI model returns parseable JSON tool calls. Run this first.
- `npm run mcp`: MCP server over stdio. Needs the wallet running.
- `npm run typecheck`: must pass before any commit.
- `PAYPAL_MOCK=1 npm start`: runs without PayPal, for UI work only. Never use it for the demo or the video.

## Rules

- PayPal sandbox only. `src/paypal.ts` hard-codes the sandbox host; do not add a live mode.
- Never print, log or commit the contents of `.env`. Never put real credentials in the README.
- Every spending rule lives in `requestPurchase` and `decide` in `src/wallet.ts`. Do not move any rule into a prompt, and do not give the agent any way to pay that bypasses `requestPurchase`.
- The agent API (`/agent/*`) must keep requiring the bearer token. The agent must never see merchant emails, PayPal credentials or batch ids (`publicTx` controls what it sees).
- Keep it small: Express, one HTML file, JSON-file storage. No new frameworks.

## Sandbox setup the app expects

- One sandbox **business** account (the wallet owner) that owns the REST app in `.env`, with Payouts enabled and enough balance (the demo spends about 78 USD).
- Two other sandbox accounts that can receive money, playing the approved merchants PaperTrail and CloudBox. Their emails go in `.env` or on the dashboard under Rules.
- The same business account and app used for Kitty can be reused.

## First real test (do these in order and stop at the first failure)

1. `npm run check`. All lines should say PASS.
2. `npm start`, open the dashboard, confirm both merchants show an email under Rules.
3. Click "Run agent" with the default task. Expected ledger, newest first:
   - Cloud hosting, 60.00, "Needs your approval" (over the 50.00 per-purchase limit).
   - Printer paper from PaperTrail, 18.00, "Paid via PayPal" with a batch id, "payment SUCCESS" and a transaction id.
   - Printer paper from BargainBin, 9.00, "Blocked" (not an approved merchant). Agents do not see the approved-merchant list (`agentBudget` in `src/wallet.ts` omits it), so the agent usually tries the cheaper BargainBin paper first. If it does not, adjust the default task or the catalogue, but do not script the agent's choices.
4. Click "Approve and pay" on the hosting purchase. Expect "Paid via PayPal", "payment SUCCESS" and a transaction id within about 15 seconds. If it still says "Waiting for PayPal...", click "Refresh PayPal status".
5. Log in to the two merchant sandbox accounts and confirm 18.00 and 60.00 arrived.
6. Budget test: lower the daily budget to 80 on the dashboard, clear nothing, run the agent again. Expect a "Blocked" for exceeding today's budget.
7. MCP test: with the wallet running, connect the MCP server from an MCP client (config in README), call `check_budget`, then `request_purchase` for the 14.00 domain renewal. Expect "paid" and a new ledger row.

## Known unknowns (not yet verified against the real sandbox)

- Whether a payout to a sandbox **business** account email settles the same way as to a personal one.
- How reliably the chosen model sticks to the one-JSON-object-per-turn protocol in `src/agent.ts` (`extractJson` tolerates code fences and stray prose; a model that ignores the format will hit the 12-step cap).
- Agent behaviour varies between runs. Do several runs before recording the video.
