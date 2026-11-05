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

// --- ULTRA MOMENTUM TARGETS ($50K - $85K GRADUATION ZONE) ---
const MIN_MARKET_CAP_USD = 50000; // Hard minimum market cap floor
const MAX_MARKET_CAP_USD = 85000; // Upper bound right before Raydium migration
const MIN_5M_VOLUME_USD = 5000;   // Requires at least $5k 5m volume

// --- AUTOMATED RISK MANAGEMENT ---
const STOP_LOSS_PERCENT = -10;     // Sell if down 10%
const TAKE_PROFIT_PERCENT = 40;    // Target profit threshold

let activePositions = new Map(); 
let processedMints = new Set();
let trackedMints = new Set();
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
    process.stdout.write(`❌ Trade Execution Failed (${action.toUpperCase()}): ${err.message}\n`);
    return null;
  }
}

// --- DYNAMIC MINT SUBSCRIBER ---
function subscribeToMints(mintArray) {
  if (!globalWs || globalWs.readyState !== WebSocket.OPEN) return;
  
  const newMints = mintArray.filter(m => !trackedMints.has(m));
  if (newMints.length === 0) return;

  newMints.forEach(m => trackedMints.add(m));

  globalWs.send(JSON.stringify({
    method: "subscribeTokenTrade",
    keys: newMints
  }));
}

// --- FETCH HIGH VOLUME GRADUATION CANDIDATES FROM DEXSCREENER ---
async function fetchTopActiveMints() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=pump');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.pairs) return;

    // Filter for Solana pump.fun pairs in $50K - $85K market cap with active 5m volume
    const activePairs = data.pairs.filter(p => 
      p.chainId === 'solana' && 
      p.marketCap >= MIN_MARKET_CAP_USD && 
      p.marketCap <= MAX_MARKET_CAP_USD &&
      (p.volume?.m5 || 0) >= MIN_5M_VOLUME_USD
    );

    const mintsToSub = [];
    for (const pair of activePairs) {
      const mintAddress = pair.baseToken.address;
      mintsToSub.push(mintAddress);

      if (pair.marketCap < MIN_MARKET_CAP_USD) continue;

      if (!processedMints.has(mintAddress)) {
        processedMints.add(mintAddress);

        process.stdout.write(`🔥 GRADUATION VOLUME MATCH: ${mintAddress} | MC: $${pair.marketCap.toFixed(0)} | 5m Vol: $${pair.volume.m5}\n`);
        const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

        if (buyTx) {
          activePositions.set(mintAddress, {
            entryMc: pair.marketCap,
            highestMc: pair.marketCap,
            buyTime: Date.now()
          });

          await sendTelegramAlert(
            `🔥 <b>High Volume Graduation Entry!</b>\n` +
            `Mint: <code>${mintAddress}</code>\n` +
            `MC: <b>$${pair.marketCap.toFixed(0)}</b>\n` +
            `5m Volume: <b>$${pair.volume.m5}</b>\n` +
            `<a href="https://solscan.io/tx/${buyTx}">View Tx on Solscan</a>`
          );
        }
      }
    }
    if (mintsToSub.length > 0) {
      subscribeToMints(mintsToSub);
    }
  } catch (err) {
    process.stdout.write(`⚠️ DexScreener fetch warning: ${err.message}\n`);
  }
}

// --- WEBSOCKET ENGINE & TRAILING STOP MONITORING ---
function startWebSocketListener() {
  process.stdout.write('⚡ Connecting to PumpPortal Stream Engine...\n');
  
  const wsUrl = PUMP_API_KEY 
    ? `wss://pumpportal.fun/api/data?api-key=${PUMP_API_KEY}` 
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(wsUrl);

  globalWs.on('open', () => {
    process.stdout.write('🟢 Connected! Monitoring high-volume tokens...\n');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));

    fetchTopActiveMints();
    setInterval(fetchTopActiveMints, 10000);
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!event || !event.mint) return;

      const mintAddress = event.mint;

      if (event.txType === 'create' || !event.txType) {
        subscribeToMints([mintAddress]);
      }

      const solPriceUsd = 200;
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0);
      const currentMc = event.marketCapUsd || event.usd_market_cap || (solReserves > 0 ? solReserves * solPriceUsd * 5 : 0);

      // 1. DYNAMIC POSITION CHECK & TRAILING STOP-LOSS
      if (activePositions.has(mintAddress) && currentMc > 0) {
        const pos = activePositions.get(mintAddress);
        
        // Update peak market cap reached for trailing protection
        if (currentMc > pos.highestMc) {
          pos.highestMc = currentMc;
          activePositions.set(mintAddress, pos);
        }

        const pnlPercent = ((currentMc - pos.entryMc) / pos.entryMc) * 100;
        const dropFromPeak = ((currentMc - pos.highestMc) / pos.highestMc) * 100;

        // Trigger Stop-Loss (-10% from entry OR -8% drop from peak after moving up)
        if (pnlPercent <= STOP_LOSS_PERCENT || (pnlPercent > 10 && dropFromPeak <= -8)) {
          activePositions.delete(mintAddress);
          process.stdout.write(`🔴 SELL TRIGGERED: ${mintAddress.slice(0, 6)}... (PnL: ${pnlPercent.toFixed(1)}%)\n`);
          
          const sellTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'sell');
          if (sellTx) {
            await sendTelegramAlert(
              `🔴 <b>Position Closed</b>\n` +
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

      // 2. LIVE BUY TRIGGER FOR HIGH-CAP STREAM EVENTS
      if (event.txType === 'buy' && currentMc >= MIN_MARKET_CAP_USD && currentMc <= MAX_MARKET_CAP_USD) {
        if (!processedMints.has(mintAddress)) {
          processedMints.add(mintAddress);

          process.stdout.write(`🚀 STREAM MATCH: ${mintAddress.slice(0, 6)}... | MC: $${currentMc.toFixed(0)}\n`);
          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            activePositions.set(mintAddress, {
              entryMc: currentMc,
              highestMc: currentMc,
              buyTime: Date.now()
            });

            await sendTelegramAlert(
              `🚀 <b>High Cap Stream Entry!</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `MC: <b>$${currentMc.toFixed(0)}</b>\n` +
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
    trackedMints.clear();
    process.stdout.write('⚠️ Disconnected. Reconnecting in 5s...\n');
    setTimeout(startWebSocketListener, 5000);
  });
}

async function main() {
  process.stdout.write(`🔑 Bot Active: ${wallet.publicKey.toString()}\n`);
  await sendTelegramAlert('🔥 <b>Pump.fun Ultra-Volume Bot Online ($50K-$85K)</b>');
  startWebSocketListener();
}

main();
