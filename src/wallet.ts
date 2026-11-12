// The wallet core: policy, ledger and the decision engine. Every rule is enforced here in code,
// so no prompt, however clever, can talk the agent past its allowance.
import { randomUUID } from 'node:crypto';
import { makeStore } from './store.js';
import { createPayout, getPayoutBatch, cancelPayoutItem } from './paypal.js';

export type Merchant = { id: string; name: string; email: string; category: string };
export type Policy = { currency: string; perPurchaseLimit: number; dailyBudget: number; merchants: Merchant[] };
// processing: PayPal accepted the payout but the item is not final yet.
// paid: the item's transaction_status is SUCCESS, so the money reached the merchant.
// returned: the item was UNCLAIMED (no PayPal account at that email); the wallet cancelled it and the money went back to the owner.
// failed: PayPal refused or reversed the payment (FAILED, DENIED, BLOCKED, RETURNED, REFUNDED, REVERSED, or an API error).
export type Tx = {
  id: string; at: string; sku?: string; merchantId: string; merchantName: string; item: string; amount: number; reason: string;
  status: 'processing' | 'paid' | 'returned' | 'failed' | 'blocked' | 'pending_approval' | 'rejected';
  rule: string; payoutBatchId?: string; payoutStatus?: string; decidedAt?: string;
  payoutItemId?: string; transactionId?: string; transactionStatus?: string; outcome?: string;
};
type Db = { policy: Policy; txs: Tx[] };

export const store = makeStore<Db>('data/db.json', {
  policy: {
    currency: 'USD', perPurchaseLimit: 50, dailyBudget: 150,
    merchants: [
      { id: 'papertrail', name: 'PaperTrail Office Supply', email: process.env.MERCHANT_EMAIL_PAPERTRAIL || '', category: 'office supplies' },
      { id: 'cloudbox', name: 'CloudBox Hosting', email: process.env.MERCHANT_EMAIL_CLOUDBOX || '', category: 'software' },
    ],
  },
  txs: [],
});

// A pretend marketplace for the demo agent to shop in. BargainBin is deliberately NOT an approved merchant.
export const CATALOG = [
  { sku: 'PT-PAPER', merchantId: 'papertrail', merchantName: 'PaperTrail Office Supply', item: 'Printer paper, box of 5 reams', price: 18 },
  { sku: 'PT-TONER', merchantId: 'papertrail', merchantName: 'PaperTrail Office Supply', item: 'Black toner cartridge', price: 42 },
  { sku: 'BB-PAPER', merchantId: 'bargainbin', merchantName: 'BargainBin Deals', item: 'Printer paper, box of 5 reams', price: 9 },
  { sku: 'CB-HOST', merchantId: 'cloudbox', merchantName: 'CloudBox Hosting', item: 'Cloud hosting, 1 month', price: 60 },
  { sku: 'CB-DOMAIN', merchantId: 'cloudbox', merchantName: 'CloudBox Hosting', item: 'Domain renewal, 1 year', price: 14 },
];

const today = () => new Date().toISOString().slice(0, 10);

export function budget() {
  const { policy, txs } = store.get();
  const todays = txs.filter((t) => t.at.slice(0, 10) === today());
  const sum = (s: Tx['status']) => todays.filter((t) => t.status === s).reduce((n, t) => n + t.amount, 0);
  // Only confirmed payments are spent. Payments still processing and purchases awaiting approval hold budget,
  // so concurrent requests cannot share it. Returned, failed, blocked and rejected purchases cost nothing.
  const spent = sum('paid'), processing = sum('processing'), awaiting = sum('pending_approval');
  return {
    currency: policy.currency, perPurchaseLimit: policy.perPurchaseLimit, dailyBudget: policy.dailyBudget,
    spentToday: spent, processingToday: processing, awaitingApproval: awaiting,
    remainingToday: Math.max(0, policy.dailyBudget - spent - processing - awaiting),
    approvedMerchants: policy.merchants.map((m) => ({ id: m.id, name: m.name, category: m.category })),
  };
}

// What an agent sees from check_budget: limits and money, but not which merchants are approved.
// The agent learns the merchant rule by being blocked; the wallet enforces it either way.
export function agentBudget() {
  const { approvedMerchants, ...rest } = budget();
  return { ...rest, merchantRule: 'Only merchants approved by the owner can be paid. The approved list is not shared with agents.' };
}

const FAILED = ['FAILED', 'BLOCKED', 'RETURNED', 'REFUNDED', 'REVERSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reads the payout item from PayPal and moves the purchase to its real outcome.
// Only an item with transaction_status SUCCESS counts as paid.
export async function settle(tx: Tx): Promise<void> {
  if (!tx.payoutBatchId) return;
  const batch = await getPayoutBatch(tx.payoutBatchId);
  tx.payoutStatus = batch.status;
  if (batch.status === 'DENIED' || batch.status === 'CANCELED') {
    tx.status = 'failed'; tx.outcome = `PayPal ${batch.status.toLowerCase()} the payout batch. The merchant was not paid.`; return;
  }
  const item = batch.items[0];
  if (!item) return; // batch still being processed
  tx.payoutItemId = item.payoutItemId; tx.transactionStatus = item.transactionStatus;
  if (item.transactionId) tx.transactionId = item.transactionId;
  const why = item.error ? ` PayPal says: ${item.error}` : '';
  if (item.transactionStatus === 'SUCCESS') {
    tx.status = 'paid'; tx.outcome = 'PayPal confirmed the merchant received the money.';
  } else if (item.transactionStatus === 'UNCLAIMED') {
    // Nobody holds a PayPal account at that email. Cancel now so the money returns to the owner
    // instead of waiting 30 days for PayPal's automatic refund. Until the cancel succeeds the
    // purchase is "processing" (never "paid"), so a failed cancel is retried on the next refresh.
    tx.status = 'processing';
    tx.outcome = `Unclaimed: the merchant's PayPal email has no account. The wallet is cancelling the payment so the money returns to the owner.${why}`;
    let c;
    try { c = await cancelPayoutItem(item.payoutItemId); }
    catch (e: any) {
      tx.outcome = `Unclaimed: the merchant's PayPal email has no account, so the merchant was not paid. PayPal refused to cancel it just now (${e.message}); the wallet retries on every refresh, and PayPal returns unclaimed money to the owner automatically after 30 days.`;
      return;
    }
    tx.transactionStatus = c.transactionStatus;
    tx.status = 'returned';
    tx.outcome = `Not delivered: the merchant's PayPal email has no account, so the payment was unclaimed. The wallet cancelled it and the money went back to the owner.${why}`;
  } else if (FAILED.includes(item.transactionStatus)) {
    tx.status = 'failed'; tx.outcome = `PayPal reports the payment as ${item.transactionStatus}. The merchant was not paid.${why}`;
  } else {
    tx.status = 'processing'; tx.outcome = `PayPal reports the payment as ${item.transactionStatus}; it is not final yet.`;
  }
}

// Sends the payout, then watches the item for about 15 seconds. If it is still not final,
// the purchase stays "processing" and is resolved on a later refresh.
async function pay(tx: Tx, merchant: Merchant) {
  try {
    const p = await createPayout({
      email: merchant.email, amount: tx.amount, currency: store.get().policy.currency,
      subject: `Payment for ${tx.item}`, note: `Allowance wallet purchase ${tx.id}: ${tx.item}`, idempotencyKey: `allowance-${tx.id}`,
    });
    tx.payoutBatchId = p.batchId; tx.payoutStatus = p.status; tx.outcome = 'PayPal accepted the payout; waiting for confirmation.';
  } catch (e: any) {
    tx.status = 'failed'; tx.outcome = 'PayPal error: ' + e.message; return;
  }
  store.save();
  for (let waited = 0; waited < 15000 && tx.status === 'processing'; waited += 3000) {
    await sleep(3000);
    try { await settle(tx); } catch { /* transient: retry, or leave it for a later refresh */ }
  }
}

// The agent names a catalogue item by sku. Merchant, item and price always come from the catalogue,
// never from the agent, so an agent cannot under-state a price to slip under a limit.
export async function requestPurchase(input: { sku: string; reason: string }): Promise<Tx> {
  const { policy, txs } = store.get();
  const sku = String(input?.sku || '').trim().toUpperCase();
  const entry = CATALOG.find((c) => c.sku === sku);
  const merchant = entry && policy.merchants.find((m) => m.id === entry.merchantId);
  const tx: Tx = {
    id: randomUUID().slice(0, 8), at: new Date().toISOString(), sku: sku.slice(0, 40),
    merchantId: entry?.merchantId || '', merchantName: entry?.merchantName || 'unknown',
    item: entry?.item || `Unknown item "${sku.slice(0, 40)}"`, amount: entry?.price ?? 0,
    reason: String(input?.reason || '').slice(0, 300), status: 'blocked', rule: '',
  };
  const amount = tx.amount;
  const b = budget();
  if (!entry) tx.rule = `Blocked: "${sku || '(none)'}" is not a catalogue sku. Use a sku from browse_catalog.`;
  else if (!merchant) tx.rule = `Blocked: "${tx.merchantName}" is not on the approved merchant list.`;
  else if (!merchant.email) tx.rule = `Blocked: no PayPal email is configured for ${merchant.name}.`;
  else if (amount > b.remainingToday) tx.rule = `Blocked: ${amount.toFixed(2)} exceeds what is left of today's budget (${b.remainingToday.toFixed(2)}).`;
  else if (amount > policy.perPurchaseLimit) {
    tx.status = 'pending_approval';
    tx.rule = `Held: ${amount.toFixed(2)} is over the per-purchase limit of ${policy.perPurchaseLimit.toFixed(2)}, so the owner must approve it.`;
  } else {
    tx.rule = 'Allowed: approved merchant, within the per-purchase limit and daily budget.';
    tx.status = 'processing';
  }
  // Record the decision before any await: the checks above and this write run without yielding,
  // so the next request's budget() already sees this purchase.
  txs.unshift(tx); store.save();
  if (tx.status === 'processing') { await pay(tx, merchant!); store.save(); }
  return tx;
}

export async function decide(id: string, approve: boolean): Promise<Tx> {
  const { policy, txs } = store.get();
  const tx = txs.find((t) => t.id === id);
  if (!tx || tx.status !== 'pending_approval') throw new Error('That purchase is not waiting for approval.');
  const merchant = policy.merchants.find((m) => m.id === tx.merchantId);
  if (approve && !merchant?.email) throw new Error('That merchant is no longer approved.');
  tx.decidedAt = new Date().toISOString();
  if (!approve) { tx.status = 'rejected'; tx.rule = 'Rejected by the owner.'; store.save(); return tx; }
  // Leave pending_approval before awaiting PayPal, so a second click cannot pay the same purchase twice.
  tx.rule = 'Approved by the owner.'; tx.status = 'processing'; store.save();
  await pay(tx, merchant!);
  store.save();
  return tx;
}

// Resolves purchases that are still processing. Also re-checks any row marked paid without a confirmed
// SUCCESS item (rows from before item-level checking), so an old unclaimed payout is found and cancelled.
export async function refreshPayouts() {
  const errors: string[] = [];
  for (const t of store.get().txs)
    if (t.payoutBatchId && (t.status === 'processing' || (t.status === 'paid' && t.transactionStatus !== 'SUCCESS')))
      try { await settle(t); } catch (e: any) { errors.push(`${t.id}: ${e.message}`); }
  store.save();
  if (errors.length) throw new Error('Could not refresh every payment. ' + errors.join(' | '));
}

// Brings one purchase up to date if PayPal has not finished with it yet.
export async function refreshOne(t: Tx): Promise<Tx> {
  if (t.status === 'processing' && t.payoutBatchId) { try { await settle(t); store.save(); } catch { /* keep processing */ } }
  return t;
}

// What an agent is allowed to see about a transaction: no merchant emails, batch ids or PayPal references.
export const publicTx = (t: Tx) => ({
  id: t.id, status: t.status, merchant: t.merchantName, item: t.item, amount: t.amount,
  explanation: [t.rule, agentOutcome(t)].filter(Boolean).join(' '),
});

function agentOutcome(t: Tx): string {
  switch (t.status) {
    case 'paid': return 'PayPal confirmed the merchant received the money.';
    case 'processing': return t.payoutBatchId
      ? 'PayPal has not confirmed delivery yet, so this is not paid. Check again later with get_purchase_status.'
      : 'The payment is being sent.';
    case 'returned': return 'Not paid: the payment could not be delivered to the merchant, so the money was returned to the owner. Report this to the owner; do not retry.';
    // PayPal's own error text can name the receiver, so the agent gets a fixed message; the owner sees the detail.
    case 'failed': return 'Not paid: PayPal did not complete the payment, so the merchant received nothing. Report this to the owner; do not retry.';
    default: return '';
  }
}
