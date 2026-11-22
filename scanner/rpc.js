'use strict';
/* A small Solana JSON-RPC client: retries on rate limits and network errors, a cap on calls in flight,
   and a budget of calls per scan so one scan can never run away with a paid plan.
   No dependencies: Node 18+ has fetch. */
const { sleep } = require('../chain/util');

class Budget extends Error { constructor() { super('call budget for this scan is spent'); this.budget = true; } }

function client(url, opt) {
  opt = opt || {};
  if (!url) throw new Error('no RPC address: pass --rpc <url> or set SOLANA_RPC_URL');
  const maxInFlight = opt.concurrency || 8, maxCalls = opt.budget || 1500, retries = opt.retries == null ? 4 : opt.retries;
  let inFlight = 0, calls = 0, id = 0;
  const queue = [];
  const take = () => new Promise(r => { if (inFlight < maxInFlight) { inFlight++; r(); } else queue.push(r); });
  const give = () => { const n = queue.shift(); if (n) n(); else inFlight--; };

  async function call(method, params) {
    if (calls >= maxCalls) throw new Budget();
    calls++;
    await take();
    try {
      for (let a = 0; ; a++) {
        let res, body;
        try {
          res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params || [] }) });
          if (res.status === 429 || res.status >= 500) throw Object.assign(new Error('HTTP ' + res.status), { retry: true });
          body = await res.json();
        } catch (e) {
          if (a < retries && (e.retry || e.name === 'TypeError')) { await sleep(400 * Math.pow(2, a)); continue; }
          throw e;
        }
        if (body.error) {
          /* -32429 and friends: some providers send rate limits as JSON-RPC errors */
          if (a < retries && /rate|limit|too many/i.test(body.error.message || '')) { await sleep(400 * Math.pow(2, a)); continue; }
          throw new Error(method + ': ' + (body.error.message || JSON.stringify(body.error)));
        }
        return body.result;
      }
    } finally { give(); }
  }
  return { call, used: () => calls, budget: maxCalls };
}

module.exports = { client, Budget };
