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
const BASE_INVEST_PERCENT = 0.22;
const SOL_RESERVE = 0.04;

const MIN_MC = 2800;
const MAX_MC = 150000;
const MIN_INITIAL_BUY = 0.25;          // Slightly lowered

const HARD_STOP_LOSS = -6.0;
const TRAILING_ACTIVATE = 6.5;
const TRAILING_DROP = -3.8;
const TAKE_PROFIT = 16.0;
const MAX_HOLD_SECONDS = 150;

let activePosition = null;
let processed = new Set();
let isBuying = false;
let solPrice = 180;
let lastBuyTime = 0;
let ws = null;

let wins = 0;
let losses = 0;
let consecutiveLosses = 0;
let lastLossTime = 0;

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
  } catch {
    return 0;
  }
}

async function getAvailableToTrade() {
  const real = await getRealBalance();
  return Math.max(0, Number((real - SOL_RESERVE).toFixed(4)));
}

function getInvestPercent() {
  if (consecutiveLosses >= 3) return 0.10;
  if (consecutiveLosses === 2) return 0.14;
  return BASE_INVEST_PERCENT;
}

// ====================== SWAP ======================
async function swap(mint, amount, action = 'buy') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log(`${action.toUpperCase()} #${attempt} → ${mint.slice(0, 8)} | ${amount}`);

      const body = {
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: action === 'sell' ? '100%' : amount,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: action === 'sell' ? 70 : 50,
        priorityFee: action === 'sell' ? 0.02 : 0.014,
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

      await new Promise(r => setTimeout(r, 2200));
      const status = await connection.getSignatureStatus(txid);
      if (status?.value?.err) throw new Error('On-chain fail');

      log(`✅ ${action.toUpperCase()} SUCCESS`);
      return txid;
    } catch (err) {
      log(`❌ ${action} failed: ${err.message}`);
      if (attempt === 3) return null;
      await new Promise(r => setTimeout(r, 1100));
    }
  }
  return null;
}

async function getCurrentMc(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await res.json();
    if (data.pairs?.length > 0) {
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
  const drop = ((mc - activePosition.highestMc) / activePosition.highestMc) * 100;
  const held = (Date.now() - activePosition.entryTime) / 1000;

  log(`Monitor → PnL ${pnl.toFixed(1)}% | Drop ${drop.toFixed(1)}%`);

  let reason = null;
  if (pnl <= HARD_STOP_LOSS) reason = `Hard SL (${pnl.toFixed(1)}%)`;
  else if (pnl >= TRAILING_ACTIVATE && drop <= TRAILING_DROP) reason = `Trailing (${drop.toFixed(1)}%)`;
  else if (pnl >= TAKE_PROFIT) reason = `Take-Profit (+${pnl.toFixed(1)}%)`;
  else if (held > MAX_HOLD_SECONDS) reason = `Max hold`;
  else if (held > 35 && pnl < 2) reason = `No momentum`;

  if (reason) {
    log(`🔴 EXIT → ${reason}`);
    const mint = activePosition.mint;
    const spent = activePosition.spentSol;
    activePosition = null;

    const tx = await swap(mint, 0, 'sell');

    if (tx) {
      if (pnl >= 0) {
        wins++;
        consecutiveLosses = 0;
      } else {
        losses++;
        consecutiveLosses++;
        lastLossTime = Date.now();
      }

      await sendTelegram(`🔴 <b>Closed</b>\n<code>${mint.slice(0, 8)}</code>\n${reason}\nSpent: ${spent} SOL\nRecord: ${wins}W/${losses}L`);
    } else {
      await sendTelegram(`⚠️ SELL FAILED: <code>${mint.slice(0, 8)}</code>`);
    }
  }
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  if (ws) try { ws.terminate(); } catch {}

  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  ws = new WebSocket(url);

  ws.on('open', () => {
    log('🟢 Connected – InitBuy 0.25 + Fast TP');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy);
      if (!isNew || processed.has(mint) || activePosition || isBuying) return;

      if (consecutiveLosses >= 2 && Date.now() - lastLossTime < 80000) return;
      if (Date.now() - lastBuyTime < 18000) return;

      const name = (event.name || event.symbol || '').trim();

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      let initialBuy = 0;
      if (event.initialBuy) {
        initialBuy = event.initialBuy > 1e7 ? event.initialBuy / 1e9 : event.initialBuy;
      }
      if (initialBuy > 50) initialBuy = initialBuy / 1e9;

      log(`New: ${mint.slice(0, 8)} | ${name.substring(0, 13)} | MC $${Math.round(mc)} | Init ${initialBuy.toFixed(2)}`);

      if (mc >= MIN_MC && mc <= MAX_MC && initialBuy >= MIN_INITIAL_BUY && name.length >= 2) {
        const available = await getAvailableToTrade();
        const investPct = getInvestPercent();
        const amount = Number((available * investPct).toFixed(4));

        log(`Available: ${available} | Investing: ${amount} SOL`);

        if (amount < 0.04) return;

        processed.add(mint);
        isBuying = true;

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

  ws.on('close', () => setTimeout(startWebSocket, 4000));
  ws.on('error', (err) => log(`WS Error: ${err.message}`));
}

// ====================== MAIN ======================
async function main() {
  log(`Wallet: ${wallet.publicKey.toString()}`);
  const bal = await getRealBalance();
  log(`Balance: ${bal} SOL | InitBuy: 0.25 | Fast TP`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  setInterval(checkPosition, 4000);

  await sendTelegram(`⚡ <b>Bot Updated</b>\nMin InitBuy: 0.25 SOL\nFast Take-Profit: +16%\nMin MC: $2800`);
  startWebSocket();
}

main();
