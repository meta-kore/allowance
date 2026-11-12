// A small built-in shopping agent, used to demo the wallet. It can only act through the wallet's tools,
// exactly like an external agent connected over MCP.
import { chat, extractJson, type Msg } from './ai.js';
import { agentBudget, requestPurchase, refreshOne, publicTx, store } from './wallet.js';
import { searchProducts, agentProducts } from './channel3.js';

export type Step = { kind: 'thought' | 'tool' | 'result' | 'final' | 'error'; text: string };
export type Run = { id: number; task: string; status: 'running' | 'done' | 'error'; steps: Step[] };
export const runs: Run[] = [];

const SYSTEM = `You are a purchasing agent for a small business. You have an allowance wallet and must complete the user's task by calling tools.
Reply with ONLY one JSON object per turn, in one of these forms:
{"thought": "<short reasoning>", "tool": "<tool name>", "args": { ... }}
{"thought": "<short reasoning>", "final": "<report to the owner: what was paid, what is waiting for approval, what was blocked and why>"}

Tools:
- check_budget {}  -> spending limits and remaining budget
- search_products {"query": "<what to look for>", "maxPrice": <optional number>}  -> products for sale, each with offers from retailers (domain and price in USD)
- request_purchase {"productId": "<productId from search_products>", "domain": "<retailer domain of the offer you chose>", "reason": "<why this purchase serves the task>"}  -> the wallet's decision and the payment outcome. The wallet charges that offer's price; you cannot set the amount.
- get_purchase_status {"id": "..."}  -> current status of an earlier request

Purchase statuses:
- paid: PayPal confirmed the merchant received the money.
- processing: sent to PayPal but not confirmed yet. It is NOT paid. You may check it once more with get_purchase_status before finishing.
- returned: the payment could not be delivered, so the money went back to the owner. Nothing was bought.
- failed: PayPal did not complete the payment. Nothing was bought.
- blocked: the wallet's rules refused it.
- pending_approval: held for the owner to approve or reject.

You cannot pay any other way. If the wallet blocks a purchase, do not retry the same offer: find a compliant alternative or report it. If a payment is returned or failed, do not retry it; report it. If a purchase is pending_approval, leave it with the owner and carry on. Finish with "final" when the task is done as far as the rules allow.

The final report must match the wallet's replies exactly:
- Report only purchases you requested with request_purchase, each with the latest status and amount the wallet gave you. Call something paid only if the wallet said paid; say plainly when a payment is still processing, was returned or failed. Never describe something you chose not to request as blocked; if you skipped an option, say you skipped it and why.
- Do not work out the remaining budget yourself. If you mention it, call check_budget just before finishing and quote its remainingToday.`;

async function callTool(tool: string, args: any): Promise<unknown> {
  switch (tool) {
    case 'check_budget': return agentBudget();
    case 'search_products':
      try { return agentProducts(await searchProducts(String(args?.query || ''), args?.maxPrice === undefined ? undefined : Number(args.maxPrice))); }
      catch (e: any) { return { error: e.message }; }
    case 'request_purchase': return publicTx(await requestPurchase(args || {}));
    case 'get_purchase_status': {
      const t = store.get().txs.find((t) => t.id === args?.id);
      return t ? publicTx(await refreshOne(t)) : { error: 'No purchase with that id' };
    }
    default: return { error: `Unknown tool "${tool}"` };
  }
}

export function startRun(task: string): Run {
  const run: Run = { id: runs.length + 1, task, status: 'running', steps: [] };
  runs.push(run);
  (async () => {
    const msgs: Msg[] = [{ role: 'user', content: `Task: ${task}` }];
    for (let i = 0; i < 16; i++) {
      const reply = await chat(SYSTEM, msgs, 700);
      msgs.push({ role: 'assistant', content: reply });
      let j: any;
      try { j = extractJson<any>(reply); }
      catch {
        // A malformed reply costs one of the 16 steps instead of ending the run.
        msgs.push({ role: 'user', content: 'That reply was not one valid JSON object. Resend it as exactly one valid JSON object and nothing else.' });
        continue;
      }
      if (j.thought) run.steps.push({ kind: 'thought', text: String(j.thought) });
      if (j.final) { run.steps.push({ kind: 'final', text: String(j.final) }); run.status = 'done'; return; }
      if (!j.tool) { msgs.push({ role: 'user', content: 'Reply with a JSON object containing either "tool" or "final".' }); continue; }
      // Some models "call" final as if it were a tool. Treat it as the report, not a wallet call.
      if (j.tool === 'final') {
        const a = j.args;
        const text = typeof a === 'string' ? a : a?.final ?? a?.report ?? a?.text ?? a?.message;
        if (text) { run.steps.push({ kind: 'final', text: String(text) }); run.status = 'done'; return; }
        msgs.push({ role: 'user', content: '"final" is not a tool. Finish with {"thought": "...", "final": "<report to the owner>"}.' });
        continue;
      }
      run.steps.push({ kind: 'tool', text: `${j.tool} ${JSON.stringify(j.args || {})}` });
      const result = await callTool(j.tool, j.args);
      run.steps.push({ kind: 'result', text: JSON.stringify(result) });
      msgs.push({ role: 'user', content: `Tool result: ${JSON.stringify(result)}` });
    }
    run.steps.push({ kind: 'error', text: 'Stopped: the agent used all 16 steps without finishing.' }); run.status = 'error';
  })().catch((e) => { run.steps.push({ kind: 'error', text: e.message }); run.status = 'error'; });
  return run;
}
