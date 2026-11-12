// Thin PayPal REST client. Sandbox only by design: this project never touches live money.
// Set PAYPAL_MOCK=1 to run without credentials (offline development only).
import { randomUUID } from 'node:crypto';

const BASE = 'https://api-m.sandbox.paypal.com';
export const MOCK = process.env.PAYPAL_MOCK === '1';

let cached: { value: string; exp: number } | null = null;

async function token(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set (see .env.example)');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${body.error_description || body.error || 'unknown'}`);
  cached = { value: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.value;
}

export async function pp<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = data.details?.map((d: any) => d.description || d.issue).join('; ');
    throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${data.message || data.name || 'error'}${detail ? ' - ' + detail : ''}${data.debug_id ? ' [debug_id ' + data.debug_id + ']' : ''}`);
  }
  return data as T;
}

const money = (n: number) => n.toFixed(2);
const lastSegment = (href: string) => href.split('?')[0].split('/').filter(Boolean).pop()!;

// ---------- Invoicing ----------
export type InvoiceInfo = { id: string; number: string; status: string; payUrl: string };
const mockInvoices = new Map<string, InvoiceInfo>();

export async function createAndSendInvoice(o: {
  recipientEmail: string; recipientName: string; amount: number; currency: string; itemName: string; note: string;
}): Promise<InvoiceInfo> {
  if (MOCK) {
    const id = 'INV2-MOCK-' + randomUUID().slice(0, 8).toUpperCase();
    const inv = { id, number: 'M' + (mockInvoices.size + 1), status: 'SENT', payUrl: `/mock/pay/${id}` };
    mockInvoices.set(id, inv);
    return { ...inv };
  }
  let invoice_number: string | undefined;
  try {
    invoice_number = (await pp('POST', '/v2/invoicing/generate-next-invoice-number')).invoice_number;
  } catch { /* PayPal will assign one */ }
  const [given_name, ...rest] = o.recipientName.split(' ');
  const created = await pp('POST', '/v2/invoicing/invoices', {
    detail: {
      ...(invoice_number ? { invoice_number } : {}),
      currency_code: o.currency,
      note: o.note,
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    primary_recipients: [{
      billing_info: { name: { given_name, surname: rest.join(' ') || '-' }, email_address: o.recipientEmail },
    }],
    items: [{ name: o.itemName, quantity: '1', unit_amount: { currency_code: o.currency, value: money(o.amount) } }],
  });
  const id: string = created.id || lastSegment(created.href);
  await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
  return getInvoice(id);
}

export async function getInvoice(id: string): Promise<InvoiceInfo> {
  if (MOCK) return { ...mockInvoices.get(id)! };
  const inv = await pp('GET', `/v2/invoicing/invoices/${id}`);
  return {
    id,
    number: inv.detail?.invoice_number || '',
    status: inv.status,
    payUrl: inv.detail?.metadata?.recipient_view_url || '',
  };
}

export async function remindInvoice(id: string, subject: string, note: string): Promise<void> {
  if (MOCK) return;
  await pp('POST', `/v2/invoicing/invoices/${id}/remind`, { subject, note, send_to_recipient: true, send_to_invoicer: false });
}

export async function recordInvoicePayment(id: string, amount: number, currency: string, note: string): Promise<void> {
  if (MOCK) { mockInvoices.get(id)!.status = 'MARKED_AS_PAID'; return; }
  await pp('POST', `/v2/invoicing/invoices/${id}/payments`, {
    method: 'CASH',
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: currency, value: money(amount) },
    note,
  });
}

export function mockPayInvoice(id: string): boolean {
  const inv = mockInvoices.get(id);
  if (inv) inv.status = 'PAID';
  return !!inv;
}

// ---------- Payouts ----------
// A batch being accepted (even batch_status SUCCESS) does not mean the money arrived: each item has its
// own transaction_status (SUCCESS, FAILED, PENDING, UNCLAIMED, RETURNED, ONHOLD, BLOCKED, REFUNDED, REVERSED).
export type PayoutInfo = { batchId: string; status: string };
export type PayoutItem = { payoutItemId: string; transactionStatus: string; transactionId?: string; error?: string };
export type PayoutBatch = { batchId: string; status: string; items: PayoutItem[] };

// Mock mode: a receiver email containing "unclaimed", "failed" or "pending" yields that item outcome.
const mockBatches = new Map<string, PayoutBatch>();

const toItem = (i: any): PayoutItem => ({
  payoutItemId: i.payout_item_id,
  transactionStatus: i.transaction_status || 'PENDING',
  transactionId: i.transaction_id || undefined,
  error: i.errors ? [i.errors.name, i.errors.message].filter(Boolean).join(': ') : undefined,
});

export async function createPayout(o: {
  email: string; amount: number; currency: string; note: string; subject: string; idempotencyKey: string;
}): Promise<PayoutInfo> {
  if (MOCK) {
    const batchId = 'MOCKBATCH' + randomUUID().slice(0, 8).toUpperCase();
    const e = o.email.toLowerCase();
    const item: PayoutItem = { payoutItemId: 'MOCKITEM' + randomUUID().slice(0, 8).toUpperCase(), transactionStatus: 'SUCCESS', transactionId: 'MOCKTX' + randomUUID().slice(0, 8).toUpperCase() };
    if (e.includes('unclaimed')) Object.assign(item, { transactionStatus: 'UNCLAIMED', error: 'RECEIVER_UNREGISTERED: The recipient for this payout does not have an account.' });
    else if (e.includes('failed')) Object.assign(item, { transactionStatus: 'FAILED', transactionId: undefined, error: 'RECEIVER_ACCOUNT_LOCKED: The receiver account is locked.' });
    else if (e.includes('pending')) Object.assign(item, { transactionStatus: 'PENDING', transactionId: undefined });
    mockBatches.set(batchId, { batchId, status: 'SUCCESS', items: [item] });
    return { batchId, status: 'PENDING' };
  }
  const r = await pp('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: o.idempotencyKey, email_subject: o.subject, email_message: o.note },
    items: [{
      recipient_type: 'EMAIL',
      receiver: o.email,
      amount: { value: money(o.amount), currency: o.currency },
      note: o.note,
      sender_item_id: o.idempotencyKey,
    }],
  });
  return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status };
}

// GET /v1/payments/payouts/{payout_batch_id}: the batch status plus every item's transaction_status.
export async function getPayoutBatch(batchId: string): Promise<PayoutBatch> {
  if (MOCK) {
    const b = mockBatches.get(batchId);
    if (!b) throw new Error(`Mock payout batch ${batchId} not found`);
    return { ...b, items: b.items.map((i) => ({ ...i })) };
  }
  const r = await pp('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  return { batchId, status: r.batch_header?.batch_status || 'PENDING', items: (r.items || []).map(toItem) };
}

// POST /v1/payments/payouts-item/{payout_item_id}/cancel: only UNCLAIMED items can be cancelled.
// The money goes back to the sender and the item becomes RETURNED.
export async function cancelPayoutItem(payoutItemId: string): Promise<PayoutItem> {
  if (MOCK) {
    for (const b of mockBatches.values()) {
      const i = b.items.find((x) => x.payoutItemId === payoutItemId);
      if (!i) continue;
      if (i.transactionStatus !== 'UNCLAIMED') throw new Error(`Mock payout item ${payoutItemId} is ${i.transactionStatus}, not UNCLAIMED`);
      i.transactionStatus = 'RETURNED';
      return { ...i };
    }
    throw new Error(`Mock payout item ${payoutItemId} not found`);
  }
  return toItem(await pp('POST', `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`));
}
