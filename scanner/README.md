# scanner/

Scan any Solana token from your own computer. The scanner reads the chain, finds the top holders, how each
one got in and which wallets belong together, then hands that to the open rules in [`rules/`](../rules)
for the score, the red flags and Guard. It fills in the part the upstream repository left closed.

No dependencies: Node 18 or newer is all it needs.

## 1. Get a free Solana RPC address

The scanner talks to Solana through an RPC address. The public one (`api.mainnet-beta.solana.com`) blocks
the heavier calls, so use a free key:

1. Sign up at [helius.dev](https://www.helius.dev) (the free plan is enough).
2. Copy your **mainnet RPC URL**. It looks like `https://mainnet.helius-rpc.com/?api-key=...`.

Any Solana RPC works (QuickNode, Alchemy, Triton…). Keep the key to yourself: never commit it.

## 2. Run a scan

```bash
git clone https://github.com/XlashCreations/quantorb && cd quantorb
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"     # Windows PowerShell: $env:SOLANA_RPC_URL="..."
npm run scan -- <token address>
```

The token address is the contract address (CA) you see in your trading app, for example the long code that
ends in `pump` on pump.fun coins.

| Option | |
|---|---|
| `--rpc <url>` | The RPC address, instead of `SOLANA_RPC_URL` |
| `--save` | Also save the scan input to `scans/`, so `node rules/cli.js scans/<file>.json` can show it again without the network |
| `--json` | Print everything as JSON |
| `--budget <n>` | The most RPC calls one scan may make (default 1,500; a scan usually takes 100 to 600) |
| `--sol-usd <price>` | The SOL price in dollars, if the scanner cannot fetch it (it is used for liquidity and market cap) |

## What it prints

```
18 wallets → 12 operators, biggest holds 33.6% of float, could move price −69% if sold

score 39 / 100 · DANGER
RED FLAG · biggest operator could move price −69% if sold (33.6% of float, 4 linked wallets)
CAP · pack of 3 wallets holds 12.0% of float
...
Guard · PASS so far
Owner powers · mint and freeze authority, metadata, transfer fee
Top holders · each wallet's share, its operator, and tags: DEV, received, fresh, sniper, bundle, sold some
Links found · which wallets were linked, and why
```

(This sample is from the made-up chain in [`test/fake-chain.js`](../test/fake-chain.js).)

**How to read it, in plain words.** The score goes from 0 (worst) to 100 (best). CLEAN is 80 or more, OK
is 60 or more, RISKY is 40 or more, and DANGER is below that. A RED FLAG forces DANGER whatever the score.
An *operator* is a group of wallets that the chain shows belong together, so 20 wallets may really be
4 people. The SCENARIO says how far the price would fall if the suspicious wallets sold at once.

## How it reads the chain

| Step | File | What it reads |
|---|---|---|
| Token | [`token.js`](token.js) | The mint (supply, mint and freeze authority, Token-2022 fees), the Metaplex metadata, the pump.fun curve or the PumpSwap pool, and the 20 largest token accounts. Curves, pools, lockers, burn addresses and any program-owned account are left out of the float |
| Launch | [`wallets.js`](wallets.js) | The mint's oldest transaction: who signed the create (the dev), when, and how much was bought in that same slot |
| Each wallet | [`wallets.js`](wallets.js) | The first transaction that gave it tokens (a swap is a buy; anything else is a transfer), whether it sold since, how many transactions it made before this token, and who sent its first SOL |
| Links | [`wallets.js`](wallets.js) | Wallets in the same buy transaction, transfers between holders, tokens from one source, first SOL from one funder (proven); 3 or more fresh wallets that entered within 10 slots (a pack). A source or funder with 1,000+ transactions is treated as an exchange or a router and never counts as a link |
| Verdict | [`../rules/`](../rules) | Operators, the score, flags, caps, the sell scenario and Guard, unchanged |

These are the scanner's own rules for reading the chain, written for this fork. They follow the steps in
[`docs/architecture.md`](../docs/architecture.md) but are not quantumorb.app's closed code, so a score here
can differ from the site's.

## Limits

- **Fresh wallets** are judged by how many transactions a wallet made before it bought (4 or fewer), not by
  how many tokens it traded.
- **Snipers and the launch slot** need the token's first transaction. For a big, busy token that is more
  than 25,000 transactions back, so the scanner says so and leaves those checks out.
- **Creator history** (how many tokens the dev launched before) is not read yet. Guard shows it as not available.
- A wallet the scanner could not read in time is marked *not read* and never counts as evidence; 3 or more
  cap the verdict at RISKY.
- It only reads public data. It never asks for a private key or a seed phrase, and it never trades.
- Nothing here is financial advice. A CLEAN score is not a promise.

## Tests

`npm test` runs the scanner end to end on a made-up chain ([`test/fake-chain.js`](../test/fake-chain.js)):
a token with a bundle buy, a transfer between holders, a pack of fresh wallets, two wallets with one
funder, a sniper, the dev and a seller. The test checks that every one of them is found and that the rules
turn them into the right operators and verdict.
