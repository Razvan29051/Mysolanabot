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

// Leave this much SOL in the wallet for fees / rent
const SOL_RESERVE = 0.035;

// ========== ENTRY FILTERS (anti-dump / anti-fake MC) ==========
const MIN_MARKET_CAP_USD = 28000;
const MAX_MARKET_CAP_USD = 140000;
const MIN_SOL_VELOCITY = 2.0;          // Strong real accumulation
const MIN_BUY_TRADES = 9;              // Need real buy volume
const MIN_BUY_RATIO = 0.72;            // ≥72% buys
const MIN_AGE_SECONDS = 45;            // Ignore very new launches
const MIN_MC_GROWTH_FROM_START = 1.35; // Must have grown at least 35% from first seen MC
const TRACKER_TTL_MS = 240_000;        // Max 4 minutes watching

// ========== EXIT RULES ==========
const HARD_STOP_LOSS = -8.0;           // Always -8% from entry
const TRAILING_ACTIVATION = 15.0;      // Start trailing after +15%
const TRAILING_DROP = -7.0;            // Drop 7% from peak → sell
const TAKE_PROFIT = 60.0;              // Hard take-profit

// ========== STATE ==========
let activePositions = new Map();
let tokenTrackers = new Map();
let processedMints = new Set();
let globalWs = null;
let solPriceUsd = 180;
let isBuying = false;                  // Prevent overlapping full-wallet buys

// ====================== HELPERS ======================
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) process.stdout.write(`❌ Telegram error: ${data.description}\n`);
  } catch (e) {
    process.stdout.write(`❌ Telegram network error: ${e.message}\n`);
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
    log('⚠️ Could not update SOL price');
  }
}

async function getSpendableSol() {
  const balance = await connection.getBalance(wallet.publicKey);
  const sol = balance / LAMPORTS_PER_SOL;
  const spendable = Math.max(0, sol - SOL_RESERVE);
  return Number(spendable.toFixed(4));
}

// ====================== TRADE EXECUTION ======================
async function executeSwap(mint, amountSol, action = 'buy') {
  try {
    log(`🔄 ${action.toUpperCase()} → ${mint.slice(0, 8)}... | ${amountSol} SOL`);

    const body = {
      publicKey: wallet.publicKey.toString(),
      action,
      mint,
      amount: action === 'sell' ? '100%' : amountSol,
      denominatedInSol: action === 'sell' ? 'false' : 'true',
      slippage: 28,
      priorityFee: 0.0028,
      pool: 'auto'
    };

    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `HTTP ${response.status}`);
    }

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
  const mint = event.mint;
  if (!mint) return null;

  let marketCapSol = event.marketCapSol ?? event.market_cap_sol ?? null;
  let solReserves = event.vSolInBondingCurve ?? event.virtualSolReserves ?? 0;
  if (solReserves > 1e6) solReserves /= 1e9;

  let mcUsd = marketCapSol != null
    ? marketCapSol * solPriceUsd
    : (event.marketCapUsd || event.usd_market_cap || solReserves * solPriceUsd * 5);

  const isBuy = event.txType === 'buy' || event.is_buy === true;
  const isSell = event.txType === 'sell' || event.is_buy === false;

  return {
    mint,
    solReserves: solReserves || 0,
    mcUsd: mcUsd || 0,
    isBuy,
    isSell,
    isTrade: !!(event.txType || event.tokenAmount || event.solAmount)
  };
}

// ====================== SUBSCRIBE HELPERS ======================
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
      log(`🧹 Stopped watching ${mint.slice(0, 8)}... (timeout)`);
    }
  }
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  log('⚡ Connecting to PumpPortal...');

  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : 'wss://pumpportal.fun/api/data';

  globalWs = new WebSocket(url);

  globalWs.on('open', () => {
    log('🟢 Connected – hunting strong buy-volume coins only');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  globalWs.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      const data = parseEvent(event);
      if (!data) return;

      const { mint, solReserves, mcUsd, isBuy, isSell, isTrade } = data;

      // ---------- 1. MANAGE OPEN POSITION ----------
      if (activePositions.has(mint) && mcUsd > 0) {
        const pos = activePositions.get(mint);

        if (mcUsd > pos.highestMc) {
          pos.highestMc = mcUsd;
          activePositions.set(mint, pos);
        }

        const pnl = ((mcUsd - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((mcUsd - pos.highestMc) / pos.highestMc) * 100;

        let reason = null;
        if (pnl <= HARD_STOP_LOSS) {
          reason = `Hard Stop-Loss ${pnl.toFixed(1)}%`;
        } else if (pnl >= TRAILING_ACTIVATION && dropFromPeak <= TRAILING_DROP) {
          reason = `Trailing Stop ${dropFromPeak.toFixed(1)}% from peak`;
        } else if (pnl >= TAKE_PROFIT) {
          reason = `Take-Profit +${pnl.toFixed(1)}%`;
        }

        if (reason) {
          activePositions.delete(mint);
          unsubscribe(mint);

          log(`🔴 EXIT ${mint.slice(0, 8)}... | ${reason} | PnL ${pnl.toFixed(1)}%`);

          const tx = await executeSwap(mint, 0, 'sell');
          if (tx) {
            await sendTelegram(
              `🔴 <b>Position Closed</b>\n` +
              `Mint: <code>${mint}</code>\n` +
              `Reason: <b>${reason}</b>\n` +
              `PnL: <b>${pnl.toFixed(1)}%</b>\n` +
              `Exit MC: $${mcUsd.toFixed(0)}\n` +
              `<a href="https://solscan.io/tx/${tx}">View Tx</a>`
            );
          }
        }
        return;
      }

      // ---------- 2. NEW TOKEN → start tracking ----------
      if (!isTrade && !processedMints.has(mint) && !tokenTrackers.has(mint)) {
        tokenTrackers.set(mint, {
          startSol: solReserves,
          peakSol: solReserves,
          firstMc: mcUsd,
          lastMc: mcUsd,
          buyCount: 0,
          sellCount: 0,
          createdAt: Date.now()
        });
        subscribe(mint);
        log(`👀 Tracking ${mint.slice(0, 8)}... | Start MC ~$${Math.round(mcUsd)}`);
        return;
      }

      // ---------- 3. TRADE UPDATE → check for strong signal ----------
      if (tokenTrackers.has(mint) && !processedMints.has(mint) && isTrade) {
        const t = tokenTrackers.get(mint);

        t.peakSol = Math.max(t.peakSol, solReserves);
        if (mcUsd > 0) t.lastMc = mcUsd;
        if (isBuy) t.buyCount++;
        if (isSell) t.sellCount++;

        const ageSec = (Date.now() - t.createdAt) / 1000;
        const solGained = t.peakSol - t.startSol;
        const totalTrades = t.buyCount + t.sellCount;
        const buyRatio = totalTrades > 0 ? t.buyCount / totalTrades : 0;
        const mcGrowth = t.firstMc > 0 ? t.lastMc / t.firstMc : 0;

        // Log interesting progress
        if (t.buyCount > 0 && t.buyCount % 3 === 0) {
          log(`📈 ${mint.slice(0, 8)} | MC $${Math.round(t.lastMc)} | +${solGained.toFixed(2)} SOL | Buys ${t.buyCount}/${totalTrades} (${(buyRatio*100).toFixed(0)}%) | Age ${ageSec.toFixed(0)}s`);
        }

        const isReallyStrong =
          ageSec >= MIN_AGE_SECONDS &&
          t.lastMc >= MIN_MARKET_CAP_USD &&
          t.lastMc <= MAX_MARKET_CAP_USD &&
          solGained >= MIN_SOL_VELOCITY &&
          t.buyCount >= MIN_BUY_TRADES &&
          buyRatio >= MIN_BUY_RATIO &&
          mcGrowth >= MIN_MC_GROWTH_FROM_START &&
          !isBuying &&
          activePositions.size === 0;           // Only one full-wallet position at a time

        if (isReallyStrong) {
          processedMints.add(mint);
          tokenTrackers.delete(mint);

          const spendable = await getSpendableSol();
          if (spendable < 0.05) {
            log(`⚠️ Strong signal but not enough SOL (${spendable})`);
            unsubscribe(mint);
            return;
          }

          isBuying = true;
          log(`🚀🚀 STRONG SIGNAL → FULL WALLET BUY`);
          log(`   Mint: ${mint}`);
          log(`   MC: $${t.lastMc.toFixed(0)} | Growth: x${mcGrowth.toFixed(2)}`);
          log(`   Velocity: +${solGained.toFixed(2)} SOL | Buys: ${t.buyCount}/${totalTrades} (${(buyRatio*100).toFixed(0)}%)`);
          log(`   Spending: ${spendable} SOL`);

          const tx = await executeSwap(mint, spendable, 'buy');
          isBuying = false;

          if (tx) {
            activePositions.set(mint, {
              entryMc: t.lastMc,
              highestMc: t.lastMc,
              buyTime: Date.now(),
              amountSol: spendable
            });
            subscribe(mint); // keep receiving updates for exit

            await sendTelegram(
              `🚀 <b>FULL WALLET ENTRY</b>\n` +
              `Mint: <code>${mint}</code>\n` +
              `Spent: <b>${spendable} SOL</b>\n` +
              `Entry MC: <b>$${t.lastMc.toFixed(0)}</b>\n` +
              `Growth: x${mcGrowth.toFixed(2)}\n` +
              `Velocity: +${solGained.toFixed(2)} SOL\n` +
              `Buy ratio: ${(buyRatio * 100).toFixed(0)}% (${t.buyCount} buys)\n` +
              `<a href="https://solscan.io/tx/${tx}">View Tx</a>`
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
    log('⚠️ Disconnected – reconnecting in 5s...');
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
  setInterval(cleanupTrackers, 30_000);

  await sendTelegram(
    `⚡ <b>Strong Momentum Bot Online</b>\n` +
    `Mode: Full wallet on high-quality signals only\n` +
    `Hard SL: -8% | Trailing after +15%`
  );

  startWebSocket();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
