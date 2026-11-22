'use strict';
/* Steps 2 and 3 of a scan: how each top wallet got in, its history before this token, and the links
   between wallets. Everything is read from public chain data under the RPC client's call budget; a wallet
   that could not be read is marked unread and never counted as evidence. */
const S = require('../chain/solana');
const cfg = require('../rules/limits');

const D = {
  sigPages: 3,           /* pages of 1,000 signatures read per token account to find the entry */
  walletPages: 2,        /* pages read per wallet to count its history before this token */
  launchPages: 25,       /* pages read on the mint to find the launch */
  freshMaxTx: 4,         /* a wallet with this many transactions or fewer before its entry is fresh */
  sniperSeconds: 30,     /* bought in the first 30 seconds: a sniper (docs/scoring.md) */
  packSlots: 10,         /* fresh wallets that entered within 10 slots of each other move as a pack */
  busySigs: 1000,        /* a funder or sender with a full page of signatures is busy (an exchange, a router): never a link */
  recentTx: 5            /* newest transactions read per holder to see whether it sold */
};

const TXO = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
const getTx = (rpc, sig) => rpc.call('getTransaction', [sig, TXO]).catch(e => { if (e.budget) throw e; return null; });

/* every signature of an address, newest first, up to `pages` pages; done = the oldest one was reached */
async function signatures(rpc, address, pages) {
  const out = []; let before;
  for (let p = 0; p < pages; p++) {
    const page = await rpc.call('getSignaturesForAddress', [address, Object.assign({ limit: 1000 }, before ? { before } : {})]);
    const ok = (page || []).filter(s => !s.err);
    out.push(...ok);
    if (!page || page.length < 1000) return { list: out, done: true };
    before = page[page.length - 1].signature;
  }
  return { list: out, done: false };
}

/* the launch: when, who signed it, and how much was bought in its slot */
async function readLaunch(rpc, t, opt) {
  const sig = await signatures(rpc, t.mint, opt.launchPages);
  if (!sig.done || !sig.list.length) return { found: false, dev: t.curve && t.curve.creator || (t.pool && t.pool.creator) || null };
  const first = sig.list[sig.list.length - 1];
  const raw = await getTx(rpc, first.signature);
  const dev = S.createSigner(raw, t.mint, t.bondingCurve) || (raw ? S.readTx(raw, t.mint).feePayer : null) || (t.curve && t.curve.creator);
  /* the launch slot: every buy in the same slot as the create */
  const slot0 = sig.list.filter(s => s.slot === first.slot).slice(0, 40);
  let bought = 0;
  for (const s of slot0) {
    const tx = s.signature === first.signature ? (raw && S.readTx(raw, t.mint)) : S.readTx(await getTx(rpc, s.signature), t.mint);
    if (!tx) continue;
    Object.keys(tx.delta).forEach(o => { if (tx.delta[o] > 0 && o !== t.bondingCurve) bought += tx.delta[o]; });
  }
  return { found: true, dev, slot: first.slot, time: (first.blockTime || 0) * 1000, slot0Share: bought / t.m.supply, signature: first.signature };
}

/* how one wallet got in: the first transaction that raised its balance */
async function readEntry(rpc, t, h, opt) {
  const acct = h.accounts[0];
  const sig = await signatures(rpc, acct, opt.sigPages);
  if (!sig.done || !sig.list.length) return null;
  const oldest = sig.list.slice(-3).reverse();
  for (const s of oldest) {
    const tx = S.readTx(await getTx(rpc, s.signature), t.mint);
    if (!tx || !(tx.delta[h.owner] > 0)) continue;
    const gainers = Object.keys(tx.delta).filter(o => tx.delta[o] > 0 && o !== t.bondingCurve && o !== t.poolAddress);
    const senders = Object.keys(tx.delta).filter(o => tx.delta[o] < 0 && o !== h.owner);
    /* did it sell since: a swap among its newest transactions that lowered its balance */
    let sold = false;
    for (const r of sig.list.slice(0, opt.recentTx)) {
      if (r.signature === s.signature) continue;
      const x = S.readTx(await getTx(rpc, r.signature), t.mint);
      if (x && x.swap && x.delta[h.owner] < 0) { sold = true; break; }
    }
    return { sig: s.signature, slot: tx.slot || s.slot, time: tx.time || (s.blockTime || 0) * 1000, kind: tx.swap ? 'buy' : 'transfer',
      from: tx.swap ? null : senders.sort((a, b) => tx.delta[a] - tx.delta[b])[0] || null, together: gainers.filter(o => o !== h.owner), sold };
  }
  return null;
}

/* the wallet before this token: how many transactions, and who funded it with its first SOL */
async function readHistory(rpc, t, h, entrySlot, opt) {
  const sig = await signatures(rpc, h.owner, opt.walletPages);
  const before = sig.list.filter(s => s.slot < entrySlot).length;
  const reachedEntry = sig.done || sig.list.some(s => s.slot < entrySlot);
  if (!reachedEntry) return { before: null, virgin: false, funder: null };
  let funder = null;
  if (sig.done && sig.list.length) {
    const tx = S.readTx(await getTx(rpc, sig.list[sig.list.length - 1].signature), t.mint);
    if (tx) {
      const paid = Object.keys(tx.sol).filter(k => k !== h.owner && tx.sol[k] < 0 && tx.sol[h.owner] > 0).sort((a, b) => tx.sol[a] - tx.sol[b]);
      funder = paid[0] || (tx.feePayer !== h.owner ? tx.feePayer : null);
    }
  }
  return { before, virgin: sig.done && before <= opt.freshMaxTx, funder, more: !sig.done };
}

/* is an address busy (an exchange, a router, a bot)? a full page of signatures says so */
async function busy(rpc, address, cache) {
  if (cache[address] != null) return cache[address];
  const page = await rpc.call('getSignaturesForAddress', [address, { limit: D.busySigs }]).catch(e => { if (e.budget) throw e; return []; });
  return (cache[address] = (page || []).length >= D.busySigs);
}

/* the links between holders, by position: proven ones merge wallets, a pack is behaviour */
async function findLinks(rpc, hs, opt) {
  const links = [], seen = new Set(), cache = {};
  const add = (a, b, kind, level) => { if (a === b) return; const k = Math.min(a, b) + ':' + Math.max(a, b) + ':' + level; if (seen.has(k)) return; seen.add(k); links.push({ a, b, kind, level }); };
  const at = {}; hs.forEach((h, i) => { at[h.owner] = i; });
  /* the same buy transaction, and transfers straight between holders */
  hs.forEach((h, i) => {
    if (!h.entry) return;
    h.entry.together.forEach(o => { if (at[o] != null) add(i, at[o], 'same buy transaction', 'proven'); });
    if (h.entry.from && at[h.entry.from] != null) add(i, at[h.entry.from], 'transfer between holders', 'proven');
  });
  /* tokens from one source, or first SOL from one funder (never an exchange or a busy address) */
  for (const key of ['from', 'funder']) {
    const groups = {};
    hs.forEach((h, i) => { const v = key === 'from' ? h.entry && h.entry.from : h.hist && h.hist.funder; if (v && at[v] == null) (groups[v] = groups[v] || []).push(i); });
    for (const src of Object.keys(groups)) {
      const g = groups[src]; if (g.length < 2) continue;
      if (await busy(rpc, src, cache)) continue;
      for (let j = 1; j < g.length; j++) add(g[0], g[j], key === 'from' ? 'tokens from one source' : 'funded by one wallet', 'proven');
    }
  }
  /* packs: 3 or more fresh wallets that entered within a few slots of each other */
  const fresh = hs.map((h, i) => ({ h, i })).filter(x => x.h.virgin && x.h.entry).sort((a, b) => a.h.entry.slot - b.h.entry.slot);
  for (let s = 0; s < fresh.length;) {
    let e = s; while (e + 1 < fresh.length && fresh[e + 1].h.entry.slot - fresh[s].h.entry.slot <= opt.packSlots) e++;
    if (e - s + 1 >= 3) for (let j = s + 1; j <= e; j++) add(fresh[s].i, fresh[j].i, 'fresh wallets that entered together', 'pack');
    s = e + 1;
  }
  return links;
}

/* every holder: entry, history, and the flags the rules read */
async function readHolders(rpc, t, launch, opt) {
  const hs = t.holders;
  await Promise.all(hs.map(async h => {
    if (h.share < cfg.scan.deepMinShare) return;
    try {
      h.entry = await readEntry(rpc, t, h, opt);
      if (h.entry) h.hist = await readHistory(rpc, t, h, h.entry.slot, opt);
    } catch (e) { if (!e.budget) h.error = e.message; }
  }));
  hs.forEach(h => {
    const deep = h.share >= cfg.scan.deepMinShare;
    h.unread = deep && !h.entry;
    h.kind = h.entry ? h.entry.kind : 'buy';
    h.virgin = !!(h.hist && h.hist.virgin);
    h.sold = !!(h.entry && h.entry.sold);
    h.dev = !!(launch.dev && h.owner === launch.dev);
    h.sniper = !!(launch.found && h.entry && h.entry.kind === 'buy' && h.entry.time && launch.time && h.entry.time - launch.time <= opt.sniperSeconds * 1000);
    h.bundle = !!(h.entry && h.entry.kind === 'buy' && h.entry.together.length > 0);
  });
  return hs;
}

/* the dev's balance now, as a share of supply */
async function devShare(rpc, t, dev) {
  if (!dev) return null;
  const inTop = t.holders.find(h => h.owner === dev);
  if (inTop) return inTop.amount / t.m.supply;
  const r = await rpc.call('getTokenAccountsByOwner', [dev, { mint: t.mint }, { encoding: 'jsonParsed' }]).catch(e => { if (e.budget) throw e; return null; });
  if (!r || !r.value) return null;
  return r.value.reduce((s, a) => s + +a.account.data.parsed.info.tokenAmount.uiAmountString, 0) / t.m.supply;
}

module.exports = { D, signatures, readLaunch, readEntry, readHistory, findLinks, readHolders, devShare };
