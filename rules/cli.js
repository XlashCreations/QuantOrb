#!/usr/bin/env node
'use strict';
/* Prints the verdict for a scan input, the way the site reads it.
   usage: node rules/cli.js examples/site-example.json [--json] */
const fs = require('fs');
const path = require('path');
const { scanVerdict } = require('./index');
const { report } = require('./report');

const args = process.argv.slice(2), file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: node rules/cli.js <scan.json> [--json]'); process.exit(2); }
const input = JSON.parse(fs.readFileSync(file, 'utf8'));
const r = scanVerdict(input);
if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
console.log(report(input, r, input.name || path.basename(file)));
