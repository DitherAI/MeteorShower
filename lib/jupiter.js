// ───────────────────────────────────────────────
// ~/lib/jupiter.js
// ───────────────────────────────────────────────
import fetch from 'node-fetch';
import { URL } from 'url';
import { VersionedTransaction } from '@solana/web3.js';
import { lamportsToUi } from './valuation.js';
import { getMintDecimals } from './solana.js';
import { PublicKey } from '@solana/web3.js';

const ENV_SLIPPAGE_BPS = Number(process.env.SLIPPAGE ?? 10);
const ENV_PRICE_IMPACT = Number(process.env.PRICE_IMPACT ?? 0.5);
const ENV_PRIORITY_μLAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 50_000);

/**
 * Fetch a Jupiter quote with the given slippageBps.
 * price_impact is a local guard; not sent to Jupiter.
 */
export async function getSwapQuote(
  inputMint,
  outputMint,
  amountRaw,
  slippageBps = ENV_SLIPPAGE_BPS,
  maxAttempts = 20,
  price_impact = ENV_PRICE_IMPACT
) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
      url.searchParams.set('inputMint', inputMint);
      url.searchParams.set('outputMint', outputMint);
      url.searchParams.set('amount', amountRaw.toString());
      url.searchParams.set('slippageBps', String(Math.max(0, Math.floor(slippageBps))));

      const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`Quote failed: ${res.status} ${res.statusText}`);

      const quote = await res.json();
      // Jupiter returns priceImpactPct as fraction (e.g., 0.003 = 0.3%)
      const impactPct = Number(quote.priceImpactPct ?? 0) * 100;

      // Guard on local price impact
      if (impactPct <= price_impact) {
        // Ensure the quote we pass down carries the slippage used
        quote.slippageBps = Math.max(0, Math.floor(slippageBps));
        return quote;
      }

      // Backoff a little and retry if price impact too high
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      if (attempt >= maxAttempts) {
        return null;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

/**
 * Execute a Jupiter swap. Slippage is now consistent:
 * - Prefer explicit override,
 * - else use quoteResponse.slippageBps (from getSwapQuote),
 * - else fall back to env SLIPPAGE.
 */
export async function executeSwap(
  quoteResponse,
  userKeypair,
  connection,
  dlmmPool,
  maxAttempts = 20,
  opts = {} // { slippageBps?: number }
) {
  let attempt = 0;
  let currentQuote = quoteResponse;

  const inMint = quoteResponse.inputMint;
  const outMint = quoteResponse.outputMint;
  const inAmountRaw = quoteResponse.inAmount;

  const computedSlippage =
    Number.isFinite(opts.slippageBps) ? Number(opts.slippageBps) :
    Number.isFinite(currentQuote?.slippageBps) ? Number(currentQuote.slippageBps) :
    ENV_SLIPPAGE_BPS;

  const slippageBps = Math.max(0, Math.floor(computedSlippage));

  while (attempt < maxAttempts) {
    attempt += 1;

    // (1) Build a fresh swap each attempt, with the **correct slippage**
    let swapJson;
    try {
      const body = {
        quoteResponse: currentQuote,
        userPublicKey: userKeypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,

        // IMPORTANT: make slippage consistent with the quote / env
        slippageBps,
        // Keep dynamicSlippage but align it to the same bps so it never tightens below requested
        dynamicSlippage: { maxBps: slippageBps },

        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: ENV_PRIORITY_μLAMPORTS,
            priorityLevel: 'veryHigh',
          },
        },
      };

      const buildRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!buildRes.ok) {
        throw new Error(`Swap build failed: ${buildRes.status} ${buildRes.statusText}`);
      }

      swapJson = await buildRes.json();
    } catch (e) {
      if (attempt >= maxAttempts) return null;

      // Re‑quote with same slippage
      await new Promise(r => setTimeout(r, 500));
      const fresh = await getSwapQuote(inMint, outMint, inAmountRaw, slippageBps);
      if (!fresh) return null;
      currentQuote = fresh;
      continue;
    }

    // (2) Send
    try {
      const { swapTransaction } = swapJson;
      const swapTx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

      const fresh = await connection.getLatestBlockhash('confirmed');
      swapTx.message.recentBlockhash = fresh.blockhash;
      swapTx.sign([userKeypair]);

      const sig = await connection.sendRawTransaction(swapTx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(
        { signature: sig, blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight },
        'confirmed'
      );

      // Optional metrics (kept from your original)
      try {
        const txInfo = await connection.getTransaction(sig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (txInfo?.meta?.err) throw new Error('swap transaction reverted on-chain');

        // Realised-slippage / spread computations (best-effort)
        const inDecs = (await getMintDecimals(connection, new PublicKey(inMint))) ?? 0;
        const outDecs = (await getMintDecimals(connection, new PublicKey(outMint))) ?? 0;

        const inUi = lamportsToUi(currentQuote.inAmount, inDecs);
        const outUi = lamportsToUi(currentQuote.outAmount, outDecs);

        const inUsd = inUi * (await getPrice(inMint));
        const outUsd = outUi * (await getPrice(outMint));
      } catch {
      }

      return sig;
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500));
        const fresh = await getSwapQuote(inMint, outMint, inAmountRaw, slippageBps);
        if (!fresh) return null;
        currentQuote = fresh;
        continue;
      }
      return null;
    }
  }

  return null;
}

async function getPrice(mint) {
  try {
    const url = new URL("https://lite-api.jup.ag/price/v2");
    url.searchParams.set("ids", mint);

    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`[getPrice] HTTP ${res.status} for mint ${mint}`);
      return null;
    }

    const json = await res.json();          

    const entry  = json?.data?.[mint];
    if (!entry || entry.price == null) {
      console.error(`[getPrice] no price field for mint ${mint}`);
      return null;
    }

    const px = typeof entry.price === "number"
      ? entry.price
      : parseFloat(entry.price);

    return Number.isFinite(px) ? px : null;
  } catch (err) {
    console.error(`[getPrice] exception for mint ${mint}: ${err.message}`);
    return null;
  }
}

export { getPrice };