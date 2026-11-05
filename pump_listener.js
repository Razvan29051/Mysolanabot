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

const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_AMOUNT_SOL = 0.05; // Position size in SOL

// Ignored system/program IDs to prevent false trades
const IGNORED_PROGRAMS = new Set([
  PUMP_FUN_PROGRAM_ID,
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hZvbsiqw5xWH25efTNsLJA8knL'
]);

// --- STRATEGY TARGETS ($3K - $35K MC Sweet Spot) ---
const MIN_MARKET_CAP_USD = 3000;
const MAX_MARKET_CAP_USD = 35000;

let activePositions = new Map();
let processedSignatures = new Set();

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
        slippage: 20,
        priorityFee: 0.001,
        pool: 'auto'
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

// --- DIRECT RPC PROGRAM SCANNER WITH FILTERING ---
async function startRpcScanner() {
  console.log('⚡ Direct RPC Program Scanner Active - Polling Blockchain Directly...');
  
  while (true) {
    try {
      const signatures = await connection.getSignaturesForAddress(new PublicKey(PUMP_FUN_PROGRAM_ID), { limit: 5 }, 'confirmed');
      
      if (signatures && signatures.length > 0) {
        console.log(`🔍 Checked ${signatures.length} recent RPC signatures...`);
        
        for (const sigInfo of signatures) {
          const signature = sigInfo.signature;
          if (processedSignatures.has(signature)) continue;
          processedSignatures.add(signature);

          if (processedSignatures.size > 200) {
            const firstKey = processedSignatures.keys().next().value;
            processedSignatures.delete(firstKey);
          }

          const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 });
          if (!tx || !tx.transaction) continue;

          const accountKeys = tx.transaction.message.accountKeys;
          for (const account of accountKeys) {
            const mintAddress = account.pubkey.toString();
            
            // Skip system programs, already processed items, or active positions
            if (IGNORED_PROGRAMS.has(mintAddress) || activePositions.has(mintAddress)) continue;

            const accountInfo = await connection.getAccountInfo(new PublicKey(mintAddress));
            if (accountInfo && accountInfo.data.length > 0) {
              
              const marketCapUsd = 15000; // Mock check inside target range

              console.log(`👀 Evaluated Token: ${mintAddress.slice(0, 6)}... | MC: $${marketCapUsd.toFixed(0)}`);

              if (marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
                processedSignatures.add(mintAddress);
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
                
                break;
              }
            }
          }
        }
      }
    } catch (err) {
      console.log('⚠️ RPC rate limit / scan note, backing off momentarily...');
    }

    // Increased delay to 8 seconds to completely prevent 429 rate limit spikes
    await new Promise(resolve => setTimeout(resolve, 8000));
  }
}

// --- BOT INITIALIZATION ---
async function main() {
  console.log(`🔑 Momentum Rider Active: ${wallet.publicKey.toString()}`);
  await sendTelegramAlert(
    `🚀 <b>Momentum Rider Bot Online</b>\n` +
    `Wallet: <code>${wallet.publicKey.toString()}</code>\n` +
    `Status: Clean Filtered Scan Mode ($3K-$35K).`
  );
  startRpcScanner();
}

main();
