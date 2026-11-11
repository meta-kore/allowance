import 'dotenv/config';
import express from 'express';
import { MOCK } from './paypal.js';
import { aiInfo } from './ai.js';
import { store, CATALOG, budget, agentBudget, requestPurchase, decide, refreshPayouts, publicTx } from './wallet.js';
import { runs, startRun } from './agent.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));
const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => res.status(400).json({ error: e.message }));

// ---------- Agent API (what an AI agent may do). Requires the agent token. ----------
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';
const agentOnly: express.RequestHandler = (req, res, next) =>
  req.headers.authorization === `Bearer ${AGENT_TOKEN}` ? next() : res.status(401).json({ error: 'Missing or wrong agent token' });

app.get('/agent/budget', agentOnly, (_req, res) => res.json(agentBudget()));
app.get('/agent/catalog', agentOnly, (_req, res) => res.json(CATALOG));
app.post('/agent/purchases', agentOnly, wrap(async (req, res) => res.json(publicTx(await requestPurchase(req.body)))));
app.get('/agent/purchases', agentOnly, (_req, res) => res.json(store.get().txs.slice(0, 25).map(publicTx)));
app.get('/agent/purchases/:id', agentOnly, (req, res) => {
  const t = store.get().txs.find((t) => t.id === req.params.id);
  t ? res.json(publicTx(t)) : res.status(404).json({ error: 'No purchase with that id' });
});

// ---------- Owner API (the human). In this demo the dashboard is unauthenticated: put it behind a login before real use. ----------
app.get('/api/state', (_req, res) => res.json({ ...store.get(), budget: budget(), runs: runs.slice(-1), mock: MOCK, ai: aiInfo(), catalog: CATALOG }));

app.put('/api/policy', wrap((req, res) => {
  const p = store.get().policy;
  const { perPurchaseLimit, dailyBudget, merchants } = req.body;
  if (!(perPurchaseLimit >= 0) || !(dailyBudget >= 0)) throw new Error('Limits must be zero or more.');
  p.perPurchaseLimit = Number(perPurchaseLimit); p.dailyBudget = Number(dailyBudget);
  if (Array.isArray(merchants)) for (const m of merchants) {
    const cur = p.merchants.find((x) => x.id === m.id);
    if (cur && typeof m.email === 'string') cur.email = m.email.trim();
  }
  store.save(); res.json({ ok: true });
}));

app.post('/api/purchases/:id/approve', wrap(async (req, res) => res.json(await decide(req.params.id, true))));
app.post('/api/purchases/:id/reject', wrap(async (req, res) => res.json(await decide(req.params.id, false))));
app.post('/api/refresh', wrap(async (_req, res) => { await refreshPayouts(); res.json({ ok: true }); }));
app.post('/api/reset', (_req, res) => { store.get().txs.length = 0; store.save(); runs.length = 0; res.json({ ok: true }); });

app.post('/api/agent/run', wrap((req, res) => {
  if (runs.some((r) => r.status === 'running')) throw new Error('The agent is already working on a task.');
  const task = String(req.body.task || '').slice(0, 600);
  if (!task) throw new Error('Give the agent a task.');
  res.json({ id: startRun(task).id });
}));

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`Allowance is running on http://localhost:${port}${MOCK ? '  (PAYPAL_MOCK=1: no real PayPal calls)' : '  (PayPal sandbox)'}`));
