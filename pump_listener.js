import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// --- CONFIGURATION & ENV VARS ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_ENDPOINT || !RAW_PRIVATE_KEY) {
  console.error('❌ CRITICAL ERROR: Missing RPC or Private Key in Railway variables!');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const TRADE_AMOUNT_SOL = 0.05; // Amount in SOL per buy

// --- TARGET WINDOW & LIQUIDITY FILTERS ---
const MIN_MARKET_CAP_USD = 15000;  
const MAX_MARKET_CAP_USD = 100000; 
const MIN_2H_VOLUME_USD = 1000;    // Ensures coin has active volume and isn't a dead $41 shitcoin

// --- RISK MANAGEMENT ---
const STOP_LOSS_PERCENT = -8.0;     
const TRAILING_DROP_PERCENT = -7.0;    
const TAKE_PROFIT_PERCENT = 45.0;      

let activePositions = new Map(); 
let processedMints = new Set();

// --- TELEGRAM NOTIFIER ---
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) {
      process.stdout.write(`❌ Telegram API Error: ${data.description}\n`);
    }
  } catch (err) {
    process.stdout.write(`❌ Telegram network error: ${err.message}\n`);
  }
}

// --- LOCAL SWAP EXECUTION ---
async function executeLocalPumpSwap(mintAddress, amountSol, action = 'buy') {
  try {
    process.stdout.write(`🔄 Requesting ${action.toUpperCase()} order for ${mintAddress} (${amountSol} SOL)...\n`);

    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action: action,
        mint: mintAddress,
        amount: action === 'sell' ? '100%' : amountSol,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: 35,
        priorityFee: 0.003,
        pool: 'auto'
      })
    });

    if (!response.ok) throw new Error(await response.text());

    const arrayBuffer = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(arrayBuffer));
    transaction.sign([wallet]);

    const txid = await connection.sendTransaction(transaction, { skipPreflight: true, maxRetries: 3 });
    process.stdout.write(`✅ Transaction Executed (${action.toUpperCase()}): ${txid}\n`);
    return txid;
  } catch (err) {
    process.stdout.write(`❌ Trade Execution Failed (${action.toUpperCase()}): ${err.message}\n`);
    return null;
  }
}

// --- ACTIVE MARKET SCANNER LOOP ---
async function scanAndTradeMarkets() {
  try {
    process.stdout.write('🔍 Scanning active Pump.fun markets for momentum...\n');
    
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=pump', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!res.ok) throw new Error(`DexScreener status ${res.status}`);
    const data = await res.json();
    if (!data.pairs) return;

    for (const pair of data.pairs) {
      if (pair.chainId !== 'solana') continue;
      
      const mintAddress = pair.baseToken?.address;
      const marketCap = pair.marketCap || 0;
      const volume2h = pair.volume?.h2 || pair.volume?.h1 || 0;

      if (!mintAddress) continue;

      // 1. POSITION MANAGEMENT (Stop-Loss / Take-Profit)
      if (activePositions.has(mintAddress) && marketCap > 0) {
        const pos = activePositions.get(mintAddress);
        
        if (marketCap > pos.highestMc) {
          pos.highestMc = marketCap;
          activePositions.set(mintAddress, pos);
        }

        const pnlPercent = ((marketCap - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((marketCap - pos.highestMc) / pos.highestMc) * 100;

        let exitReason = null;
        if (pnlPercent <= STOP_LOSS_PERCENT) {
          exitReason = `Stop-Loss Triggered (${pnlPercent.toFixed(1)}%)`;
        } else if (pnlPercent > 10 && dropFromPeak <= TRAILING_DROP_PERCENT) {
          exitReason = `Trailing Profit Lock Triggered`;
        } else if (pnlPercent >= TAKE_PROFIT_PERCENT) {
          exitReason = `Take-Profit Target Reached (+${pnlPercent.toFixed(1)}%)`;
        }

        if (exitReason) {
          activePositions.delete(mintAddress);
          process.stdout.write(`🔴 EXITING POSITION: ${mintAddress.slice(0, 6)}... | Reason: ${exitReason}\n`);
          
          const sellTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'sell');
          if (sellTx) {
            await sendTelegramAlert(
              `🔴 <b>Position Closed</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Reason: <b>${exitReason}</b>\n` +
              `Final PnL: <b>${pnlPercent.toFixed(1)}%</b>\n` +
              `Exit MC: <b>$${marketCap.toFixed(0)}</b>`
            );
          }
        }
        continue;
      }

      // 2. ENTRY FILTER MATCH (Target MC + Real Active Volume)
      if (!processedMints.has(mintAddress)) {
        if (marketCap >= MIN_MARKET_CAP_USD && marketCap <= MAX_MARKET_CAP_USD && volume2h >= MIN_2H_VOLUME_USD) {
          processedMints.add(mintAddress);

          process.stdout.write(`🚀 MOMENTUM MATCH: ${mintAddress.slice(0, 6)}... | MC: $${marketCap.toFixed(0)} | Volume: $${volume2h}\n`);
          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            activePositions.set(mintAddress, {
              entryMc: marketCap,
              highestMc: marketCap,
              buyTime: Date.now()
            });

            await sendTelegramAlert(
              `🚀 <b>Momentum Snipe Entry!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Entry MC: <b>~$${marketCap.toFixed(0)}</b>\n` +
              `Volume: <b>$${volume2h}</b>\n` +
              `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
            );
          }
        }
      }
    }
  } catch (err) {
    process.stdout.write(`⚠️ Scanner warning: ${err.message}\n`);
  }
}

async function main() {
  process.stdout.write(`🔑 Bot Active: ${wallet.publicKey.toString()}\n`);
  await sendTelegramAlert('⚡ <b>Pump.fun Active Momentum Scanner Online</b>');
  
  // Run scanner every 7 seconds
  setInterval(scanAndTradeMarkets, 7000);
  scanAndTradeMarkets();
}

main();
