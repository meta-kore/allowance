// The wallet core: policy, ledger and the decision engine. Every rule is enforced here in code,
// so no prompt, however clever, can talk the agent past its allowance.
import { randomUUID } from 'node:crypto';
import { makeStore } from './store.js';
import { createPayout, getPayout } from './paypal.js';

export type Merchant = { id: string; name: string; email: string; category: string };
export type Policy = { currency: string; perPurchaseLimit: number; dailyBudget: number; merchants: Merchant[] };
export type Tx = {
  id: string; at: string; sku?: string; merchantId: string; merchantName: string; item: string; amount: number; reason: string;
  status: 'processing' | 'paid' | 'blocked' | 'pending_approval' | 'rejected' | 'failed';
  rule: string; payoutBatchId?: string; payoutStatus?: string; decidedAt?: string;
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
  // A purchase being paid right now counts as spent, so concurrent requests cannot share the same budget.
  const spent = todays.filter((t) => t.status === 'paid' || t.status === 'processing').reduce((s, t) => s + t.amount, 0);
  const held = todays.filter((t) => t.status === 'pending_approval').reduce((s, t) => s + t.amount, 0);
  return {
    currency: policy.currency, perPurchaseLimit: policy.perPurchaseLimit, dailyBudget: policy.dailyBudget,
    spentToday: spent, awaitingApproval: held, remainingToday: Math.max(0, policy.dailyBudget - spent - held),
    approvedMerchants: policy.merchants.map((m) => ({ id: m.id, name: m.name, category: m.category })),
  };
}

// What an agent sees from check_budget: limits and money, but not which merchants are approved.
// The agent learns the merchant rule by being blocked; the wallet enforces it either way.
export function agentBudget() {
  const { approvedMerchants, ...rest } = budget();
  return { ...rest, merchantRule: 'Only merchants approved by the owner can be paid. The approved list is not shared with agents.' };
}

async function pay(tx: Tx, merchant: Merchant) {
  try {
    const p = await createPayout({
      email: merchant.email, amount: tx.amount, currency: store.get().policy.currency,
      subject: `Payment for ${tx.item}`, note: `Allowance wallet purchase ${tx.id}: ${tx.item}`, idempotencyKey: `allowance-${tx.id}`,
    });
    tx.payoutBatchId = p.batchId; tx.payoutStatus = p.status; tx.status = 'paid';
  } catch (e: any) {
    tx.status = 'failed'; tx.rule = 'PayPal error: ' + e.message;
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

export async function refreshPayouts() {
  for (const t of store.get().txs)
    if (t.payoutBatchId && !['SUCCESS', 'DENIED', 'CANCELED'].includes(t.payoutStatus || '')) t.payoutStatus = (await getPayout(t.payoutBatchId)).status;
  store.save();
}

// What an agent is allowed to see about a transaction.
export const publicTx = (t: Tx) => ({ id: t.id, status: t.status, merchant: t.merchantName, item: t.item, amount: t.amount, explanation: t.rule });
