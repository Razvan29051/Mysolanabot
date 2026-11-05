import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// --- CONFIGURATION & ENV VARS ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const PUMP_API_KEY = process.env.PUMP_PORTAL_API_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_ENDPOINT || !RAW_PRIVATE_KEY) {
  console.error('❌ CRITICAL ERROR: Missing RPC or Private Key in Railway variables!');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const TRADE_AMOUNT_SOL = 0.05; // Amount in SOL per buy

// --- TARGET WINDOW & BUY POWER THRESHOLDS ---
const MIN_MARKET_CAP_USD = 15000;  
const MAX_MARKET_CAP_USD = 90000;  
const MIN_BUY_VELOCITY = 3;        // Requires at least 3 consecutive/net buys to prove green candle momentum

// --- RISK MANAGEMENT ---
const STOP_LOSS_PERCENT = -8.0;     // Tight -8% stop loss
const TRAILING_DROP_PERCENT = -7.0;    
const TAKE_PROFIT_PERCENT = 45.0;      

let activePositions = new Map(); 
let tokenMomentumMap = new Map();  // Tracks active buy vs sell velocity per token
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
  process.stdout.write('⚡ Connecting to PumpPortal Live Momentum Stream...\n');
  
  const wsUrl = PUMP_API_KEY 
    ? `wss://pumpportal.fun/api/data?api-key=${PUMP_API_KEY}` 
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(wsUrl);

  globalWs.on('open', () => {
    process.stdout.write('🟢 Connected! Subscribing to token trade feeds...\n');
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

      // Dynamically subscribe to live trades for every discovered token
      if (globalWs.readyState === WebSocket.OPEN) {
        globalWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mintAddress] }));
      }

      // --- TRACK BUY / SELL MOMENTUM ---
      let momentum = tokenMomentumMap.get(mintAddress) || { buys: 0, sells: 0, buySol: 0 };
      if (event.txType === 'buy') {
        momentum.buys += 1;
        momentum.buySol += (event.solAmount || 0.05);
      } else if (event.txType === 'sell') {
        momentum.sells += 1;
      }
      tokenMomentumMap.set(mintAddress, momentum);

      // 1. ACTIVE POSITION MANAGEMENT (Stop-Loss / Take-Profit)
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

      // 2. GREEN CANDLE BUY-POWER ENTRY TRIGGER
      if (!processedMints.has(mintAddress) && currentMc >= MIN_MARKET_CAP_USD && currentMc <= MAX_MARKET_CAP_USD) {
        
        // Strict Green Candle Check: Must have active net buys and outpace sells
        const isStrongGreenCandle = momentum.buys >= MIN_BUY_VELOCITY && momentum.buys > momentum.sells;

        if (isStrongGreenCandle) {
          processedMints.add(mintAddress);

          process.stdout.write(`🚀 GREEN CANDLE MOMENTUM MATCH: ${mintAddress.slice(0, 6)}... | MC: $${currentMc.toFixed(0)} | Buys: ${momentum.buys}\n`);
          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            activePositions.set(mintAddress, {
              entryMc: currentMc,
              highestMc: currentMc,
              buyTime: Date.now()
            });

            await sendTelegramAlert(
              `🚀 <b>Green Candle Buy-Power Entry!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `Entry MC: <b>~$${currentMc.toFixed(0)}</b>\n` +
              `Confirmed Buys: <b>${momentum.buys}</b>\n` +
              `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
            );
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
  await sendTelegramAlert('⚡ <b>Pump.fun Green-Candle Buy-Power Bot Online</b>');
  startWebSocketListener();
}

main();
