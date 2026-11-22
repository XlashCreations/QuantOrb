'use strict';
/* One scan of one token, from the chain to the verdict:
     1. the token and its top holders          scanner/token.js
     2. how each wallet got in, its history    scanner/wallets.js
     3. the links between wallets              scanner/wallets.js
     4–5. operators, score, flags, Guard       rules/ (unchanged)
   scan() returns the input the rules read (the same format as examples/) and the verdict. */
const { readToken, ownerPowers } = require('./token');
const W = require('./wallets');
const { scanVerdict } = require('../rules');

async function solUsd(opt) {
  if (opt.solUsd != null) return opt.solUsd;
  if (opt.offline) return null;
  try {
    const r = await fetch('https://lite-api.jup.ag/price/v3?ids=' + require('../chain/solana').WSOL, { signal: AbortSignal.timeout(5000) });
    const j = await r.json(), v = j && (j[require('../chain/solana').WSOL] || {}).usdPrice;
    return v > 0 ? v : null;
  } catch (e) { return null; }
}

async function scan(rpc, mint, opt) {
  opt = Object.assign({}, W.D, opt || {});
  const log = opt.log || (() => {});
  const started = Date.now();

  log('reading the token and its top holders');
  const t = await readToken(rpc, mint);
  const sol = await solUsd(opt);
  log(t.holders.length + ' holders outside the curve and pools · stage ' + t.stage);

  log('looking for the launch');
  const launch = await W.readLaunch(rpc, t, opt).catch(e => { if (e.budget) return { found: false }; throw e; });
  log(launch.found ? 'launch found · dev ' + launch.dev : 'launch is too far back to read · first-30-second buyers and the launch slot are not checked');

  log('reading how each wallet got in');
  await W.readHolders(rpc, t, launch, opt);

  log('looking for links between wallets');
  let links = [];
  try { links = await W.findLinks(rpc, t.holders, opt); } catch (e) { if (!e.budget) throw e; }

  let dev = null;
  try { dev = await W.devShare(rpc, t, launch.dev); } catch (e) { if (!e.budget) throw e; }

  const liquidityUsd = t.quoteSol != null && sol ? t.quoteSol * sol * 2 : null;
  const mcap = t.priceSol != null && sol ? t.priceSol * sol * t.m.supply : null;
  const ageDays = launch.found && launch.time ? (Date.now() - launch.time) / 864e5 : null;

  const input = {
    name: t.name || mint, symbol: t.symbol || undefined, mint, stage: t.stage === 'curve' ? 'curve' : t.stage,
    scannedAt: new Date().toISOString(),
    floatTokens: t.floatTokens, reserveTokens: t.reserveTokens, liquidityUsd,
    market: ageDays != null && mcap != null ? { ageDays, liquidityUsd, mcap, fdv: mcap } : undefined,
    holders: t.holders.map(h => ({ wallet: h.owner, share: h.share, kind: h.kind, virgin: h.virgin, sniper: h.sniper, bundle: h.bundle, sold: h.sold, dev: h.dev, unread: h.unread,
      txBefore: h.hist ? h.hist.before : null, entered: h.entry && h.entry.time ? new Date(h.entry.time).toISOString() : null })),
    links,
    creator: { unavailable: true },
    slot0Share: launch.found ? launch.slot0Share : undefined,
    devShare: dev == null ? undefined : dev,
    traded: true
  };
  const verdict = scanVerdict(input);
  return { input, verdict, extra: { ownerPowers: ownerPowers(t), dev: launch.dev || null, launch, solUsd: sol, mcap, priceSol: t.priceSol, infra: t.infra,
    calls: rpc.used ? rpc.used() : null, seconds: Math.round((Date.now() - started) / 100) / 10 } };
}

module.exports = { scan };
