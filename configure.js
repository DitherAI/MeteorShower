// configure.js – interactive .env generator with Solana wallet support
// -------------------------------------------------------------------
// • Reads example.env (template) line‑by‑line
// • Prompts the user for every KEY, offering the template value as default
// • Ensures a Solana key‑pair exists; if not, writes ./id.json in CWD
// • After creating a wallet, prints the public address
// • Adds the public address as a comment in the .env, e.g.
//     # WALLET_ADDRESS=6yP4…JWkq
//   just above the WALLET_PATH line.
// -------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Keypair } from '@solana/web3.js';

const kvRegex = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/;

/* ---------- helpers -------------------------------------------------- */

/** Parse KEY=value pairs (ignore comments/blank lines). */
function parseTemplate(templatePath) {
  const lines = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/);
  const pairs = [];

  lines.forEach((line, idx) => {
    const match = line.match(kvRegex);
    if (match) {
      pairs.push({ key: match[1], def: match[2] });
    } else if (line.trim() && !line.trim().startsWith('#')) {
      console.warn(`[warn] line ${idx + 1} ignored (not KEY=VALUE): ${line}`);
    }
  });

  return pairs;
}

/** Ensure wallet exists, return { path, pubkey }. */
function ensureWallet(walletPath) {
  let absPath = path.resolve(walletPath);
  let kp;

  try {
    if (fs.existsSync(absPath)) {
      // Read existing wallet to get the public key
      const secret = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      kp = Keypair.fromSecretKey(Uint8Array.from(secret));
      console.log(`[info] using existing wallet at ${absPath}`);
      return { path: absPath, pubkey: kp.publicKey.toBase58() };
    }

    console.log('[info] wallet file not found — generating a new key‑pair …');
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    kp = Keypair.generate();
    fs.writeFileSync(absPath, JSON.stringify(Array.from(kp.secretKey)), {
      mode: 0o600, flag: 'wx',
    });
    console.log(`[success] new key‑pair saved to ${absPath}`);
    return { path: absPath, pubkey: kp.publicKey.toBase58() };
  } catch (err) {
    console.error(`[warn] cannot write wallet at ${absPath}: ${err.message}`);

    // Fallback to ./id.json in CWD
    const fallback = path.join(process.cwd(), 'id.json');
    try {
      kp = Keypair.generate();
      fs.writeFileSync(fallback, JSON.stringify(Array.from(kp.secretKey)), {
        mode: 0o600, flag: 'wx',
      });
      console.log(`[success] new key‑pair saved to ${fallback}`);
      return { path: fallback, pubkey: kp.publicKey.toBase58() };
    } catch (e) {
      console.error(`[error] fallback wallet creation failed: ${e.message}`);
      return { path: fallback, pubkey: kp?.publicKey?.toBase58() ?? '' };
    }
  }
}

/* ---------- main ----------------------------------------------------- */

async function main(templateFile = '.env.example', outputFile = '.env') {
  if (!fs.existsSync(templateFile)) {
    console.error(`[fatal] template not found: ${templateFile}`);
    return;
  }

  const templatePairs = parseTemplate(templateFile);
  const rl = readline.createInterface({ input, output });
  const answers = {};

  // Interactive prompt
  for (const { key, def } of templatePairs) {
    try {
      const reply = await rl.question(`${key} [${def}]: `);
      answers[key] = reply.trim() ? reply.trim() : def;
    } catch (err) {
      console.error(`[error] reading ${key}: ${err.message}`);
      answers[key] = def;
    }
  }
  rl.close();

  // Wallet handling ----------------------------------------------------
  const WALLET_VAR = 'WALLET_PATH';
  let walletPath =
    answers[WALLET_VAR] || path.join(process.cwd(), 'id.json');

  // Make relative paths explicit
  if (!path.isAbsolute(walletPath)) {
    walletPath = path.join(process.cwd(), walletPath);
  }

  const { path: finalWalletPath, pubkey } = ensureWallet(walletPath);
  answers[WALLET_VAR] = finalWalletPath;

  if (pubkey) {
    console.log(`[info] wallet public address: ${pubkey}`);
  }

  // Write .env ---------------------------------------------------------
  try {
    const lines = [];
    for (const [key, val] of Object.entries(answers)) {
      if (key === WALLET_VAR && pubkey) {
        lines.push(`# WALLET_ADDRESS=${pubkey}`); // comment with address
      }
      lines.push(`${key}=${val}`);
    }

    fs.writeFileSync(outputFile, lines.join('\n') + '\n');
    console.log(`[success] wrote ${outputFile}`);
  } catch (err) {
    console.error(`[error] writing ${outputFile}: ${err.message}`);
  }
}

main().catch((err) => console.error(`[fatal] unhandled: ${err.message}`));