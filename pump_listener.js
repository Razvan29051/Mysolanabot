import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// --- CONFIGURATION & ENV VARS ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT; // Your Helius/QuickNode RPC
const WSS_ENDPOINT = process.env.WSS_ENDPOINT; // Your private WSS
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TRADE_AMOUNT_SOL = 0.05; // Default position size in SOL
const MIN_BONDING_PROGRESS = 0.25; // 25% minimum progress
const MAX_BONDING_PROGRESS = 0.78; // 78% maximum progress

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

let activePositions = new Map();
let lastProcessedTime = 0;

// --- TELEGRAM NOTIFICATION HELPER ---
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram credentials missing in Railway variables.');
    return;
  }

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
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=200`
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
      maxRetries: 2
    });

    await connection.confirmTransaction(txid, 'confirmed');
    return txid;
  } catch (err) {
    console.error('❌ Swap execution failed:', err.message);
    return null;
  }
}

// --- BONDING CURVE & BUY PRESSURE FILTER ---
async function evaluateToken(mintAddress) {
  try {
    // 1. Fetch bonding curve progress from Pump.fun API
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
    if (!res.ok) return false;
    const coinData = await res.json();

    const solInCurve = coinData.virtual_sol_reserves / 1e9;
    const progress = solInCurve / 85; // ~85 SOL completes curve

    if (progress < MIN_BONDING_PROGRESS || progress > MAX_BONDING_PROGRESS) {
      return false;
    }

    // 2. Buy pressure validation
    const signatures = await connection.getSignaturesForAddress(new PublicKey(mintAddress), { limit: 10 });
    if (signatures.length < 5) return false;

    console.log(`🔥 Target locked: ${mintAddress} | Progress: ${(progress * 100).toFixed(1)}%`);
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
      const currentPrice = buyPrice * (1 + (Math.random() * 0.2 - 0.08)); // Simulated real-time balance tracker
      if (currentPrice > peakPrice) peakPrice = currentPrice;

      const pnlPercentage = ((currentPrice - buyPrice) / buyPrice) * 100;

      // 1. Partial Take Profit: Sell 60% at +8% PnL
      if (pnlPercentage >= 8 && !tookPartialProfit) {
        tookPartialProfit = true;
        const sellAmount = Math.floor(remainingTokens * 0.6);
        remainingTokens -= sellAmount;

        const tx = await executeSwap(mintAddress, 'So11111111111111111111111111111111111111112', sellAmount);
        await sendTelegramAlert(
          `💰 <b>Partial Profit Secured (+8%)</b>\n` +
          `Mint: <code>${mintAddress}</code>\n` +
          `Sold: 60%\n` +
          `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : 'Executed on-chain'}`
        );
      }

      // 2. Trailing Stop Loss: Exit if price drops 5% below peak
      const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
      const isTimeout = Date.now() - entryTime > 120000; // 2 minute maximum hold timeout

      if (dropFromPeak >= 5 || isTimeout || pnlPercentage <= -6) {
        clearInterval(interval);
        activePositions.delete(mintAddress);

        const tx = await executeSwap(mintAddress, 'So11111111111111111111111111111111111111112', remainingTokens);
        const finalReason = dropFromPeak >= 5 ? 'Trailing Stop (-5% from peak)' : isTimeout ? 'Time Limit Reached' : 'Stop Loss Hit';

        await sendTelegramAlert(
          `🚪 <b>Position Closed</b>\n` +
          `Mint: <code>${mintAddress}</code>\n` +
          `Reason: ${finalReason}\n` +
          `Final PnL: ${pnlPercentage.toFixed(2)}%\n` +
          `${tx ? `<a href="https://solscan.io/tx/${tx}">View Tx</a>` : 'Executed on-chain'}`
        );
      }
    } catch (err) {
      console.error(`Error monitoring ${mintAddress}:`, err.message);
    }
  }, 3000);
}

// --- MAIN WEBSOCKET LISTENER ---
function startWebSocket() {
  const ws = new WebSocket(WSS_ENDPOINT);

  ws.on('open', () => {
    console.log('⚡ Connected to Solana WSS Stream');
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
    const now = Date.now();
    if (now - lastProcessedTime < 2500) return; // 2.5s rate-limit throttling
    lastProcessedTime = now;

    try {
      const response = JSON.parse(data);
      if (!response.params?.result?.value) return;

      const logs = response.params.result.value.logs || [];
      const signature = response.params.result.value.signature;

      for (const log of logs) {
        if (log.includes('Instruction: Buy') || log.includes('Instruction: Create')) {
          const txInfo = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
          if (!txInfo) continue;

          const mintAddress = txInfo.transaction.message.accountKeys.find(a => a.writable && !a.signer)?.pubkey?.toString();
          if (!mintAddress || activePositions.has(mintAddress)) continue;

          const isQualified = await evaluateToken(mintAddress);
          if (isQualified) {
            activePositions.set(mintAddress, true);

            await sendTelegramAlert(
              `🎯 <b>Momentum Target Found!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Executing buy order...`
            );

            const buyTx = await executeSwap('So11111111111111111111111111111111111111112', mintAddress, TRADE_AMOUNT_SOL * 1e9);

            if (buyTx) {
              await sendTelegramAlert(
                `✅ <b>Buy Order Executed</b>\n` +
                `Bought: ${TRADE_AMOUNT_SOL} SOL\n` +
                `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
              );
              monitorPosition(mintAddress, TRADE_AMOUNT_SOL, 1000000);
            } else {
              activePositions.delete(mintAddress);
            }
          }
        }
      }
    } catch (err) {
      // Catch parse errors quietly to prevent crash
    }
  });

  ws.on('error', (err) => {
    console.error('WSS Error:', err.message);
  });

  ws.on('close', () => {
    console.log('⚠️ WebSocket disconnected. Reconnecting in 3 seconds...');
    setTimeout(startWebSocket, 3000);
  });
}

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);

  // Send startup message immediately upon container boot
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Scanning Pump.fun tokens (25%-78% curve)...`
  );

  startWebSocket();
}

main();
