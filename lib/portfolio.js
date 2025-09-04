// ───────────────────────────────────────────────
// ~/lib/portfolio.js
// Instrumented logging end-to-end; persistent PriceCache; wallet supplement
// ───────────────────────────────────────────────
import dlmmPackage, { StrategyType as StrategyTypeNamed } from '@meteora-ag/dlmm';
import { PublicKey } from '@solana/web3.js';
import {
  ensurePoolDecimals,
  snapshotSleeve,
  snapshotWallet,
  computeTotals,
  PriceCache,
  SOL_MINT_ADDR,
} from './valuation.js';

const DLMM = dlmmPackage?.default ?? dlmmPackage ?? {};

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG = {
  debug: (...a) => { if (['debug', 'trace'].includes(LOG_LEVEL)) console.log('[portfolio][debug]', ...a); },
  info:  (...a) => { if (['info', 'debug', 'trace'].includes(LOG_LEVEL))  console.log('[portfolio][info ]',  ...a); },
  warn:  (...a) => console.warn('[portfolio][warn ]',  ...a),
  error: (...a) => console.error('[portfolio][error]', ...a),
};

const DEFAULTS = {
  drift_bps: 150,
  min_rebalance_usd: 50,
  cooldown_seconds: 300,
  price_stale_secs: 60,
};

function normalizeStrategyType(input) {
  // Prefer SDK enum if available
  const ST = (dlmmPackage?.StrategyType ?? StrategyTypeNamed) || {};
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input ?? '').trim();
  if (s && typeof ST[s] === 'number') return ST[s];
  // case-insensitive fallback map
  const MAP = { spot: 0, stable: 1 };
  const v = MAP[s.toLowerCase()];
  if (typeof v === 'number') return v;
  // env default or Spot
  const envS = String(process.env.LIQUIDITY_STRATEGY_TYPE || 'Spot');
  if (typeof ST[envS] === 'number') return ST[envS];
  return MAP[envS.toLowerCase()] ?? 0;
}

/**
 * Normalize & validate a config object.
 */
export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  if (!Array.isArray(cfg.sleeves) || cfg.sleeves.length === 0) {
    throw new Error('portfolio config: sleeves[] is required and non-empty');
  }

  // Normalize weights to 1.0
  const weights = cfg.sleeves.map(s => Number(s.target_weight ?? 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    throw new Error('portfolio config: invalid target weights');
  }

  cfg.sleeves = cfg.sleeves.map((s, i) => ({
    id: String(s.id || `sleeve-${i}`),
    pool_address: String(s.pool_address),
    target_weight: Number(s.target_weight) / sum,
    total_bins_span: s.total_bins_span ?? null,
    lower_coef: s.lower_coef ?? null,
    edge_buffer_bins: Number.isFinite(Number(s.edge_buffer_bins))
      ? Math.trunc(Number(s.edge_buffer_bins))
      : (Number(process.env.EDGE_BUFFER_BINS ?? 0)),
    liquidity_strategy_type: normalizeStrategyType(s.liquidity_strategy_type ?? (process.env.LIQUIDITY_STRATEGY_TYPE || 'Spot')),
    do_swap_on_open: typeof s.do_swap_on_open === 'boolean'
      ? s.do_swap_on_open
      : (String(process.env.DO_SWAP_ON_OPEN ?? 'false').toLowerCase() === 'true'),
    do_swap_on_center: typeof s.do_swap_on_center === 'boolean'
      ? s.do_swap_on_center
      : (String(process.env.DO_SWAP_ON_CENTER ?? 'false').toLowerCase() === 'true'),
    min_liquidity_usd: Number(s.min_liquidity_usd ?? 0),
  }));

  LOG.info('[config] normalized portfolio config: '
    + `sleeves=${cfg.sleeves.length} drift_bps=${cfg.drift_bps} `
    + `min_rebalance_usd=${cfg.min_rebalance_usd} cooldown=${cfg.cooldown_seconds}s `
    + `price_stale_secs=${cfg.price_stale_secs}`);
  return cfg;
}

/** Build sleeve registry: instantiate DLMM pools and ensure decimals. */
export async function buildSleeveRegistry({ connection, config }) {
  const map = new Map();
  for (const s of config.sleeves) {
    LOG.info(`[registry] create DLMM for sleeve id=${s.id} pool=${s.pool_address}`);
    const pool = await DLMM.create(connection, new PublicKey(s.pool_address));
    await ensurePoolDecimals(connection, pool);
    map.set(s.id, { pool, meta: s, positionPubkey: null, lastRecenterAt: 0, lastPortfolioRebalanceAt: 0 });
  }
  return map;
}

/** Discover / attach to existing positions (first position per pool). */
export async function discoverPositions({ connection, ownerPk, registry }) {
  for (const [id, r] of registry.entries()) {
    try {
      await r.pool.refetchStates();
      const { userPositions } = await r.pool.getPositionsByUserAndLbPair(ownerPk);
      r.positionPubkey = userPositions?.[0]?.publicKey ?? null;
      LOG.info(`[discover] id=${id} position=${r.positionPubkey?.toBase58?.() || 'none'}`);
    } catch (e) {
      LOG.warn(`[discover] sleeve ${id}: ${e?.message ?? e}`);
      r.positionPubkey = null;
    }
  }
  return registry;
}

/**
 * Snapshot portfolio state (per-sleeve and wallet).
 * IMPORTANT: You can pass a persistent PriceCache (recommended).
 */
export async function snapshotPortfolio({ connection, ownerPk, registry, config, priceCache }) {
  const pc = priceCache instanceof PriceCache ? priceCache : new PriceCache(config.price_stale_secs);
  const sleeveSnaps = {};
  const walletMintSet = new Set();

  LOG.info('[snapshot] starting per-sleeve snapshots…');

  for (const [id, r] of registry.entries()) {
    try {
      const snap = await snapshotSleeve({
        connection,
        dlmmPool: r.pool,
        ownerPk,
        edgeBufferBins: r.meta.edge_buffer_bins,
        priceCache: pc,
      });
      sleeveSnaps[id] = { ...snap, meta: r.meta };
      walletMintSet.add(snap.mints.xMint);
      walletMintSet.add(snap.mints.yMint);

      LOG.info(`[snapshot] sleeve=${id} total=$${(snap.totals.totalUsd ?? 0).toFixed(2)} `
        + `liq=$${(snap.totals.liqUsd ?? 0).toFixed(2)} fees=$${(snap.totals.feesUsd ?? 0).toFixed(2)} `
        + `trigger=${snap.triggers.oor ? 'OOR' : 'ok'} side=${snap.triggers.side || '-'}`);
    } catch (e) {
      LOG.warn(`[snapshot] sleeve=${id} failed:`, e?.message ?? e);
    }
  }

  // Always include SOL for wallet
  walletMintSet.add(SOL_MINT_ADDR);

  LOG.info('[snapshot] building wallet snapshot…');
  const walletSnap = await snapshotWallet({
    connection,
    ownerPk,
    mints: Array.from(walletMintSet),
    priceCache: pc,
  });

  const totals = computeTotals({ sleeveSnaps, walletSnap });
  LOG.info(`[snapshot] totals sleeves=${totals.sleevesUsd.toFixed(2)} wallet=${totals.walletUsd.toFixed(2)} total=${totals.totalUsd.toFixed(2)}`);

  return { priceCache: pc, sleeveSnaps, walletSnap, totals, ts: Date.now() };
}

/**
 * Build intent:
 *  1) Move sleeve→sleeve (classic drift correction).
 *  2) THEN use wallet surplus (after reserving per-position SOL buffer) to fill remaining underweights.
 */
export function buildRebalanceIntent({ snapshot, config }) {
  const { sleeveSnaps, totals, walletSnap } = snapshot;

  // Targets by sleeve (USD)
  const targetById = {};
  for (const s of config.sleeves) {
    targetById[s.id] = s.target_weight * totals.totalUsd;
  }

  // Drift per sleeve
  const drift = {};
  let worstAbsRel = 0;
  for (const [id, snap] of Object.entries(sleeveSnaps)) {
    const cur = Number(snap.totals.totalUsd || 0);
    const tgt = Number(targetById[id] || 0);
    const delta = cur - tgt;            // >0 overweight, <0 underweight
    const rel = tgt > 0 ? (delta / tgt) : 0;
    drift[id] = { currentUsd: cur, targetUsd: tgt, deltaUsd: delta, rel };
    worstAbsRel = Math.max(worstAbsRel, Math.abs(rel));
  }

  const threshold = (config.drift_bps ?? 0) / 10_000;
  const trigger = worstAbsRel > threshold;

  // Partition by drift
  const over = Object.entries(drift)
    .filter(([, d]) => d.deltaUsd > 0)
    .map(([id, d]) => ({ id, deltaUsd: d.deltaUsd }))
    .sort((a, b) => b.deltaUsd - a.deltaUsd);

  const under = Object.entries(drift)
    .filter(([, d]) => d.deltaUsd < 0)
    .map(([id, d]) => ({ id, needUsd: -d.deltaUsd }))
    .sort((a, b) => b.needUsd - a.needUsd);

  // Sleeve→sleeve budget
  const totalOver  = over.reduce((s, x) => s + x.deltaUsd, 0);
  const totalUnder = under.reduce((s, x) => s + x.needUsd,  0);
  const sleeveBudget = Math.min(totalOver, totalUnder);

  const removes = [];
  const adds    = [];
  let remaining = sleeveBudget;

  for (const o of over) {
    if (remaining <= 0) break;
    const amt = Math.min(o.deltaUsd, remaining);
    removes.push({ sleeveId: o.id, withdrawUsd: amt });
    remaining -= amt;
  }

  remaining = sleeveBudget;
  for (const u of under) {
    if (remaining <= 0) break;
    const amt = Math.min(u.needUsd, remaining);
    adds.push({ sleeveId: u.id, addUsd: amt });
    remaining -= amt;
  }

  // ── Wallet supplement: use wallet surplus after reserving per-position SOL buffer
  const solPx   = Number(walletSnap[SOL_MINT_ADDR]?.price ?? 0);
  const solBufL = Number(process.env.SOL_FEE_BUFFER_LAMPORTS ?? 70_000_000); // lamports per open position
  const openCount = Object.values(sleeveSnaps).reduce((n, s) => n + (s.positionPubkey ? 1 : 0), 0);

  const solBufUi = (solBufL * openCount) / 1e9;      // SOL units to reserve
  const solBuf$  = solPx > 0 ? (solBufUi * solPx) : 0;

  const walletAvailable$ = Math.max(0, totals.walletUsd - solBuf$);
  const underRemaining   = totalUnder - sleeveBudget;

  LOG.info('[intent] worst drift %s%% (threshold %s%%) trigger=%s',
    (worstAbsRel * 100).toFixed(2),
    (threshold * 100).toFixed(2),
    trigger ? 'true' : 'false'
  );
  LOG.info('[intent] over=%d under=%d totalOver=%s totalUnder=%s sleeveBudget=%s',
    over.length, under.length,
    totalOver.toFixed(2), totalUnder.toFixed(2), sleeveBudget.toFixed(2)
  );
  LOG.info('[intent] walletAvailable(after buffer)=%s (buffer$=%s for openPositions=%d)',
    walletAvailable$.toFixed(2), solBuf$.toFixed(2), openCount
  );

  if (underRemaining > 0 && walletAvailable$ >= (config.min_rebalance_usd ?? 0)) {
    let walletBudget = Math.min(underRemaining, walletAvailable$);
    for (const u of under) {
      if (walletBudget <= 0) break;

      const already = adds.find(a => a.sleeveId === u.id)?.addUsd ?? 0;
      const still   = Math.max(0, u.needUsd - already);
      if (still <= 0) continue;

      const take = Math.min(still, walletBudget);
      const rec  = adds.find(a => a.sleeveId === u.id);
      if (rec) rec.addUsd += take; else adds.push({ sleeveId: u.id, addUsd: take });
      walletBudget -= take;
    }
  }

  // Final threshold guard
  const totalAdds = adds.reduce((s,a)=>s + a.addUsd, 0);
  const totalRems = removes.reduce((s,r)=>s + r.withdrawUsd, 0);

  if (!trigger && totalAdds <= 0 && totalRems <= 0) {
    LOG.info('[intent] below threshold and no net action');
    return { trigger: false, removes: [], adds: [], drift };
  }
  if (Math.max(totalAdds, totalRems) < (config.min_rebalance_usd ?? 0)) {
    LOG.info('[intent] below MIN_REBALANCE_USD=%s → no action', (config.min_rebalance_usd ?? 0));
    return { trigger: false, removes: [], adds: [], drift };
  }

  if (removes.length) {
    LOG.info('[intent] removes: ' + removes.map(r => `${r.sleeveId}-$${r.withdrawUsd.toFixed(2)}`).join(', '));
  }
  if (adds.length) {
    LOG.info('[intent] adds: '    + adds.map(a => `${a.sleeveId}+$${a.addUsd.toFixed(2)}`).join(', '));
  }

  return { trigger: true, removes, adds, drift };
}
