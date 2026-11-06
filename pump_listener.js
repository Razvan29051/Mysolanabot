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
  console.error('❌ Missing RPC_ENDPOINT or PRIVATE_KEY');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const SOL_RESERVE = 0.05;
const MAX_BUY_SOL = 0.25;

// ========== AGGRESSIVE MOMENTUM FILTERS ==========
const MIN_MARKET_CAP_USD = 9000;
const MAX_MARKET_CAP_USD = 180000;
const MIN_AGE_SECONDS = 25;
const MIN_SOL_INFLOW = 1.2;
const MIN_BUY_TRADES = 6;
const MIN_BUY_RATIO = 0.59;
const MIN_RECENT_BUYS = 4;
const RECENT_WINDOW_MS = 30_000;

// ========== QUICK PROFIT EXITS ==========
const HARD_STOP_LOSS = -6.5;
const TRAILING_ACTIVATION = 9.0;
const TRAILING_DROP = -4.2;
const TAKE_PROFIT = 29.0;
const MAX_HOLD_MS = 8 * 60 * 1000;
const NO_UPDATE_MS = 10_000;

// ========== STATE ==========
let activePositions = new Map();
let tokenTrackers = new Map();
let processedMints = new Set();
let globalWs = null;
let solPriceUsd = 180;
let isBuying = false;
let lastLossTime = 0;

// ====================== HELPERS ======================
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

function log(msg) {
  const t = new Date().toISOString().substr(11, 8);
  process.stdout.write(`[${t}] ${msg}\n`);
}

async function updateSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    if (data?.solana?.usd) solPriceUsd = data.solana.usd;
  } catch {}
}

async function getSpendableSol() {
  const bal = await connection.getBalance(wallet.publicKey);
  return Math.max(0, Number(((bal / LAMPORTS_PER_SOL) - SOL_RESERVE).toFixed(4)));
}

// ====================== SWAP ======================
async function executeSwap(mint, amount, action = 'buy') {
  try {
    log(`🔄 ${action.toUpperCase()} ${mint.slice(0, 8)}... | ${amount} SOL`);

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

    const txid = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 4
    });

    log(`✅ ${action.toUpperCase()} sent: ${txid}`);
    return txid;
  } catch (err) {
    log(`❌ ${action.toUpperCase()} failed: ${err.message}`);
    return null;
  }
}

// ====================== PARSER ======================
function parseEvent(event) {
  if (!event.mint) return null;

  let mcUsd = 0;
  if (event.marketCapSol) mcUsd = event.marketCapSol * solPriceUsd;
  else if (event.marketCapUsd) mcUsd = event.marketCapUsd;
  else if (event.usd_market_cap) mcUsd = event.usd_market_cap;

  const txType = (event.txType || '').toLowerCase();
  const isBuy = txType === 'buy';
  const isSell = txType === 'sell';
  const isNew = !!(event.initialBuy || event.name || event.symbol);

  let solAmount = event.solAmount || 0;
  if (solAmount > 1e6) solAmount /= 1e9;

  return {
    mint: event.mint,
    mcUsd,
    solReserves: event.vSolInBondingCurve ? event.vSolInBondingCurve / 1e9 : 0,
    isBuy,
    isSell,
    solAmount,
    isNew,
    isTrade: isBuy || isSell
  };
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(url);

  globalWs.on('open', () => {
    log('🟢 Connected to PumpPortal');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
    log('📡 Subscribed to new tokens');
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      const parsed = parseEvent(event);
      if (!parsed) return;

      const { mint, mcUsd, solReserves, isBuy, isSell, solAmount, isNew, isTrade } = parsed;
      const now = Date.now();

      // ========== MANAGE POSITION ==========
      if (activePositions.has(mint) && mcUsd > 0) {
        const pos = activePositions.get(mint);
        pos.lastUpdate = now;
        if (mcUsd > pos.highestMc) pos.highestMc = mcUsd;

        const pnl = ((mcUsd - pos.entryMc) / pos.entryMc) * 100;
        const drop = ((mcUsd - pos.highestMc) / pos.highestMc) * 100;

        let reason = null;
        if (pnl <= HARD_STOP_LOSS) reason = `Stop-Loss ${pnl.toFixed(1)}%`;
        else if (pnl >= TAKE_PROFIT) reason = `Take-Profit +${pnl.toFixed(1)}%`;
        else if (pnl >= TRAILING_ACTIVATION && drop <= TRAILING_DROP) reason = `Trailing ${drop.toFixed(1)}%`;
        else if (now - pos.buyTime > MAX_HOLD_MS) reason = `Max hold`;

        if (reason) {
          activePositions.delete(mint);
          log(`🔴 EXIT ${mint.slice(0, 8)} | ${reason}`);
          const tx = await executeSwap(mint, 0, 'sell');
          if (tx) {
            await sendTelegram(`🔴 <b>Closed</b>\n<code>${mint}</code>\n${reason}\nPnL: <b>${pnl.toFixed(1)}%</b>`);
          }
        }
        return;
      }

      // ========== NEW TOKEN ==========
      if (isNew && !tokenTrackers.has(mint) && !processedMints.has(mint)) {
        tokenTrackers.set(mint, {
          startSol: solReserves,
          peakSol: solReserves,
          firstMc: mcUsd,
          lastMc: mcUsd,
          buyCount: 0,
          sellCount: 0,
          totalBuySol: 0,
          createdAt: now,
          tradeLog: []
        });
        globalWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        log(`👀 Watching ${mint.slice(0, 8)} | MC $${Math.round(mcUsd)}`);
        return;
      }

      // ========== TRADE UPDATE ==========
      if (tokenTrackers.has(mint) && !processedMints.has(mint) && isTrade) {
        const t = tokenTrackers.get(mint);

        t.tradeLog.push({ time: now, isBuy });
        t.tradeLog = t.tradeLog.filter(x => now - x.time < 60000);

        t.peakSol = Math.max(t.peakSol, solReserves);
        if (mcUsd > 0) t.lastMc = mcUsd;

        if (isBuy) {
          t.buyCount++;
          t.totalBuySol += solAmount;
        }
        if (isSell) t.sellCount++;

        const age = (now - t.createdAt) / 1000;
        const inflow = Math.max(t.totalBuySol, t.peakSol - t.startSol);
        const total = t.buyCount + t.sellCount;
        const ratio = total > 0 ? t.buyCount / total : 0;
        const recentBuys = t.tradeLog.filter(x => x.isBuy && now - x.time <= RECENT_WINDOW_MS).length;

        if (t.buyCount > 0 && t.buyCount % 3 === 0) {
          log(`📈 ${mint.slice(0, 8)} | Age ${age.toFixed(0)}s | MC $${Math.round(t.lastMc)} | +${inflow.toFixed(2)} SOL | Recent ${recentBuys} | Ratio ${(ratio*100).toFixed(0)}%`);
        }

        // ENTRY
        if (
          age >= MIN_AGE_SECONDS &&
          t.lastMc >= MIN_MARKET_CAP_USD &&
          t.lastMc <= MAX_MARKET_CAP_USD &&
          inflow >= MIN_SOL_INFLOW &&
          t.buyCount >= MIN_BUY_TRADES &&
          ratio >= MIN_BUY_RATIO &&
          recentBuys >= MIN_RECENT_BUYS &&
          !isBuying &&
          activePositions.size === 0 &&
          now - lastLossTime > 4 * 60 * 1000
        ) {
          processedMints.add(mint);
          tokenTrackers.delete(mint);

          const amount = Math.min(await getSpendableSol(), MAX_BUY_SOL);
          if (amount < 0.05) return;

          isBuying = true;
          log(`🚀 STRONG MOMENTUM → Buying ${amount} SOL`);

          const tx = await executeSwap(mint, amount, 'buy');
          isBuying = false;

          if (tx) {
            activePositions.set(mint, {
              entryMc: t.lastMc,
              highestMc: t.lastMc,
              buyTime: now,
              lastUpdate: now
            });
            await sendTelegram(
              `🚀 <b>ENTRY</b>\n<code>${mint}</code>\nSpent: <b>${amount} SOL</b>\nMC: $${t.lastMc.toFixed(0)}\nInflow: +${inflow.toFixed(2)} SOL`
            );
          }
        }
      }
    } catch (err) {
      log(`❌ Error: ${err.message}`);
    }
  });

  globalWs.on('close', () => {
    log('⚠️ Reconnecting...');
    setTimeout(startWebSocket, 4000);
  });
}

// ====================== MAIN ======================
async function main() {
  log(`🔑 Wallet: ${wallet.publicKey.toString()}`);
  log(`🌐 RPC: ${RPC_ENDPOINT.slice(0, 40)}...`);
  log(`💰 Max buy: ${MAX_BUY_SOL} SOL`);

  await updateSolPrice();
  setInterval(updateSolPrice, 5 * 60 * 1000);

  // Force close stale positions
  setInterval(() => {
    const now = Date.now();
    for (const [mint, pos] of activePositions) {
      if (now - pos.lastUpdate > NO_UPDATE_MS) {
        log(`⚠️ Force closing ${mint.slice(0, 8)}`);
        activePositions.delete(mint);
        executeSwap(mint, 0, 'sell');
      }
    }
  }, 5000);

  await sendTelegram(`⚡ <b>Bot Started</b>\nAggressive momentum mode\nHelius RPC + Quick TP`);

  startWebSocket();
}

main();
