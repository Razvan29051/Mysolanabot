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

const SOL_RESERVE = 0.04;

// ========== FILTERS (balanced for real momentum) ==========
const MIN_MARKET_CAP_USD = 30000;
const MAX_MARKET_CAP_USD = 220000;
const MIN_AGE_SECONDS = 180;                // 3 minutes
const MIN_SOL_INFLOW = 2.8;                 // Real SOL bought
const MIN_BUY_TRADES = 12;
const MIN_BUY_RATIO = 0.68;                 // Slightly relaxed
const MIN_MC_GROWTH = 1.35;

const RECENT_WINDOW_MS = 45_000;
const MIN_RECENT_BUYS = 5;

const HARD_STOP_LOSS = -8.0;
const TRAILING_ACTIVATION = 15.0;
const TRAILING_DROP_EARLY = -7.0;
const TRAILING_DROP_TIGHT = -4.8;
const TIGHT_TRAIL_AFTER = 28.0;
const TAKE_PROFIT = 65.0;
const MAX_HOLD_MS = 16 * 60 * 1000;
const LOSS_COOLDOWN_MS = 8 * 60 * 1000;
const TRACKER_TTL_MS = 12 * 60 * 1000;

// ========== STATE ==========
let activePositions = new Map();
let tokenTrackers = new Map();
let processedMints = new Set();
let globalWs = null;
let solPriceUsd = 180;
let isBuying = false;
let lastLossTime = 0;
let messageCount = 0;

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
    log(`❌ Telegram error: ${e.message}`);
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
    if (data?.solana?.usd) {
      solPriceUsd = data.solana.usd;
      log(`💰 SOL price: $${solPriceUsd.toFixed(2)}`);
    }
  } catch {
    log('⚠️ SOL price update failed');
  }
}

async function getSpendableSol() {
  const balance = await connection.getBalance(wallet.publicKey);
  const sol = balance / LAMPORTS_PER_SOL;
  return Math.max(0, Number((sol - SOL_RESERVE).toFixed(4)));
}

// ====================== TRADE EXECUTION ======================
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
        slippage: 26,
        priorityFee: 0.003,
        pool: 'auto'
      })
    });

    if (!response.ok) throw new Error(await response.text());

    const tx = VersionedTransaction.deserialize(new Uint8Array(await response.arrayBuffer()));
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

// ====================== EVENT PARSER ======================
function parseEvent(event) {
  if (event.message && !event.mint) return null;

  const mint = event.mint;
  if (!mint) return null;

  let marketCapSol = event.marketCapSol ?? event.market_cap_sol ?? null;
  let solReserves = event.vSolInBondingCurve ?? event.virtualSolReserves ?? 0;
  if (solReserves > 1e6) solReserves /= 1e9;

  let mcUsd = marketCapSol != null
    ? marketCapSol * solPriceUsd
    : (event.marketCapUsd || event.usd_market_cap || solReserves * solPriceUsd * 5);

  const txType = (event.txType || event.type || '').toLowerCase();
  const isBuy = txType === 'buy' || event.is_buy === true;
  const isSell = txType === 'sell' || event.is_buy === false;

  const isNewToken = !!(event.initialBuy || event.name || event.symbol || txType === 'create');

  let solAmount = 0;
  if (event.solAmount) {
    solAmount = event.solAmount > 1e6 ? event.solAmount / 1e9 : event.solAmount;
  }

  return {
    mint,
    solReserves: solReserves || 0,
    mcUsd: mcUsd || 0,
    isBuy,
    isSell,
    solAmount,
    isNewToken,
    isTrade: (isBuy || isSell) && !isNewToken
  };
}

// ====================== HELPERS ======================
function updateStructure(tracker, mcUsd) {
  const now = Date.now();
  tracker.mcHistory.push({ mc: mcUsd, time: now });
  tracker.mcHistory = tracker.mcHistory.filter(p => now - p.time < 5 * 60 * 1000);
}

function hasHigherHighsHigherLows(tracker) {
  const points = tracker.mcHistory.map(p => p.mc);
  if (points.length < 5) return false;

  let higherHighs = 0;
  for (let i = 2; i < points.length; i++) {
    if (points[i] > points[i - 1] && points[i - 1] > points[i - 2]) higherHighs++;
  }
  return higherHighs >= 2;
}

function getRecentBuyPressure(tracker) {
  const now = Date.now();
  const recent = tracker.tradeLog.filter(t => now - t.time <= RECENT_WINDOW_MS);
  const recentBuys = recent.filter(t => t.isBuy).length;
  const recentSol = recent.filter(t => t.isBuy).reduce((sum, t) => sum + t.sol, 0);

  return { recentBuys, recentSol };
}

// ====================== SUBSCRIBE / CLEANUP ======================
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

function cleanupTrackers() {
  const now = Date.now();
  for (const [mint, t] of tokenTrackers) {
    if (now - t.createdAt > TRACKER_TTL_MS) {
      tokenTrackers.delete(mint);
      unsubscribe(mint);
    }
  }
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  log('⚡ Connecting to PumpPortal...');

  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : 'wss://pumpportal.fun/api/data';

  if (PUMPPORTAL_API_KEY) {
    log('🔑 Using PUMPPORTAL_API_KEY');
  } else {
    log('⚠️ No API key – data may be limited');
  }

  globalWs = new WebSocket(url);

  globalWs.on('open', () => {
    log('🟢 WebSocket OPEN');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
    log('📡 Subscribed to new tokens');
  });

  globalWs.on('message', async (raw) => {
    messageCount++;
    try {
      const event = JSON.parse(raw.toString());
      const data = parseEvent(event);
      if (!data) return;

      const { mint, solReserves, mcUsd, isBuy, isSell, solAmount, isNewToken, isTrade } = data;
      const now = Date.now();

      // ---------- POSITION MANAGEMENT ----------
      if (activePositions.has(mint) && mcUsd > 0) {
        const pos = activePositions.get(mint);

        if (mcUsd > pos.highestMc) {
          pos.highestMc = mcUsd;
          activePositions.set(mint, pos);
        }

        const pnl = ((mcUsd - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((mcUsd - pos.highestMc) / pos.highestMc) * 100;
        const holdTime = now - pos.buyTime;

        let reason = null;
        if (pnl <= HARD_STOP_LOSS) {
          reason = `Hard Stop-Loss ${pnl.toFixed(1)}%`;
          lastLossTime = now;
        } else if (holdTime >= MAX_HOLD_MS) {
          reason = `Max hold time`;
        } else if (pnl >= TAKE_PROFIT) {
          reason = `Take-Profit +${pnl.toFixed(1)}%`;
        } else if (pnl >= TRAILING_ACTIVATION) {
          const trailDrop = pnl >= TIGHT_TRAIL_AFTER ? TRAILING_DROP_TIGHT : TRAILING_DROP_EARLY;
          if (dropFromPeak <= trailDrop) {
            reason = `Trailing Stop ${dropFromPeak.toFixed(1)}%`;
          }
        }

        if (reason) {
          activePositions.delete(mint);
          unsubscribe(mint);
          log(`🔴 EXIT ${mint.slice(0, 8)} | ${reason} | PnL ${pnl.toFixed(1)}%`);

          const tx = await executeSwap(mint, 0, 'sell');
          if (tx) {
            await sendTelegram(
              `🔴 <b>Closed</b>\nMint: <code>${mint}</code>\nReason: <b>${reason}</b>\nPnL: <b>${pnl.toFixed(1)}%</b>\n<a href="https://solscan.io/tx/${tx}">Tx</a>`
            );
          }
        }
        return;
      }

      // ---------- NEW TOKEN → start watching ----------
      if (isNewToken && !processedMints.has(mint) && !tokenTrackers.has(mint)) {
        tokenTrackers.set(mint, {
          startSol: solReserves,
          peakSol: solReserves,
          firstMc: mcUsd,
          lastMc: mcUsd,
          buyCount: 0,
          sellCount: 0,
          totalBuySol: 0,                // ← real inflow tracker
          createdAt: now,
          tradeLog: [],
          mcHistory: [{ mc: mcUsd, time: now }],
          biggestBuy: 0
        });
        subscribe(mint);
        log(`👀 WATCHING ${mint.slice(0, 8)}... | Start MC ~$${Math.round(mcUsd)}`);
        return;
      }

      // ---------- TRADE UPDATES ----------
      if (tokenTrackers.has(mint) && !processedMints.has(mint) && isTrade) {
        const t = tokenTrackers.get(mint);

        // Record trade
        t.tradeLog.push({ time: now, isBuy, sol: solAmount });
        t.tradeLog = t.tradeLog.filter(tr => now - tr.time < 6 * 60 * 1000);

        // Update reserves & real inflow
        t.peakSol = Math.max(t.peakSol, solReserves);
        if (mcUsd > 0) t.lastMc = mcUsd;

        if (isBuy) {
          t.buyCount++;
          t.totalBuySol += solAmount;          // ← important
          t.biggestBuy = Math.max(t.biggestBuy, solAmount);
        }
        if (isSell) t.sellCount++;

        updateStructure(t, t.lastMc);

        const ageSec = (now - t.createdAt) / 1000;
        const solInflow = t.totalBuySol;                 // real SOL bought while watching
        const reserveGain = t.peakSol - t.startSol;
        const effectiveVelocity = Math.max(solInflow, reserveGain);

        const totalTrades = t.buyCount + t.sellCount;
        const buyRatio = totalTrades > 0 ? t.buyCount / totalTrades : 0;
        const mcGrowth = t.firstMc > 0 ? t.lastMc / t.firstMc : 0;
        const pressure = getRecentBuyPressure(t);
        const goodStructure = hasHigherHighsHigherLows(t);

        // Progress log
        if (t.buyCount > 0 && t.buyCount % 5 === 0) {
          log(`📈 ${mint.slice(0, 8)} | Age ${ageSec.toFixed(0)}s | MC $${Math.round(t.lastMc)} | Inflow +${effectiveVelocity.toFixed(2)} SOL | Buys ${t.buyCount}/${totalTrades} (${(buyRatio*100).toFixed(0)}%) | Recent ${pressure.recentBuys} | Struct ${goodStructure}`);
        }

        // ========== ENTRY DECISION ==========
        const pass =
          ageSec >= MIN_AGE_SECONDS &&
          t.lastMc >= MIN_MARKET_CAP_USD &&
          t.lastMc <= MAX_MARKET_CAP_USD &&
          effectiveVelocity >= MIN_SOL_INFLOW &&
          t.buyCount >= MIN_BUY_TRADES &&
          buyRatio >= MIN_BUY_RATIO &&
          mcGrowth >= MIN_MC_GROWTH &&
          pressure.recentBuys >= MIN_RECENT_BUYS &&
          goodStructure &&
          !isBuying &&
          activePositions.size === 0 &&
          (now - lastLossTime > LOSS_COOLDOWN_MS);

        if (pass) {
          processedMints.add(mint);
          tokenTrackers.delete(mint);

          const spendable = await getSpendableSol();
          if (spendable < 0.07) {
            log(`⚠️ Low balance: ${spendable} SOL`);
            unsubscribe(mint);
            return;
          }

          isBuying = true;
          log(`🚀 STRONG MOMENTUM → Buying ${spendable} SOL`);
          log(`   ${mint}`);
          log(`   MC: $${t.lastMc.toFixed(0)} | Inflow: +${effectiveVelocity.toFixed(2)} SOL | Age: ${ageSec.toFixed(0)}s`);
          log(`   Buys: ${t.buyCount}/${totalTrades} (${(buyRatio*100).toFixed(0)}%) | Recent: ${pressure.recentBuys}`);

          const tx = await executeSwap(mint, spendable, 'buy');
          isBuying = false;

          if (tx) {
            activePositions.set(mint, {
              entryMc: t.lastMc,
              highestMc: t.lastMc,
              buyTime: now,
              amountSol: spendable
            });
            subscribe(mint);

            await sendTelegram(
              `🚀 <b>STRONG MOMENTUM ENTRY</b>\n` +
              `Mint: <code>${mint}</code>\n` +
              `Spent: <b>${spendable} SOL</b>\n` +
              `MC: $${t.lastMc.toFixed(0)}\n` +
              `Inflow: +${effectiveVelocity.toFixed(2)} SOL\n` +
              `Age: ${ageSec.toFixed(0)}s | Buys: ${t.buyCount}\n` +
              `<a href="https://solscan.io/tx/${tx}">Tx</a>`
            );
          } else {
            unsubscribe(mint);
          }
        }
      }
    } catch (err) {
      log(`❌ Handler error: ${err.message}`);
    }
  });

  globalWs.on('error', (e) => log(`❌ WS Error: ${e.message}`));
  globalWs.on('close', () => {
    log('⚠️ WS Closed – reconnecting in 5s...');
    setTimeout(startWebSocket, 5000);
  });
}

// ====================== MAIN ======================
async function main() {
  log(`🔑 Wallet: ${wallet.publicKey.toString()}`);
  const bal = await getSpendableSol();
  log(`💰 Spendable SOL: ${bal}`);

  await updateSolPrice();
  setInterval(updateSolPrice, 5 * 60 * 1000);
  setInterval(cleanupTrackers, 60_000);

  setInterval(() => {
    log(`💓 Status | Msgs: ${messageCount} | Watching: ${tokenTrackers.size} | Positions: ${activePositions.size}`);
  }, 3 * 60 * 1000);

  await sendTelegram(`⚡ <b>Bot updated</b> – fixed velocity tracking`);

  startWebSocket();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
