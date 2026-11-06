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

// ====== SNIPER SETTINGS ======
const MAX_BUY_SOL = 0.18;
const SOL_RESERVE = 0.04;

const MIN_INITIAL_MC = 9000;          // Minimum market cap at creation
const MAX_INITIAL_MC = 120000;        // Don't buy if already too high
const MIN_INITIAL_BUY = 0.8;          // Minimum SOL in initial buy

// Exit settings
const STOP_LOSS = -7;
const TAKE_PROFIT = 28;
const MAX_HOLD_SECONDS = 420;         // 7 minutes max

// State
let activePosition = null;
let processed = new Set();
let ws = null;
let solPrice = 180;
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
  } catch {}
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
        slippage: 50,
        priorityFee: 0.01,
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
    log('🟢 Connected – Early Sniper Mode');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy || event.txType === 'create');

      if (!isNew || processed.has(mint) || activePosition || isBuying) return;

      // Calculate initial values
      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;
      else if (event.usd_market_cap) mc = event.usd_market_cap;

      let initialBuy = 0;
      if (event.initialBuy) {
        initialBuy = event.initialBuy > 1000 ? event.initialBuy / 1e9 : event.initialBuy;
      } else if (event.solAmount) {
        initialBuy = event.solAmount > 1000 ? event.solAmount / 1e9 : event.solAmount;
      }

      log(`New token: ${mint.slice(0, 8)} | MC $${Math.round(mc)} | InitialBuy ${initialBuy.toFixed(2)} SOL`);

      // ===== SNIPER ENTRY CONDITION =====
      if (
        mc >= MIN_INITIAL_MC &&
        mc <= MAX_INITIAL_MC &&
        initialBuy >= MIN_INITIAL_BUY
      ) {
        processed.add(mint);

        const amount = Math.min(await getBalance(), MAX_BUY_SOL);
        if (amount < 0.06) {
          log('Not enough balance');
          return;
        }

        isBuying = true;
        log(`🚀 EARLY SNIPER → Buying ${amount} SOL`);

        const tx = await swap(mint, amount, 'buy');
        isBuying = false;

        if (tx) {
          activePosition = {
            mint,
            entryMc: mc,
            entryTime: Date.now(),
            amount
          };

          await sendTelegram(
            `🚀 <b>EARLY SNIPER ENTRY</b>\n` +
            `Mint: <code>${mint}</code>\n` +
            `Spent: <b>${amount} SOL</b>\n` +
            `MC: $${Math.round(mc)}\n` +
            `Initial Buy: ${initialBuy.toFixed(2)} SOL\n` +
            `<a href="https://solscan.io/tx/${tx}">Tx</a>`
          );

          // Subscribe to trades just for exit monitoring (even if flaky)
          ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
        }
      }
    } catch (err) {
      log(`Error: ${err.message}`);
    }
  });

  // Monitor open position with whatever trade data comes
  ws.on('message', async (raw) => {
    if (!activePosition) return;

    try {
      const event = JSON.parse(raw.toString());
      if (event.mint !== activePosition.mint) return;

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      if (mc <= 0) return;

      const pnl = ((mc - activePosition.entryMc) / activePosition.entryMc) * 100;
      const holdTime = (Date.now() - activePosition.entryTime) / 1000;

      let reason = null;
      if (pnl <= STOP_LOSS) reason = `Stop-Loss ${pnl.toFixed(1)}%`;
      else if (pnl >= TAKE_PROFIT) reason = `Take-Profit +${pnl.toFixed(1)}%`;
      else if (holdTime > MAX_HOLD_SECONDS) reason = `Max hold time`;

      if (reason) {
        log(`🔴 EXIT ${activePosition.mint.slice(0, 8)} | ${reason}`);
        const mint = activePosition.mint;
        activePosition = null;

        const tx = await swap(mint, 0, 'sell');
        if (tx) {
          await sendTelegram(`🔴 Closed <code>${mint.slice(0, 8)}</code>\n${reason}`);
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    log('WS Closed – reconnecting in 4s');
    setTimeout(startWebSocket, 4000);
  });

  ws.on('error', (err) => log(`WS Error: ${err.message}`));
}

// ====================== MAIN ======================
async function main() {
  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`RPC: ${RPC_ENDPOINT.slice(0, 55)}...`);
  log(`Mode: EARLY SNIPER`);
  log(`Min MC: $${MIN_INITIAL_MC} | Max Buy: ${MAX_BUY_SOL} SOL`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  // Safety: force close if position is open too long without updates
  setInterval(async () => {
    if (activePosition && Date.now() - activePosition.entryTime > MAX_HOLD_SECONDS * 1000) {
      log('Force closing old position');
      const mint = activePosition.mint;
      activePosition = null;
      await swap(mint, 0, 'sell');
    }
  }, 15000);

  await sendTelegram(`⚡ <b>Early Sniper Started</b>\nMin MC: $${MIN_INITIAL_MC}\nMax buy: ${MAX_BUY_SOL} SOL`);
  startWebSocket();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
