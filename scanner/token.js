'use strict';
/* Step 1 of a scan: the token itself and the top holders.
   Reads the mint (supply, owner powers), the pump.fun curve or the PumpSwap pool, and the 20 largest token
   accounts; leaves out the curve, pools, lockers and burn addresses so a pool never looks like a whale. */
const S = require('../chain/solana');
const { onCurve, b58decode } = require('../chain/util');

const b64 = v => v && v.data && Array.isArray(v.data) ? Buffer.from(v.data[0], 'base64') : null;

async function accounts(rpc, keys, encoding) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc.call('getMultipleAccounts', [keys.slice(i, i + 100), { encoding: encoding || 'base64' }]);
    out.push(...(r && r.value || []));
  }
  return out;
}

/* why an owner of token accounts is not a holder (null: it is a holder) */
function infraLabel(owner, ownerAcct, known) {
  if (known[owner]) return known[owner];
  if (S.INFRA_ADDR[owner]) return S.INFRA_ADDR[owner];
  if (ownerAcct && S.INFRA_PROGRAMS[ownerAcct.owner]) return S.INFRA_PROGRAMS[ownerAcct.owner];
  let pda = false; try { pda = !onCurve(b58decode(owner)); } catch (e) { /* not an address */ }
  /* an address off the ed25519 curve has no private key: it belongs to a program (a pool, a vault, a lock) */
  if (pda) return 'program account';
  if (ownerAcct && ownerAcct.owner !== S.P.SYSTEM && ownerAcct.executable) return 'program';
  return null;
}

async function readToken(rpc, mint) {
  const [mintInfo] = await accounts(rpc, [mint], 'jsonParsed');
  const m = S.parseMint(mintInfo);
  if (!m) throw new Error(mint + ' is not a token mint');
  const bcAddr = S.bondingCurve(mint), poolAddr = S.pumpSwapPool(mint);
  const [bcAcct, poolAcct, mdAcct] = await accounts(rpc, [bcAddr, poolAddr, S.metadataPda(mint)]);
  const curve = S.decodeCurve(b64(bcAcct)), pool = S.decodePumpSwap(b64(poolAcct)), md = S.decodeMetaplex(b64(mdAcct)) || null;

  /* SOL in the pool (for liquidity) and tokens in it (for the sell scenario) */
  let stage = 'unknown', reserveTokens = null, quoteSol = null, priceSol = null;
  if (curve && !curve.complete) {
    stage = 'curve'; reserveTokens = curve.vTokens; quoteSol = curve.quoteMint ? null : curve.realSol;
    priceSol = curve.quoteMint ? null : curve.vSol / curve.vTokens;
  } else if (pool && pool.baseMint === mint) {
    stage = 'pumpswap';
    const [bv, qv] = await Promise.all([pool.baseVault, pool.quoteVault].map(a => rpc.call('getTokenAccountBalance', [a]).catch(() => null)));
    if (bv && bv.value) reserveTokens = +bv.value.uiAmountString;
    if (qv && qv.value && pool.quoteMint === S.WSOL) quoteSol = +qv.value.uiAmountString;
    if (reserveTokens && quoteSol) priceSol = quoteSol / reserveTokens;
  }

  const largest = await rpc.call('getTokenLargestAccounts', [mint]);
  const list = (largest && largest.value || []).filter(a => +a.amount > 0);
  const tokenAccts = await accounts(rpc, list.map(a => a.address), 'jsonParsed');
  const owners = tokenAccts.map(t => t && t.data && t.data.parsed ? t.data.parsed.info.owner : null);
  const uniq = [...new Set(owners.filter(Boolean))];
  const ownerAccts = await accounts(rpc, uniq);
  const ownerAcct = {}; uniq.forEach((o, i) => { ownerAcct[o] = ownerAccts[i]; });
  const known = { [bcAddr]: 'bonding curve', [poolAddr]: 'PumpSwap pool' };

  const infra = [], byOwner = {};
  list.forEach((a, i) => {
    const owner = owners[i]; if (!owner) return;
    const amount = +a.uiAmountString;
    const label = infraLabel(owner, ownerAcct[owner], known);
    if (label) { infra.push({ owner, account: a.address, amount, label }); return; }
    const h = byOwner[owner] = byOwner[owner] || { owner, accounts: [], amount: 0 };
    h.accounts.push(a.address); h.amount += amount;
  });

  /* the real float: supply outside the curve, pools, lockers and burn addresses */
  const infraTokens = infra.reduce((s, x) => s + x.amount, 0);
  const floatTokens = Math.max(1, m.supply - infraTokens);
  if (reserveTokens == null) {                     /* another DEX: the biggest pool account sets the price */
    const p = infra.filter(x => /pool|vault|program/.test(x.label)).sort((a, b) => b.amount - a.amount)[0];
    if (p) { reserveTokens = p.amount; stage = p.label; }
  }
  const holders = Object.values(byOwner).sort((a, b) => b.amount - a.amount).slice(0, 20)
    .map(h => Object.assign(h, { share: h.amount / floatTokens }));

  return { mint, m, md, curve, pool, bondingCurve: bcAddr, poolAddress: poolAddr, stage, reserveTokens, quoteSol, priceSol,
    floatTokens, infra, holders, name: (md && md.name) || (m.md && m.md.name) || null, symbol: (md && md.symbol) || (m.md && m.md.symbol) || null };
}

/* what the owner can still change */
function ownerPowers(t) {
  const mutable = t.md ? t.md.mutable : t.m.md ? !!t.m.md.updateAuthority : null;
  return [
    { name: 'Mint authority', ok: !t.m.mintAuthority, text: t.m.mintAuthority ? 'can still create new tokens · ' + t.m.mintAuthority : 'revoked: no new tokens can be made' },
    { name: 'Freeze authority', ok: !t.m.freezeAuthority, text: t.m.freezeAuthority ? 'can freeze any wallet · ' + t.m.freezeAuthority : 'revoked: nobody can freeze your tokens' },
    { name: 'Metadata', ok: mutable === false ? true : mutable ? false : null, text: mutable == null ? 'not read' : mutable ? 'can still be changed (name, logo, links)' : 'locked' },
    { name: 'Transfer fee', ok: !t.m.transferFeeBps, text: t.m.transferFeeBps ? (t.m.transferFeeBps / 100) + '% on every transfer (Token-2022)' : 'none' }
  ];
}

module.exports = { readToken, ownerPowers, infraLabel, accounts };
