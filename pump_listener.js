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

// --- TARGET WINDOW ($20K - $100K EARLY-TO-MID MOMENTUM) ---
const MIN_MARKET_CAP_USD = 20000;  
const MAX_MARKET_CAP_USD = 100000; 

// --- BALANCED VOLUME & GREEN CANDLE THRESHOLDS ---
const MIN_BUY_VOLUME_SOL = 0.15;   // Lowered to 0.15 SOL so it triggers on faster, early green candles
const BUY_TO_SELL_RATIO = 1.2;     // Buys just need to outweigh sells (1.2x) instead of a strict 2x

// --- RISK MANAGEMENT ---
const STOP_LOSS_PERCENT = -10;     
const TAKE_PROFIT_PERCENT = 45;    

let activePositions = new Map(); 
let tokenVolumeMap = new Map();  // Tracks live buy vs sell volume per token
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
        slippage: 30,
        priorityFee: 0.002,
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
    process.stdout.write(`❌ Trade Execution Failed (${action.toUpperCase()}) -> ${err.message}\n`);
    return null;
  }
}

// --- LIVE WEBSOCKET ENGINE ---
function startWebSocketListener() {
  process.stdout.write('⚡ Connecting to PumpPortal Volume & Green Candle Stream...\n');
  
  const wsUrl = PUMP_API_KEY 
    ? `wss://pumpportal.fun/api/data?api-key=${PUMP_API_KEY}` 
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(wsUrl);

  globalWs.on('open', () => {
    process.stdout.write('🟢 Connected! Tracking live candle volume flows...\n');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!event || !event.mint) return;

      const mintAddress = event.mint;

      // Subscribe to individual trade stream for this token to monitor volume flow
      if (globalWs.readyState === WebSocket.OPEN) {
        globalWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mintAddress] }));
      }

      const solPriceUsd = 200;
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0);
      const currentMc = event.marketCapUsd || event.usd_market_cap || (solReserves > 0 ? solReserves * solPriceUsd * 5 : 0);

      // --- CALCULATE LIVE BUY VS SELL VOLUME ---
      let volStats = tokenVolumeMap.get(mintAddress) || { buyVolumeSol: 0, sellVolumeSol: 0, buyCount: 0, sellCount: 0 };
      
      const tradeSol = event.solAmount || (event.vSolInBondingCurve ? 0.05 : 0.02);

      if (event.txType === 'buy') {
        volStats.buyVolumeSol += tradeSol;
        volStats.buyCount += 1;
      } else if (event.txType === 'sell') {
        volStats.sellVolumeSol += tradeSol;
        volStats.sellCount += 1;
      }
      tokenVolumeMap.set(mintAddress, volStats);

      // 1. ACTIVE POSITION MANAGEMENT (Stop-Loss / Take-Profit)
      if (activePositions.has(mintAddress) && currentMc > 0) {
        const pos = activePositions.get(mintAddress);
        
        if (currentMc > pos.highestMc) {
          pos.highestMc = currentMc;
          activePositions.set(mintAddress, pos);
        }

        const pnlPercent = ((currentMc - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((currentMc - pos.highestMc) / pos.highestMc) * 100;

        if (pnlPercent <= STOP_LOSS_PERCENT || (pnlPercent > 10 && dropFromPeak <= -8)) {
          activePositions.delete(mintAddress);
          process.stdout.write(`🔴 STOP-LOSS TRIGGERED: ${mintAddress.slice(0, 6)}... (PnL: ${pnlPercent.toFixed(1)}%)\n`);
          
          const sellTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'sell');
          if (sellTx) {
            await sendTelegramAlert(
              `🔴 <b>Stop-Loss Executed</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `PnL: <b>${pnlPercent.toFixed(1)}%</b>\n` +
              `Exit MC: <b>$${currentMc.toFixed(0)}</b>`
            );
          }
        } else if (pnlPercent >= TAKE_PROFIT_PERCENT) {
          activePositions.delete(mintAddress);
          process.stdout.write(`🟢 TAKE-PROFIT TRIGGERED: ${mintAddress.slice(0, 6)}... (+${pnlPercent.toFixed(1)}%)\n`);

          const sellTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'sell');
          if (sellTx) {
            await sendTelegramAlert(
              `🟢 <b>Take-Profit Executed! 🎉</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `PnL: <b>+${pnlPercent.toFixed(1)}%</b>\n` +
              `Exit MC: <b>$${currentMc.toFixed(0)}</b>`
            );
          }
        }
      }

      // 2. GREEN CANDLE VOLUME-DRIVEN ENTRY TRIGGER
      if (event.txType === 'buy' && currentMc >= MIN_MARKET_CAP_USD && currentMc <= MAX_MARKET_CAP_USD) {
        if (!processedMints.has(mintAddress)) {
          
          const isGreenCandleFlow = 
            volStats.buyVolumeSol >= MIN_BUY_VOLUME_SOL && 
            (volStats.sellVolumeSol === 0 || (volStats.buyVolumeSol / volStats.sellVolumeSol) >= BUY_TO_SELL_RATIO);

          if (!isGreenCandleFlow) {
            process.stdout.write(`🛡️ WAITING FOR GREEN VOLUME: ${mintAddress.slice(0, 6)}... | Buy Vol: ${volStats.buyVolumeSol.toFixed(2)} SOL | Sell Vol: ${volStats.sellVolumeSol.toFixed(2)} SOL\n`);
            return;
          }

          processedMints.add(mintAddress);

          process.stdout.write(`🚀 GREEN CANDLE VOLUME MATCH: ${mintAddress.slice(0, 6)}... | MC: $${currentMc.toFixed(0)} | Buy Vol: ${volStats.buyVolumeSol.toFixed(2)} SOL\n`);
          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            activePositions.set(mintAddress, {
              entryMc: currentMc,
              highestMc: currentMc,
              buyTime: Date.now()
            });

            await sendTelegramAlert(
              `🚀 <b>Green Candle Volume Entry!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `MC: <b>$${currentMc.toFixed(0)}</b>\n` +
              `Buy Volume: <b>${volStats.buyVolumeSol.toFixed(2)} SOL</b>\n` +
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
  await sendTelegramAlert('🚀 <b>Pump.fun Green-Candle Volume Bot Online</b>');
  startWebSocketListener();
}

main();
