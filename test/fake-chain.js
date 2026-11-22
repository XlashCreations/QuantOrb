'use strict';
/* A made-up chain for the scanner's tests: a fake RPC that answers the calls a real one would, for a graduated
   token whose holders hide every pattern the scanner looks for (a bundle, a transfer, a pack of fresh wallets,
   one funder, a sniper, the dev, a seller). */
const crypto = require('crypto');
const S = require('../chain/solana');
const { b58encode } = require('../chain/util');

/* a real wallet address (on the ed25519 curve), like a keypair's public key */
const wallet = () => b58encode(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
const sigOf = () => b58encode(crypto.randomBytes(64));

function chain() {
  const mint = wallet(), dev = wallet();
  const bc = S.bondingCurve(mint), poolAddr = S.pumpSwapPool(mint);
  const baseVault = wallet(), quoteVault = wallet();
  const T0 = 1_760_000_000, SLOT0 = 1000;
  const acct = {}, sigs = {}, txs = {}, balances = {};
  const addSig = (addr, s, slot, time) => { (sigs[addr] = sigs[addr] || []).push({ signature: s, slot, blockTime: time, err: null }); };

  /* the mint, the curve (graduated) and the PumpSwap pool */
  acct[mint] = { owner: S.P.TOKEN, data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } };
  const cb = Buffer.alloc(150); cb.writeBigUInt64LE(0n, 8); cb[48] = 1; Buffer.from(require('../chain/util').b58decode(dev)).copy(cb, 49);
  acct[bc] = { owner: S.P.PUMP, data: [cb.toString('base64'), 'base64'] };
  const pb = Buffer.alloc(260); const put = (k, o) => Buffer.from(require('../chain/util').b58decode(k)).copy(pb, o);
  put(dev, 11); put(mint, 43); put(S.WSOL, 75); put(wallet(), 107); put(baseVault, 139); put(quoteVault, 171);
  acct[poolAddr] = { owner: S.P.PUMP_AMM, data: [pb.toString('base64'), 'base64'] };
  balances[baseVault] = 300_000_000; balances[quoteVault] = 90;

  /* transactions */
  function tx({ slot, time, payer, signers, swap, delta, sol, ix }) {
    const s = sigOf(); const keys = [payer, ...Object.keys(sol || {}).filter(k => k !== payer)];
    const tokenBal = (pre) => Object.keys(delta || {}).map(o => ({ owner: o, mint, uiTokenAmount: { amount: String(Math.round((pre ? (delta[o] < 0 ? -delta[o] : 0) : (delta[o] > 0 ? delta[o] : 0)) * 1e6)), decimals: 6 } }));
    txs[s] = { slot, blockTime: time, version: 0,
      transaction: { signatures: [s], message: { accountKeys: keys.map(k => ({ pubkey: k, signer: k === payer || (signers || []).includes(k) })),
        instructions: ix || [{ programId: swap ? S.P.PUMP_AMM : S.P.TOKEN }] } },
      meta: { err: null, preBalances: keys.map(k => 10e9), postBalances: keys.map(k => 10e9 + Math.round(((sol || {})[k] || 0) * 1e9)),
        preTokenBalances: tokenBal(true), postTokenBalances: tokenBal(false), innerInstructions: [], logMessages: [] } };
    return s;
  }

  /* the launch: the dev creates the token and buys 4% in the same slot */
  const create = tx({ slot: SLOT0, time: T0, payer: dev, signers: [mint], delta: { [dev]: 40_000_000, [bc]: -40_000_000 }, ix: [{ programId: S.P.PUMP, accounts: [mint, bc, dev] }] });
  addSig(mint, create, SLOT0, T0);

  const H = [];
  function holder(amount, o) {
    o = o || {}; const w = o.w || wallet(), ta = wallet();
    acct[ta] = { owner: S.P.TOKEN, data: { parsed: { type: 'account', info: { owner: w, mint } } } };
    acct[w] = acct[w] || { owner: S.P.SYSTEM, data: ['', 'base64'] };
    H.push({ w, ta, amount, o }); return H.length - 1;
  }
  const big = holder(80_000_000), b2 = holder(60_000_000), b3 = holder(50_000_000);           /* one bundle buy */
  const recv = holder(45_000_000);                                                            /* received from #1 */
  const f1 = holder(30_000_000, { fresh: true }), f2 = holder(28_000_000, { fresh: true }), f3 = holder(26_000_000, { fresh: true });  /* a pack */
  const funder = wallet();
  const g1 = holder(24_000_000, { funder }), g2 = holder(22_000_000, { funder });             /* one funder */
  const devH = holder(40_000_000, { w: dev });                                                /* the dev */
  const snip = holder(20_000_000, { sniper: true });                                          /* bought in the first 10 s */
  const seller = holder(18_000_000, { sold: true });
  for (let i = 0; i < 6; i++) holder(15_000_000 - i * 1_000_000);

  let slot = SLOT0 + 200;
  const entry = (i, s, sl, t) => { addSig(H[i].ta, s, sl, t); addSig(H[i].w, s, sl, t); addSig(mint, s, sl, t); H[i].slot = sl; };
  /* bundle: one transaction, three receivers */
  { const sl = slot += 5, t = T0 + 300; const s = tx({ slot: sl, time: t, payer: H[big].w, swap: true, delta: { [H[big].w]: 80e6, [H[b2].w]: 60e6, [H[b3].w]: 50e6, [poolAddr]: -190e6 } });
    [big, b2, b3].forEach(i => entry(i, s, sl, t)); }
  /* the transfer from #1 to #4 */
  { const sl = slot += 5, t = T0 + 400; const s = tx({ slot: sl, time: t, payer: H[big].w, delta: { [H[recv].w]: 45e6, [H[big].w]: -45e6 } }); entry(recv, s, sl, t); }
  /* the pack: three fresh wallets within 3 slots */
  [f1, f2, f3].forEach((i, k) => { const sl = slot + 1 + k, t = T0 + 500 + k; entry(i, tx({ slot: sl, time: t, payer: H[i].w, swap: true, delta: { [H[i].w]: H[i].amount, [poolAddr]: -H[i].amount } }), sl, t); });
  slot += 50;
  /* everyone else */
  [g1, g2, seller, ...H.map((_, i) => i).slice(12)].forEach(i => { const sl = slot += 20, t = T0 + 600 + sl - SLOT0; entry(i, tx({ slot: sl, time: t, payer: H[i].w, swap: true, delta: { [H[i].w]: H[i].amount, [poolAddr]: -H[i].amount } }), sl, t); });
  { const sl = SLOT0 + 3, t = T0 + 10; entry(snip, tx({ slot: sl, time: t, payer: H[snip].w, swap: true, delta: { [H[snip].w]: 20e6, [bc]: -20e6 } }), sl, t); }
  addSig(H[devH].ta, create, SLOT0, T0); addSig(dev, create, SLOT0, T0); H[devH].slot = SLOT0;
  /* the seller sold part of its bag later */
  { const sl = slot += 100, t = T0 + 9000; const s = tx({ slot: sl, time: t, payer: H[seller].w, swap: true, delta: { [H[seller].w]: -2e6, [poolAddr]: 2e6 } }); addSig(H[seller].ta, s, sl, t); addSig(H[seller].w, s, sl, t); }

  /* history before the token: fresh wallets were only funded; the rest traded for a while */
  H.forEach((h, i) => {
    const from = h.o.funder || wallet();
    const n = h.o.fresh ? 0 : 12;
    for (let k = 0; k < n; k++) addSig(h.w, sigOf(), h.slot - 500 + k, T0 - 1000 + k);
    const fs = tx({ slot: h.slot - 600, time: T0 - 2000, payer: from, sol: { [from]: -1, [h.w]: 1 } });
    addSig(h.w, fs, h.slot - 600, T0 - 2000);
  });
  addSig(funder, sigOf(), 10, T0 - 5000);

  /* largest accounts: the pool vault and the 19 holders */
  const largest = [{ address: baseVault, amount: String(300_000_000e6), uiAmountString: '300000000' }, ...H.map(h => ({ address: h.ta, amount: String(h.amount * 1e6), uiAmountString: String(h.amount) }))];
  acct[baseVault] = { owner: S.P.TOKEN, data: { parsed: { type: 'account', info: { owner: poolAddr, mint } } } };

  Object.keys(sigs).forEach(k => sigs[k].sort((a, b) => b.slot - a.slot));
  let calls = 0;
  async function call(method, params) {
    calls++;
    switch (method) {
      case 'getMultipleAccounts': return { value: params[0].map(k => acct[k] || null) };
      case 'getTokenLargestAccounts': return { value: largest.slice(0, 20) };
      case 'getTokenAccountBalance': return { value: { uiAmountString: String(balances[params[0]]) } };
      case 'getSignaturesForAddress': {
        const l = sigs[params[0]] || [], o = params[1] || {}; let i = 0;
        if (o.before) i = l.findIndex(s => s.signature === o.before) + 1;
        return l.slice(i, i + (o.limit || 1000));
      }
      case 'getTransaction': return txs[params[0]] || null;
      case 'getTokenAccountsByOwner': return { value: [] };
      default: throw new Error('unexpected ' + method);
    }
  }
  return { rpc: { call, used: () => calls }, mint, dev, H, idx: { big, b2, b3, recv, f1, f2, f3, g1, g2, devH, snip, seller } };
}

module.exports = { chain, wallet, sigOf };
