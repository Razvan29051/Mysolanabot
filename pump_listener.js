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
  console.error('❌ Missing RPC or Private Key');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const SOL_RESERVE = 0.05;
const MAX_BUY_SOL = 0.25;

// ========== VERY AGGRESSIVE FOR TESTING ==========
const MIN_MARKET_CAP_USD = 8000;
const MAX_MARKET_CAP_USD = 600000;
const MIN_RECENT_BUYS = 3;
const MIN_BUY_RATIO = 0.52;
const RECENT_WINDOW_MS = 45_000;

// ========== QUICK PROFIT ==========
const HARD_STOP_LOSS = -6.0;
const TRAILING_ACTIVATION = 8.0;
const TRAILING_DROP = -4.0;
const TAKE_PROFIT = 28.0;
const MAX_HOLD_MS = 8 * 60 * 1000;
const NO_UPDATE_FORCE_SELL_MS = 11_000;

// ========== STATE ==========
let activePositions = new Map();
let tokenTrackers = new Map();
let processedMints = new Set();
let subscribedMints = new Set();
let globalWs = null;
let solPriceUsd = 180;
let isBuying = false;
let lastLossTime = 0;
let tradeEventsReceived = 0;

// ====================== HELPERS ======================
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {}
}

function log(msg) {
  const time = new Date().toISOString().substr(11, 8);
  process.stdout.write(`[${time}] ${msg}\n`);
}

async function updateSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    if (data?.solana?.usd) solPriceUsd = data.solana.usd;
  } catch {}
}

async function getSpendableSol() {
  const balance = await connection.getBalance(wallet.publicKey);
  return Math.max(0, Number(((balance / LAMPORTS_PER_SOL) - SOL_RESERVE).toFixed(4)));
}

// ====================== EXECUTION ======================
async function executeSwap(mint, amountSol, action = 'buy') {
  try {
    log(`🔄 ${action.toUpperCase()} ${mint.slice(0, 8)}... | ${amountSol} SOL`);

    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: action === 'sell' ? '100%' : amountSol,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: 55,
        priorityFee: 0.012,
        pool: 'auto'
      })
    });

    if (!response.ok) throw new Error(await response.text());

    const tx = VersionedTransaction.deserialize(new Uint8Array(await response.arrayBuffer()));
    tx.sign([wallet]);

    const txid = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 4 });
    log(`✅ ${action.toUpperCase()} sent: ${txid}`);
    return txid;
  } catch (err) {
    log(`❌ ${action.toUpperCase()} failed: ${err.message}`);
    return null;
  }
}

// ====================== TRENDING ======================
async function fetchTrendingTokens() {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const data = await res.json();
    if (!Array.isArray(data)) return;

    let added = 0;
    for (const item of data) {
      if (item.chainId !== 'solana') continue;
      const mint = item.tokenAddress;
      if (!mint || subscribedMints.has(mint) || processedMints.has(mint)) continue;

      subscribedMints.add(mint);
      tokenTrackers.set(mint, {
        lastMc: 0,
        buyCount: 0,
        sellCount: 0,
        totalBuySol: 0,
        createdAt: Date.now(),
        tradeLog: []
      });
      subscribe(mint);
      added++;
      log(`🔥 TRENDING → ${mint.slice(0, 8)}...`);
    }
    if (added > 0) log(`✅ Added ${added} trending tokens`);
  } catch (err) {
    log(`⚠️ DexScreener error: ${err.message}`);
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

  let solAmount = event.solAmount || 0;
  if (solAmount > 1e6) solAmount /= 1e9;

  return { mint: event.mint, mcUsd, isBuy, isSell, solAmount, isTrade: isBuy || isSell };
}

function subscribe(mint) {
  if (globalWs?.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
  }
}

function unsubscribe(mint) {
  if (globalWs?.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
  }
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(url);

  globalWs.on('open', () => log('🟢 Connected – Debug + Aggressive Mode'));

  globalWs.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const data = parseEvent(event);
      if (!data) return;

      const { mint, mcUsd, isBuy, isSell, solAmount, isTrade } = data;
      const now = Date.now();

      // EXIT
      if (activePositions.has(mint) && mcUsd > 0) {
        const pos = activePositions.get(mint);
        pos.lastUpdate = now;
        if (mcUsd > pos.highestMc) pos.highestMc = mcUsd;

        const pnl = ((mcUsd - pos.entryMc) / pos.entryMc) * 100;
        const drop = ((mcUsd - pos.highestMc) / pos.highestMc) * 100;

        let reason = null;
        if (pnl <= HARD_STOP_LOSS) reason = `SL ${pnl.toFixed(1)}%`;
        else if (pnl >= TAKE_PROFIT) reason = `TP +${pnl.toFixed(1)}%`;
        else if (pnl >= TRAILING_ACTIVATION && drop <= TRAILING_DROP) reason = `Trail ${drop.toFixed(1)}%`;
        else if (now - pos.buyTime > MAX_HOLD_MS) reason = `Max hold`;

        if (reason) {
          activePositions.delete(mint);
          unsubscribe(mint);
          log(`🔴 EXIT ${mint.slice(0,8)} | ${reason}`);
          await executeSwap(mint, 0, 'sell');
        }
        return;
      }

      // ENTRY TRACKING
      if (!tokenTrackers.has(mint) || processedMints.has(mint) || !isTrade) return;

      tradeEventsReceived++;
      const t = tokenTrackers.get(mint);

      t.tradeLog.push({ time: now, isBuy });
      t.tradeLog = t.tradeLog.filter(x => now - x.time < 5 * 60 * 1000);

      if (mcUsd > 0) t.lastMc = mcUsd;
      if (isBuy) t.buyCount++;
      if (isSell) t.sellCount++;

      const recentBuys = t.tradeLog.filter(x => x.isBuy && now - x.time <= RECENT_WINDOW_MS).length;
      const total = t.buyCount + t.sellCount;
      const ratio = total > 0 ? t.buyCount / total : 0;

      // Log every trade for debugging
      log(`📊 TRADE ${mint.slice(0,6)} | ${isBuy ? 'BUY' : 'SELL'} | MC $${Math.round(t.lastMc)} | RecentBuys ${recentBuys} | Total ${t.buyCount}/${total}`);

      // Very aggressive entry
      if (
        t.lastMc >= MIN_MARKET_CAP_USD &&
        t.lastMc <= MAX_MARKET_CAP_USD &&
        recentBuys >= MIN_RECENT_BUYS &&
        ratio >= MIN_BUY_RATIO &&
        !isBuying &&
        activePositions.size === 0 &&
        (now - lastLossTime > 300000)
      ) {
        processedMints.add(mint);
        tokenTrackers.delete(mint);

        const buyAmount = Math.min(await getSpendableSol(), MAX_BUY_SOL);
        if (buyAmount < 0.05) return;

        isBuying = true;
        log(`🚀 BUYING ${buyAmount} SOL of ${mint.slice(0,8)}`);

        const tx = await executeSwap(mint, buyAmount, 'buy');
        isBuying = false;

        if (tx) {
          activePositions.set(mint, {
            entryMc: t.lastMc,
            highestMc: t.lastMc,
            buyTime: now,
            lastUpdate: now
          });
          subscribe(mint);
          await sendTelegram(`🚀 <b>ENTRY</b>\nMint: <code>${mint}</code>\nSpent: ${buyAmount} SOL\nMC: $${t.lastMc.toFixed(0)}`);
        }
      }
    } catch (err) {
      log(`❌ Error: ${err.message}`);
    }
  });

  globalWs.on('close', () => setTimeout(startWebSocket, 4000));
}

// ====================== MAIN ======================
async function main() {
  log(`🔑 Wallet: ${wallet.publicKey.toString()}`);
  await updateSolPrice();
  setInterval(updateSolPrice, 300000);

  await fetchTrendingTokens();
  setInterval(fetchTrendingTokens, 40000);

  setInterval(() => {
    log(`💓 Status | Watching: ${tokenTrackers.size} | Trades received: ${tradeEventsReceived} | Open: ${activePositions.size}`);
  }, 60000);

  await sendTelegram(`⚡ Debug Mode ON – logging every trade`);
  startWebSocket();
}

main();
