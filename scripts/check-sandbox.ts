// Sandbox preflight: run `npm run check` before the first real test.
// It confirms the credentials work, that the app may use Payouts, and that the merchants and AI key are configured.
import 'dotenv/config';

const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
const line = (ok: boolean, msg: string) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
if (!id || !secret) { line(false, 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env'); process.exit(1); }

const res = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
const body: any = await res.json().catch(() => ({}));
line(res.ok, res.ok ? 'Sandbox credentials accepted' : `Sandbox credentials rejected: ${body.error_description || res.status}`);
if (!res.ok) process.exit(1);

line(/payouts/i.test(body.scope || ''), 'Payouts scope present on the app (if FAIL: enable Payouts in the app settings)');

for (const k of ['MERCHANT_EMAIL_PAPERTRAIL', 'MERCHANT_EMAIL_CLOUDBOX']) {
  const v = process.env[k] || '';
  line(/^\S+@\S+\.\S+$/.test(v), v ? `${k} is set` : `${k} missing from .env (or set it on the dashboard under Rules)`);
}
const tok = process.env.AGENT_TOKEN;
line(!!tok && tok !== 'dev-agent-token', tok && tok !== 'dev-agent-token' ? 'AGENT_TOKEN is set to a custom value' : 'AGENT_TOKEN is missing or still the default: change it before deploying');

const c3 = process.env.CHANNEL3_API_KEY;
if (!c3) line(false, 'CHANNEL3_API_KEY missing from .env: the agent will shop the demo catalogue instead of real products');
else {
  try {
    const { searchProducts } = await import('../src/channel3.js');
    const ps = await searchProducts('printer paper', undefined, 3);
    line(ps.length > 0, `Channel3 live search returned ${ps.length} product(s) with in-stock USD offers`);
  } catch (e: any) { line(false, e.message); }
}

const key = process.env.AI_API_KEY;
line(!!key, key ? `AI key set for provider "${process.env.AI_PROVIDER || 'anthropic'}"` : 'AI_API_KEY missing from .env');
if (key) {
  try {
    const { chat, aiInfo, extractJson } = await import('../src/ai.js');
    const out = await chat('Reply with ONLY this JSON object: {"tool":"check_budget","args":{}}', 'Go.', 60);
    const j = extractJson<any>(out);
    line(j.tool === 'check_budget', `AI model ${aiInfo().model} returns parseable JSON tool calls`);
  } catch (e: any) { line(false, e.message + ' (set AI_MODEL in .env to a model your key can use)'); }
}
