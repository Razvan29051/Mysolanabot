import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// --- CONFIGURATION ---
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

// --- SWEET SPOT TARGETS ($4K - $50K) ---
const MIN_MARKET_CAP_USD = 4000;
const MAX_MARKET_CAP_USD = 50000;

let tokenMetrics = new Map();
let activePositions = new Map();
let processedMints = new Set();
let trackedMints = new Set();
let globalWs = null;

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
  } catch (err) {
    process.stdout.write(`Telegram error: ${err.message}\n`);
  }
}

async function executeLocalPumpSwap(mintAddress, amountSol, action = 'buy') {
  try {
    process.stdout.write(`🔄 Requesting ${action} for ${mintAddress} (${amountSol} SOL)...\n`);

    const response = await fetch(`https://pumpportal.fun/api/trade-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action: action,
        mint: mintAddress,
        amount: amountSol,
        denominatedInSol: "true",
        slippage: 25,
        priorityFee: 0.0015,
        pool: 'pump'
      })
    });

    if (!response.ok) throw new Error(await response.text());

    const arrayBuffer = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(arrayBuffer));
    transaction.sign([wallet]);

    const txid = await connection.sendTransaction(transaction, { skipPreflight: true, maxRetries: 3 });
    process.stdout.write(`✅ Transaction Executed: ${txid}\n`);
    return txid;
  } catch (err) {
    process.stdout.write(`❌ Trade Execution Failed: ${err.message}\n`);
    return null;
  }
}

// Dynamically subscribe to trade events for a batch of token mints
function subscribeToMints(mintArray) {
  if (!globalWs || globalWs.readyState !== WebSocket.OPEN) return;
  
  const newMints = mintArray.filter(m => !trackedMints.has(m));
  if (newMints.length === 0) return;

  newMints.forEach(m => trackedMints.add(m));

  globalWs.send(JSON.stringify({
    method: "subscribeTokenTrade",
    keys: newMints
  }));
  
  process.stdout.write(`📡 Subscribed to live trades for ${newMints.length} tokens.\n`);
}

function startWebSocketListener() {
  process.stdout.write('⚡ Connecting to PumpPortal Stream Engine...\n');
  
  const wsUrl = PUMP_API_KEY 
    ? `wss://pumpportal.fun/api/data?api-key=${PUMP_API_KEY}` 
    : `wss://pumpportal.fun/api/data`;

  globalWs = new WebSocket(wsUrl);

  globalWs.on('open', () => {
    process.stdout.write('🟢 Connected! Listening to token creations and trade feeds...\n');
    globalWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  globalWs.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!event || !event.mint) return;

      const mintAddress = event.mint;

      // Automatically register new launches to trade stream
      if (event.txType === 'create' || !event.txType) {
        subscribeToMints([mintAddress]);
      }

      // Calculate Market Cap
      const solPriceUsd = 200;
      const solReserves = event.vSolInBondingCurve || (event.virtualSolReserves ? event.virtualSolReserves / 1e9 : 0);
      const marketCapUsd = event.marketCapUsd || event.usd_market_cap || (solReserves > 0 ? solReserves * solPriceUsd * 5 : 0);

      if (event.txType === 'buy' || event.txType === 'sell') {
        process.stdout.write(`📥 Live Trade -> Mint: ${mintAddress.slice(0, 6)}... | Type: ${event.txType} | MC: $${marketCapUsd.toFixed(0)}\n`);
      }

      // Trigger condition: Real BUY trade in target range ($4K - $50K)
      if (event.txType === 'buy' && marketCapUsd >= MIN_MARKET_CAP_USD && marketCapUsd <= MAX_MARKET_CAP_USD) {
        let stats = tokenMetrics.get(mintAddress) || { buyCount: 0, volumeSol: 0 };
        stats.buyCount += 1;
        stats.volumeSol += Number(event.solAmount || 0.1);
        tokenMetrics.set(mintAddress, stats);

        process.stdout.write(`🎯 SWEET SPOT BUY MATCH: ${mintAddress.slice(0, 6)}... | MC: $${marketCapUsd.toFixed(0)} | Buys: ${stats.buyCount}\n`);

        // Buy immediately on momentum signal
        if (!processedMints.has(mintAddress)) {
          processedMints.add(mintAddress);
          tokenMetrics.delete(mintAddress);

          process.stdout.write(`🌊 MOMENTUM WAVE LOCKED: ${mintAddress} - Executing Buy Order...\n`);
          const buyTx = await executeLocalPumpSwap(mintAddress, TRADE_AMOUNT_SOL, 'buy');

          if (buyTx) {
            await sendTelegramAlert(
              `🌊 <b>Momentum Wave Buy</b>\n` +
              `Mint: <code>${mintAddress}</code>\n` +
              `MC: <b>$${marketCapUsd.toFixed(0)}</b>\n` +
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
    process.stdout.write('⚠️ Disconnected. Reconnecting in 5 seconds...\n');
    setTimeout(startWebSocketListener, 5000);
  });
}

async function main() {
  process.stdout.write(`🔑 Bot Active: ${wallet.publicKey.toString()}\n`);
  startWebSocketListener();
}

main();
