// ───────────────────────────────────────────────
// ~/lib/dlmm.js
// ───────────────────────────────────────────────
import BN from 'bn.js';
import dlmmPackage from '@meteora-ag/dlmm';
const { StrategyType } = dlmmPackage;
import {
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction
} from '@solana/web3.js';

import { withRetry } from './retry.js';
import { getPrice } from './price.js';
import { getSwapQuote, executeSwap } from './jupiter.js';
import {
  getMintDecimals,
  safeGetBalance,
  unwrapWSOL,
} from './solana.js';

import 'dotenv/config';
// pull config from env once
 const {
   POOL_ADDRESS,
   TOTAL_BINS_SPAN: ENV_TOTAL_BINS_SPAN,
   LOWER_COEF               = 0.5,
   PRIORITY_FEE_MICRO_LAMPORTS = 50_000,
   MANUAL = 'true',
   DITHER_ALPHA_API = 'http://0.0.0.0:8000/metrics',   // sensible defaults
   LOOKBACK = '30',
   PRICE_IMPACT,
   SLIPPAGE
 } = process.env;

const MANUAL_MODE             = String(MANUAL).toLowerCase() === 'true';
console.log(MANUAL_MODE)
const DEFAULT_TOTAL_BINS_SPAN = Number(ENV_TOTAL_BINS_SPAN ?? 20);
const SLIPPAGE_BPS = Number(SLIPPAGE ?? 10);       // e.g. “25” → 25
const PRICE_IMPACT_PCT = Number(PRICE_IMPACT ?? 0.5);

const DLMM = dlmmPackage.default ?? dlmmPackage;

const STRATEGY_STRING = (process.env.LIQUIDITY_STRATEGY_TYPE || "Spot").trim();

// Validate & translate
if (!(STRATEGY_STRING in StrategyType)) {
  throw new Error(
    `Invalid LIQUIDITY_STRATEGY_TYPE="${STRATEGY_STRING}". ` +
    `Valid options: ${Object.keys(StrategyType).join(", ")}`
  );
}

export const LIQUIDITY_STRATEGY_TYPE = StrategyType[STRATEGY_STRING];

async function resolveTotalBinsSpan(dlmmPool) {
  if (MANUAL_MODE) {
    console.log(`[config] MANUAL=true – using TOTAL_BINS_SPAN=${DEFAULT_TOTAL_BINS_SPAN}`);
    return DEFAULT_TOTAL_BINS_SPAN;
  }
  if (!DITHER_ALPHA_API || !LOOKBACK) {
    console.warn('[config] DITHER_ALPHA_API or LOOKBACK unset – using default span');
    return DEFAULT_TOTAL_BINS_SPAN;
  }
  // Attempt to read the pool's step size in basis‑points.
  // Try the SDK property first; fall back if missing
  const stepBp = dlmmPool?.lbPair?.binStep ?? dlmmPool?.binStep ?? dlmmPool?.stepBp ?? dlmmPool?.stepBP ?? null;
  if (stepBp == null) {
    console.warn('[config] Could not determine pool step_bp – using default span');
    return DEFAULT_TOTAL_BINS_SPAN;
  }

  // Compose API URL
  const mintA = dlmmPool.tokenX.publicKey.toString();
  const mintB = dlmmPool.tokenY.publicKey.toString();
  const url   = `${DITHER_ALPHA_API}?mintA=${mintA}&mintB=${mintB}&lookback=${LOOKBACK}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[config] API fetch failed (${res.status} ${res.statusText}) – using default span`);
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const data = await res.json();
    const gridSweep = data?.grid_sweep ?? data?.pnl_drivers?.grid_sweep;
    if (!Array.isArray(gridSweep)) {
      console.warn('[config] grid_sweep missing – using default span');
      return DEFAULT_TOTAL_BINS_SPAN;
    }

    const match = gridSweep.find(g => Number(g.step_bp) === Number(stepBp));
    if (!match) {
      console.warn(`[config] No grid_sweep entry for step_bp=${stepBp} – default span`);
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const binsPerSide = Number(match.bins);
    if (!Number.isFinite(binsPerSide) || binsPerSide <= 0) {
      console.warn('[config] Invalid bins value – default span');
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const span = binsPerSide * 2;                 // convert per‑side → total
    console.log(`[config] Resolved TOTAL_BINS_SPAN=${span} via API (step_bp=${stepBp})`);
    return span;
  } catch (err) {
    console.warn('[config] Error fetching grid_sweep –', err?.message ?? err);
    return DEFAULT_TOTAL_BINS_SPAN;
  }
}

async function fetchBalances(connection, dlmmPool, ownerPk) {
  return {
    lamX: await safeGetBalance(
      connection,
      dlmmPool.tokenX.publicKey,
      ownerPk
    ),
    lamY: await safeGetBalance(
      connection,
      dlmmPool.tokenY.publicKey,
      ownerPk
    ),
  };
}

async function openDlmmPosition(connection, userKeypair) {
  return await withRetry(async () => {
    //------------------------------------------------------------------
    // 0) Pool metadata
    //------------------------------------------------------------------
    const poolPK   = new PublicKey(POOL_ADDRESS);
    const dlmmPool = await DLMM.create(connection, poolPK);
    // 🔍 0‑a) Abort if a position already exists
    try {
      const { userPositions } =
        await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);

      if (userPositions.length) {
        // ── grab the first position (or pick by some other rule) ─────────
        const existingPos = userPositions[0];

        // (i) make sure decimals are cached
        for (const t of [dlmmPool.tokenX, dlmmPool.tokenY]) {
          if (typeof t.decimal !== 'number')
            t.decimal = await getMintDecimals(connection, t.publicKey);
        }
        const dx = dlmmPool.tokenX.decimal;
        const dy = dlmmPool.tokenY.decimal;

        // (ii) pull the balances locked in that position
        let lamX = new BN(0), lamY = new BN(0);
        existingPos.positionData.positionBinData.forEach(b => {
          lamX = lamX.add(new BN(b.positionXAmount));
          lamY = lamY.add(new BN(b.positionYAmount));
        });

        // (iii) USD valuation
        const priceX = await getPrice(dlmmPool.tokenX.publicKey.toString());
        const priceY = await getPrice(dlmmPool.tokenY.publicKey.toString());
        const uiX    = lamX.toNumber() / 10 ** dx;
        const uiY    = lamY.toNumber() / 10 ** dy;
        const depositUsd = uiX * priceX + uiY * priceY;

        console.log('[open] Existing position detected – skipping open.');

        return {
          dlmmPool,
          initialCapitalUsd: depositUsd,
          positionPubKey:    existingPos.publicKey,
          openFeeLamports:   0                 
        };
      }
    } catch (err) {
      console.error('[open] Could not check for existing positions:', err);
    }
    // Decide span (may hit API)
    const TOTAL_BINS_SPAN = await resolveTotalBinsSpan(dlmmPool);

    // Cache decimals
    for (const t of [dlmmPool.tokenX, dlmmPool.tokenY]) {
      if (typeof t.decimal !== 'number')
        t.decimal = await getMintDecimals(connection, t.publicKey);
    }
    const dx = dlmmPool.tokenX.decimal;
    const dy = dlmmPool.tokenY.decimal;

    const SOL_MINT_ADDR = 'So11111111111111111111111111111111111111112';
    const X_MINT  = dlmmPool.tokenX.publicKey.toString();
    const Y_MINT  = dlmmPool.tokenY.publicKey.toString();
    const X_IS_SOL = X_MINT === SOL_MINT_ADDR;
    const Y_IS_SOL = Y_MINT === SOL_MINT_ADDR;

    //------------------------------------------------------------------
    // 1) Reserve SOL buffer
    //------------------------------------------------------------------
    const SOL_BUFFER = new BN(70_000_000);         // 0.07 SOL hard‑coded

    const balances   = await fetchBalances(connection, dlmmPool, userKeypair.publicKey);

    let lamX = balances.lamX;      // BN
    let lamY = balances.lamY;      // BN

    //------------------------------------------------------------------
    // 2) Optional Jupiter swap to balance USD value
    //------------------------------------------------------------------
    const priceX = await getPrice(X_MINT);
    const priceY = await getPrice(Y_MINT);
    if (priceX == null || priceY == null)
      throw new Error('Price feed unavailable for one of the pool tokens');

    const usdX = lamX.toNumber() / 10 ** dx * priceX;
    const usdY = lamY.toNumber() / 10 ** dy * priceY;
    const diffUsd = usdY - usdX;                     // +ve → Y richer

    if (Math.abs(diffUsd) > 0.01) {
      const inputMint  = diffUsd > 0 ? Y_MINT : X_MINT;
      const outputMint = diffUsd > 0 ? X_MINT : Y_MINT;
      const inputDecs  = diffUsd > 0 ? dy      : dx;
      const pxInputUsd = diffUsd > 0 ? priceY  : priceX;
      // move half the USD gap from richer → poorer
      const usdToSwap   = Math.abs(diffUsd) / 2;
      const rawInputAmt = BigInt(
        Math.floor((usdToSwap / pxInputUsd) * 10 ** inputDecs)
      );
      console.log(`Swapping ${diffUsd > 0 ? 'Y→X' : 'X→Y'} worth $${usdToSwap.toFixed(2)} …`);

      const quote = await getSwapQuote(
        inputMint,
        outputMint,
        rawInputAmt,        // amountRaw
        SLIPPAGE_BPS,       // ← fourth parameter: slippageBps
        undefined,          // keep default maxAttempts (20)
        PRICE_IMPACT_PCT    // ← sixth parameter: price_impact threshold (%)
      );
      if (!quote) throw new Error('Could not obtain swap quote');

      const sig = await executeSwap(quote, userKeypair, connection, dlmmPool);
      if (!sig)  throw new Error('Swap failed');
    }
    // ───────────────────────── 3) Refresh balances ─────────────────────────
    ({ lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey));

    if (X_IS_SOL) {
      if (lamX.lt(SOL_BUFFER)) throw new Error('Not enough SOL (tokenX) to keep fee‑buffer');
      lamX = lamX.sub(SOL_BUFFER);
    } else if (Y_IS_SOL) {
      if (lamY.lt(SOL_BUFFER)) throw new Error('Not enough SOL (tokenY) to keep fee‑buffer');
      lamY = lamY.sub(SOL_BUFFER);
    } else {
      const native = new BN(await connection.getBalance(userKeypair.publicKey, 'confirmed'));
      if (native.lt(SOL_BUFFER)) throw new Error('Not enough native SOL for rent + fees');
    }
    // Sanity‑check: wallet still owns the buffer
    const walletSol = await connection.getBalance(userKeypair.publicKey, 'confirmed');
    if (walletSol < SOL_BUFFER.toNumber())
      throw new Error('SOL buffer was consumed during swap — aborting');

    //------------------------------------------------------------------
    // 4) Final deposit figures & USD value
    //------------------------------------------------------------------
    const uiX = lamX.toNumber() / 10 ** dx;
    const uiY = lamY.toNumber() / 10 ** dy;
    const depositUsd = uiX * priceX + uiY * priceY;
    console.log(`Final deposit: ${uiX.toFixed(4)} X  +  ${uiY.toFixed(4)} Y  =  $${depositUsd.toFixed(2)}`);

    //------------------------------------------------------------------
    // 5) Bin‑range centred on the active bin
    //------------------------------------------------------------------
    const activeBin = await dlmmPool.getActiveBin();
    const minBin    = activeBin.binId - Math.floor(TOTAL_BINS_SPAN * LOWER_COEF);
    const maxBin    = activeBin.binId + Math.floor(TOTAL_BINS_SPAN * (1 - LOWER_COEF));

    //------------------------------------------------------------------
    // 6) Build & send InitializePositionAndAddLiquidity transaction
    //------------------------------------------------------------------
    const posKP = Keypair.generate();
    const ixs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: posKP.publicKey,
      user:           userKeypair.publicKey,
      totalXAmount:   lamX,
      totalYAmount:   lamY,
      strategy:       {
        minBinId: minBin,
        maxBinId: maxBin,
        strategyType: LIQUIDITY_STRATEGY_TYPE,
      },
    });

    const tx = new Transaction().add(...ixs.instructions);
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS })
    );
    tx.feePayer = userKeypair.publicKey;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash      = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair, posKP]);
    console.log(`Position opened: ${sig}`);

    return {
      dlmmPool,
      initialCapitalUsd: depositUsd,
      positionPubKey:    posKP.publicKey,
      openFeeLamports:   (await connection.getParsedTransaction(
                           sig, { maxSupportedTransactionVersion: 0 }
                         ))?.meta?.fee ?? 0,
    };
  }, 'openDlmmPosition');
}
// -----------------------------------------------------------------------------
// closeDlmmPosition: remove 100% & claim fees
// -----------------------------------------------------------------------------
async function closeDlmmPosition(connection, dlmmPool, userKeypair, positionPubKey) {
    return await withRetry(async () => {
      await dlmmPool.refetchStates();
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);
      const pos = userPositions.find(p => p.publicKey.equals(positionPubKey));
      if (!pos) {
        console.log("Position already closed.");
        return true;
      }
  
      const closeIx = await dlmmPool.removeLiquidity({
        position:            positionPubKey,
        user:                userKeypair.publicKey,
        fromBinId:           pos.positionData.lowerBinId,
        toBinId:             pos.positionData.upperBinId,
        bps:                 new BN(10_000),
        shouldClaimAndClose: true,
      });
  
      const tx = new Transaction().add(...closeIx.instructions);
      tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS })
      );
      tx.feePayer = userKeypair.publicKey;
      // refresh blockhash
      const recent = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash      = recent.blockhash;
      tx.lastValidBlockHeight = recent.lastValidBlockHeight;
  
      const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair], {
        commitment: 'confirmed',
        skipPreflight: false
      });
      console.log(`✅ [close] Position closed: ${sig}`);
      return true;
    }, 'closeDlmmPosition');
  }

async function recenterPosition(connection, dlmmPool, userKeypair, oldPositionPubKey) {
  console.log('Starting recenterPosition');

  // 0) ensure decimals are cached ────────────────────────────────────────────
  if (typeof dlmmPool.tokenX.decimal !== 'number')
    dlmmPool.tokenX.decimal = await getMintDecimals(connection, dlmmPool.tokenX.publicKey);
  if (typeof dlmmPool.tokenY.decimal !== 'number')
    dlmmPool.tokenY.decimal = await getMintDecimals(connection, dlmmPool.tokenY.publicKey);

  const dx = dlmmPool.tokenX.decimal;
  const dy = dlmmPool.tokenY.decimal;

  // 1) locate the old position ───────────────────────────────────────────────
  await dlmmPool.refetchStates();
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);
  const oldPos = userPositions.find(p => p.publicKey.equals(oldPositionPubKey));
  if (!oldPos) {
    console.log('Old position not found – skip recenter.');
    return null;
  }

  // 2) value the position and realise IL (for metrics only) ──────────────────
  let lamX = new BN(0), lamY = new BN(0);
  oldPos.positionData.positionBinData.forEach(b => {
    lamX = lamX.add(new BN(b.positionXAmount));
    lamY = lamY.add(new BN(b.positionYAmount));
  });
  lamX = lamX.add(new BN(oldPos.positionData.feeX));
  lamY = lamY.add(new BN(oldPos.positionData.feeY));

  // 3) close the position ────────────────────────────────────────────────────
  await withRetry(async () => {
    const closeIx = await dlmmPool.removeLiquidity({
      position:            oldPositionPubKey,
      user:                userKeypair.publicKey,
      fromBinId:           oldPos.positionData.lowerBinId,
      toBinId:             oldPos.positionData.upperBinId,
      bps:                 new BN(10_000),
      shouldClaimAndClose: true,
    });
    let tx;
    if (Array.isArray(closeIx)) {
      // SDK returned an array of instructions
      tx = new Transaction().add(...closeIx);
    } else if (closeIx instanceof Transaction) {
      // SDK returned a complete transaction
      tx = closeIx;
    } else if (closeIx && closeIx.instructions) {
      // SDK returned an object with instructions property
      tx = new Transaction().add(...closeIx.instructions);
    } else {
      throw new Error('Unknown SDK response format for removeLiquidity');
    }
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS })
    );
    tx.feePayer = userKeypair.publicKey;

    const recent = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash      = recent.blockhash;
    tx.lastValidBlockHeight = recent.lastValidBlockHeight;

    const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
    await unwrapWSOL(connection, userKeypair);       // keep SOL as native
    console.log(`Closed old position, sig: ${sig}`);
  }, 'closePosition');

  // 4) reopen via the canonical helper (handles swap + SOL buffer) ───────────
  let openRes;
  try {
    openRes = await openDlmmPosition(connection, userKeypair, dlmmPool);
  } catch (err) {
    console.error('[recenter] reopen failed:', err?.message ?? err);
    throw err;   // bubble up so a supervisor can decide what to do
  }

  // 5) pass through the interesting fields ───────────────────────────────────
  return {
    dlmmPool,
    openValueUsd:   openRes.initialCapitalUsd,
    positionPubKey: openRes.positionPubKey,
    rebalanceSignature: openRes.openFeeLamports,
  };
}

export {
  fetchBalances,
  openDlmmPosition,
  closeDlmmPosition,
  recenterPosition
};
