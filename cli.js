// ───────────────────────────────────────────────
// ~/cli.js
// ───────────────────────────────────────────────
import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { main } from './main.js';
import { fileURLToPath } from 'url';
import path from 'path';

function loadEnv() {
  const cfg = {
    RPC_URL      : process.env.RPC_URL,
    WALLET_PATH  : process.env.WALLET_PATH,
    LOG_LEVEL    : process.env.LOG_LEVEL ?? 'info'
  };
  if (!cfg.RPC_URL)     throw new Error('RPC_URL is not set');
  if (!cfg.WALLET_PATH) throw new Error('WALLET_PATH is not set');
  return cfg;
}

function parseArgs() {
  return yargs(hideBin(process.argv))
    .command('run', 'start the liquidity bot', y =>
      y.option('interval', {
        alias    : 'i',
        type     : 'number',
        describe : 'Monitor tick interval in seconds (overrides env if provided)'
      })
    )
    .demandCommand(1)
    .strict()
    .help()
    .parse();
}

async function runCli() {
  try {
    const env   = loadEnv();
    const argv  = parseArgs();
    const { interval } = argv;

    await main({
      ...env,
      MONITOR_INTERVAL_SECONDS : (interval === undefined ? undefined : interval)
    });
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const entryArg = path.resolve(process.argv[1] || '');
if (thisFile === entryArg) {
  runCli();
}

export { loadEnv, parseArgs, runCli };
