'use strict';
/* The verdict as text, the way the site reads it. Used by rules/cli.js and scanner/cli.js. */
const { WEIGHTS } = require('./score');
const { pct } = require('./format');

const LABEL = { operator: 'Biggest operator', virgin: 'Fresh wallets', transfer: 'Received, not bought', sniper: 'Unsold snipers', concentration: 'Top-20 share' };

function report(input, r, title) {
  const out = [];
  out.push((title || input.name) + (input.symbol ? ' · $' + input.symbol : ''));
  out.push(r.headline);
  out.push('');
  if (r.score == null) out.push(r.band + ' · no score');
  else {
    out.push('score ' + r.score + ' / 100 · ' + r.band + (r.state === 'partial' ? ' · PARTIAL' : ''));
    Object.keys(WEIGHTS).forEach(k => out.push('  ' + LABEL[k].padEnd(22) + String(r.parts[k].toFixed(1)).padStart(5) + ' / ' + WEIGHTS[k]));
    (r.gates || []).forEach(g => out.push((g.note ? 'NOTE · ' : g.hard ? 'RED FLAG · ' : 'CAP · ') + g.text));
    if (r.scenario) out.push('SCENARIO · if the linked, fresh and transferred wallets sold their ' + pct(r.scenario.share) + ' of float into today\'s liquidity, the price would fall about ' + Math.round(r.scenario.drop * 100) + '%');
    const multi = r.operators.filter(o => o.wallets.length > 1);
    if (multi.length) out.push('operators · ' + multi.map(o => o.id + ' ' + o.wallets.length + (o.level === 'pack' ? ' fresh wallets (pack)' : ' wallets') + ' ' + pct(o.share)).join(' · '));
  }
  if (r.guard) {
    out.push('');
    out.push('Guard · ' + (r.guard.pass ? (r.guard.pending ? 'PASS so far' : 'PASS') : 'HELD · ' + r.guard.reason));
    r.guard.checks.forEach(c => out.push('  ' + (c.ok === true ? '✓' : c.ok === false ? '✕' : '…') + ' ' + c.name.padEnd(18) + c.text));
  }
  return out.join('\n');
}

module.exports = { report, LABEL };
