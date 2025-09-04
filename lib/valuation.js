// ───────────────────────────────────────────────
// ~/lib/valuation.js
// Instrumented logging + robust caching
// ───────────────────────────────────────────────
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { getPrice } from './jupiter.js';
import { getMintDecimals, safeGetBalance } from './solana.js';

// Exported to keep a single source in the app
export const SOL_MINT_ADDR = 'So11111111111111111111111111111111111111112';

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG = {
  debug: (...a) => { if (['debug','trace'].includes(LOG_LEVEL)) console.log('[valuation][debug]', ...a); },
  info:  (...a) => { if (['info','debug','trace'].includes(LOG_LEVEL))  console.log('[valuation][info ]',  ...a); },
  warn:  (...a) => console.warn('[valuation][warn ]',  ...a),
  error: (...a) => console.error('[valuation][error]', ...a),
};

const nowSec = () => Math.floor(Date.now() / 1000);

// -------------------------------- Price & Decimals caches ---------------------

export class PriceCache {
  constructor(ttlSec = Number(process.env.PRICE_TTL_SECONDS ?? 15)) {
    this.ttlSec = Math.max(1, ttlSec);
    this.cache = new Map(); // mint -> { px, ts }
  }

  async get(mint) {
    const k = String(mint);
    const t = nowSec();
    const hit = this.cache.get(k);

    if (hit && t - hit.ts <= this.ttlSec && Number.isFinite(hit.px) && hit.px > 0) {
      LOG.debug(`[price] HIT ${k} px=${hit.px} age=${t - hit.ts}s`);
      return hit.px;
    }

    try {
      const px = await getPrice(k); // expected USD number with its own retry/backoff
      if (!Number.isFinite(px) || px <= 0) {
        LOG.warn(`[price] BAD ${k} → ${px}; using stale=${hit?.px ?? 'none'}`);
        return hit?.px ?? null;
      }
      this.cache.set(k, { px, ts: t });
      LOG.debug(`[price] MISS ${k} px=${px}`);
      return px;
    } catch (e) {
      LOG.warn(`[price] ERR ${k}: ${e?.message ?? e}; stale=${hit?.px ?? 'none'}`);
      return hit?.px ?? null;
    }
  }

  async prefetch(mints = []) {
    await Promise.allSettled(mints.map((m) => this.get(m)));
  }
}

export class DecimalsCache {
  constructor(connection) {
    this.connection = connection;
    this.cache = new Map(); // mint -> decimals
  }
  async get(mint) {
    const k = String(mint);
    if (this.cache.has(k)) return this.cache.get(k);
    const dec = await getMintDecimals(this.connection, new PublicKey(k));
    const n = Number(dec ?? 0);
    this.cache.set(k, n);
    LOG.debug(`[decimals] ${k} -> ${n}`);
    return n;
  }
  async prefetch(mints = []) {
    await Promise.allSettled(mints.map((m) => this.get(m)));
  }
}

// -------------------------------- Conversion helpers -------------------------

export function rawToUi(raw, decimals) {
  const d = Number(decimals || 0);
  const bi = typeof raw === 'bigint' ? raw : BigInt(raw?.toString?.() ?? '0');
  if (d <= 0) return Number(bi);
  return Number(bi) / 10 ** d;
}

export function uiToRaw(ui, decimals) {
  const d = Number(decimals || 0);
  const x = Number(ui || 0);
  if (!Number.isFinite(x) || x <= 0) return 0n;
  return BigInt(Math.floor(x * 10 ** d));
}

export function valueRawUSD(raw, decimals, price) {
  const ui = rawToUi(raw, decimals);
  return ui * Number(price ?? 0);
}

function lamportsToUi(amountStr, decimals) {
  const len = amountStr.length;
  if (decimals === 0) return parseFloat(amountStr);
  if (len <= decimals) {
    return parseFloat('0.' + '0'.repeat(decimals - len) + amountStr);
  }
  return parseFloat(amountStr.slice(0, len - decimals) + '.' + amountStr.slice(len - decimals));
}
export { lamportsToUi };

// -------------------------------- DLMM sleeve valuation ----------------------

/**
 * Ensure tokenX/Y decimals are populated on the DLMM pool instance.
 */
export async function ensurePoolDecimals(connection, dlmmPool) {
  for (const t of [dlmmPool.tokenX, dlmmPool.tokenY]) {
    if (typeof t.decimal !== 'number') {
      t.decimal = await getMintDecimals(connection, t.publicKey);
      LOG.debug(`[decimals] pool ${dlmmPool?.lbPair?.publicKey?.toBase58?.() || 'unknown'} `
        + `${t.publicKey.toBase58()} -> ${t.decimal}`);
    }
  }
  return dlmmPool;
}

function sumBN(arr, field) {
  return arr.reduce((acc, b) => acc.add(new BN(b[field] ?? 0)), new BN(0));
}

/**
 * Reads lamport amounts + fees for a position (no network calls here).
 */
export function readPositionAmounts(pos) {
  const bins = pos?.positionData?.positionBinData ?? [];
  const lamX = sumBN(bins, 'positionXAmount');
  const lamY = sumBN(bins, 'positionYAmount');
  const feeX = new BN(pos?.positionData?.feeX ?? 0);
  const feeY = new BN(pos?.positionData?.feeY ?? 0);
  const lower = pos?.positionData?.lowerBinId ?? null;
  const upper = pos?.positionData?.upperBinId ?? null;
  return { lamX, lamY, feeX, feeY, lower, upper };
}

/**
 * Snapshot one sleeve:
 * - Re-fetch pool state
 * - Find user's position (first position if multiple)
 * - Compute USD valuation
 * - Return OOR/trigger fields for the execution loop
 */
export async function snapshotSleeve({
  connection,
  dlmmPool,
  ownerPk,
  edgeBufferBins = Number(process.env.EDGE_BUFFER_BINS ?? 0),
  priceCache,
}) {
  try {
    await dlmmPool.refetchStates();
  } catch (e) {
    LOG.warn('[sleeve] refetchStates failed (continuing):', e?.message ?? e);
  }

  let userPositions = [];
  try {
    ({ userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPk));
  } catch (e) {
    LOG.warn('[sleeve] getPositions failed (assuming none):', e?.message ?? e);
  }

  const position = userPositions?.[0] ?? null;

  let activeBin = null;
  try {
    activeBin = await dlmmPool.getActiveBin();
  } catch (e) {
    LOG.warn('[sleeve] getActiveBin failed:', e?.message ?? e);
  }

  await ensurePoolDecimals(connection, dlmmPool);
  const dx = dlmmPool.tokenX.decimal;
  const dy = dlmmPool.tokenY.decimal;
  const xMint = dlmmPool.tokenX.publicKey.toString();
  const yMint = dlmmPool.tokenY.publicKey.toString();

  const [pxX, pxY] = await Promise.all([priceCache.get(xMint), priceCache.get(yMint)]);

  let amounts = { lamX: new BN(0), lamY: new BN(0), feeX: new BN(0), feeY: new BN(0), lower: null, upper: null };
  if (position) amounts = readPositionAmounts(position);

  const liqUsd   = valueRawUSD(amounts.lamX, dx, pxX) + valueRawUSD(amounts.lamY, dy, pxY);
  const feesUsd  = valueRawUSD(amounts.feeX, dx, pxX) + valueRawUSD(amounts.feeY, dy, pxY);
  const totalUsd = liqUsd + feesUsd;

  const lower = amounts.lower ?? null;
  const upper = amounts.upper ?? null;
  const B = Number.isFinite(edgeBufferBins) ? Math.trunc(edgeBufferBins) : 0;

  const activeId = activeBin?.binId ?? null;
  const triggerUpper = activeId != null && upper != null ? activeId >= (upper + B) : false;
  const triggerLower = activeId != null && lower != null ? activeId <= (lower - B) : false;

  LOG.debug('[sleeve] snapshot',
    {
      pool: dlmmPool?.lbPair?.publicKey?.toBase58?.() || 'unknown',
      xMint, yMint,
      dx, dy,
      prices: { pxX, pxY },
      ui: {
        x: Number(rawToUi(amounts.lamX, dx)).toFixed(6),
        y: Number(rawToUi(amounts.lamY, dy)).toFixed(6),
        feeX: Number(rawToUi(amounts.feeX, dx)).toFixed(6),
        feeY: Number(rawToUi(amounts.feeY, dy)).toFixed(6),
      },
      usd: { liqUsd: liqUsd.toFixed(2), feesUsd: feesUsd.toFixed(2), totalUsd: totalUsd.toFixed(2) },
      bins: { lower, upper, active: activeId, edgeBuffer: B },
      triggers: { oor: (triggerUpper || triggerLower), side: triggerUpper ? 'upper' : triggerLower ? 'lower' : null },
      hasPosition: Boolean(position),
    }
  );

  return {
    mints: { xMint, yMint },
    decimals: { dx, dy },
    prices: { pxX, pxY },
    totals: { liqUsd, feesUsd, totalUsd },
    positionPubkey: position?.publicKey ?? null,
    range: { lowerBinId: lower, upperBinId: upper },
    activeBinId: activeId,
    triggers: {
      oor: triggerUpper || triggerLower,
      side: triggerUpper ? 'upper' : triggerLower ? 'lower' : null,
    },
    amounts, // BN fields for X/Y + fees
  };
}

// -------------------------------- Wallet valuation ---------------------------

/**
 * Read balances for the given set of mints (includes native SOL via special constant).
 */
export async function snapshotWallet({
  connection,
  ownerPk,
  mints,
  priceCache,
}) {
  const unique = Array.from(new Set(mints.map(String)));
  LOG.info(`[wallet] snapshot mints=${unique.length}`);
  const out = {};
  for (const mint of unique) {
    const mintPk = new PublicKey(mint);
    let decs;
    try {
      decs = await getMintDecimals(connection, mintPk);
    } catch {
      decs = mint === SOL_MINT_ADDR ? 9 : 0; // SOL has 9; best-effort fallback
    }

    const raw = await safeGetBalance(connection, mintPk, ownerPk);
    const px = await priceCache.get(mint);
    const ui = rawToUi(BigInt(raw.toString()), decs);
    const usd = ui * Number(px ?? 0);

    out[mint] = { raw: BigInt(raw.toString()), ui, usd, decimals: decs, price: px ?? 0 };
    LOG.debug(`[wallet] mint=${mint} ui=${ui.toFixed(6)} px=${Number(px ?? 0).toFixed(6)} usd=${usd.toFixed(2)}`);
  }
  return out;
}

/**
 * Compute portfolio totals from sleeve snapshots and wallet.
 */
export function computeTotals({ sleeveSnaps, walletSnap }) {
  const sleevesUsd = Object.values(sleeveSnaps).reduce((s, v) => s + (v.totals.totalUsd ?? 0), 0);
  const walletUsd  = Object.values(walletSnap).reduce((s, v) => s + (v.usd ?? 0), 0);
  const totalUsd   = sleevesUsd + walletUsd;

  LOG.info(`[totals] sleeves=${sleevesUsd.toFixed(2)} wallet=${walletUsd.toFixed(2)} total=${totalUsd.toFixed(2)}`);
  return { sleevesUsd, walletUsd, totalUsd };
}
