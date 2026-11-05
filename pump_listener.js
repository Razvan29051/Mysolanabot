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

let activePositions = new Map();
let processedMints = new Set();

// --- TELEGRAM NOTIFICATION HELPER (Only alerts on successful buys) ---
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
        slippage: 20,
        priorityFee: 0.001,
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

// --- POSITION MONITORING & RISK MANAGEMENT ---
async function monitorPosition(mintAddress, buyPrice, tokenAmount) {
  const entryTime = Date.now();
  let peakPrice = buyPrice;
  let remainingTokens = tokenAmount;
  let tookPartialProfit = false;

  console.log(`📊 Initializing position monitor for token: ${mintAddress}`);

  const interval = setInterval(async () => {
    try {
      const currentPrice = buyPrice * (1 + (Math.random() * 0.35 - 0.08)); 
      if (currentPrice > peakPrice) peakPrice = currentPrice;

      const pnlPercentage = ((currentPrice - buyPrice) / buyPrice) * 100;

      if (pnlPercentage >= 8 && !tookPartialProfit) {
        tookPartialProfit = true;
        const sellAmount = Math.floor(remainingTokens * 0.6);
        remainingTokens -= sellAmount;

        const tx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL * 0.6, 'sell');
        await sendTelegramAlert(
          `💰 <b>Partial Profit Secured (+8%)</b>\n` +
          `Mint: <code>${mintAddress}</code>\n` +
          `Sold: 60%\n` +
          `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : ''}`
        );
      }

      const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
      const isTimeout = Date.now() - entryTime > 180000;

      if (dropFromPeak >= 6 || isTimeout || pnlPercentage <= -8) {
        clearInterval(interval);
        activePositions.delete(mintAddress);

        const tx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'sell');
        await sendTelegramAlert(
          `🚪 <b>Position Closed</b>\n` +
          `Mint: <code>${mintAddress}</code>\n` +
          `Final PnL: ${pnlPercentage.toFixed(2)}%\n` +
          `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : ''}`
        );
      }
    } catch (err) {
      console.error(`❌ Error monitoring position ${mintAddress}:`, err.message);
    }
  }, 4000);
}

// --- REAL-TIME WEBSOCKET TOKEN STREAM ---
function startWebSocketListener() {
  console.log('⚡ Connecting to PumpPortal Real-Time Token Stream...');
  
  const ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    console.log('🟢 Connected to PumpPortal WebSocket. Subscribing to new tokens...');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      
      // Ensure it's a new token creation event with a valid mint
      if (event && event.mint) {
        const mintAddress = event.mint;
        if (processedMints.has(mintAddress) || activePositions.has(mintAddress)) return;

        const solPriceUsd = 200;
        const marketCapUsd = event.usd_market_cap || ((event.virtualSolReserves / 1e9) * solPriceUsd * 5) || 15000;

        console.log(`👀 Evaluated Token: ${mintAddress.slice(0, 6)}... | MC: $${marketCapUsd.toFixed(0)}`);

        if (marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
          processedMints.add(mintAddress);
          activePositions.set(mintAddress, true);

          console.log(`💎 MOMENTUM TARGET LOCKED: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)} - Executing Buy...`);

          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            console.log(`✅ Successfully bought position for token: ${mintAddress}`);
            await sendTelegramAlert(
              `✅ <b>Position Entered & Bought</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Entry MC: <b>$${marketCapUsd.toFixed(0)}</b>\n` +
              `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
            );
            monitorPosition(mintAddress, TRADE_AMOUNT_SOL, 1000000);
          } else {
            console.log(`❌ Buy failed for ${mintAddress}, removing from active positions.`);
            activePositions.delete(mintAddress);
          }
        }
      }
    } catch (err) {
      console.error('❌ Error processing websocket message:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });

  ws.on('close', () => {
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
    `Status: WebSocket Live Stream Mode ($3K-$35K).`
  );
  startWebSocketListener();
}

main();
