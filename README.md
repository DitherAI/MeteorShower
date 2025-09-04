# Meteor Shower — Meteora DLMM Liquidity Bot (Portfolio branch)

Automates DLMM liquidity management on Solana. Adds **multi‑pool portfolio management** with target weights, sleeve‑level recenters, and cross‑sleeve rebalancing.

> **Disclaimers**
>
> **No financial advice.** Use at your own risk.
> **Risk of loss.** Impermanent loss, volatility, contract risk, and total loss are possible.
> **Open‑source, no warranty.** Review code before use.
> **No performance guarantees.** Past results are irrelevant.

---

## What’s new in this branch

* **Portfolio mode**: manage many DLMM pools as “sleeves” with target weights.
* **Recenter + Rebalance loop**:

  * Per‑sleeve OOR detection with optional **edge buffer bins**.
  * Cross‑sleeve USD reallocation; then optional **wallet supplement** if underweight remains.
* **Consistent swap controls**: slippage in bps, price‑impact guard, priority fees.
* **Fee buffer discipline**: reserves SOL per open position; auto **top‑up** via Jupiter and **unwraps WSOL**.
* **Defensive execution**: retry helpers, SDK fallbacks, error‑code handling (e.g., 6068/6054).

---

## Getting the code

### Git (recommended)

```bash
git clone https://github.com/TheMattness/MeteorShower.git
cd MeteorShower
git checkout portfolio
```

### ZIP

On GitHub, switch to the `portfolio` branch, then **Code → Download ZIP**. Unzip and `cd` into the folder.

---

## Requirements

* **Node.js 20+** (JSON import attributes and fetch behavior assumed)
* A Solana wallet with funds and tokens for the target pools

```bash
node -v   # must be 20.x or newer
npm -v
```

---

## Install

```bash
npm install
```

> The project uses `package.json` (not “packages.json”).

---

## Configure

### Option A — Interactive generator

1. Create a baseline template file:

```bash
cat > .env.example <<'EOF'
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PATH=./id.json
LOG_LEVEL=info
MODE=single
POOL_ADDRESS=
TOTAL_BINS_SPAN=20
LOWER_COEF=0.5
LIQUIDITY_STRATEGY_TYPE=Spot
PRIORITY_FEE_MICRO_LAMPORTS=50000
SOL_FEE_BUFFER_LAMPORTS=70000000
PRICE_IMPACT=0.5
SLIPPAGE=10
MONITOR_INTERVAL_SECONDS=60
EDGE_BUFFER_BINS=0
MANUAL=true
DITHER_ALPHA_API=
LOOKBACK=30
DO_SWAP_ON_OPEN=false
DO_SWAP_ON_CENTER=false
SOL_TOPUP_USD=10
PRICE_TTL_SECONDS=15
FEE_SHARE_WALLET=
FEE_SHARE_PCT=0
PORTFOLIO_CONFIG=./portfolio.config.json
EOF
```

2. Run the generator:

```bash
node configure.js
```

* Generates a wallet at `WALLET_PATH` if missing and writes `.env`.
* Adds `# WALLET_ADDRESS=…` comment for convenience.

### Option B — Manual

Create `.env` from the template above and edit values.

---

## Modes

### Single‑sleeve mode (default)

* Uses `POOL_ADDRESS`.
* Opens one position, monitors, recenters when leaving range.

### Portfolio mode

* Set `MODE=portfolio`.
* Provide `PORTFOLIO_CONFIG` pointing to a JSON file (recommend relative path like `./portfolio.config.json`).

#### `portfolio.config.json` schema

```jsonc
{
  "drift_bps": 150,                 // rebalance trigger threshold (1.50% relative drift)
  "min_rebalance_usd": 50,          // ignore tiny actions
  "cooldown_seconds": 300,          // portfolio rebalance cooldown
  "price_stale_secs": 60,           // price cache TTL used in portfolio loop
  "sleeves": [
    {
      "id": "SOL-USDC",
      "pool_address": "DLMM_POOL_PUBKEY_1",
      "target_weight": 0.6,         // weights are normalized; raw sum need not be 1.0
      "edge_buffer_bins": 0,         // extra bins before marking OOR
      "liquidity_strategy_type": "Spot", // or "Stable" (SDK enum also accepted)
      "do_swap_on_open": false,
      "do_swap_on_center": false,
      "min_liquidity_usd": 25
      // NOTE: total_bins_span/lower_coef present for future use; currently global via .env.
    },
    {
      "id": "mSOL-SOL",
      "pool_address": "DLMM_POOL_PUBKEY_2",
      "target_weight": 0.4,
      "edge_buffer_bins": 0,
      "liquidity_strategy_type": "Spot",
      "do_swap_on_open": true,
      "do_swap_on_center": true,
      "min_liquidity_usd": 25
    }
  ]
}
```

> **Important**
>
> * The open‑position path currently uses **global** `TOTAL_BINS_SPAN` and `LOWER_COEF` from `.env`. Per‑sleeve `total_bins_span` and `lower_coef` are **not yet wired** in this branch.
> * Use a relative file path for `PORTFOLIO_CONFIG` (e.g., `./portfolio.config.json`) to avoid platform import quirks.

---

## Run

### Single

```bash
node cli.js run
# or
node cli.js run --interval 30
```

### Portfolio

```bash
# .env must include MODE=portfolio and a valid PORTFOLIO_CONFIG
node cli.js run
# or override tick interval
node cli.js run --interval 30
```

CLI reads:

* `RPC_URL`, `WALLET_PATH`, `LOG_LEVEL` from `.env`.
* `--interval` overrides `MONITOR_INTERVAL_SECONDS`.

---

## What the bot does

* **Open / Add / Remove / Close** DLMM positions using Meteora SDK.
* **Recenters** when active bin crosses the position range (with optional `EDGE_BUFFER_BINS`).
* **Portfolio rebalance**:

  1. Move USD from overweight sleeves to underweight sleeves.
  2. If underweight remains and wallet has surplus (after SOL buffer reservation), allocate from wallet.
* **Swaps via Jupiter** for balancing and SOL top‑ups, with:

  * **Slippage** in bps (`SLIPPAGE`).
  * **Local price‑impact guard** (`PRICE_IMPACT`, percent).
  * **Priority fee** in micro‑lamports (`PRIORITY_FEE_MICRO_LAMPORTS`).
* **Fee buffer**: reserves `SOL_FEE_BUFFER_LAMPORTS` per open position; respects buffer when planning swaps and adds.
* **WSOL hygiene**: unwraps after swaps/removes/closes.

---

## `.env` reference

**Network**

* `RPC_URL` — Solana RPC endpoint (include API key if required).

**Wallet**

* `WALLET_PATH` — JSON keypair path. Generator writes here if missing.
* `# WALLET_ADDRESS=…` — comment added by generator for reference.

**Mode**

* `MODE` — `single` or `portfolio`.
* `PORTFOLIO_CONFIG` — path to JSON config in portfolio mode.

**Single‑mode range**

* `POOL_ADDRESS` — DLMM pair address.
* `TOTAL_BINS_SPAN` — total bins across both sides. Default `20`.
* `LOWER_COEF` — fraction below center, `[0..1]`.
* `MANUAL` — `true` uses `TOTAL_BINS_SPAN`; `false` queries `DITHER_ALPHA_API` with `LOOKBACK` days to resolve span.
* `DITHER_ALPHA_API` — external signal URL (optional).
* `LOOKBACK` — days for the span signal (string acceptable).

**Execution / Fees / Swaps**

* `PRIORITY_FEE_MICRO_LAMPORTS` — compute unit price. Example `50000`.
* `SOL_FEE_BUFFER_LAMPORTS` — SOL buffer. Default `70000000` (0.07 SOL).
* `SOL_TOPUP_USD` — when topping up SOL, target USD for swap. Default `10`.
* `SLIPPAGE` — bps; `10` = 0.10%.
* `PRICE_IMPACT` — max allowed impact in percent; `0.5` = 0.5%.
* `DO_SWAP_ON_OPEN` — pre‑swap to balance X/Y before opening.
* `DO_SWAP_ON_CENTER` — swap as part of recenter.

**Monitoring**

* `MONITOR_INTERVAL_SECONDS` — loop tick. CLI `--interval` overrides.
* `EDGE_BUFFER_BINS` — extra bins before declaring OOR.

**Logging**

* `LOG_LEVEL` — `fatal|error|warn|info|debug|trace`.

**Pricing cache**

* `PRICE_TTL_SECONDS` — single‑mode PriceCache TTL.
  Portfolio loop uses `price_stale_secs` from `portfolio.config.json`.

**Optional fee sharing**

* `FEE_SHARE_WALLET` — destination public key.
* `FEE_SHARE_PCT` — fraction `[0..1]` of **claimed fees** to send.

---

## Portfolio planner details

* **Drift trigger**: worst relative drift > `drift_bps/10_000`.
* **Sleeve→Sleeve**: withdraw from biggest overweights first; add to biggest underweights first.
* **Wallet supplement**: after reserving `SOL_FEE_BUFFER_LAMPORTS × open_positions`, use surplus wallet USD to fill remaining underweights if ≥ `min_rebalance_usd`.
* **Cooldown**: enforce `cooldown_seconds` between portfolio rebalances.
* **Error handling**:

  * On remove failures like `6068`/`InvalidMinimumLiquidity`, fall back to `closePosition`.
  * On add failures like `6054`/`InvalidStrategyParameters`, warn and continue.

---

## Safety characteristics

* Retries with backoff for network‑sensitive calls.
* Consistent slippage propagation from quote→swap.
* Impact guard applied before swap submission.
* Compute unit price applied to all txs.
* Idempotent opens if a position already exists on a sleeve.
* Strict SOL buffer accounting across all actions.

---

## Troubleshooting

* **JSON import fails**: use Node 20+. Keep `PORTFOLIO_CONFIG` as a **relative** path like `./portfolio.config.json`.
* **Not enough SOL**: increase `SOL_TOPUP_USD` or deposit SOL.
* **No quote / high impact**: relax `PRICE_IMPACT` or `SLIPPAGE` thoughtfully.
* **Per‑sleeve span**: currently global via `.env`. The `total_bins_span` and `lower_coef` fields in the portfolio file are placeholders.

---

## Quick‑start templates

### Minimal single‑mode

```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PATH=./id.json
MODE=single
POOL_ADDRESS=PASTE_DLMM_POOL
TOTAL_BINS_SPAN=20
LOWER_COEF=0.5
LIQUIDITY_STRATEGY_TYPE=Spot
SLIPPAGE=10
PRICE_IMPACT=0.5
PRIORITY_FEE_MICRO_LAMPORTS=50000
SOL_FEE_BUFFER_LAMPORTS=70000000
MONITOR_INTERVAL_SECONDS=60
LOG_LEVEL=info
```

### Minimal portfolio‑mode

```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_PATH=./id.json
MODE=portfolio
PORTFOLIO_CONFIG=./portfolio.config.json
TOTAL_BINS_SPAN=20
LOWER_COEF=0.5
LIQUIDITY_STRATEGY_TYPE=Spot
SLIPPAGE=10
PRICE_IMPACT=0.5
PRIORITY_FEE_MICRO_LAMPORTS=50000
SOL_FEE_BUFFER_LAMPORTS=70000000
MONITOR_INTERVAL_SECONDS=60
EDGE_BUFFER_BINS=0
LOG_LEVEL=info
```

`portfolio.config.json` example:

```json
{
  "drift_bps": 150,
  "min_rebalance_usd": 50,
  "cooldown_seconds": 300,
  "price_stale_secs": 60,
  "sleeves": [
    {
      "id": "SOL-USDC",
      "pool_address": "6wJ7W3oHj7ex6MVFp2o26NSof3aey7U8Brs8E371WCXA",
      "target_weight": 0.5,
      "edge_buffer_bins": 0,
      "liquidity_strategy_type": "Spot",
      "do_swap_on_open": false,
      "do_swap_on_center": false,
      "min_liquidity_usd": 25
    },
    {
      "id": "mSOL-SOL",
      "pool_address": "REPLACE_ME",
      "target_weight": 0.5,
      "edge_buffer_bins": 0,
      "liquidity_strategy_type": "Spot",
      "do_swap_on_open": true,
      "do_swap_on_center": true,
      "min_liquidity_usd": 25
    }
  ]
}
```

---

## Commands recap

```bash
# Generate .env from .env.example and wallet if missing
node configure.js

# Single‑mode
node cli.js run
node cli.js run --interval 30

# Portfolio‑mode
# (ensure MODE=portfolio and PORTFOLIO_CONFIG set)
node cli.js run
node cli.js run --interval 30
```

---
