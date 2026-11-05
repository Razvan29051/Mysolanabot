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

// --- LOW-CAP HIGH-MOMENTUM TARGETS ($10K - $60K) ---
const MIN_MARKET_CAP_USD = 10000;  // Catch them early right out of the initial launch zone
const MAX_MARKET_CAP_USD = 60000;  

// --- BUY POWER VELOCITY THRESHOLDS ---
const MIN_BUY_VOLUME_SOL = 0.10;   // Lower threshold for early caps to catch momentum immediately
const BUY_TO_SELL_RATIO = 1.5;     // Buy volume must be 1.5x higher than sell volume

// --- RISK MANAGEMENT ---
const STOP_LOSS_PERCENT = -12;     // Slightly tighter stop loss for low caps (-12%)
const TAKE_PROFIT_PERCENT = 50;    // Higher reward target (+50%)

let activePositions = new Map(); 
let tokenVolumeMap = new Map();  
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
        slippage: 35, // Slightly higher slippage for fast low-cap entries
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
  process.stdout.write('⚡ Connecting to PumpPortal Low-Cap Buy-Power Stream...\n');
  
  const wsUrl = PUMP_API_KEY 
    ? `wss://pumpportal.fun/api/data?api-key=${PUMP_API_KEY}` 
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(wsUrl);

  globalWs.on('open', () => {
    process.stdout.write('🟢 Connected! Scanning low-caps for heavy buy power...\n');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!event || !event.mint) return;

      const mintAddress = event.mint;

      if (globalWs.readyState === WebSocket.OPEN) {
        globalWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mintAddress] }));
      }

      const solPriceUsd = 200;
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0);
      const currentMc = event.marketCapUsd || event.usd_market_cap || (solReserves > 0 ? solReserves * solPriceUsd * 5 : 0);

      // --- TRACK LIVE BUY VS SELL VOLUME ---
      let volStats = tokenVolumeMap.get(mintAddress) || { buyVolumeSol: 0, sellVolumeSol: 0, uniqueBuyers: new Set() };
      
      const tradeSol = event.solAmount || (event.vSolInBondingCurve ? 0.04 : 0.02);

      if (event.txType === 'buy') {
        volStats.buyVolumeSol += tradeSol;
        if (event.traderPublicKey) volStats.uniqueBuyers.add(event.traderPublicKey);
      } else if (event.txType === 'sell') {
        volStats.sellVolumeSol += tradeSol;
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

        if (pnlPercent <= STOP_LOSS_PERCENT || (pnlPercent > 10 && dropFromPeak <= -10)) {
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

      // 2. LOW-CAP BUY-POWER ENTRY TRIGGER
      if (event.txType === 'buy' && currentMc >= MIN_MARKET_CAP_USD && currentMc <= MAX_MARKET_CAP_USD) {
        if (!processedMints.has(mintAddress)) {
          
          // Require active buy volume AND multiple unique buyers to confirm true green pressure
          const hasStrongBuyPower = 
            volStats.buyVolumeSol >= MIN_BUY_VOLUME_SOL && 
            volStats.uniqueBuyers.size >= 2 &&
            (volStats.sellVolumeSol === 0 || (volStats.buyVolumeSol / volStats.sellVolumeSol) >= BUY_TO_SELL_RATIO);

          if (!hasStrongBuyPower) {
            return; // Skip silently until buy power thresholds are met
          }

          processedMints.add(mintAddress);

          process.stdout.write(`🚀 LOW-CAP BUY-POWER MATCH: ${mintAddress.slice(0, 6)}... | MC: $${currentMc.toFixed(0)} | Buy Vol: ${volStats.buyVolumeSol.toFixed(2)} SOL | Buyers: ${volStats.uniqueBuyers.size}\n`);
          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            activePositions.set(mintAddress, {
              entryMc: currentMc,
              highestMc: currentMc,
              buyTime: Date.now()
            });

            await sendTelegramAlert(
              `🚀 <b>Low-Cap Buy-Power Entry!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `MC: <b>$${currentMc.toFixed(0)}</b>\n` +
              `Buy Vol: <b>${volStats.buyVolumeSol.toFixed(2)} SOL</b>\n` +
              `Unique Buyers: <b>${volStats.uniqueBuyers.size}</b>\n` +
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
  await sendTelegramAlert('⚡ <b>Pump.fun Low-Cap Buy-Power Bot Online ($10K-$60K)</b>');
  startWebSocketListener();
}

main();
