#!/usr/bin/env node
'use strict';
/* Scan any pump.fun / Solana token from the command line.
   usage: node scanner/cli.js <mint address> [--rpc <url>] [--json] [--save] [--budget <calls>] [--sol-usd <price>]
   The RPC address can also come from the SOLANA_RPC_URL environment variable (a free Helius key works). */
const fs = require('fs');
const path = require('path');
const { client } = require('./rpc');
const { scan } = require('./index');
const { report } = require('../rules/report');
const { isAddress, short, usd, pct } = require('../chain/util');

const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const val = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const mint = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && /^--(rpc|budget|sol-usd)$/.test(argv[i - 1])));

if (!mint || flag('help')) {
  console.error('usage: node scanner/cli.js <mint address> [--rpc <url>] [--json] [--save] [--budget <calls>] [--sol-usd <price>]\n' +
    '       or set SOLANA_RPC_URL instead of --rpc');
  process.exit(2);
}
if (!isAddress(mint)) { console.error(mint + ' does not look like a Solana address'); process.exit(2); }
const url = val('rpc') || process.env.SOLANA_RPC_URL;
if (!url) { console.error('no RPC address: pass --rpc <url> or set SOLANA_RPC_URL (a free key from helius.dev works)'); process.exit(2); }

(async () => {
  const rpc = client(url, { budget: +val('budget') || 1500 });
  const quiet = flag('json');
  const res = await scan(rpc, mint, { solUsd: val('sol-usd') != null ? +val('sol-usd') : undefined, log: quiet ? null : m => process.stderr.write('· ' + m + '\n') });

  if (flag('save')) {
    const dir = path.join(__dirname, '..', 'scans'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, mint + '-' + res.input.scannedAt.slice(0, 10) + '.json');
    fs.writeFileSync(file, JSON.stringify(res.input, null, 2));
    if (!quiet) process.stderr.write('· saved the scan input to ' + path.relative(process.cwd(), file) + ' (re-run it with: node rules/cli.js ' + path.relative(process.cwd(), file) + ')\n');
  }
  if (quiet) { console.log(JSON.stringify(res, null, 2)); return; }

  const x = res.extra, out = [];
  out.push('');
  out.push(report(res.input, res.verdict, res.input.name));
  out.push('');
  out.push('Market · ' + [res.input.stage === 'curve' ? 'still on the pump.fun curve' : 'trading on ' + res.input.stage,
    'market cap ' + usd(x.mcap), 'liquidity ' + usd(res.input.liquidityUsd)].join(' · ') + (x.solUsd ? '' : '  (no SOL price: pass --sol-usd)'));
  out.push('');
  out.push('Owner powers');
  x.ownerPowers.forEach(p => out.push('  ' + (p.ok === true ? '✓' : p.ok === false ? '✕' : '…') + ' ' + p.name.padEnd(18) + p.text));
  out.push('');
  out.push('Top holders (share of float)');
  res.input.holders.forEach((h, i) => {
    const tags = [h.dev && 'DEV', h.kind === 'transfer' && 'received', h.virgin && 'fresh', h.sniper && !h.dev && 'sniper', h.bundle && 'bundle', h.sold && 'sold some', h.unread && 'not read'].filter(Boolean);
    const op = res.verdict.holders && res.verdict.holders[i] && res.verdict.holders[i].op;
    out.push('  ' + String(i + 1).padStart(2) + '. ' + short(h.wallet) + '  ' + pct(h.share).padStart(6) + (op ? '  ' + op : '') + (tags.length ? '  ' + tags.join(', ') : ''));
  });
  if (res.input.links.length) {
    out.push('');
    out.push('Links found');
    res.input.links.forEach(l => out.push('  #' + (l.a + 1) + ' ↔ #' + (l.b + 1) + '  ' + l.kind + (l.level === 'pack' ? ' (pack)' : '')));
  }
  out.push('');
  out.push(x.calls + ' RPC calls · ' + x.seconds + ' s · public chain data only · not financial advice');
  console.log(out.join('\n'));
})().catch(e => { console.error('scan failed: ' + e.message); process.exit(1); });
