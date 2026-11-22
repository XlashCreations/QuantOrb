'use strict';
/* The scanner end to end on a made-up chain: a fake RPC answers the same calls a real one would, with a token
   whose holders hide every pattern the scanner looks for. Then the same scan through the real HTTP client
   against a local JSON-RPC server, to check the wire format and retries. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const S = require('../chain/solana');
const { scan } = require('../scanner');
const { client } = require('../scanner/rpc');
const { infraLabel } = require('../scanner/token');

const { chain, wallet, sigOf } = require('./fake-chain');

test('scanner: finds every pattern on a made-up chain', async () => {
  const c = chain();
  const { input, verdict, extra } = await scan(c.rpc, c.mint, { solUsd: 150, offline: true });
  const at = w => input.holders.findIndex(h => h.wallet === w);
  const H = i => input.holders[at(c.H[i].w)];
  const I = c.idx;

  assert.strictEqual(input.holders.length, 18, 'the pool vault is left out');
  assert.strictEqual(input.stage, 'pumpswap');
  assert.strictEqual(input.reserveTokens, 300_000_000);
  assert.strictEqual(input.floatTokens, 700_000_000);
  assert.strictEqual(input.liquidityUsd, 90 * 150 * 2);
  assert.strictEqual(extra.dev, c.dev);
  assert.ok(Math.abs(input.slot0Share - 0.04) < 1e-9, 'the dev bought 4% in the launch slot');

  assert.strictEqual(H(I.recv).kind, 'transfer');
  [I.f1, I.f2, I.f3].forEach(i => assert.ok(H(i).virgin, 'fresh wallet'));
  assert.ok(!H(I.big).virgin);
  assert.ok(H(I.snip).sniper && !H(I.big).sniper);
  assert.ok(H(I.big).bundle && H(I.b2).bundle);
  assert.ok(H(I.seller).sold && !H(I.big).sold);
  assert.ok(H(I.devH).dev);

  const has = (a, b, kind) => input.links.some(l => ((l.a === at(c.H[a].w) && l.b === at(c.H[b].w)) || (l.b === at(c.H[a].w) && l.a === at(c.H[b].w))) && l.kind === kind);
  assert.ok(has(I.big, I.b2, 'same buy transaction'));
  assert.ok(has(I.big, I.recv, 'transfer between holders'));
  assert.ok(has(I.g1, I.g2, 'funded by one wallet'));
  assert.ok(has(I.f1, I.f2, 'fresh wallets that entered together') || has(I.f1, I.f3, 'fresh wallets that entered together'));

  /* the rules turn that into operators and a verdict */
  const op1 = verdict.operators[0];
  assert.deepStrictEqual(op1.wallets.map(i => input.holders[i].wallet).sort(), [c.H[I.big].w, c.H[I.b2].w, c.H[I.b3].w, c.H[I.recv].w].sort());
  assert.ok(verdict.operators.some(o => o.level === 'pack' && o.wallets.length === 3));
  assert.ok(Math.abs(verdict.metrics.transfer - 45 / 700) < 1e-9, 'received share of float');
  assert.strictEqual(verdict.band, 'DANGER');
  assert.strictEqual(verdict.guard.checks.find(x => x.k === 'slot0').ok, true);
  assert.ok(extra.ownerPowers.find(p => p.name === 'Mint authority').ok);
});

test('scanner: a busy funder (an exchange) is never a link', async () => {
  const c = chain();
  const funder = c.H[c.idx.g1].o.funder;
  const orig = c.rpc.call;
  c.rpc.call = async (m, p) => m === 'getSignaturesForAddress' && p[0] === funder ? Array.from({ length: 1000 }, () => ({ signature: sigOf(), slot: 1, err: null })) : orig(m, p);
  const { input } = await scan(c.rpc, c.mint, { solUsd: 150, offline: true });
  assert.ok(!input.links.some(l => l.kind === 'funded by one wallet'));
});

test('scanner: pools, curves and program accounts are not holders', () => {
  const pda = S.bondingCurve(wallet()), w = wallet();
  assert.strictEqual(infraLabel(w, { owner: S.P.SYSTEM }, {}), null);
  assert.strictEqual(infraLabel(w, { owner: S.P.PUMP_AMM }, {}), 'PumpSwap pool');
  assert.strictEqual(infraLabel(pda, null, {}), 'program account');
  assert.strictEqual(infraLabel(S.BURN, null, {}), 'burn address');
});

test('scanner: the HTTP client retries a rate limit and keeps to its budget', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      n++; if (n === 1) { res.writeHead(429); return res.end(); }
      const q = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: q.method === 'getSlot' ? 42 : null }));
    });
  });
  await new Promise(r => srv.listen(0, r));
  try {
    const rpc = client('http://127.0.0.1:' + srv.address().port, { budget: 2 });
    assert.strictEqual(await rpc.call('getSlot'), 42);
    assert.strictEqual(n, 2, 'one retry after the 429');
    await rpc.call('getSlot');
    await assert.rejects(rpc.call('getSlot'), e => e.budget === true);
  } finally { srv.close(); }
});
