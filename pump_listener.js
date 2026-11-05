import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// --- CONFIGURATION & ENV VARS ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

// --- API SCANNER LOOP WITH BROWSER HEADERS ---
async function startScanner() {
  console.log('⚡ Pump.fun API Scanner Active - Scanning $3K-$35K Range...');
  runScanCycle();
  setInterval(runScanCycle, 4000);
}

async function runScanCycle() {
  try {
    const res = await fetch('https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Origin': 'https://pump.fun',
        'Referer': 'https://pump.fun/'
      }
    });
    
    if (!res.ok) {
      console.log(`⚠️ API returned status: ${res.status}`);
      return;
    }
    
    const coins = await res.json();
    console.log(`🔍 Successfully fetched ${coins.length} coins. Evaluating market caps...`);

    for (const coin of coins) {
      const mintAddress = coin.mint;
      if (!mintAddress || processedMints.has(mintAddress) || activePositions.has(mintAddress)) continue;

      const solPriceUsd = 200;
      const marketCapUsd = coin.usd_market_cap || ((coin.virtual_sol_reserves / 1e9) * solPriceUsd * 5);

      if (marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
        processedMints.add(mintAddress);
        console.log(`💎 MOMENTUM TARGET LOCKED: ${mintAddress} | MC: $${marketCapUsd.toFixed(0)}`);

        await sendTelegramAlert(
          `🎯 <b>Momentum Target Found ($3K-$35K MC)!</b>\n` +
          `Mint: <code>${mintAddress}</code>\n` +
          `Market Cap: $${marketCapUsd.toFixed(0)}\n` +
          `Sniping entry with ${TRADE_AMOUNT_SOL} SOL...`
        );

        activePositions.set(mintAddress, true);
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
        
        break; 
      }
    }
  } catch (err) {
    console.error('❌ Scanner loop error:', err.message);
  }
}

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Active Scan Mode ($3K-$35K).`
  );
  startScanner();
}

main();
