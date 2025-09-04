// ───────────────────────────────────────────────
// ~/main.js  (portfolio-aware)
// ───────────────────────────────────────────────
import BN from 'bn.js';
import 'dotenv/config';
import { Connection } from '@solana/web3.js';

import { loadWalletKeypair, getMintDecimals } from './lib/solana.js';
import { getPrice } from './lib/jupiter.js';
import {
  openDlmmPosition,
  recenterPosition,
} from './lib/dlmm.js';

import {
  normalizeConfig,
  buildSleeveRegistry,
  discoverPositions,
  snapshotPortfolio,
  buildRebalanceIntent,
} from './lib/portfolio.js';

import {
  executeRecenters,
  executePortfolioRebalance,
} from './lib/dlmm.js';

import { PriceCache } from './lib/valuation.js';

const {
  RPC_URL,
  WALLET_PATH,
  MONITOR_INTERVAL_SECONDS = '60',
  MODE: ENV_MODE = 'single',
  PORTFOLIO_CONFIG = '',
} = process.env;

// ----------------------------- single-sleeve loop  ---------------
async function monitorPositionLoop(connection, dlmmPool, userKeypair, positionPubKey, intervalSeconds) {
  console.log(`Starting monitoring - Interval ${intervalSeconds}s`);
  console.log(`Tracking Position: ${positionPubKey.toBase58()}`);

  if (typeof dlmmPool.tokenX.decimal !== 'number')
    dlmmPool.tokenX.decimal = await getMintDecimals(connection, dlmmPool.tokenX.publicKey);
  if (typeof dlmmPool.tokenY.decimal !== 'number')
    dlmmPool.tokenY.decimal = await getMintDecimals(connection, dlmmPool.tokenY.publicKey);
  const dx = dlmmPool.tokenX.decimal;
  const dy = dlmmPool.tokenY.decimal;

  console.log("Time         | Total($)");

  while (true) {
    try {
      await dlmmPool.refetchStates();
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);
      const activeBin = await dlmmPool.getActiveBin();
      const pos = userPositions.find(p => p.publicKey.equals(positionPubKey));
      if (!pos || !activeBin) break;

      let lamX = new BN(0), lamY = new BN(0);
      pos.positionData.positionBinData.forEach(b => {
        lamX = lamX.add(new BN(b.positionXAmount));
        lamY = lamY.add(new BN(b.positionYAmount));
      });
      const feeX = new BN(pos.positionData.feeX);
      const feeY = new BN(pos.positionData.feeY);

      const amtX    = Number(lamX.toString()) / 10 ** dx;
      const amtY    = Number(lamY.toString()) / 10 ** dy;
      const feeAmtX = Number(feeX.toString()) / 10 ** dx;
      const feeAmtY = Number(feeY.toString()) / 10 ** dy;

      const pxX = await getPrice(dlmmPool.tokenX.publicKey.toString());
      const pxY = await getPrice(dlmmPool.tokenY.publicKey.toString());

      const liqUsd   = amtX * pxX + amtY * pxY;
      const feesUsd  = feeAmtX * pxX + feeAmtY * pxY;
      const totalUsd = liqUsd + feesUsd;

      const lower  = pos.positionData.lowerBinId;
      const upper  = pos.positionData.upperBinId;

      const B = Number(process.env.EDGE_BUFFER_BINS ?? 0);
      const triggerUpper = activeBin.binId >= (upper + B);
      const triggerLower = activeBin.binId <= (lower - B);
      const shouldRecenter = triggerUpper || triggerLower;

      if (shouldRecenter) {
        const res = await recenterPosition(connection, dlmmPool, userKeypair, positionPubKey);
        if (!res) break;
        dlmmPool       = res.dlmmPool;
        positionPubKey = res.positionPubKey;
        await new Promise(r => setTimeout(r, intervalSeconds * 1_000));
        continue;
      }
      console.log(`${new Date().toLocaleTimeString()} | ${totalUsd.toFixed(2).padStart(8)}`);
    } catch (err) {
      console.error('Error during monitor tick:', err?.message ?? err);
    }
    await new Promise(r => setTimeout(r, intervalSeconds * 1_000));
  }
  console.log('Monitoring ended.');
}

// ----------------------------- portfolio loop --------------------------------
async function monitorPortfolioLoop(connection, userKeypair, intervalSeconds, configObj) {
  const cfg = normalizeConfig(configObj);
  const registry = await buildSleeveRegistry({ connection, config: cfg });
  await discoverPositions({ connection, ownerPk: userKeypair.publicKey, registry });

  // Persistent price cache to avoid 429s
  const priceCache = new PriceCache(cfg.price_stale_secs);

  console.log(`[portfolio] sleeves: ${cfg.sleeves.map(s => s.id).join(', ')}`);

  let lastPortfolioRebalanceAt = 0;

  while (true) {
    try {
      const snap = await snapshotPortfolio({
        connection,
        ownerPk: userKeypair.publicKey,
        registry,
        config: cfg,
        priceCache, 
      });

      await executeRecenters({
        connection,
        ownerKeypair: userKeypair,
        registry,
        sleeveSnaps: snap.sleeveSnaps,
      });

      const intent = buildRebalanceIntent({ snapshot: snap, config: cfg });
      const now = Date.now();
      const cooldownMs = (cfg.cooldown_seconds ?? 30) * 1000;

      if (intent.trigger && (now - lastPortfolioRebalanceAt) >= cooldownMs) {
        await executePortfolioRebalance({
          connection,
          ownerKeypair: userKeypair,
          registry,
          snapshot: snap,
          intent,
        });
        lastPortfolioRebalanceAt = Date.now();
      }

      const total = snap.totals.totalUsd.toFixed(2);
      const worst = Math.max(...Object.values(intent.drift).map(d => Math.abs(d.rel || 0))) * 100;
      console.log(`[portfolio] total=$${total} | worst-drift=${worst.toFixed(2)}%`);

    } catch (e) {
      console.error('[portfolio] loop error:', e?.message ?? e);
    }

    await new Promise(r => setTimeout(r, intervalSeconds * 1_000));
  }
}

// ----------------------------- entrypoint ------------------------------------
async function main(overrides = {}) {
  const userKeypair = loadWalletKeypair(WALLET_PATH);
  const connection  = new Connection(RPC_URL, 'confirmed');

  const mode = String(overrides.MODE ?? ENV_MODE).toLowerCase();
  const interval = Number(overrides.MONITOR_INTERVAL_SECONDS ?? MONITOR_INTERVAL_SECONDS) || 30;

  if (mode === 'portfolio') {
    let cfgObj = overrides.portfolioConfigObj;
    if (!cfgObj && PORTFOLIO_CONFIG) {
      try {
        const raw = await import(PORTFOLIO_CONFIG, { with: { type: 'json' } });
        cfgObj = raw.default || raw;
      } catch (e) {
        throw new Error(`Failed to load PORTFOLIO_CONFIG: ${e.message}`);
      }
    }
    if (!cfgObj) throw new Error('Portfolio mode requires a config object or PORTFOLIO_CONFIG path');
    await monitorPortfolioLoop(connection, userKeypair, interval, cfgObj);
    return;
  }

  const { dlmmPool, positionPubKey } = await openDlmmPosition(connection, userKeypair);
  if (!dlmmPool || !positionPubKey) {
    console.error("Failed to open position – aborting.");
    process.exit(1);
  }
  await monitorPositionLoop(connection, dlmmPool, userKeypair, positionPubKey, interval);
}

export { main, monitorPositionLoop, monitorPortfolioLoop };
