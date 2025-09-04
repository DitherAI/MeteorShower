// ───────────────────────────────────────────────
// ~/lib/dlmm.js
// ───────────────────────────────────────────────
import 'dotenv/config';
import BN from 'bn.js';
import dlmmPackage, { StrategyType as StrategyTypeNamed } from '@meteora-ag/dlmm';
import {
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { withRetry } from './retry.js';
import { getSwapQuote, executeSwap, getPrice } from './jupiter.js';
import { getMintDecimals, safeGetBalance, unwrapWSOL } from './solana.js';
import { ensurePoolDecimals, rawToUi, uiToRaw, SOL_MINT_ADDR } from './valuation.js';

// ───────────────────────────────────────────────
// SDK guards
// ───────────────────────────────────────────────
const DLMM = dlmmPackage?.default ?? dlmmPackage ?? {};
const StrategyType = (dlmmPackage?.StrategyType ?? StrategyTypeNamed) || {};

// ───────────────────────────────────────────────
// Logging
// ───────────────────────────────────────────────
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG = {
  debug: (...a) => { if (['debug', 'trace'].includes(LOG_LEVEL)) console.log('[dlmm][debug]', ...a); },
  info:  (...a) => { if (['info', 'debug', 'trace'].includes(LOG_LEVEL)) console.log('[dlmm][info ]', ...a); },
  warn:  (...a) => console.warn('[dlmm][warn ]', ...a),
  error: (...a) => console.error('[dlmm][error]', ...a),
};

// ───────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────
const cfg = {
  priorityFeeMicroLamports: Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 50_000),
  slippageBps: Number(process.env.SLIPPAGE ?? 10),
  priceImpactPct: Number(process.env.PRICE_IMPACT ?? 0.5),
  solFeeBufferLamports: BigInt(Number(process.env.SOL_FEE_BUFFER_LAMPORTS ?? 70_000_000)),
  ditherAlphaApi: String(process.env.DITHER_ALPHA_API || ''),
  lookback: String(process.env.LOOKBACK ?? '30'),
  liquidityStrategyTypeEnv: String(process.env.LIQUIDITY_STRATEGY_TYPE || 'Spot'),
  manualSpanMode: String(process.env.MANUAL || 'true').toLowerCase() === 'true',
};

// ───────────────────────────────────────────────
// Utils
// ───────────────────────────────────────────────
function parseBoolEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1','true','yes','y','on'].includes(v))  return true;
  if (['0','false','no','n','off'].includes(v)) return false;
  return fallback;
}
function resolveOpenSwapFlag(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  return parseBoolEnv(process.env.DO_SWAP_ON_OPEN, false);
}
function resolveCenterSwapFlag(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  return parseBoolEnv(process.env.DO_SWAP_ON_CENTER, false);
}
function clamp01(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** Robust resolver: accepts number or string; safe if SDK enum is missing. */
function asStrategyType(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input || '').trim();
  if (s && typeof StrategyType[s] === 'number') return StrategyType[s];
  const MAP = { spot: 0, stable: 1 };
  const v = MAP[s.toLowerCase()];
  if (typeof v === 'number') return v;
  const envS = String(cfg.liquidityStrategyTypeEnv || 'Spot').trim();
  if (typeof StrategyType[envS] === 'number') return StrategyType[envS];
  return MAP[envS.toLowerCase()] ?? 0;
}

// ───────────────────────────────────────────────
// TX helper
// ───────────────────────────────────────────────
async function sendIxOrTx({ connection, ownerKeypair, ixOrTx }) {
  let tx;
  if (Array.isArray(ixOrTx)) tx = new Transaction().add(...ixOrTx);
  else if (ixOrTx?.instructions) tx = new Transaction().add(...ixOrTx.instructions);
  else if (ixOrTx instanceof Transaction) tx = ixOrTx;
  else throw new Error('unexpected instruction/transaction payload');

  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports })
  );
  tx.feePayer = ownerKeypair.publicKey;

  const recent = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = recent.blockhash;
  tx.lastValidBlockHeight = recent.lastValidBlockHeight;

  const sig = await sendAndConfirmTransaction(connection, tx, [ownerKeypair], {
    commitment: 'confirmed',
    skipPreflight: true,
  });
  return sig;
}

// ───────────────────────────────────────────────
// Fee share
// ───────────────────────────────────────────────
async function maybeSendFeeShare(connection, userKeypair, mintPk, claimedFeeRawBN) {
  const recipientStr = (process.env.FEE_SHARE_WALLET || '').trim();
  const pct          = clamp01(process.env.FEE_SHARE_PCT ?? 0);
  if (!recipientStr || pct <= 0) return false;

  let recipientPk;
  try {
    recipientPk = new PublicKey(recipientStr);
  } catch {
    LOG.warn('[fees] FEE_SHARE_WALLET is not a valid Pubkey; skipping payout.');
    return false;
  }

  const SCALE = 1_000_000;
  const shareRawBN = claimedFeeRawBN.mul(new BN(Math.floor(pct * SCALE))).div(new BN(SCALE));
  if (shareRawBN.lte(new BN(0))) return false;

  const owner = userKeypair.publicKey;
  const isSOL = mintPk.toBase58() === SOL_MINT_ADDR;

  // SPL transfer path
  try {
    const fromAta = await getAssociatedTokenAddress(mintPk, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const toAta   = await getAssociatedTokenAddress(mintPk, recipientPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const fromInfo = await connection.getAccountInfo(fromAta);
    if (fromInfo) {
      const bal = await connection.getTokenAccountBalance(fromAta).catch(() => null);
      const availableBN = new BN(bal?.value?.amount ?? '0');
      if (availableBN.gt(new BN(0))) {
        const sendBN = BN.min(shareRawBN, availableBN);

        const ixs = [];
        const toInfo = await connection.getAccountInfo(toAta);
        if (!toInfo) {
          ixs.push(
            createAssociatedTokenAccountInstruction(
              owner, toAta, recipientPk, mintPk,
              TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }
        ixs.push(
          createTransferInstruction(
            fromAta, toAta, owner, BigInt(sendBN.toString()), [], TOKEN_PROGRAM_ID
          )
        );

        const tx = new Transaction().add(...ixs);
        tx.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports })
        );
        tx.feePayer = owner;

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash      = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;

        const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair], {
          commitment: 'confirmed',
          skipPreflight: true
        });
        LOG.info(`[fees] Sent SPL fee share (${sendBN.toString()}) for ${mintPk.toBase58()} → ${recipientPk.toBase58()}: ${sig}`);
        return true;
      }
    }
  } catch (e) {
    if (!isSOL) LOG.warn('[fees] SPL fee-share attempt failed:', e?.message ?? e);
  }

  // Native SOL fallback
  if (isSOL) {
    const nativeBal = await connection.getBalance(owner, 'confirmed');
    const shareLamports = BigInt(shareRawBN.toString());
    const sendLamports = shareLamports <= BigInt(nativeBal) ? shareLamports : BigInt(nativeBal);
    if (sendLamports <= 0n) return false;

    const ix = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey:   recipientPk,
      lamports:   Number(sendLamports),
    });

    const tx = new Transaction().add(ix);
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports })
    );
    tx.feePayer = owner;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash      = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair], {
      commitment: 'confirmed',
      skipPreflight: true
    });
    LOG.info(`[fees] Sent native SOL fee share (${sendLamports.toString()} lamports) → ${recipientPk.toBase58()}: ${sig}`);
    return true;
  }

  return false;
}

// ───────────────────────────────────────────────
// Balances, swaps, and SOL top-up
// ───────────────────────────────────────────────
async function fetchBalances(connection, dlmmPool, ownerPk) {
  return {
    lamX: await safeGetBalance(connection, dlmmPool.tokenX.publicKey, ownerPk),
    lamY: await safeGetBalance(connection, dlmmPool.tokenY.publicKey, ownerPk),
  };
}

async function topUpSolForFees(
  connection,
  dlmmPool,
  userKeypair,
  wantLamports /* BN */,
  preferMint = null,
  usdTarget = Number(process.env.SOL_TOPUP_USD ?? 10),
  maxPriceImpactPct = cfg.priceImpactPct,
  slippageBps = cfg.slippageBps
) {
  const xMint = dlmmPool.tokenX.publicKey.toString();
  const yMint = dlmmPool.tokenY.publicKey.toString();
  const xIsSol = xMint === SOL_MINT_ADDR;
  const yIsSol = yMint === SOL_MINT_ADDR;

  const { lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey);
  const dx = typeof dlmmPool.tokenX.decimal === 'number'
    ? dlmmPool.tokenX.decimal
    : await getMintDecimals(connection, dlmmPool.tokenX.publicKey);
  const dy = typeof dlmmPool.tokenY.decimal === 'number'
    ? dlmmPool.tokenY.decimal
    : await getMintDecimals(connection, dlmmPool.tokenY.publicKey);

  const pxSOL = await getPrice(SOL_MINT_ADDR);
  const pxX   = await getPrice(xMint);
  const pxY   = await getPrice(yMint);

  const lamportsFromUsd = BigInt(Math.floor((usdTarget / pxSOL) * 1e9));
  const minNeeded = BigInt(wantLamports.toString());
  const buyLamports = lamportsFromUsd < minNeeded ? minNeeded : lamportsFromUsd;

  const candidates = [];
  if (!xIsSol) candidates.push({ mint: xMint, bal: lamX, dec: dx, px: pxX });
  if (!yIsSol) candidates.push({ mint: yMint, bal: lamY, dec: dy, px: pxY });

  let input = candidates[0];
  if (preferMint && candidates.some(c => c.mint === preferMint)) {
    input = candidates.find(c => c.mint === preferMint);
  } else if (candidates.length === 2) {
    const usd0 = Number(candidates[0].bal.toString()) / 10**candidates[0].dec * candidates[0].px;
    const usd1 = Number(candidates[1].bal.toString()) / 10**candidates[1].dec * candidates[1].px;
    input = usd1 > usd0 ? candidates[1] : candidates[0];
  }
  if (!input) throw new Error('No non-SOL token to swap from for fee top-up');

  const solUi   = Number(buyLamports) / 1e9;
  const usdNeed = solUi * pxSOL;
  const inputUi = usdNeed / input.px;
  const amountRaw = BigInt(Math.max(1, Math.floor(inputUi * 10 ** input.dec)));

  LOG.info(`[fees] topping up ~${usdNeed.toFixed(2)} USD to SOL from ${input.mint}`);

  const quote = await getSwapQuote(
    input.mint,
    SOL_MINT_ADDR,
    amountRaw,
    slippageBps,
    /*maxAttempts*/ 20,
    maxPriceImpactPct
  );
  if (!quote) throw new Error('Fee top-up: no Jupiter quote');

  const sig = await executeSwap(quote, userKeypair, connection, dlmmPool, /*maxAttempts*/ 20);
  if (!sig)  throw new Error('Fee top-up: swap failed');
  LOG.info(`[fees] SOL top-up swap sig: ${sig}`);

  try { await unwrapWSOL(connection, userKeypair); } catch { }
}

// ───────────────────────────────────────────────
// Span resolution (optional external signal)
// ───────────────────────────────────────────────
async function resolveTotalBinsSpan(dlmmPool) {
  const DEFAULT_TOTAL_BINS_SPAN = Number(process.env.TOTAL_BINS_SPAN ?? 20);
  if (cfg.manualSpanMode) {
    LOG.info(`[config] MANUAL=true – using TOTAL_BINS_SPAN=${DEFAULT_TOTAL_BINS_SPAN}`);
    return DEFAULT_TOTAL_BINS_SPAN;
  }
  if (!cfg.ditherAlphaApi || !cfg.lookback) {
    LOG.warn('[config] DITHER_ALPHA_API or LOOKBACK unset – using default span');
    return DEFAULT_TOTAL_BINS_SPAN;
  }
  const stepBp =
    dlmmPool?.lbPair?.binStep ??
    dlmmPool?.binStep ??
    dlmmPool?.stepBp ??
    dlmmPool?.stepBP ??
    null;
  if (stepBp == null) {
    LOG.warn('[config] Could not determine pool step_bp – using default span');
    return DEFAULT_TOTAL_BINS_SPAN;
  }

  const mintA = dlmmPool.tokenX.publicKey.toString();
  const mintB = dlmmPool.tokenY.publicKey.toString();
  const url   = `${cfg.ditherAlphaApi}?mintA=${mintA}&mintB=${mintB}&lookback=${cfg.lookback}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      LOG.warn(`[config] API fetch failed (${res.status} ${res.statusText}) – using default span`);
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const data = await res.json();
    const gridSweep = data?.grid_sweep ?? data?.pnl_drivers?.grid_sweep;
    if (!Array.isArray(gridSweep)) {
      LOG.warn('[config] grid_sweep missing – using default span');
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const match = gridSweep.find(g => Number(g.step_bp) === Number(stepBp));
    if (!match) {
      LOG.warn(`[config] No grid_sweep entry for step_bp=${stepBp} – default span`);
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const binsPerSide = Number(match.bins);
    if (!Number.isFinite(binsPerSide) || binsPerSide <= 0) {
      LOG.warn('[config] Invalid bins value – default span');
      return DEFAULT_TOTAL_BINS_SPAN;
    }
    const span = binsPerSide * 2;
    LOG.info(`[config] Resolved TOTAL_BINS_SPAN=${span} via API (step_bp=${stepBp})`);
    return span;
  } catch (err) {
    LOG.warn('[config] Error fetching grid_sweep –', err?.message ?? err);
    return DEFAULT_TOTAL_BINS_SPAN;
  }
}

// ───────────────────────────────────────────────
// Core position operations
// ───────────────────────────────────────────────
async function openPositionForPool(connection, userKeypair, dlmmPool, enableSwap /* boolean? */) {
  return await withRetry(async () => {
    // Ensure decimals and refresh
    for (const t of [dlmmPool.tokenX, dlmmPool.tokenY]) {
      if (typeof t.decimal !== 'number') {
        t.decimal = await getMintDecimals(connection, t.publicKey);
      }
    }
    const dx = dlmmPool.tokenX.decimal;
    const dy = dlmmPool.tokenY.decimal;

    try { await dlmmPool.refetchStates(); } catch (e) {
      LOG.warn('[openForPool] refetchStates warning:', e?.message ?? e);
    }

    // Idempotent: if a position exists, return it
    try {
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);
      if (Array.isArray(userPositions) && userPositions.length > 0) {
        const pos = userPositions[0];

        let lamX = new BN(0), lamY = new BN(0);
        (pos.positionData?.positionBinData ?? []).forEach(b => {
          lamX = lamX.add(new BN(b.positionXAmount ?? 0));
          lamY = lamY.add(new BN(b.positionYAmount ?? 0));
        });

        const priceX = await getPrice(dlmmPool.tokenX.publicKey.toString());
        const priceY = await getPrice(dlmmPool.tokenY.publicKey.toString());
        const uiX = Number(lamX.toString()) / 10 ** dx;
        const uiY = Number(lamY.toString()) / 10 ** dy;
        const depositUsd = (uiX * Number(priceX ?? 0)) + (uiY * Number(priceY ?? 0));

        LOG.info('[openForPool] Existing position detected – skipping open.');
        return {
          dlmmPool,
          initialCapitalUsd: depositUsd,
          positionPubKey: pos.publicKey,
          openFeeLamports: 0,
        };
      }
    } catch (err) {
      LOG.warn('[openForPool] Could not check existing positions:', err?.message ?? err);
    }

    const X_MINT   = dlmmPool.tokenX.publicKey.toString();
    const Y_MINT   = dlmmPool.tokenY.publicKey.toString();
    const X_IS_SOL = X_MINT === SOL_MINT_ADDR;
    const Y_IS_SOL = Y_MINT === SOL_MINT_ADDR;

    let { lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey);

    const priceX = await getPrice(X_MINT);
    const priceY = await getPrice(Y_MINT);
    if (!Number.isFinite(priceX) || priceX <= 0 || !Number.isFinite(priceY) || priceY <= 0) {
      throw new Error('Price feed unavailable for one of the pool tokens');
    }

    const doSwap = resolveOpenSwapFlag(enableSwap);
    if (doSwap) {
      try {
        const usdX    = (Number(lamX.toString()) / 10 ** dx) * priceX;
        const usdY    = (Number(lamY.toString()) / 10 ** dy) * priceY;
        const diffUsd = usdY - usdX; // positive ⇒ Y richer

        if (Math.abs(diffUsd) > 0.01) {
          const inputMint  = diffUsd > 0 ? Y_MINT : X_MINT;
          const outputMint = diffUsd > 0 ? X_MINT : Y_MINT;
          const inputDecs  = diffUsd > 0 ? dy      : dx;
          const pxInputUsd = diffUsd > 0 ? priceY  : priceX;

          const usdToSwap   = Math.abs(diffUsd) / 2;
          const rawInputAmt = BigInt(Math.max(1, Math.floor((usdToSwap / pxInputUsd) * 10 ** inputDecs)));

          LOG.info(`[openForPool] Jupiter swap ${diffUsd > 0 ? 'Y→X' : 'X→Y'} for ~$${usdToSwap.toFixed(2)}`);

          const quote = await getSwapQuote(inputMint, outputMint, rawInputAmt, cfg.slippageBps, /*maxAttempts*/ 20, cfg.priceImpactPct);
          if (quote) {
            const sig = await executeSwap(quote, userKeypair, connection, dlmmPool, /*maxAttempts*/ 20);
            if (sig) {
              LOG.info(`[openForPool] swap sig: ${sig}`);
              ({ lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey));
            } else {
              LOG.warn('[openForPool] Swap executed but returned null signature – continuing.');
            }
          } else {
            LOG.warn('[openForPool] No acceptable quote – continuing without pre-swap.');
          }
        } else {
          LOG.info('[openForPool] Wallet already balanced – no pre-swap needed.');
        }
      } catch (e) {
        LOG.warn('[openForPool] Pre-swap attempt failed; continuing:', e?.message ?? e);
        ({ lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey));
      }
    } else {
      LOG.info('[openForPool] Pre-swaps disabled – skipping Jupiter swap.');
    }

    // Maintain SOL buffer before deposit
    const SOL_BUFFER = new BN(Number(cfg.solFeeBufferLamports));
    if (X_IS_SOL || Y_IS_SOL) {
      const nativeBefore = new BN(await connection.getBalance(userKeypair.publicKey, 'confirmed'));
      if (nativeBefore.lt(SOL_BUFFER)) {
        await topUpSolForFees(connection, dlmmPool, userKeypair, SOL_BUFFER);
      }
      ({ lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey));
    }

    if (X_IS_SOL) {
      if (lamX.lt(SOL_BUFFER)) {
        await topUpSolForFees(connection, dlmmPool, userKeypair, SOL_BUFFER, Y_MINT);
        ({ lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey));
        if (lamX.lt(SOL_BUFFER)) throw new Error('Not enough SOL (tokenX) after top-up to preserve SOL buffer');
      }
      lamX = lamX.sub(SOL_BUFFER);
    } else if (Y_IS_SOL) {
      if (lamY.lt(SOL_BUFFER)) {
        await topUpSolForFees(connection, dlmmPool, userKeypair, SOL_BUFFER, X_MINT);
        ({ lamX, lamY } = await fetchBalances(connection, dlmmPool, userKeypair.publicKey));
        if (lamY.lt(SOL_BUFFER)) throw new Error('Not enough SOL (tokenY) after top-up to preserve SOL buffer');
      }
      lamY = lamY.sub(SOL_BUFFER);
    } else {
      const native = new BN(await connection.getBalance(userKeypair.publicKey, 'confirmed'));
      if (native.lt(SOL_BUFFER)) {
        await topUpSolForFees(connection, dlmmPool, userKeypair, SOL_BUFFER);
      }
      const nativeCheck = await connection.getBalance(userKeypair.publicKey, 'confirmed');
      if (nativeCheck < SOL_BUFFER.toNumber()) {
        throw new Error('Native SOL still below buffer after top-up');
      }
    }

    const walletSol = await connection.getBalance(userKeypair.publicKey, 'confirmed');
    if (walletSol < SOL_BUFFER.toNumber()) {
      throw new Error('SOL buffer was consumed prior to deposit — aborting');
    }

    const uiX = Number(lamX.toString()) / 10 ** dx;
    const uiY = Number(lamY.toString()) / 10 ** dy;
    const usdX = uiX * priceX;
    const usdY = uiY * priceY;
    const depositUsd = usdX + usdY;

    LOG.info(`[openForPool] Final deposit: ${uiX.toFixed(6)} X + ${uiY.toFixed(6)} Y = $${depositUsd.toFixed(2)}`);

    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    if (!activeBin || typeof activeBin.binId !== 'number') {
      throw new Error('Could not fetch active bin for range computation');
    }

    // Range orientation
    const TOTAL_BINS_SPAN = await resolveTotalBinsSpan(dlmmPool);
    const LOWER_COEF = Number.isFinite(Number(process.env.LOWER_COEF)) ? Number(process.env.LOWER_COEF) : 0.5;
    const lowerCoefNum = (LOWER_COEF >= 0 && LOWER_COEF <= 1) ? LOWER_COEF : 0.5;
    const isCenterSwapDisabled = (typeof enableSwap === 'boolean') && !enableSwap;
    const baseLowerBins = Math.floor(TOTAL_BINS_SPAN * lowerCoefNum);

    let lowerBins, upperBins;
    if (isCenterSwapDisabled) {
      if (usdX >= usdY) {
        lowerBins = TOTAL_BINS_SPAN - baseLowerBins;
        upperBins = TOTAL_BINS_SPAN - lowerBins;
        LOG.info(`[openForPool] center-swap=false; orienting toward Y: lower=${lowerBins}, upper=${upperBins}`);
      } else {
        lowerBins = baseLowerBins;
        upperBins = TOTAL_BINS_SPAN - lowerBins;
        LOG.info(`[openForPool] center-swap=false; orienting toward X: lower=${lowerBins}, upper=${upperBins}`);
      }
    } else {
      lowerBins = baseLowerBins;
      upperBins = TOTAL_BINS_SPAN - lowerBins;
      LOG.info(`[openForPool] default split: lower=${lowerBins}, upper=${upperBins}`);
    }

    const minBin = activeBin.binId - lowerBins;
    const maxBin = activeBin.binId + upperBins;

    // Create position & add liquidity
    const posKP = Keypair.generate();
    const ixs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: posKP.publicKey,
      user:           userKeypair.publicKey,
      totalXAmount:   lamX,
      totalYAmount:   lamY,
      strategy:       {
        minBinId: minBin,
        maxBinId: maxBin,
        strategyType: asStrategyType(cfg.liquidityStrategyTypeEnv || 'Spot'),
      },
    });

    let tx;
    if (Array.isArray(ixs))             tx = new Transaction().add(...ixs);
    else if (ixs?.instructions)         tx = new Transaction().add(...ixs.instructions);
    else if (ixs instanceof Transaction) tx = ixs;
    else throw new Error('initializePositionAndAddLiquidityByStrategy returned unexpected format');

    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports })
    );
    tx.feePayer = userKeypair.publicKey;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash      = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair, posKP], {
      commitment: 'confirmed',
      skipPreflight: true,
    });
    LOG.info(`[openForPool] Position opened: ${sig}`);

    const openFeeLamports =
      (await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }))?.meta?.fee ?? 0;

    try { await unwrapWSOL(connection, userKeypair); } catch {}

    return {
      dlmmPool,
      initialCapitalUsd: depositUsd,
      positionPubKey:    posKP.publicKey,
      openFeeLamports,
    };
  }, 'openPositionForPool');
}

async function closePosition(connection, dlmmPool, userKeypair, positionPubKey) {
  return await withRetry(async () => {
    // Try SDK-provided close if available
    try {
      if (typeof dlmmPool.closePosition === 'function') {
        const ixOrTx = await dlmmPool.closePosition({
          position: positionPubKey,
          user: userKeypair.publicKey,
        });
        const sig = await sendIxOrTx({ connection, ownerKeypair: userKeypair, ixOrTx });
        LOG.info(`[close] Position closed via SDK: ${sig}`);
        return true;
      }
    } catch (e) {
      LOG.warn('[close] closePosition() failed; will fallback to remove+close:', e?.message ?? e);
    }

    await dlmmPool.refetchStates();
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userKeypair.publicKey);
    const pos = userPositions.find(p => p.publicKey.equals(positionPubKey));
    if (!pos) {
      LOG.info('[close] Position already closed.');
      return true;
    }

    const feeXBN = new BN(pos.positionData?.feeX ?? 0);
    const feeYBN = new BN(pos.positionData?.feeY ?? 0);
    const mintX  = dlmmPool.tokenX.publicKey;
    const mintY  = dlmmPool.tokenY.publicKey;

    const closeIx = await dlmmPool.removeLiquidity({
      position:            positionPubKey,
      user:                userKeypair.publicKey,
      fromBinId:           pos.positionData.lowerBinId,
      toBinId:             pos.positionData.upperBinId,
      bps:                 new BN(10_000),
      shouldClaimAndClose: true,
    });

    const sig = await sendIxOrTx({ connection, ownerKeypair: userKeypair, ixOrTx: closeIx });
    LOG.info(`[close] Position closed via remove+close: ${sig}`);

    // Optional fee sharing after claim
    try {
      if (feeXBN.gt(new BN(0))) await maybeSendFeeShare(connection, userKeypair, mintX, feeXBN);
      if (feeYBN.gt(new BN(0))) await maybeSendFeeShare(connection, userKeypair, mintY, feeYBN);
    } catch (e) {
      LOG.warn('[fees] Fee-share encountered an error (continuing):', e?.message ?? e);
    }

    return true;
  }, 'closePosition');
}

async function recenterPosition(connection, dlmmPool, userKeypair, oldPositionPubKey, enableSwap /* boolean? */) {
  LOG.info('[recenter] starting');
  const closed = await closePosition(connection, dlmmPool, userKeypair, oldPositionPubKey);
  if (!closed) {
    LOG.warn('[recenter] closePosition returned false; aborting reopen.');
    return null;
  }

  try { await unwrapWSOL(connection, userKeypair); } catch (e) {
    LOG.warn('[recenter] unwrapWSOL failed:', e?.message ?? e);
  }

  const doSwapOnCenter = resolveCenterSwapFlag(enableSwap);
  const openRes = await openPositionForPool(connection, userKeypair, dlmmPool, doSwapOnCenter);

  return {
    dlmmPool,
    openValueUsd:    openRes.initialCapitalUsd,
    positionPubKey:  openRes.positionPubKey,
    openFeeLamports: openRes.openFeeLamports,
  };
}

// ───────────────────────────────────────────────
// Liquidity ops helpers
// ───────────────────────────────────────────────
async function removeLiquidity(connection, userKeypair, pool, { positionPubkey, fromBinId, toBinId, bps, claimAndClose = false }) {
  const ixOrTx = await pool.removeLiquidity({
    position: positionPubkey,
    user: userKeypair.publicKey,
    fromBinId,
    toBinId,
    bps: new BN(bps),
    shouldClaimAndClose: !!claimAndClose,
  });
  const sig = await sendIxOrTx({ connection, ownerKeypair: userKeypair, ixOrTx });
  return sig;
}

async function addLiquidityByStrategy(connection, userKeypair, pool, {
  positionPubkey,
  totalXRaw,
  totalYRaw,
  minBinId,
  maxBinId,
  strategyType,
}) {
  const strat = { minBinId, maxBinId, strategyType: asStrategyType(strategyType) };
  const addFn1 = pool.addLiquidityToPositionByStrategy?.bind(pool);
  const addFn2 = pool.addLiquidityByStrategy?.bind(pool);

  let ixs;
  if (typeof addFn1 === 'function') {
    ixs = await addFn1({
      position: positionPubkey,
      user: userKeypair.publicKey,
      totalXAmount: new BN(totalXRaw.toString()),
      totalYAmount: new BN(totalYRaw.toString()),
      strategy: strat,
    });
  } else if (typeof addFn2 === 'function') {
    ixs = await addFn2({
      positionPubKey: positionPubkey,
      user: userKeypair.publicKey,
      totalXAmount: new BN(totalXRaw.toString()),
      totalYAmount: new BN(totalYRaw.toString()),
      strategy: strat,
    });
  } else {
    throw new Error('SDK lacks add-liquidity method');
  }

  const sig = await sendIxOrTx({ connection, ownerKeypair: userKeypair, ixOrTx: ixs });
  return sig;
}

// ───────────────────────────────────────────────
// Sleeve utilities & planner
// ───────────────────────────────────────────────
async function executeRecenters({ connection, ownerKeypair, registry, sleeveSnaps }) {
  const acted = [];
  for (const [id, r] of registry.entries()) {
    const snap = sleeveSnaps[id];
    if (!snap) continue;

    if (snap.triggers?.oor && r.positionPubkey) {
      try {
        const res = await recenterPosition(connection, r.pool, ownerKeypair, r.positionPubkey);
        if (res?.positionPubKey) {
          r.positionPubkey = res.positionPubKey;
          acted.push(id);
        }
        try { await unwrapWSOL(connection, ownerKeypair); } catch {}
      } catch (e) {
        LOG.warn(`[recenter] sleeve ${id} failed:`, e?.message ?? e);
      }
    }
  }
  return acted;
}

function computeWithdrawBps({ snap, withdrawUsd }) {
  const cur = Number(snap.totals?.totalUsd || 0);
  if (!Number.isFinite(cur) || cur <= 0) return 0;
  const frac = Math.min(0.9999, Math.max(0.0001, withdrawUsd / cur));
  return Math.max(1, Math.min(9999, Math.floor(frac * 10_000)));
}

function planAllocationsAndSwaps({ walletSnap, sleeveSnaps, demandBySleeve }) {
  const surplus = new Map(Object.entries(walletSnap).map(([m, v]) => [m, { ...v, raw: BigInt(v.raw) }]));
  const allocations = {};
  const deficitsByMint = new Map();

  for (const d of demandBySleeve) {
    const snap = sleeveSnaps[d.sleeveId];
    if (!snap) continue;

    const xMint = snap.mints.xMint;
    const yMint = snap.mints.yMint;
    const needUsd = Number(d.addUsd || 0);
    if (needUsd <= 0) continue;

    const pxX = Number(snap.prices.pxX || 0);
    const pxY = Number(snap.prices.pxY || 0);

    const targetUsdX = needUsd / 2;
    const targetUsdY = needUsd - targetUsdX;

    const sX = surplus.get(xMint);
    const sY = surplus.get(yMint);

    const takeUsdX = Math.min(targetUsdX, Math.max(0, sX?.usd ?? 0));
    const takeUsdY = Math.min(targetUsdY, Math.max(0, sY?.usd ?? 0));

    const rawX = uiToRaw(takeUsdX / (pxX || 1), sX?.decimals ?? snap.decimals.dx);
    const rawY = uiToRaw(takeUsdY / (pxY || 1), sY?.decimals ?? snap.decimals.dy);

    allocations[d.sleeveId] = { byMint: {} };
    if (rawX > 0n) allocations[d.sleeveId].byMint[xMint] = rawX;
    if (rawY > 0n) allocations[d.sleeveId].byMint[yMint] = rawY;

    if (sX && rawX > 0n) { sX.raw -= rawX; sX.ui = rawToUi(sX.raw, sX.decimals); sX.usd = sX.ui * sX.price; }
    if (sY && rawY > 0n) { sY.raw -= rawY; sY.ui = rawToUi(sY.raw, sY.decimals); sY.usd = sY.ui * sY.price; }

    const remUsdX = Math.max(0, targetUsdX - takeUsdX);
    const remUsdY = Math.max(0, targetUsdY - takeUsdY);

    if (remUsdX > 0) {
      const needRawX = uiToRaw(remUsdX / (pxX || 1), sX?.decimals ?? snap.decimals.dx);
      const cur = deficitsByMint.get(xMint) ?? { raw: 0n, decimals: sX?.decimals ?? snap.decimals.dx };
      cur.raw += needRawX; deficitsByMint.set(xMint, cur);
    }
    if (remUsdY > 0) {
      const needRawY = uiToRaw(remUsdY / (pxY || 1), sY?.decimals ?? snap.decimals.dy);
      const cur = deficitsByMint.get(yMint) ?? { raw: 0n, decimals: sY?.decimals ?? snap.decimals.dy };
      cur.raw += needRawY; deficitsByMint.set(yMint, cur);
    }
  }

  const swapPlan = [];
  const deficitsArr = Array.from(deficitsByMint.entries())
    .map(([mint, { raw, decimals }]) => {
      const s = surplus.get(mint); const px = Number(s?.price ?? 0);
      const usd = rawToUi(raw, decimals) * px;
      return { mint, raw, decimals, usd };
    })
    .sort((a, b) => b.usd - a.usd);

  for (const def of deficitsArr) {
    let neededRaw = def.raw;
    const donors = Array.from(surplus.entries())
      .filter(([m, v]) => m !== def.mint && (v?.usd ?? 0) > 0)
      .map(([m, v]) => ({ mint: m, usd: v.usd, raw: v.raw, decimals: v.decimals, price: v.price }))
      .sort((a, b) => b.usd - a.usd);

    for (const donor of donors) {
      if (neededRaw <= 0n) break;
      const donorUsd = Number(donor.usd || 0); if (donorUsd <= 0) continue;

      const needUsd = rawToUi(neededRaw, def.decimals) * Number((surplus.get(def.mint)?.price) ?? 0);
      const swapUsd = Math.min(needUsd, donorUsd);

      const donorUi = swapUsd / (donor.price || 1);
      const amountRawFrom = uiToRaw(donorUi, donor.decimals);
      if (amountRawFrom <= 0n) continue;

      swapPlan.push({ fromMint: donor.mint, toMint: def.mint, amountRawFrom });

      donor.raw -= amountRawFrom;
      donor.ui = rawToUi(donor.raw, donor.decimals);
      donor.usd = donor.ui * donor.price;
      surplus.set(donor.mint, donor);

      const defUsdCovered = donorUi * donor.price;
      const defUi = defUsdCovered / ((Number(surplus.get(def.mint)?.price) || 1));
      const defRawCovered = uiToRaw(defUi, def.decimals);
      neededRaw = neededRaw > defRawCovered ? (neededRaw - defRawCovered) : 0n;
    }
  }

  return { allocations, swapPlan };
}

// ───────────────────────────────────────────────
// Full portfolio rebalance
// ───────────────────────────────────────────────
async function executePortfolioRebalance({
  connection,
  ownerKeypair,
  registry,
  snapshot,
  intent,
}) {
  const { sleeveSnaps, walletSnap, priceCache } = snapshot;

  // 1) Removes / Closes
  for (const r of intent.removes || []) {
    const rt = registry.get(r.sleeveId);
    const snap = sleeveSnaps[r.sleeveId];
    if (!rt || !snap || !rt.positionPubkey) continue;

    const zeroTarget = (Number(rt.meta?.target_weight ?? 0) <= 1e-9);
    const almostAllUsd = Number(r.withdrawUsd || 0) >= Math.max(0, Number(snap.totals?.totalUsd || 0) - 0.01);
    const noLiquidity = (snap.amounts?.lamX?.isZero?.() && snap.amounts?.lamY?.isZero?.());

    try {
      if (zeroTarget || noLiquidity || almostAllUsd) {
        try {
          await closePosition(connection, rt.pool, ownerKeypair, rt.positionPubkey);
          rt.positionPubkey = null;
          continue;
        } catch {
          // Fallback: remove+close
          const fromBinId = snap.range.lowerBinId;
          const toBinId   = snap.range.upperBinId;
          await removeLiquidity(connection, ownerKeypair, rt.pool, {
            positionPubkey: rt.positionPubkey,
            fromBinId, toBinId,
            bps: 9999,
            claimAndClose: true,
          });
          rt.positionPubkey = null;
          continue;
        }
      }

      // Partial remove
      const bps = computeWithdrawBps({ snap, withdrawUsd: r.withdrawUsd });
      if (bps <= 0) continue;

      try {
        const sig = await removeLiquidity(connection, ownerKeypair, rt.pool, {
          positionPubkey: rt.positionPubkey,
          fromBinId: snap.range.lowerBinId,
          toBinId:   snap.range.upperBinId,
          bps,
          claimAndClose: false,
        });
        LOG.info('[rebalance-remove] sleeve=%s bps=%d sig=%s', r.sleeveId, bps, sig);
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes('6068') || msg.includes('InvalidMinimumLiquidity')) {
          LOG.warn('[rebalance-remove] %s got 6068 → fallback to close', r.sleeveId);
          try {
            await closePosition(connection, rt.pool, ownerKeypair, rt.positionPubkey);
            rt.positionPubkey = null;
          } catch (e2) {
            LOG.warn('[rebalance-remove] %s close fallback failed: %s', r.sleeveId, e2?.message ?? e2);
          }
        } else {
          LOG.warn(`[rebalance-remove] ${r.sleeveId} failed:`, msg);
        }
      }
    } catch (e) {
      LOG.warn(`[rebalance-remove] ${r.sleeveId} failed:`, e?.message ?? e);
    }
  }
  try { await unwrapWSOL(connection, ownerKeypair); } catch {}

  // 2) Refresh wallet after removes
  const mints = Object.keys(walletSnap || {});
  LOG.info('[wallet] refreshing balances for mints=', mints.length);
  const freshWallet = {};
  for (const mint of mints) {
    try {
      const decs = walletSnap[mint]?.decimals ?? await getMintDecimals(connection, new PublicKey(mint));
      const rawBN = await safeGetBalance(connection, new PublicKey(mint), ownerKeypair.publicKey);
      const raw = BigInt(rawBN.toString());
      const px = await priceCache.get(mint);
      const ui = rawToUi(raw, decs);
      const usd = ui * Number(px ?? 0);
      freshWallet[mint] = { raw, ui, usd, decimals: decs, price: Number(px ?? 0) };
    } catch (e) {
      LOG.warn(`[wallet-refresh] ${mint}:`, e?.message ?? e);
    }
  }

  // 3) Allocations & swap planning
  const { allocations, swapPlan } = planAllocationsAndSwaps({
    walletSnap: freshWallet,
    sleeveSnaps,
    demandBySleeve: intent.adds || [],
  });

  // Reserve SOL buffer for open positions + sleeves to open
  const openPositions = Array.from(registry.values()).filter(r => r.positionPubkey).length;
  const sleevesToOpen = (intent.adds || [])
    .filter(a => {
      const rt = registry.get(a.sleeveId);
      if (!rt || rt.positionPubkey) return false;
      const minLiq = Number(rt.meta?.min_liquidity_usd ?? 0);
      return Number(a.addUsd || 0) >= minLiq;
    })
    .length;

  const requiredBufferLamports =
    (BigInt(openPositions + sleevesToOpen) * cfg.solFeeBufferLamports);

  const walletSolLamports = BigInt((freshWallet[SOL_MINT_ADDR]?.raw ?? 0n).toString());
  const spendableSolLamports =
    walletSolLamports > requiredBufferLamports ? (walletSolLamports - requiredBufferLamports) : 0n;

  LOG.info(
    '[planner] reserved SOL buffer %s lamports; SOL usable ui=%s usd=%s',
    requiredBufferLamports.toString(),
    rawToUi(spendableSolLamports, 9).toFixed(6),
    (rawToUi(spendableSolLamports, 9) * Number(freshWallet[SOL_MINT_ADDR]?.price ?? 0)).toFixed(2)
  );

  // 4) Swaps (respect SOL buffer)
  if ((swapPlan || []).length) {
    LOG.info('[planner] swap legs: %j', swapPlan.map(l => ({
      from: l.fromMint, to: l.toMint, rawFrom: l.amountRawFrom.toString()
    })));
  }
  for (const leg of swapPlan || []) {
    try {
      if (leg.fromMint === SOL_MINT_ADDR) {
        const maxFrom = spendableSolLamports;
        if (leg.amountRawFrom > maxFrom) {
          LOG.info('[swap] clamp SOL leg from %s to %s (respect buffer)',
            leg.amountRawFrom.toString(), maxFrom.toString());
          if (maxFrom <= 0n) continue;
          leg.amountRawFrom = maxFrom;
        }
      }

      const amountUi = rawToUi(leg.amountRawFrom, freshWallet[leg.fromMint]?.decimals ?? 0);
      LOG.info('[swap] quote %s→%s amountUi=%s raw=%s bps=%s',
        leg.fromMint, leg.toMint, amountUi, leg.amountRawFrom.toString(), cfg.slippageBps);

      const quote = await getSwapQuote(
        leg.fromMint,
        leg.toMint,
        leg.amountRawFrom,
        cfg.slippageBps,
        /*maxAttempts*/ 20,
        cfg.priceImpactPct
      );
      if (!quote) {
        LOG.warn(`[swap] no quote ${leg.fromMint} → ${leg.toMint} for ${leg.amountRawFrom.toString()}`);
        continue;
      }
      const sig = await executeSwap(quote, ownerKeypair, connection, null, /*maxAttempts*/ 20);
      if (sig) LOG.info('[swap] success sig=%s', sig);
      else LOG.warn('[swap] swap failed (null signature).');
    } catch (e) {
      LOG.warn(`[swap] failed ${leg.fromMint} → ${leg.toMint}:`, e?.message ?? e);
    }
  }
  try { await unwrapWSOL(connection, ownerKeypair); } catch {}

  // 5) Adds (existing position or open)
  const HEADROOM_DIVISOR = 50n;
  const withHeadroom = (planned) => (planned > 0n ? (planned + (planned / HEADROOM_DIVISOR)) : 0n);
  const clampToPlan = (nowRaw, plannedRaw) => {
    const cap = withHeadroom(plannedRaw);
    if (cap <= 0n) return 0n;
    return nowRaw < cap ? nowRaw : cap;
  };

  for (const a of intent.adds || []) {
    const rt = registry.get(a.sleeveId);
    const snap = sleeveSnaps[a.sleeveId];
    if (!rt || !snap) continue;

    if (!rt.positionPubkey) {
      const minLiq = Number(rt.meta?.min_liquidity_usd ?? 0);
      if (Number(a.addUsd || 0) < minLiq) {
        LOG.warn('[open] sleeve=%s planned add $%s < min_liquidity_usd=$%s → skip open this tick',
          a.sleeveId, Number(a.addUsd || 0).toFixed(2), minLiq.toFixed(2));
        continue;
      }
      try {
        LOG.info('[open] sleeve=%s no existing position → openPositionForPool()', a.sleeveId);
        const res = await openPositionForPool(connection, ownerKeypair, rt.pool, rt.meta?.do_swap_on_open);
        rt.positionPubkey = res?.positionPubKey ?? res?.positionPubkey ?? null;
        if (!rt.positionPubkey) LOG.warn('[open] sleeve=%s open returned no position pubkey', a.sleeveId);
        else LOG.info('[open] sleeve=%s opened pos=%s', a.sleeveId, rt.positionPubkey.toBase58?.() || String(rt.positionPubkey));
      } catch (e) {
        LOG.warn('[open] sleeve=%s failed to open: %s', a.sleeveId, e?.message ?? e);
      }
      continue;
    }

    // Existing position → add within current range
    await ensurePoolDecimals(connection, rt.pool);
    const xMint = snap.mints.xMint, yMint = snap.mints.yMint;

    const byMint = allocations[a.sleeveId]?.byMint ?? {};

    const rawXNow = BigInt((await safeGetBalance(connection, new PublicKey(xMint), ownerKeypair.publicKey)).toString());
    const rawYNow = BigInt((await safeGetBalance(connection, new PublicKey(yMint), ownerKeypair.publicKey)).toString());

    const plannedRawX = byMint[xMint] ?? 0n;
    const plannedRawY = byMint[yMint] ?? 0n;

    let rawX = clampToPlan(rawXNow, plannedRawX);
    let rawY = clampToPlan(rawYNow, plannedRawY);

    if (xMint === SOL_MINT_ADDR && rawX > spendableSolLamports) rawX = spendableSolLamports;
    if (yMint === SOL_MINT_ADDR && rawY > spendableSolLamports) rawY = spendableSolLamports;

    let totalXAmount = new BN(rawX.toString());
    let totalYAmount = new BN(rawY.toString());

    if (totalXAmount.lte(new BN(0)) && totalYAmount.lte(new BN(0))) {
      LOG.info(`[add] ${a.sleeveId}: nothing to add.`);
      continue;
    }

    const lower = snap.range.lowerBinId;
    const upper = snap.range.upperBinId;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
      LOG.warn('[add] invalid range for sleeve=%s lower=%s upper=%s → skipping add', a.sleeveId, lower, upper);
      continue;
    }

    const strategyTypeEnum = asStrategyType(rt.meta?.liquidity_strategy_type ?? (cfg.liquidityStrategyTypeEnv || 'Spot'));
    const strat = { minBinId: lower, maxBinId: upper, strategyType: strategyTypeEnum };

    LOG.info(
      '[add] sleeve=%s x=%s ui=%s y=%s ui=%s',
      a.sleeveId,
      xMint,
      rawToUi(totalXAmount, rt.pool.tokenX.decimal).toFixed(6),
      yMint,
      rawToUi(totalYAmount, rt.pool.tokenY.decimal).toFixed(9),
    );
    LOG.info('[add] strategy: type=%s bins=[%s,%s]', strategyTypeEnum, lower, upper);

    try {
      const addFn1 = rt.pool.addLiquidityToPositionByStrategy?.bind(rt.pool);
      const addFn2 = rt.pool.addLiquidityByStrategy?.bind(rt.pool);

      let ixs;
      if (typeof addFn1 === 'function') {
        ixs = await addFn1({
          position: rt.positionPubkey,
          user: ownerKeypair.publicKey,
          totalXAmount,
          totalYAmount,
          strategy: strat,
        });
      } else if (typeof addFn2 === 'function') {
        ixs = await addFn2({
          positionPubKey: rt.positionPubkey,
          user: ownerKeypair.publicKey,
          totalXAmount,
          totalYAmount,
          strategy: strat,
        });
      } else {
        LOG.warn(`[add] SDK lacks add-liquidity method; skipping add for ${a.sleeveId}.`);
        continue;
      }

      const sig = await sendIxOrTx({ connection, ownerKeypair, ixOrTx: ixs });
      LOG.info('[add] success sleeve=%s sig=%s', a.sleeveId, sig);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('6054') || msg.includes('InvalidStrategyParameters')) {
        LOG.warn(
          '[add] sleeve %s failed with InvalidStrategyParameters(6054). Check type=%s, bins=[%s,%s], X=%s Y=%s.',
          a.sleeveId, strategyTypeEnum, lower, upper, totalXAmount.toString(), totalYAmount.toString()
        );
      }
      LOG.warn('[add] sleeve %s failed: %j', a.sleeveId, e?.InstructionError ? e : msg);
    }
  }

  try { await unwrapWSOL(connection, ownerKeypair); } catch {}
}

// ───────────────────────────────────────────────
// Optional wrapper: open by env POOL_ADDRESS
// ───────────────────────────────────────────────
async function openPosition(connection, userKeypair, enableSwap /* boolean? */) {
  return await withRetry(async () => {
    const poolPK = new PublicKey(process.env.POOL_ADDRESS);
    const dlmmPool = await DLMM.create(connection, poolPK);
    return await openPositionForPool(connection, userKeypair, dlmmPool, enableSwap);
  }, 'openPosition');
}

// ───────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────
export {
  // Core ops
  openPositionForPool,
  closePosition,
  recenterPosition,
  removeLiquidity,
  addLiquidityByStrategy,
  // Sleeve + planner
  executeRecenters,
  computeWithdrawBps,
  planAllocationsAndSwaps,
  executePortfolioRebalance,
  // Utilities
  fetchBalances,
  topUpSolForFees,
  // Optional env-driven open
  openPosition,
  // Re-exports for compatibility with old imports
  openPositionForPool as openDlmmPosition,
  recenterPosition as recenterPositionForPool,
};
