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

// ========== AGGRESSIVE ENTRY (for green candles) ==========
const MIN_MARKET_CAP_USD = 10000;
const MAX_MARKET_CAP_USD = 500000;
const MIN_RECENT_BUYS = 5;
const MIN_BUY_RATIO = 0.58;
const RECENT_WINDOW_MS = 35_000;

// ========== QUICK PROFIT EXIT ==========
const HARD_STOP_LOSS = -6.5;
const TRAILING_ACTIVATION = 9.0;
const TRAILING_DROP = -4.5;
const TAKE_PROFIT = 32.0;          // Take profit faster
const MAX_HOLD_MS = 9 * 60 * 1000; // Max 9 minutes
const NO_UPDATE_FORCE_SELL_MS = 11_000;
const LOSS_COOLDOWN_MS = 5 * 60 * 1000;
const TRACKER_TTL_MS = 12 * 60 * 1000;

// ========== STATE ==========
let activePositions = new Map();
let tokenTrackers = new Map();
let processedMints = new Set();
let subscribedMints = new Set();
let globalWs = null;
let solPriceUsd = 180;
let isBuying = false;
let lastLossTime = 0;

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
  } catch (e) {
    log(`❌ Telegram: ${e.message}`);
  }
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

    const latest = await connection.getLatestBlockhash('confirmed');
    const conf = await connection.confirmTransaction({
      signature: txid,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight
    }, 'confirmed');

    if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));

    log(`✅ ${action.toUpperCase()} SUCCESS: ${txid}`);
    return txid;
  } catch (err) {
    log(`❌ ${action.toUpperCase()} FAILED: ${err.message}`);
    if (action === 'buy') {
      await sendTelegram(`❌ Buy failed\nMint: <code>${mint}</code>\n${err.message.slice(0, 120)}`);
    }
    return null;
  }
}

// ====================== TRENDING DISCOVERY ======================
async function fetchTrendingTokens() {
  try {
    // Method 1: Boosted tokens
    const res1 = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const data1 = await res1.json();

    // Method 2: Latest token profiles (sometimes better)
    const res2 = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const data2 = await res2.json();

    const all = [];
    if (Array.isArray(data1)) all.push(...data1);
    if (Array.isArray(data2)) all.push(...data2);

    let added = 0;

    for (const item of all) {
      const chain = item.chainId || item.chain;
      if (chain !== 'solana') continue;

      const mint = item.tokenAddress || item.address;
      if (!mint || subscribedMints.has(mint) || processedMints.has(mint)) continue;

      subscribedMints.add(mint);
      tokenTrackers.set(mint, {
        lastMc: 0,
        buyCount: 0,
        sellCount: 0,
        totalBuySol: 0,
        createdAt: Date.now(),
        tradeLog: [],
        mcHistory: []
      });

      subscribe(mint);
      added++;
      log(`🔥 TRENDING → ${mint.slice(0, 8)}...`);
    }

    if (added > 0) log(`✅ Added ${added} trending tokens`);
  } catch (err) {
    log(`⚠️ Trending fetch error: ${err.message}`);
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

  return {
    mint: event.mint,
    mcUsd,
    isBuy,
    isSell,
    solAmount,
    isTrade: isBuy || isSell
  };
}

function getRecentBuys(tracker) {
  const now = Date.now();
  return tracker.tradeLog.filter(t => t.isBuy && now - t.time <= RECENT_WINDOW_MS).length;
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

  globalWs.on('open', () => {
    log('🟢 Connected – Only Trending + Quick Profit Mode');
  });

  globalWs.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const data = parseEvent(event);
      if (!data) return;

      const { mint, mcUsd, isBuy, isSell, solAmount, isTrade } = data;
      const now = Date.now();

      // ===== EXIT LOGIC =====
      if (activePositions.has(mint) && mcUsd > 0) {
        const pos = activePositions.get(mint);
        pos.lastUpdate = now;
        if (mcUsd > pos.highestMc) pos.highestMc = mcUsd;

        const pnl = ((mcUsd - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((mcUsd - pos.highestMc) / pos.highestMc) * 100;

        let reason = null;
        if (pnl <= HARD_STOP_LOSS) reason = `Stop-Loss ${pnl.toFixed(1)}%`;
        else if (pnl >= TAKE_PROFIT) reason = `Quick TP +${pnl.toFixed(1)}%`;
        else if (pnl >= TRAILING_ACTIVATION && dropFromPeak <= TRAILING_DROP) reason = `Trailing ${dropFromPeak.toFixed(1)}%`;
        else if (now - pos.buyTime > MAX_HOLD_MS) reason = `Max hold`;

        if (reason) {
          activePositions.delete(mint);
          unsubscribe(mint);
          log(`🔴 EXIT ${mint.slice(0, 8)} | ${reason}`);

          const tx = await executeSwap(mint, 0, 'sell');
          if (tx) {
            await sendTelegram(`🔴 <b>Closed</b>\nMint: <code>${mint}</code>\n${reason}\nPnL: <b>${pnl.toFixed(1)}%</b>\n<a href="https://solscan.io/tx/${tx}">Tx</a>`);
          }
        }
        return;
      }

      // ===== ENTRY LOGIC =====
      if (!tokenTrackers.has(mint) || processedMints.has(mint) || !isTrade) return;

      const t = tokenTrackers.get(mint);
      t.tradeLog.push({ time: now, isBuy, sol: solAmount });
      t.tradeLog = t.tradeLog.filter(x => now - x.time < 5 * 60 * 1000);

      if (mcUsd > 0) t.lastMc = mcUsd;
      if (isBuy) {
        t.buyCount++;
        t.totalBuySol += solAmount;
      }
      if (isSell) t.sellCount++;

      const recentBuys = getRecentBuys(t);
      const total = t.buyCount + t.sellCount;
      const ratio = total > 0 ? t.buyCount / total : 0;

      if (t.buyCount % 3 === 0 && t.buyCount > 0) {
        log(`📈 ${mint.slice(0, 8)} | MC $${Math.round(t.lastMc)} | Recent buys: ${recentBuys} | Ratio ${(ratio*100).toFixed(0)}%`);
      }

      // Fast entry on strong recent buying
      if (
        t.lastMc >= MIN_MARKET_CAP_USD &&
        t.lastMc <= MAX_MARKET_CAP_USD &&
        recentBuys >= MIN_RECENT_BUYS &&
        ratio >= MIN_BUY_RATIO &&
        !isBuying &&
        activePositions.size === 0 &&
        (now - lastLossTime > LOSS_COOLDOWN_MS)
      ) {
        processedMints.add(mint);
        tokenTrackers.delete(mint);

        const buyAmount = Math.min(await getSpendableSol(), MAX_BUY_SOL);
        if (buyAmount < 0.05) return;

        isBuying = true;
        log(`🚀 GREEN CANDLE → Buying ${buyAmount} SOL`);

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

          await sendTelegram(
            `🚀 <b>GREEN CANDLE ENTRY</b>\n` +
            `Mint: <code>${mint}</code>\n` +
            `Spent: <b>${buyAmount} SOL</b>\n` +
            `MC: $${t.lastMc.toFixed(0)}\n` +
            `Recent buys: ${recentBuys}\n` +
            `<a href="https://solscan.io/tx/${tx}">Tx</a>`
          );
        }
      }
    } catch (err) {
      log(`❌ Error: ${err.message}`);
    }
  });

  globalWs.on('close', () => setTimeout(startWebSocket, 5000));
  globalWs.on('error', (e) => log(`WS Error: ${e.message}`));
}

// ====================== MAIN ======================
async function main() {
  log(`🔑 Wallet: ${wallet.publicKey.toString()}`);
  log(`💰 Max buy: ${MAX_BUY_SOL} SOL | Quick TP: ${TAKE_PROFIT}%`);

  await updateSolPrice();
  setInterval(updateSolPrice, 5 * 60 * 1000);

  // Fetch trending every 35 seconds
  await fetchTrendingTokens();
  setInterval(fetchTrendingTokens, 35_000);

  setInterval(() => {
    // Force sell stale positions
    const now = Date.now();
    for (const [mint, pos] of activePositions) {
      if (now - pos.lastUpdate > NO_UPDATE_FORCE_SELL_MS) {
        log(`⚠️ Force sell ${mint.slice(0,8)}`);
        activePositions.delete(mint);
        executeSwap(mint, 0, 'sell');
      }
    }
  }, 4000);

  await sendTelegram(`⚡ <b>Quick Profit Mode</b>\nOnly trending + fast TP at +${TAKE_PROFIT}%`);

  startWebSocket();
}

main();
