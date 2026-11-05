import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import WebSocket from 'ws';
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

// --- STRICT MOMENTUM & MARKET CAP TARGETS ---
const MIN_MARKET_CAP_USD = 15000;  // Skip instant micro-rugs (<$15K)
const MAX_MARKET_CAP_USD = 80000;  // Sweet spot for 5x–10x expansion
const MIN_SOL_VELOCITY = 0.3;      // Minimum SOL accumulation required to confirm green pressure

// --- RISK MANAGEMENT ---
const STOP_LOSS_PERCENT = -8.0;     // Hard stop-loss at -8%
const TRAILING_DROP_PERCENT = -7.0;    // Trail profit and exit if it drops 7% from peak
const TAKE_PROFIT_PERCENT = 45.0;      // Take profit target

let activePositions = new Map(); 
let tokenTrackers = new Map();     
let processedMints = new Set();
let globalWs = null;

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

// --- LIVE WEBSOCKET ENGINE ---
function startWebSocketListener() {
  process.stdout.write('⚡ Connecting to PumpPortal Stream...\n');
  
  const wsUrl = `wss://pumpportal.fun/api/data`;
  globalWs = new WebSocket(wsUrl);

  globalWs.on('open', () => {
    process.stdout.write('🟢 Connected! Monitoring bonding curve momentum...\n');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!event || !event.mint) return;

      const mintAddress = event.mint;
      const solPriceUsd = 200;
      
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0.03);
      const currentMc = event.marketCapUsd || event.usd_market_cap || (solReserves * solPriceUsd * 5);

      // 1. ACTIVE POSITION MANAGEMENT (Stop-Loss / Take-Profit / Trailing)
      if (activePositions.has(mintAddress) && currentMc > 0) {
        const pos = activePositions.get(mintAddress);
        
        if (currentMc > pos.highestMc) {
          pos.highestMc = currentMc;
          activePositions.set(mintAddress, pos);
        }

        const pnlPercent = ((currentMc - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((currentMc - pos.highestMc) / pos.highestMc) * 100;

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
              `Exit MC: <b>$${currentMc.toFixed(0)}</b>`
            );
          }
        }
        return;
      }

      // 2. MOMENTUM & GREEN CANDLE VELOCITY FILTER
      if (!processedMints.has(mintAddress)) {
        if (!tokenTrackers.has(mintAddress)) {
          // Initialize tracking window
          tokenTrackers.set(mintAddress, {
            startSol: solReserves,
            peakSol: solReserves,
            lastMc: currentMc,
            createdAt: Date.now()
          });
        } else {
          let tracker = tokenTrackers.get(mintAddress);
          tracker.peakSol = Math.max(tracker.peakSol, solReserves);
          tracker.lastMc = currentMc;
          
          const solGained = tracker.peakSol - tracker.startSol;

          // Check if token hits our target criteria during the active wave
          if (tracker.lastMc >= MIN_MARKET_CAP_USD && tracker.lastMc <= MAX_MARKET_CAP_USD && solGained >= MIN_SOL_VELOCITY) {
            processedMints.add(mintAddress);
            tokenTrackers.delete(mintAddress);

            process.stdout.write(`🚀 GREEN CANDLE MOMENTUM DETECTED: ${mintAddress.slice(0, 6)}... | MC: $${tracker.lastMc.toFixed(0)} | Growth: +${solGained.toFixed(2)} SOL\n`);
            const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

            if (buyTx) {
              activePositions.set(mintAddress, {
                entryMc: tracker.lastMc,
                highestMc: tracker.lastMc,
                buyTime: Date.now()
              });

              await sendTelegramAlert(
                `🚀 <b>Green Candle Snipe Entry!</b>\n` +
                `Mint: <code>${mintAddress}</code>\n` +
                `Entry MC: <b>~$${tracker.lastMc.toFixed(0)}</b>\n` +
                `Curve Velocity: <b>+${solGained.toFixed(2)} SOL</b>\n` +
                `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
              );
            }
          }
        }
      }
    } catch (err) {
      process.stdout.write(`❌ Parse error: ${err.message}\n`);
    }
  });

  globalWs.on('error', (err) => process.stdout.write(`❌ WS Error: ${err.message}\n`));
  globalWs.on('close', () => {
    process.stdout.write('⚠️ Disconnected. Reconnecting in 5s...\n');
    setTimeout(startWebSocketListener, 5000);
  });
}

async function main() {
  process.stdout.write(`🔑 Bot Active: ${wallet.publicKey.toString()}\n`);
  await sendTelegramAlert('⚡ <b>Pump.fun Momentum Velocity Bot Online</b>');
  startWebSocketListener();
}

main();
