// MCP server: plug the allowance wallet into any MCP-capable agent (Claude Desktop, Claude Code, Cursor, ...).
// It is a thin client of the wallet's agent API, so the same rules apply to every agent.
// Start the wallet (npm start), then run: npm run mcp
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const WALLET_URL = (process.env.WALLET_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

async function wallet(method: string, path: string, body?: unknown) {
  const res = await fetch(WALLET_URL + path, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { content: [{ type: 'text' as const, text: await res.text() }], isError: !res.ok };
}

const server = new McpServer({ name: 'allowance-wallet', version: '1.0.0' });

server.tool('check_budget', 'See the spending limits and how much of today\'s budget is left. Only owner-approved retailers can be paid; the list is not shared.', {}, () => wallet('GET', '/agent/budget'));
server.tool(
  'search_products',
  'Search real products for sale (via Channel3). Each product has offers from retailers, each with a domain and a USD price. Only in-stock USD offers are listed.',
  { query: z.string().describe('What to look for, e.g. "printer paper"'), maxPrice: z.number().positive().optional().describe('Only offers at or below this price (USD)') },
  ({ query, maxPrice }) => wallet('GET', `/agent/search?query=${encodeURIComponent(query)}${maxPrice ? `&maxPrice=${maxPrice}` : ''}`),
);
server.tool(
  'request_purchase',
  'Ask the wallet to buy one offer from search_products through PayPal. The wallet charges that offer\'s price (you cannot set the amount) and replies with a status: paid (PayPal confirmed the merchant received it), processing (sent but not confirmed yet; not paid), returned (undeliverable; money went back to the owner), failed (PayPal did not complete it), blocked (refused by the rules), or pending_approval (the owner must approve). Do not retry returned or failed payments; report them.',
  {
    productId: z.string().describe('The productId, from search_products'),
    domain: z.string().describe('The retailer domain of the chosen offer, from search_products'),
    reason: z.string().describe('Why this purchase serves the task; shown to the owner'),
  },
  (args) => wallet('POST', '/agent/purchases', args),
);
server.tool('get_purchase_status', 'Check the latest status of an earlier purchase request, for example one waiting for approval or a payment still processing at PayPal.', { id: z.string() }, ({ id }) => wallet('GET', `/agent/purchases/${encodeURIComponent(id)}`));
server.tool('list_purchases', 'List the most recent purchase requests and their outcomes.', {}, () => wallet('GET', '/agent/purchases'));

await server.connect(new StdioServerTransport());
console.error(`Allowance MCP server connected to ${WALLET_URL}`);
