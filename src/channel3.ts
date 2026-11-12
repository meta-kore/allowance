// Product search for the agent. With CHANNEL3_API_KEY set it searches real products through Channel3
// (https://docs.trychannel3.com); without a key it falls back to a small demo catalogue so the app still runs.
// Every offer a search returns is cached here, and the wallet charges the cached price, never one the agent states.

export const CHANNEL3 = !!process.env.CHANNEL3_API_KEY;
const OFFER_TTL_MS = 30 * 60 * 1000; // prices and stock change; an older offer must be searched again

export type Offer = { domain: string; price: number; currency: string; availability: string; url: string };
export type Product = { productId: string; title: string; brand: string; image?: string; offers: Offer[] };
export type CachedOffer = Offer & { productId: string; title: string; brand: string; image?: string; cachedAt: number };

const cache = new Map<string, CachedOffer>();
const key = (productId: string, domain: string) => `${productId}|${domain.toLowerCase()}`;

function remember(p: Product, offers: Offer[]) {
  const now = Date.now();
  for (const o of offers) cache.set(key(p.productId, o.domain), { ...o, productId: p.productId, title: p.title, brand: p.brand, image: p.image, cachedAt: now });
}

// The offer the wallet will charge for, or why it cannot be used.
export function lookupOffer(productId: string, domain: string): { offer?: CachedOffer; problem?: 'unknown' | 'expired' } {
  const o = cache.get(key(productId, domain));
  if (!o) return { problem: 'unknown' };
  if (Date.now() - o.cachedAt > OFFER_TTL_MS) return { problem: 'expired' };
  return { offer: o };
}

// Demo catalogue, used only when CHANNEL3_API_KEY is not set. bargainbin.example is deliberately not approved.
export const DEMO_CATALOG: Product[] = [
  { productId: 'PT-PAPER', title: 'Printer paper, box of 5 reams', brand: 'PaperTrail', offers: [{ domain: 'papertrail.example', price: 18, currency: 'USD', availability: 'InStock', url: '' }] },
  { productId: 'PT-TONER', title: 'Black toner cartridge', brand: 'PaperTrail', offers: [{ domain: 'papertrail.example', price: 42, currency: 'USD', availability: 'InStock', url: '' }] },
  { productId: 'BB-PAPER', title: 'Printer paper, box of 5 reams', brand: 'BargainBin', offers: [{ domain: 'bargainbin.example', price: 9, currency: 'USD', availability: 'InStock', url: '' }] },
  { productId: 'CB-HOST', title: 'Cloud hosting, 1 month', brand: 'CloudBox', offers: [{ domain: 'cloudbox.example', price: 60, currency: 'USD', availability: 'InStock', url: '' }] },
  { productId: 'CB-DOMAIN', title: 'Domain renewal, 1 year', brand: 'CloudBox', offers: [{ domain: 'cloudbox.example', price: 14, currency: 'USD', availability: 'InStock', url: '' }] },
];
export const DEMO_DOMAINS: Record<string, string[]> = { papertrail: ['papertrail.example'], cloudbox: ['cloudbox.example'] };

const usable = (o: Offer, maxPrice?: number) =>
  o.currency === 'USD' && o.availability === 'InStock' && o.price > 0 && (maxPrice === undefined || o.price <= maxPrice);

// Searches products and returns only USD, in-stock offers (within maxPrice if given). Caches every returned offer,
// including unusable ones, so the wallet can say exactly why an offer cannot be bought.
export async function searchProducts(query: string, maxPrice?: number, limit = 8): Promise<Product[]> {
  const q = query.trim().slice(0, 200);
  if (!q) throw new Error('Give a search query.');
  const max = maxPrice !== undefined && Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : undefined;
  let products: Product[];
  if (!CHANNEL3) {
    const words = q.toLowerCase().split(/\s+/);
    products = DEMO_CATALOG.filter((p) => words.some((w) => (p.title + ' ' + p.brand).toLowerCase().includes(w)));
    if (!products.length) products = DEMO_CATALOG;
  } else {
    const res = await fetch('https://api.trychannel3.com/v1/search', {
      method: 'POST',
      headers: { 'x-api-key': process.env.CHANNEL3_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, limit, filters: { ...(max ? { price: { max_price: max } } : {}), availability: ['InStock'] } }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Channel3 search failed (${res.status}): ${String(body?.detail || body?.message || body?.error || 'no detail').slice(0, 200)}`);
    products = (body.products ?? []).map((p: any): Product => ({
      productId: String(p.id),
      title: String(p.title || 'Untitled product'),
      brand: p.brands?.[0]?.name || '',
      image: (p.images?.find((i: any) => i.is_main_image) ?? p.images?.[0])?.url,
      offers: (p.offers ?? []).filter((o: any) => o?.domain && o?.price).map((o: any): Offer => ({
        domain: String(o.domain).toLowerCase(), price: Number(o.price.price), currency: String(o.price.currency || ''),
        availability: String(o.availability || ''), url: /^https:\/\//.test(String(o.url)) ? String(o.url) : '',
      })),
    }));
  }
  const out: Product[] = [];
  for (const p of products) {
    remember(p, p.offers);
    const offers = p.offers.filter((o) => usable(o, max));
    if (offers.length) out.push({ ...p, offers });
  }
  return out;
}

// What the agent sees from a search: enough to choose and buy, without image or link noise.
export const agentProducts = (ps: Product[]) => ({
  currency: 'USD',
  products: ps.map((p) => ({ productId: p.productId, title: p.title, brand: p.brand || undefined, offers: p.offers.map((o) => ({ domain: o.domain, price: o.price })) })),
  howToBuy: 'request_purchase with a productId and one of its offer domains. The wallet charges that offer\'s price.',
});
