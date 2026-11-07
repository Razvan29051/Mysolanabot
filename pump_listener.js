import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// ====================== CONFIG ======================
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';
const CODEX_API_KEY = process.env.CODEX_API_KEY || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('=== BOT STARTING ===');

if (!RPC_ENDPOINT || !RAW_PRIVATE_KEY) {
  console.error('Missing RPC_ENDPOINT or PRIVATE_KEY');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const MAX_BUY_SOL = 0.17;
const SOL_RESERVE = 0.04;
const MIN_MC = 6000;
const MAX_MC = 160000;

let activePosition = null;
let processed = new Set();
let isBuying = false;
let solPrice = 180;

// ====================== HELPERS ======================
function log(msg) {
  const t = new Date().toISOString().substr(11, 8);
  console.log(`[${t}] ${msg}`);
}

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {}
}

async function getBalance() {
  const bal = await connection.getBalance(wallet.publicKey);
  return Math.max(0, Number(((bal / LAMPORTS_PER_SOL) - SOL_RESERVE).toFixed(4)));
}

async function swap(mint, amount, action = 'buy') {
  try {
    log(`${action.toUpperCase()} ${mint.slice(0, 8)} | ${amount} SOL`);

    const res = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: action === 'sell' ? '100%' : amount,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: 50,
        priorityFee: 0.01,
        pool: 'auto'
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([wallet]);

    const txid = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 4 });
    log(`SUCCESS ${action}: ${txid}`);
    return txid;
  } catch (err) {
    log(`FAILED ${action}: ${err.message}`);
    return null;
  }
}

// ====================== PUMPPORTAL ======================
function startPumpPortal() {
  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  log('Starting PumpPortal...');
  const ws = new WebSocket(url);

  ws.on('open', () => {
    log('PumpPortal connected');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy);

      // Exit check
      if (activePosition && mint === activePosition.mint) {
        let mc = 0;
        if (event.marketCapSol) mc = event.marketCapSol * solPrice;
        else if (event.marketCapUsd) mc = event.marketCapUsd;

        if (mc > 0) {
          const pnl = ((mc - activePosition.entryMc) / activePosition.entryMc) * 100;
          if (pnl <= -7 || pnl >= 28) {
            log(`EXIT ${mint.slice(0, 8)} | PnL ${pnl.toFixed(1)}%`);
            const old = activePosition.mint;
            activePosition = null;
            await swap(old, 0, 'sell');
            await sendTelegram(`Closed ${old.slice(0, 8)} | PnL ${pnl.toFixed(1)}%`);
          }
        }
        return;
      }

      if (!isNew || processed.has(mint) || activePosition || isBuying) return;

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      let initialBuy = 0;
      if (event.initialBuy) {
        initialBuy = event.initialBuy > 1e6 ? event.initialBuy / 1e9 : event.initialBuy;
      }

      log(`New token: ${mint.slice(0, 8)} | MC $${Math.round(mc)} | Init ${initialBuy.toFixed(2)}`);

      if (mc >= MIN_MC && mc <= MAX_MC && initialBuy >= 0.25) {
        processed.add(mint);
        const amount = Math.min(await getBalance(), MAX_BUY_SOL);
        if (amount < 0.06) return;

        isBuying = true;
        log(`BUYING ${amount} SOL`);
        const tx = await swap(mint, amount, 'buy');
        isBuying = false;

        if (tx) {
          activePosition = { mint, entryMc: mc, entryTime: Date.now() };
          await sendTelegram(`BOUGHT ${mint.slice(0, 8)}\n${amount} SOL\nMC $${Math.round(mc)}`);
        }
      }
    } catch (err) {
      log(`PumpPortal error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    log('PumpPortal closed – reconnecting');
    setTimeout(startPumpPortal, 4000);
  });

  ws.on('error', (err) => log(`PumpPortal error: ${err.message}`));
}

// ====================== MAIN ======================
async function main() {
  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`RPC: ${RPC_ENDPOINT.slice(0, 50)}...`);
  log(`Codex Key: ${CODEX_API_KEY ? 'Yes' : 'No'}`);
  log(`PumpPortal Key: ${PUMPPORTAL_API_KEY ? 'Yes' : 'No'}`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  await sendTelegram('Bot started – Hybrid (PumpPortal focus)');
  startPumpPortal();

  // Note: Codex is temporarily disabled until we confirm the plan supports WebSockets
  log('Codex temporarily disabled (plan may not support subscriptions)');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
