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

// ====== SETTINGS ======
const INVEST_PERCENT = 0.25;          // 25% of available balance
const SOL_RESERVE = 0.04;

const MIN_MC = 4000;
const MAX_MC = 160000;
const MIN_INITIAL_BUY = 0.35;         // As you requested

// Faster profit taking
const HARD_STOP_LOSS = -7.5;
const TRAILING_ACTIVATE = 9.0;        // Start trailing earlier
const TRAILING_DROP = -5.0;           // Tighter trail
const TAKE_PROFIT = 26.0;             // Quicker TP
const MAX_HOLD_SECONDS = 280;         // Don't hold too long

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

async function getRealBalance() {
  try {
    const bal = await connection.getBalance(wallet.publicKey, 'confirmed');
    return Number((bal / LAMPORTS_PER_SOL).toFixed(4));
  } catch (err) {
    log(`Balance error: ${err.message}`);
    return 0;
  }
}

async function getAvailableToTrade() {
  const realBalance = await getRealBalance();
  return Math.max(0, Number((realBalance - SOL_RESERVE).toFixed(4)));
}

// ====================== SWAP ======================
async function swap(mint, amount, action = 'buy') {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`${action.toUpperCase()} attempt ${attempt} → ${mint.slice(0, 8)} | ${amount}`);

      const body = {
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: action === 'sell' ? '100%' : amount,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: action === 'sell' ? 60 : 50,
        priorityFee: action === 'sell' ? 0.015 : 0.012,
        pool: 'auto'
      };

      const res = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) throw new Error(await res.text());

      const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
      tx.sign([wallet]);

      const txid = await connection.sendTransaction(tx, {
        skipPreflight: true,
        maxRetries: 4
      });

      await new Promise(r => setTimeout(r, 3000));
      const status = await connection.getSignatureStatus(txid);

      if (status?.value?.err) throw new Error('On-chain error');

      log(`✅ ${action.toUpperCase()} SUCCESS: ${txid}`);
      return txid;

    } catch (err) {
      log(`❌ ${action} attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) return null;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
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

  const pnlPercent = ((mc - activePosition.entryMc) / activePosition.entryMc) * 100;
  const dropFromHigh = ((mc - activePosition.highestMc) / activePosition.highestMc) * 100;
  const held = (Date.now() - activePosition.entryTime) / 1000;

  log(`Monitor → PnL ${pnlPercent.toFixed(1)}% | Drop ${dropFromHigh.toFixed(1)}%`);

  let reason = null;
  if (pnlPercent <= HARD_STOP_LOSS) reason = `Hard SL`;
  else if (pnlPercent >= TRAILING_ACTIVATE && dropFromHigh <= TRAILING_DROP) reason = `Trailing Stop`;
  else if (pnlPercent >= TAKE_PROFIT) reason = `Take-Profit`;
  else if (held > MAX_HOLD_SECONDS) reason = `Max hold`;

  if (reason) {
    log(`🔴 EXIT ${activePosition.mint.slice(0, 8)} | ${reason}`);

    const mint = activePosition.mint;
    const spentSol = activePosition.spentSol;

    activePosition = null;

    const sellTx = await swap(mint, 0, 'sell');

    if (sellTx) {
      await sendTelegram(
        `🔴 <b>Closed</b> <code>${mint.slice(0, 8)}</code>\n` +
        `Reason: ${reason}\n` +
        `Spent: ${spentSol.toFixed(4)} SOL`
      );
    } else {
      await sendTelegram(`⚠️ SELL FAILED <code>${mint.slice(0, 8)}</code>\nSell manually!`);
    }
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
    log('🟢 Connected – Fast Profit Mode');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy);

      if (!isNew || processed.has(mint) || activePosition || isBuying) return;
      
      // Shorter cooldown
      if (Date.now() - lastBuyTime < 25000) return;

      const name = (event.name || event.symbol || '').trim();

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      let initialBuy = 0;
      if (event.initialBuy) {
        initialBuy = event.initialBuy > 1e7 ? event.initialBuy / 1e9 : event.initialBuy;
      }
      if (initialBuy > 50) initialBuy = initialBuy / 1e9;

      log(`New: ${mint.slice(0, 8)} | ${name.substring(0, 14)} | MC $${Math.round(mc)} | Init ${initialBuy.toFixed(2)}`);

      if (mc >= MIN_MC && mc <= MAX_MC && initialBuy >= MIN_INITIAL_BUY && name.length >= 2) {
        
        const realBalance = await getRealBalance();
        const available = await getAvailableToTrade();
        const amount = Number((available * INVEST_PERCENT).toFixed(4));

        log(`Balance: ${realBalance} SOL | Investing: ${amount} SOL`);

        if (amount < 0.05) return;

        processed.add(mint);
        isBuying = true;

        log(`🚀 BUYING ${amount} SOL`);
        const tx = await swap(mint, amount, 'buy');
        isBuying = false;

        if (tx) {
          lastBuyTime = Date.now();
          activePosition = {
            mint,
            entryMc: mc,
            highestMc: mc,
            entryTime: Date.now(),
            spentSol: amount
          };

          await sendTelegram(
            `🚀 <b>ENTRY</b>\n` +
            `<code>${mint}</code>\n` +
            `Spent: <b>${amount} SOL</b>\n` +
            `MC: $${Math.round(mc)}\n` +
            `Init: ${initialBuy.toFixed(2)} SOL`
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
  log(`Mode: InitBuy 0.35 | Fast TP | 25% balance`);

  const startBalance = await getRealBalance();
  log(`Starting Balance: ${startBalance} SOL`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  setInterval(checkPosition, 6000);

  await sendTelegram(`⚡ <b>Bot Updated</b>\nMin InitBuy: 0.35 SOL\nFaster take-profit\n25% of balance`);
  startWebSocket();
}

main();
