import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// ====================== CONFIG ======================
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_ENDPOINT || !RAW_PRIVATE_KEY) {
  console.error('❌ Missing RPC_ENDPOINT or PRIVATE_KEY');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const MAX_BUY_SOL = 0.20;
const SOL_RESERVE = 0.04;

// Settings
const MIN_MC = 8000;
const MIN_BUYS = 5;
const MIN_RECENT_BUYS = 3;
const STOP_LOSS = -6;
const TAKE_PROFIT = 26;

// State
let activePositions = new Map();
let trackers = new Map();
let processed = new Set();
let ws = null;
let solPrice = 180;
let tradesReceived = 0;
let isBuying = false;

// ====================== HELPERS ======================
function log(msg) {
  const t = new Date().toISOString().substr(11, 8);
  console.log(`[${t}] ${msg}`);
}

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {}
}

async function getBalance() {
  const bal = await connection.getBalance(wallet.publicKey);
  return Math.max(0, Number(((bal / LAMPORTS_PER_SOL) - SOL_RESERVE).toFixed(4)));
}

// ====================== SWAP ======================
async function swap(mint, amount, action = 'buy') {
  try {
    log(`${action.toUpperCase()} → ${mint.slice(0, 8)} | ${amount} SOL`);

    const res = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toString(),
        action,
        mint,
        amount: action === 'sell' ? '100%' : amount,
        denominatedInSol: action === 'sell' ? 'false' : 'true',
        slippage: 48,
        priorityFee: 0.009,
        pool: 'auto'
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([wallet]);

    const txid = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 4
    });

    log(`✅ ${action.toUpperCase()} SUCCESS: ${txid}`);
    return txid;
  } catch (err) {
    log(`❌ ${action.toUpperCase()} FAILED: ${err.message}`);
    return null;
  }
}

// ====================== WEBSOCKET ======================
function startWebSocket() {
  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  log(`Connecting... API Key: ${PUMPPORTAL_API_KEY ? 'YES' : 'NO'}`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    log('🟢 Connected to PumpPortal');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const txType = (event.txType || '').toLowerCase();
      const isBuy = txType === 'buy';
      const isSell = txType === 'sell';
      const isNew = !!(event.name || event.symbol || event.initialBuy);

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;
      else if (event.usd_market_cap) mc = event.usd_market_cap;

      // ========== EXIT ==========
      if (activePositions.has(mint) && mc > 0) {
        const pos = activePositions.get(mint);
        const pnl = ((mc - pos.entry) / pos.entry) * 100;

        if (pnl <= STOP_LOSS || pnl >= TAKE_PROFIT) {
          activePositions.delete(mint);
          log(`🔴 EXIT ${mint.slice(0, 8)} | PnL ${pnl.toFixed(1)}%`);
          await swap(mint, 0, 'sell');
          await sendTelegram(`Closed <code>${mint.slice(0, 8)}</code> | PnL ${pnl.toFixed(1)}%`);
        }
        return;
      }

      // ========== NEW TOKEN ==========
      if (isNew && !trackers.has(mint) && !processed.has(mint)) {
        trackers.set(mint, {
          buys: 0,
          sells: 0,
          recent: [],
          mc: mc,
          start: Date.now()
        });
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        log(`👀 WATCH ${mint.slice(0, 8)} | MC $${Math.round(mc)}`);
        return;
      }

      // ========== TRADE ==========
      if (trackers.has(mint) && !processed.has(mint) && (isBuy || isSell)) {
        tradesReceived++;
        const t = trackers.get(mint);

        if (isBuy) t.buys++;
        if (isSell) t.sells++;
        if (mc > 0) t.mc = mc;

        t.recent.push({ time: Date.now(), buy: isBuy });
        t.recent = t.recent.filter(x => Date.now() - x.time < 30000);

        const recentBuys = t.recent.filter(x => x.buy).length;
        const age = (Date.now() - t.start) / 1000;

        log(`📊 ${mint.slice(0, 6)} | ${isBuy ? 'BUY' : 'SELL'} | MC $${Math.round(t.mc)} | Buys ${t.buys} | Recent ${recentBuys}`);

        // ENTRY
        if (
          t.mc >= MIN_MC &&
          t.buys >= MIN_BUYS &&
          recentBuys >= MIN_RECENT_BUYS &&
          age > 12 &&
          activePositions.size === 0 &&
          !isBuying
        ) {
          processed.add(mint);
          trackers.delete(mint);

          const amount = Math.min(await getBalance(), MAX_BUY_SOL);
          if (amount < 0.05) return;

          isBuying = true;
          log(`🚀 BUYING ${amount} SOL → ${mint.slice(0, 8)}`);

          const tx = await swap(mint, amount, 'buy');
          isBuying = false;

          if (tx) {
            activePositions.set(mint, { entry: t.mc, time: Date.now() });
            await sendTelegram(`🚀 Bought <code>${mint}</code>\nAmount: ${amount} SOL\nMC: $${Math.round(t.mc)}`);
          }
        }
      }
    } catch (err) {
      log(`Error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    log('WS Closed - reconnecting in 4s');
    setTimeout(startWebSocket, 4000);
  });

  ws.on('error', (err) => {
    log(`WS Error: ${err.message}`);
  });
}

// ====================== MAIN ======================
async function main() {
  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`RPC: ${RPC_ENDPOINT.slice(0, 55)}...`);
  log(`PumpPortal API Key: ${PUMPPORTAL_API_KEY ? 'Loaded' : 'MISSING'}`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  setInterval(() => {
    log(`Status | Watching: ${trackers.size} | Trades: ${tradesReceived} | Positions: ${activePositions.size}`);
  }, 30000);

  await sendTelegram('Bot started (full clean version)');
  startWebSocket();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
