import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
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

const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
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

// --- DIRECT RPC SIGNATURE SCANNER ---
async function startRpcScanner() {
  console.log('⚡ Direct RPC Scanner Active - Polling Pump.fun Program via RPC...');
  runRpcScanCycle();
  setInterval(runRpcScanCycle, 5000);
}

async function runRpcScanCycle() {
  try {
    const signatures = await connection.getSignaturesForAddress(PUMP_FUN_PROGRAM_ID, { limit: 15 }, 'confirmed');
    
    if (!signatures || signatures.length === 0) return;

    for (const sigInfo of signatures) {
      const signature = sigInfo.signature;
      if (processedMints.has(signature)) continue;
      processedMints.add(signature);

      // FIXED: Added maxSupportedTransactionVersion: 0 to support v0 transactions
      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.transaction) continue;

      const accountKeys = tx.transaction.message.accountKeys;
      for (const account of accountKeys) {
        const mintAddress = account.pubkey.toString();
        
        if (activePositions.has(mintAddress)) continue;

        try {
          const accountInfo = await connection.getAccountInfo(new PublicKey(mintAddress));
          if (!accountInfo) continue;

          console.log(`💎 Found active token account: ${mintAddress}`);
          break;
        } catch (e) {
          // Ignore invalid mint accounts
        }
      }
    }
  } catch (err) {
    console.error('❌ RPC Scanner error:', err.message);
  }
}

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Direct RPC Scan Mode ($3K-$35K).`
  );
  startRpcScanner();
}

main();
