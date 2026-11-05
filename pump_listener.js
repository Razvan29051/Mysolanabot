import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// --- CONFIGURATION & ENV VARS ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_ENDPOINT) {
  console.error('❌ CRITICAL ERROR: RPC_ENDPOINT is missing in Railway variables!');
  process.exit(1);
}

if (!RAW_PRIVATE_KEY) {
  console.error('❌ CRITICAL ERROR: Private key is missing in Railway variables!');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const TRADE_AMOUNT_SOL = 0.05; // Position size in SOL

// --- WAVE RIDING TARGETS ($4K - $50K Sweet Spot) ---
const MIN_MARKET_CAP_USD = 4000;
const MAX_MARKET_CAP_USD = 50000;

let tokenMetrics = new Map();
let activePositions = new Map();
let processedMints = new Set();
let globalWs = null;

// --- TELEGRAM NOTIFICATION HELPER ---
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (error) {
    console.error('❌ Failed to send Telegram alert:', error.message);
  }
}

// --- LOCAL TRANSACTION EXECUTION ---
async function executeLocalPumpSwap(mintAddress, amountSol, action = 'buy') {
  try {
    console.log(`🔄 Requesting trade for ${mintAddress} (${amountSol} SOL, action: ${action})...`);

    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action: action,
        mint: mintAddress,
        amount: amountSol,
        denominatedInSol: "true",
        slippage: 25,
        priorityFee: 0.0015,
        pool: 'pump'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PumpPortal Local API status ${response.status}: ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(arrayBuffer));
    transaction.sign([wallet]);

    const txid = await connection.sendTransaction(transaction, {
      skipPreflight: true,
      maxRetries: 3
    });

    console.log(`✅ Transaction submitted: ${txid}`);
    return txid;
  } catch (err) {
    console.error(`❌ Local swap execution failed (${action}):`, err.message);
    return null;
  }
}

// --- REAL-TIME POSITION MONITORING ---
async function evaluatePositionRealtime(mintAddress, currentMc) {
  const position = activePositions.get(mintAddress);
  if (!position) return;

  if (currentMc > position.peakMc) position.peakMc = currentMc;

  const pnlPercentage = ((currentMc - position.entryMc) / position.entryMc) * 100;
  const dropFromPeak = ((position.peakMc - currentMc) / position.peakMc) * 100;
  const ageMs = Date.now() - position.entryTime;

  if (pnlPercentage >= 22 && !position.tookPartialProfit) {
    position.tookPartialProfit = true;
    const sellAmount = Number((TRADE_AMOUNT_SOL * 0.6).toFixed(4));

    console.log(`💰 Take-Profit Triggered (+22%) for ${mintAddress}`);
    const tx = await executeLocalPumpSwap(mintAddress, sellAmount, 'sell');
    await sendTelegramAlert(
      `💰 <b>Wave Profit Secured (+22%)</b>\n` +
      `Mint: <code>${mintAddress}</code>\n` +
      `Current MC: <b>$${currentMc.toFixed(0)}</b>\n` +
      `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : ''}`
    );
  }

  const hitStopLoss = pnlPercentage <= -10;
  const hitTrailingDrop = position.tookPartialProfit && dropFromPeak >= 10;
  const hitTimeout = ageMs > 240000;

  if (hitStopLoss || hitTrailingDrop || hitTimeout) {
    console.log(`🚪 Exit Triggered for ${mintAddress} (PnL: ${pnlPercentage.toFixed(2)}%)`);
    activePositions.delete(mintAddress);

    const tx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'sell');
    await sendTelegramAlert(
      `🚪 <b>Position Closed</b>\n` +
      `Mint: <code>${mintAddress}</code>\n` +
      `Final PnL: ${pnlPercentage.toFixed(2)}%\n` +
      `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : ''}`
    );
  }
}

// --- WEBSOCKET ENGINE ---
function startWebSocketListener() {
  console.log('⚡ Connecting to PumpPortal Real-Time Engine...');
  
  globalWs = new WebSocket('wss://pumpportal.fun/api/data');

  globalWs.on('open', () => {
    console.log('🟢 Connected. Subscribing to trade and creation feeds...');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
    globalWs.send(JSON.stringify({ method: 'subscribeTrade' }));
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!event || !event.mint) return;

      const mintAddress = event.mint;

      if (activePositions.has(mintAddress)) {
        const currentMc = event.marketCapUsd || event.usd_market_cap || ((event.vSolInBondingCurve || event.virtualSolReserves / 1e9 || 0) * 200 * 5) || 0;
        if (currentMc > 0) await evaluatePositionRealtime(mintAddress, currentMc);
        return;
      }

      // Calculate accurate Market Cap
      const solPriceUsd = 200;
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0);
      const marketCapUsd = event.marketCapUsd || event.usd_market_cap || (solReserves > 0 ? solReserves * solPriceUsd * 5 : 0);

      // Strict validation: Require actual 'buy' trade momentum within target range
      if (marketCapUsd > 0 && event.txType === 'buy') {
        console.log(`🔎 Active Trade Token: ${mintAddress.slice(0, 6)}... | MC: $${marketCapUsd.toFixed(0)} | SOL: ${event.solAmount}`);

        if (marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
          let stats = tokenMetrics.get(mintAddress);
          if (!stats) {
            stats = { buyCount: 0, volumeSol: 0 };
            tokenMetrics.set(mintAddress, stats);
          }

          stats.buyCount += 1;
          stats.volumeSol += Number(event.solAmount || 0.2);

          console.log(`🎯 SWEET SPOT BUY MATCH: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)} | Buys: ${stats.buyCount} | Vol: ${stats.volumeSol.toFixed(2)} SOL`);

          if (stats.buyCount >= 2 && stats.volumeSol >= 0.5 && !processedMints.has(mintAddress)) {
            processedMints.add(mintAddress);
            tokenMetrics.delete(mintAddress);

            console.log(`🌊 MOMENTUM WAVE LOCKED: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)} - Executing Buy...`);

            const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

            if (buyTx) {
              console.log(`✅ Wave buy completed for: ${mintAddress}`);
              
              activePositions.set(mintAddress, {
                entryMc: marketCapUsd,
                peakMc: marketCapUsd,
                entryTime: Date.now(),
                remainingTokens: TRADE_AMOUNT_SOL,
                tookPartialProfit: false
              });

              await sendTelegramAlert(
                `🌊 <b>Wave Entry Triggered</b>\n` +
                `Mint: <code>${mintAddress}</code>\n` +
                `Entry MC: <b>$${marketCapUsd.toFixed(0)}</b>\n` +
                `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
              );
            }
          }
        }
      }
    } catch (err) {
      console.error('❌ Error parsing stream message:', err.message);
    }
  });

  globalWs.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });

  globalWs.on('close', () => {
    console.log('⚠️ WebSocket disconnected. Reconnecting in 5 seconds...');
    setTimeout(startWebSocketListener, 5000);
  });
}

// --- INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);
  await sendTelegramAlert(
    `🚀 <b>Momentum Wave Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Multi-Feed Stream Active ($4K-$50K MC).`
  );
  startWebSocketListener();
}

main();
