import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// ====================== CONFIG ======================
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_ENDPOINT || !RAW_PRIVATE_KEY) {
  console.error('Missing RPC_ENDPOINT or PRIVATE_KEY');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

// ====== STRICTER QUALITY FILTERS ======
const MAX_BUY_SOL = 0.15;
const SOL_RESERVE = 0.04;

const MIN_MC = 9000;               // Higher to avoid micro rugs
const MAX_MC = 120000;
const MIN_INITIAL_BUY = 0.55;      // Much stronger initial buy required

// Exit (more protective)
const HARD_STOP_LOSS = -8.0;
const TRAILING_ACTIVATE = 12.0;
const TRAILING_DROP = -6.0;
const TAKE_PROFIT = 38.0;
const MAX_HOLD_SECONDS = 360;

let activePosition = null;
let processed = new Set();
let isBuying = false;
let solPrice = 180;
let lastBuyTime = 0;
let ws = null;

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
  } catch {}
}

async function getBalance() {
  const bal = await connection.getBalance(wallet.publicKey);
  return Math.max(0, Number(((bal / LAMPORTS_PER_SOL) - SOL_RESERVE).toFixed(4)));
}

async function swap(mint, amount, action = 'buy') {
  try {
    log(`${action.toUpperCase()} → ${mint.slice(0, 8)} | ${amount} SOL`);
    const res = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: action === 'sell' ? '100%' : amount,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: 48,
        priorityFee: 0.012,
        pool: 'auto'
      })
    });
    if (!res.ok) throw new Error(await res.text());
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([wallet]);
    const txid = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
    log(`✅ ${action.toUpperCase()} SUCCESS: ${txid}`);
    return txid;
  } catch (err) {
    log(`❌ ${action.toUpperCase()} FAILED: ${err.message}`);
    return null;
  }
}

async function getCurrentMc(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await res.json();
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      return parseFloat(pair.marketCap || pair.fdv || 0);
    }
  } catch {}
  return 0;
}

// ====================== MONITOR ======================
async function checkPosition() {
  if (!activePosition) return;

  const mc = await getCurrentMc(activePosition.mint);
  if (mc <= 0) return;

  if (mc > activePosition.highestMc) activePosition.highestMc = mc;

  const pnl = ((mc - activePosition.entryMc) / activePosition.entryMc) * 100;
  const dropFromHigh = ((mc - activePosition.highestMc) / activePosition.highestMc) * 100;
  const held = (Date.now() - activePosition.entryTime) / 1000;

  log(`Monitor → PnL ${pnl.toFixed(1)}% | Drop ${dropFromHigh.toFixed(1)}%`);

  let reason = null;
  if (pnl <= HARD_STOP_LOSS) reason = `Hard SL ${pnl.toFixed(1)}%`;
  else if (pnl >= TRAILING_ACTIVATE && dropFromHigh <= TRAILING_DROP) reason = `Trailing ${dropFromHigh.toFixed(1)}%`;
  else if (pnl >= TAKE_PROFIT) reason = `Take-Profit +${pnl.toFixed(1)}%`;
  else if (held > MAX_HOLD_SECONDS) reason = `Max hold`;

  if (reason) {
    log(`🔴 EXIT ${activePosition.mint.slice(0, 8)} | ${reason}`);
    const mint = activePosition.mint;
    activePosition = null;
    await swap(mint, 0, 'sell');
    await sendTelegram(`🔴 Closed <code>${mint.slice(0, 8)}</code>\n${reason}\nPnL: <b>${pnl.toFixed(1)}%</b>`);
  }
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  if (ws) {
    try { ws.terminate(); } catch {}
  }

  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  log('Connecting...');
  ws = new WebSocket(url);

  ws.on('open', () => {
    log('🟢 Connected – Strict Quality Mode');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy);

      if (!isNew || processed.has(mint) || activePosition || isBuying) return;

      // Cooldown between buys (45 seconds)
      if (Date.now() - lastBuyTime < 45000) return;

      const name = (event.name || event.symbol || '').trim();

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      let initialBuy = 0;
      if (event.initialBuy) {
        initialBuy = event.initialBuy > 1e7 ? event.initialBuy / 1e9 : event.initialBuy;
      }
      if (initialBuy > 50) initialBuy = initialBuy / 1e9;

      log(`New: ${mint.slice(0, 8)} | ${name.substring(0, 16)} | MC $${Math.round(mc)} | Init ${initialBuy.toFixed(2)}`);

      // Strict filters
      if (
        mc >= MIN_MC &&
        mc <= MAX_MC &&
        initialBuy >= MIN_INITIAL_BUY &&
        name.length >= 3
      ) {
        processed.add(mint);

        const amount = Math.min(await getBalance(), MAX_BUY_SOL);
        if (amount < 0.06) return;

        isBuying = true;
        log(`🚀 QUALITY BUY ${amount} SOL`);
        const tx = await swap(mint, amount, 'buy');
        isBuying = false;

        if (tx) {
          lastBuyTime = Date.now();
          activePosition = {
            mint,
            entryMc: mc,
            highestMc: mc,
            entryTime: Date.now()
          };
          await sendTelegram(
            `🚀 <b>QUALITY ENTRY</b>\n` +
            `Mint: <code>${mint}</code>\n` +
            `Spent: <b>${amount} SOL</b>\n` +
            `MC: $${Math.round(mc)}\n` +
            `Init Buy: ${initialBuy.toFixed(2)} SOL`
          );
        }
      }
    } catch (err) {
      log(`Error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    log('Reconnecting in 5s...');
    setTimeout(startWebSocket, 5000);
  });

  ws.on('error', (err) => log(`WS Error: ${err.message}`));
}

// ====================== MAIN ======================
async function main() {
  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`Strict Mode: Min InitBuy ${MIN_INITIAL_BUY} SOL | Min MC $${MIN_MC}`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  setInterval(checkPosition, 7000);

  await sendTelegram(`⚡ <b>Strict Quality Mode Activated</b>\nMin InitBuy: ${MIN_INITIAL_BUY} SOL`);
  startWebSocket();
}

main();
