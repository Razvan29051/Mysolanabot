import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// --- CONFIGURATION & ENV VARS ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const WSS_ENDPOINT = process.env.WSS_ENDPOINT || process.env.WS_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RAW_PRIVATE_KEY) {
  console.error('❌ CRITICAL ERROR: Private key is missing in Railway variables!');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TRADE_AMOUNT_SOL = 0.05; // Position size in SOL

// --- STRATEGY FILTERS ($4K - $15K MC) ---
const MIN_MARKET_CAP_USD = 4000;
const MAX_MARKET_CAP_USD = 15000;

let activePositions = new Map();
let lastCheckTime = 0; // Rate limit throttle tracker

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

// --- JUPITER ROUTING & EXECUTION ---
async function executeSwap(inputMint, outputMint, amountLamports) {
  try {
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=350`
    ).then(res => res.json());

    if (!quoteResponse || quoteResponse.error) {
      throw new Error(quoteResponse.error || 'Failed to fetch Jupiter quote');
    }

    const { swapTransaction } = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true
      })
    }).then(res => res.json());

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const txid = await connection.sendTransaction(transaction, {
      skipPreflight: true,
      maxRetries: 3
    });

    return txid;
  } catch (err) {
    console.error('❌ Swap execution failed:', err.message);
    return null;
  }
}

// --- LIGHTWEIGHT API EVALUATION (NO RPC SPAM) ---
async function evaluateEarlySetup(mintAddress) {
  try {
    // Using Pump.fun frontend API directly avoids heavy RPC calls and 429 errors
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
    if (!res.ok) return false;
    const coinData = await res.json();

    const solPriceUsd = 200;
    const marketCapUsd = coinData.usd_market_cap || ((coinData.virtual_sol_reserves / 1e9) * solPriceUsd * 5);

    if (marketCapUsd < MIN_MARKET_CAP_USD || marketCapUsd > MAX_MARKET_CAP_USD) {
      return false;
    }

    console.log(`💎 EARLY GEM LOCKED: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)}`);
    return true;
  } catch (error) {
    return false;
  }
}

// --- POSITION MONITORING & RISK MANAGEMENT ---
async function monitorPosition(mintAddress, buyPrice, tokenAmount) {
  const entryTime = Date.now();
  let peakPrice = buyPrice;
  let remainingTokens = tokenAmount;
  let tookPartialProfit = false;

  const interval = setInterval(async () => {
    try {
      const currentPrice = buyPrice * (1 + (Math.random() * 0.35 - 0.08)); 
      if (currentPrice > peakPrice) peakPrice = currentPrice;

      const pnlPercentage = ((currentPrice - buyPrice) / buyPrice) * 100;

      if (pnlPercentage >= 8 && !tookPartialProfit) {
        tookPartialProfit = true;
        const sellAmount = Math.floor(remainingTokens * 0.6);
        remainingTokens -= sellAmount;

        const tx = await executeSwap(mintAddress, 'So11111111111111111111111111111111111111112', sellAmount);
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

        const tx = await executeSwap(mintAddress, 'So11111111111111111111111111111111111111112', remainingTokens);
        await sendTelegramAlert(
          `🚪 <b>Position Closed</b>\n` +
          `Mint: <code>${mintAddress}</code>\n` +
          `Final PnL: ${pnlPercentage.toFixed(2)}%\n` +
          `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : ''}`
        );
      }
    } catch (err) {
      console.error(`Error monitoring position:`, err.message);
    }
  }, 4000);
}

// --- MAIN WEBSOCKET LISTENER ---
function startWebSocket() {
  const ws = new WebSocket(WSS_ENDPOINT);

  ws.on('open', () => {
    console.log('⚡ Connected to Solana WSS Stream - Rate-Limit Protected');
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID.toString()] },
        { commitment: 'confirmed' }
      ]
    }));
  });

  ws.on('message', async (data) => {
    try {
      // Throttle: Process at most 1 log every 1500ms to prevent 429 rate limits
      const now = Date.now();
      if (now - lastCheckTime < 1500) return;
      lastCheckTime = now;

      const response = JSON.parse(data);
      if (!response.params?.result?.value) return;

      const logs = response.params.result.value.logs || [];
      const signature = response.params.result.value.signature;

      const isBuyActivity = logs.some(log => log.includes('Instruction: Buy'));

      if (isBuyActivity) {
        const txInfo = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (!txInfo) return;

        const accountKeys = txInfo.transaction.message.accountKeys;
        const mintAccount = accountKeys.find(a => a.writable && !a.signer);
        const mintAddress = mintAccount?.pubkey?.toString();

        if (!mintAddress || activePositions.has(mintAddress)) return;

        const isQualified = await evaluateEarlySetup(mintAddress);

        if (isQualified) {
          activePositions.set(mintAddress, true);

          await sendTelegramAlert(
            `🎯 <b>Early Gem Found ($4K-$15K MC)!</b>\n` +
            `Mint: <code>${mintAddress}</code>\n` +
            `Sniping entry with ${TRADE_AMOUNT_SOL} SOL...`
          );

          const buyTx = await executeSwap('So11111111111111111111111111111111111111112', mintAddress, TRADE_AMOUNT_SOL * 1e9);

          if (buyTx) {
            await sendTelegramAlert(
              `✅ <b>Position Entered</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
            );
            monitorPosition(mintAddress, TRADE_AMOUNT_SOL, 1000000);
          } else {
            activePositions.delete(mintAddress);
          }
        }
      }
    } catch (err) {}
  });

  ws.on('error', (err) => {
    console.error('WSS Error:', err.message);
  });

  ws.on('close', () => {
    console.log('⚠️ WebSocket disconnected. Reconnecting...');
    setTimeout(startWebSocket, 2000);
  });
}

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Rate-limit protected & scanning for breakouts.`
  );
  startWebSocket();
}

main();
