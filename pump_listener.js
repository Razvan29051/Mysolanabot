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

// --- STRATEGY TARGETS ($3K - $35K MC Sweet Spot) ---
const MIN_MARKET_CAP_USD = 3000;
const MAX_MARKET_CAP_USD = 35000;

// Track active positions: mint -> { entryMc, tokenAmount, peakMc, wsInstance }
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

// --- LOCAL TRANSACTION PUMP.FUN EXECUTION ---
async function executeLocalPumpSwap(mintAddress, amountSol, action = 'buy') {
  try {
    console.log(`🔄 Requesting local trade for ${mintAddress} (${amountSol} SOL, action: ${action})...`);

    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action: action,
        mint: mintAddress,
        amount: amountSol,
        denominatedInSol: "true",
        slippage: 25, // Slightly higher slippage to ensure fills on volatile pumps
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

    console.log(`✅ Transaction submitted successfully: ${txid}`);
    return txid;
  } catch (err) {
    console.error(`❌ Local swap execution failed (${action}):`, err.message);
    return null;
  }
}

// --- REAL-TIME POSITION EVALUATION ---
async function evaluatePositionRealtime(mintAddress, currentMc) {
  const position = activePositions.get(mintAddress);
  if (!position) return;

  if (currentMc > position.peakMc) {
    position.peakMc = currentMc;
  }

  const pnlPercentage = ((currentMc - position.entryMc) / position.entryMc) * 100;
  const dropFromPeak = ((position.peakMc - currentMc) / position.peakMc) * 100;
  const ageMs = Date.now() - position.entryTime;

  // TAKE PROFIT: Hit +18% gain -> Sell 60% of position to lock in profit
  if (pnlPercentage >= 18 && !position.tookPartialProfit) {
    position.tookPartialProfit = true;
    const sellAmount = Number((TRADE_AMOUNT_SOL * 0.6).toFixed(4));
    position.remainingTokens -= sellAmount;

    console.log(`💰 Target PnL reached (+18%) for ${mintAddress}. Locking in partial profits...`);
    const tx = await executeLocalPumpSwap(mintAddress, sellAmount, 'sell');
    await sendTelegramAlert(
      `💰 <b>Partial Profit Secured (+18%)</b>\n` +
      `Mint: <code>${mintAddress}</code>\n` +
      `Current MC: <b>$${currentMc.toFixed(0)}</b>\n` +
      `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : ''}`
    );
  }

  // STOP LOSS / TRAILING EXIT: Drop -10% from peak, or hard stop -12%, or 3-minute timeout
  const hitStopLoss = pnlPercentage <= -12;
  const hitTrailingDrop = position.tookPartialProfit && dropFromPeak >= 8;
  const hitTimeout = ageMs > 180000;

  if (hitStopLoss || hitTrailingDrop || hitTimeout) {
    console.log(`🚪 Closing position for ${mintAddress} (PnL: ${pnlPercentage.toFixed(2)}%). Executing sell...`);
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

// --- WEBSOCKET STREAM & TRADE LISTENER ---
function startWebSocketListener() {
  console.log('⚡ Connecting to PumpPortal Real-Time Stream...');
  
  globalWs = new WebSocket('wss://pumpportal.fun/api/data');

  globalWs.on('open', () => {
    console.log('🟢 Connected to PumpPortal WebSocket. Subscribing...');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      
      // Handle live trade updates for active positions
      if (event && event.mint && activePositions.has(event.mint)) {
        const currentMc = event.usd_market_cap || (event.marketCapSol * 200) || 0;
        if (currentMc > 0) {
          await evaluatePositionRealtime(event.mint, currentMc);
        }
      }

      // Handle brand new token launches
      if (event && event.mint && event.vSolInBondingCurve !== undefined) {
        const mintAddress = event.mint;
        if (processedMints.has(mintAddress) || activePositions.has(mintAddress)) return;

        const solPriceUsd = 200;
        const marketCapUsd = event.usd_market_cap || ((event.virtualSolReserves / 1e9) * solPriceUsd * 5) || 15000;

        console.log(`👀 Evaluated Token: ${mintAddress.slice(0, 6)}... | MC: $${marketCapUsd.toFixed(0)}`);

        if (marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
          processedMints.add(mintAddress);

          console.log(`💎 MOMENTUM TARGET LOCKED: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)} - Executing Buy...`);

          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            console.log(`✅ Successfully bought position for token: ${mintAddress}`);
            
            // Register active position with real entry market cap
            activePositions.set(mintAddress, {
              entryMc: marketCapUsd,
              peakMc: marketCapUsd,
              entryTime: Date.now(),
              remainingTokens: TRADE_AMOUNT_SOL,
              tookPartialProfit: false
            });

            // Subscribe to real-time trade updates for this specific token mint
            if (globalWs && globalWs.readyState === WebSocket.OPEN) {
              globalWs.send(JSON.stringify({
                method: "subscribeTokenTrade",
                keys: [mintAddress]
              }));
            }

            await sendTelegramAlert(
              `✅ <b>Position Entered & Bought</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Entry MC: <b>$${marketCapUsd.toFixed(0)}</b>\n` +
              `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
            );
          } else {
            console.log(`❌ Buy failed for ${mintAddress}.`);
          }
        }
      }
    } catch (err) {
      console.error('❌ Error processing websocket message:', err.message);
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

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Real-Time Market Cap Tracking Active.`
  );
  startWebSocketListener();
}

main();
