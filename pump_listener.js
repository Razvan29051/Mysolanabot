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

// Settings
const BASE_INVEST_PERCENT = 0.20;
const SOL_RESERVE = 0.035;

const MIN_MC = 2000;
const MAX_MC = 160000;
const MIN_INITIAL_BUY = 0.20;

const HARD_STOP_LOSS = -6.5;
const TRAILING_ACTIVATE = 8.0;
const TRAILING_DROP = -4.2;
const TAKE_PROFIT = 20.0;

const MIN_HOLD_SECONDS = 25;
const MAX_HOLD_SECONDS = 240;
const WEAK_MOMENTUM_TIME = 45;

let activePosition = null;
let processed = new Set();
let watching = new Map();
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
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      log(`${action.toUpperCase()} attempt ${attempt} → ${mint.slice(0, 8)}`);

      const isSell = action === 'sell';

      const body = {
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: isSell ? '100%' : amount,
        denominatedInSol: isSell ? 'false' : 'true',
        slippage: isSell ? 80 : 55,
        priorityFee: isSell ? 0.025 : 0.015,
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

      const txid = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
      await new Promise(r => setTimeout(r, 3500));

      const status = await connection.getSignatureStatuses([txid]);
      if (status?.value?.[0]?.err) throw new Error('On-chain fail');

      log(`✅ ${action.toUpperCase()} SUCCESS`);
      return txid;
    } catch (err) {
      log(`❌ ${action} failed: ${err.message}`);
      if (attempt === 4) return null;
      await new Promise(r => setTimeout(r, 1800));
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

// ====================== SMART MONITOR ======================
async function checkPosition() {
  if (!activePosition) return;

  const mc = await getCurrentMc(activePosition.mint);
  if (mc <= 0) return;

  if (mc > activePosition.highestMc) {
    activePosition.highestMc = mc;
    activePosition.lastUpTime = Date.now();
  }

  const pnl = ((mc - activePosition.entryMc) / activePosition.entryMc) * 100;
  const drop = ((mc - activePosition.highestMc) / activePosition.highestMc) * 100;
  const held = (Date.now() - activePosition.entryTime) / 1000;
  const timeSinceHigh = (Date.now() - (activePosition.lastUpTime || activePosition.entryTime)) / 1000;

  log(`Monitor → PnL ${pnl.toFixed(1)}% | Drop ${drop.toFixed(1)}% | Held ${held.toFixed(0)}s`);

  let reason = null;

  if (pnl <= HARD_STOP_LOSS) reason = `Hard Stop Loss`;
  else if (pnl >= TAKE_PROFIT) reason = `Take Profit`;
  else if (pnl >= TRAILING_ACTIVATE && drop <= TRAILING_DROP) reason = `Trailing Stop`;
  else if (held > WEAK_MOMENTUM_TIME && timeSinceHigh > 35 && pnl < 6) reason = `Lost Momentum`;
  else if (held > MAX_HOLD_SECONDS) reason = `Max Hold Time`;
  else if (held < MIN_HOLD_SECONDS && pnl > -4) return;

  if (reason) {
    log(`🔴 SELL SIGNAL → ${reason}`);
    const mint = activePosition.mint;
    const spent = activePosition.spentSol;
    const entryMc = activePosition.entryMc;
    activePosition = null;

    const tx = await swap(mint, 0, 'sell');

    if (tx) {
      const profitSol = spent * (pnl / 100);
      const profitUsd = profitSol * solPrice;

      if (pnl >= 0) {
        wins++;
        consecutiveLosses = 0;
      } else {
        losses++;
        consecutiveLosses++;
        lastLossTime = Date.now();
      }

      const resultEmoji = pnl >= 0 ? '🟢' : '🔴';
      const sign = pnl >= 0 ? '+' : '';

      await sendTelegram(
        `${resultEmoji} <b>SELL</b> ${resultEmoji}\n` +
        `<code>${mint.slice(0, 10)}...</code>\n\n` +
        `Reason: <b>${reason}</b>\n` +
        `PnL: <b>${sign}${pnl.toFixed(2)}%</b>\n` +
        `Profit: <b>${sign}${profitSol.toFixed(4)} SOL</b> (≈ $${profitUsd.toFixed(2)})\n` +
        `Spent: ${spent} SOL\n\n` +
        `📊 Record: <b>${wins}W – ${losses}L</b>`
      );
    } else {
      await sendTelegram(`⚠️ <b>SELL FAILED</b>\n<code>${mint}</code>\nPlease sell manually!`);
    }
  }
}

// ====================== WATCH FOR ENTRY ======================
async function checkWatching() {
  for (const [mint, data] of watching.entries()) {
    const elapsed = Date.now() - data.firstTime;
    if (elapsed < 7000) continue;

    const currentMc = await getCurrentMc(mint);
    watching.delete(mint);

    if (currentMc <= 0 || activePosition || isBuying) continue;

    const change = ((currentMc - data.firstMc) / data.firstMc) * 100;
    log(`Watch ${mint.slice(0, 8)} → ${change.toFixed(1)}%`);

    if (change >= 3.5) {
      const available = await getAvailableToTrade();
      const amount = Number((available * getInvestPercent()).toFixed(4));
      if (amount < 0.035) continue;

      isBuying = true;
      log(`🟢 BUY SIGNAL → Momentum +${change.toFixed(1)}%`);
      const tx = await swap(mint, amount, 'buy');
      isBuying = false;

      if (tx) {
        lastBuyTime = Date.now();
        activePosition = {
          mint,
          entryMc: currentMc,
          highestMc: currentMc,
          entryTime: Date.now(),
          lastUpTime: Date.now(),
          spentSol: amount
        };

        await sendTelegram(
          `🟢 <b>BUY</b> 🟢\n` +
          `<code>${mint}</code>\n\n` +
          `Spent: <b>${amount} SOL</b> (≈ $${(amount * solPrice).toFixed(2)})\n` +
          `Momentum: <b>+${change.toFixed(1)}%</b>\n` +
          `MC: $${Math.round(currentMc)}\n\n` +
          `📊 Record: ${wins}W – ${losses}L`
        );
      }
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
    log('🟢 Connected – Smart Mode with clear signals');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy);
      if (!isNew || processed.has(mint) || activePosition || isBuying || watching.has(mint)) return;

      if (consecutiveLosses >= 2 && Date.now() - lastLossTime < 70000) return;
      if (Date.now() - lastBuyTime < 15000) return;

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      let initialBuy = 0;
      if (event.initialBuy) {
        initialBuy = event.initialBuy > 1e7 ? event.initialBuy / 1e9 : event.initialBuy;
      }
      if (initialBuy > 50) initialBuy = initialBuy / 1e9;

      const name = (event.name || event.symbol || '').trim();
      log(`New: ${mint.slice(0, 8)} | ${name.substring(0, 13)} | MC $${Math.round(mc)} | Init ${initialBuy.toFixed(2)}`);

      if (mc >= MIN_MC && mc <= MAX_MC && initialBuy >= MIN_INITIAL_BUY) {
        processed.add(mint);
        watching.set(mint, { firstMc: mc, firstTime: Date.now() });
        log(`👀 Watching ${mint.slice(0, 8)} for buy signal...`);
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
  log(`Balance: ${bal} SOL`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  setInterval(checkPosition, 4000);
  setInterval(checkWatching, 3000);

  await sendTelegram(
    `⚡ <b>Bot Started</b>\n` +
    `Clear BUY / SELL signals enabled\n` +
    `Will show profit + Win/Loss record`
  );
  startWebSocket();
}

main();
