// ───────────────────────────────────────────────
// ~/main.js
// ───────────────────────────────────────────────
import BN from 'bn.js';
import { loadWalletKeypair } from './lib/solana.js';
import { openDlmmPosition, recenterPosition } from './lib/dlmm.js';
import 'dotenv/config';
import { getMintDecimals } from './lib/solana.js';
import { getPrice } from './lib/price.js';
import {
  Connection,
} from '@solana/web3.js';
// pull vars from the environment
const {
  RPC_URL,
  WALLET_PATH,
  MONITOR_INTERVAL_SECONDS = 5,
} = process.env;

async function monitorPositionLoop(
  connection,
  dlmmPool,
  userKeypair,
  initialCapitalUsd,
  positionPubKey,
  intervalSeconds,
) {
  console.log(`Starting monitoring - Interval ${intervalSeconds}s`);
  console.log(`Tracking Position: ${positionPubKey.toBase58()}`);

  /* ─── 1. token-decimals  ─────────────────────────────── */
  if (typeof dlmmPool.tokenX.decimal !== 'number')
    dlmmPool.tokenX.decimal = await getMintDecimals(connection, dlmmPool.tokenX.publicKey);
  if (typeof dlmmPool.tokenY.decimal !== 'number')
    dlmmPool.tokenY.decimal = await getMintDecimals(connection, dlmmPool.tokenY.publicKey);
  const dx = dlmmPool.tokenX.decimal;
  const dy = dlmmPool.tokenY.decimal;
  console.log(`Token decimals: X=${dx}, Y=${dy}`);

  /* ─── 3. heading ────────────────────────────────────────────────── */
  console.log(
    "Time         | Total($)  "
  );

  /* ─── 4. loop ───────────────────────────────────────────────────── */
  while (true) {
    try {
      /* 4-A refresh on-chain state --------------------------------- */
      await dlmmPool.refetchStates();
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);
      const activeBin   = await dlmmPool.getActiveBin();
      const pos         = userPositions.find(p => p.publicKey.equals(positionPubKey));
      if (!pos || !activeBin) break;

      /* 4-B amounts ------------------------------------------------- */
      let lamX = new BN(0), lamY = new BN(0);
      pos.positionData.positionBinData.forEach(b => {
        lamX = lamX.add(new BN(b.positionXAmount));
        lamY = lamY.add(new BN(b.positionYAmount));
      });
      const feeX = new BN(pos.positionData.feeX);
      const feeY = new BN(pos.positionData.feeY);

      const amtX     = lamX.toNumber() / 10 ** dx;
      const amtY     = lamY.toNumber() / 10 ** dy;
      const feeAmtX  = feeX.toNumber() / 10 ** dx;
      const feeAmtY  = feeY.toNumber() / 10 ** dy;

      const pxX      = await getPrice(dlmmPool.tokenX.publicKey.toString());
      const pxY      = await getPrice(dlmmPool.tokenY.publicKey.toString());

      const liqUsd   = amtX * pxX + amtY * pxY;
      const feesUsd  = feeAmtX * pxX + feeAmtY * pxY;
      const totalUsd = liqUsd + feesUsd;

      /* 4-C re-centre if out of range ------------------------------- */
      const width  = pos.positionData.upperBinId - pos.positionData.lowerBinId + 1;
      const centre = pos.positionData.lowerBinId + (width - 1) / 2;
      const dist   = Math.abs(activeBin.binId - centre);

      if (dist > width * Number(process.env.CENTER_DISTANCE_THRESHOLD || 0.45)) {
        console.log(`🔄 Rebalancing: active=${activeBin.binId}, center=${centre}`);

        const res = await recenterPosition(connection, dlmmPool, userKeypair, positionPubKey);
        if (!res) break;

        dlmmPool        = res.dlmmPool;
        positionPubKey  = res.positionPubKey;
      }

      console.log(
        `${new Date().toLocaleTimeString()} | ` +
        `${totalUsd.toFixed(2).padStart(8)} ` 
      );

    } catch (err) {
      console.error('Error during monitor tick:', err?.message ?? err);
    }

    await new Promise(r => setTimeout(r, intervalSeconds * 1_000));
  }

  console.log('Monitoring ended.');
}

async function main() {
    const userKeypair = loadWalletKeypair(WALLET_PATH);
    const connection  = new Connection(RPC_URL, 'confirmed');
  
    // 1️⃣ Open initial position
    const {
      dlmmPool,
      initialCapitalUsd,
      positionPubKey,
      openFeeLamports
    } = await openDlmmPosition(connection, userKeypair);
  
    if (!dlmmPool || !positionPubKey) {
      console.error("Failed to open position – aborting.");
      process.exit(1);
    }
  
    // 2️⃣ Start monitoring & rebalancing (pass initialTxnLamports)
    await monitorPositionLoop(
      connection,
      dlmmPool,
      userKeypair,
      initialCapitalUsd,
      positionPubKey,
      MONITOR_INTERVAL_SECONDS,
      openFeeLamports
    );
  
    console.log("🏁 Script finished.");
  }
  
  /*main().catch(err => {
    console.error("💥 Unhandled error in main:", err);
    process.exit(1);
  });*/
export { main, monitorPositionLoop };
