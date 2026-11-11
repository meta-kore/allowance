// Provider-agnostic chat helper. Works with Anthropic (Claude), Groq, Gemini and OpenRouter.
// Configure with AI_PROVIDER, AI_API_KEY and (recommended) AI_MODEL in .env.
type Provider = 'anthropic' | 'groq' | 'gemini' | 'openrouter';

const OPENAI_COMPATIBLE: Record<string, { url: string; model: string }> = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'qwen/qwen3.8-27b' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'anthropic/claude-sonnet-4.5' },
};
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';

export type Msg = { role: 'user' | 'assistant'; content: string };

// Free tiers rate-limit hard (Groq: 8,000 tokens a minute). On 429 or a transient 5xx, wait as long as
// the provider asks (retry-after, in seconds), capped at 65 s, and try again up to 3 times.
async function withRetry(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await send();
    if (attempt > 3 || !(res.status === 429 || res.status === 503 || res.status === 529)) return res;
    const after = Number(res.headers.get('retry-after'));
    const waitS = Math.min(65, Number.isFinite(after) && after > 0 ? after : 5 * attempt);
    await new Promise((r) => setTimeout(r, waitS * 1000));
  }
}

export function aiInfo() {
  const provider = (process.env.AI_PROVIDER || 'anthropic') as Provider;
  const model = process.env.AI_MODEL || (provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : OPENAI_COMPATIBLE[provider]?.model);
  return { provider, model };
}

export async function chat(system: string, messages: Msg[] | string, maxTokens = 1200): Promise<string> {
  const { provider, model } = aiInfo();
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('AI_API_KEY is not set (see .env.example)');
  const msgs: Msg[] = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;

  if (provider === 'anthropic') {
    const res = await withRetry(() => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: msgs }),
    }));
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`AI call failed (${provider} ${res.status}): ${body.error?.message || 'unknown error'}`);
    return (body.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  }

  const cfg = process.env.AI_BASE_URL
    ? { url: process.env.AI_BASE_URL.replace(/\/$/, '') + '/chat/completions', model }
    : OPENAI_COMPATIBLE[provider];
  if (!cfg) throw new Error(`Unknown AI_PROVIDER "${provider}". Use anthropic, groq, gemini or openrouter.`);
  const res = await withRetry(() => fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...msgs] }),
  }));
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = Array.isArray(body) ? body[0]?.error : body.error;
    throw new Error(`AI call failed (${provider} ${res.status}): ${e?.message || 'unknown error'}`);
  }
  return body.choices?.[0]?.message?.content || '';
}

// Pulls the first JSON object out of a model reply (tolerates code fences and stray prose).
export function extractJson<T = any>(text: string): T {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('AI reply contained no JSON: ' + text.slice(0, 200));
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('AI reply contained incomplete JSON: ' + text.slice(0, 200));
}
