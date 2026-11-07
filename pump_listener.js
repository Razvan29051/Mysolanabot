import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import WebSocket from 'ws';
import bs58 from 'bs58';

// ====================== CONFIG ======================
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || process.env.RPC_URL;
const RAW_PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';
const CODEX_API_KEY = process.env.CODEX_API_KEY || '';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!RPC_ENDPOINT || !RAW_PRIVATE_KEY) {
  console.error('❌ Missing RPC or PRIVATE_KEY');
  process.exit(1);
}

const connection = new Connection(RPC_ENDPOINT, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(RAW_PRIVATE_KEY));

const MAX_BUY_SOL = 0.18;
const SOL_RESERVE = 0.04;

// Entry filters
const MIN_MC = 6000;
const MAX_MC = 180000;
const MIN_BUY_COUNT = 4;

// Exit
const STOP_LOSS = -7;
const TAKE_PROFIT = 30;
const MAX_HOLD_MS = 8 * 60 * 1000;

// State
let activePosition = null;
let processed = new Set();
let isBuying = false;
let solPrice = 180;

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

// ====================== SWAP (PumpPortal) ======================
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
        priorityFee: 0.012,
        pool: 'auto'
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([wallet]);

    const txid = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
    log(`✅ ${action.toUpperCase()} SUCCESS: ${txid}`);
    return txid;
  } catch (err) {
    log(`❌ ${action.toUpperCase()} FAILED: ${err.message}`);
    return null;
  }
}

// ====================== CODEX WEBSOCKET ======================
function startCodex() {
  if (!CODEX_API_KEY) {
    log('⚠️ No CODEX_API_KEY – skipping Codex');
    return;
  }

  log('Connecting to Codex...');

  const ws = new WebSocket('wss://graph.codex.io/graphql', 'graphql-transport-ws');

  ws.on('open', () => {
    // Authenticate
    ws.send(JSON.stringify({
      type: 'connection_init',
      payload: { Authorization: CODEX_API_KEY }
    }));
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'connection_ack') {
        log('🟢 Codex connected');

        // Subscribe to Pump.fun launchpad events
        ws.send(JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: {
            query: `
              subscription {
                onLaunchpadTokenEventBatch(
                  input: {
                    protocol: Pump
                    networkId: 1399811149
                  }
                ) {
                  eventType
                  address
                  marketCap
                  price
                  volume1
                  buyCount1
                  sellCount1
                  token {
                    name
                    symbol
                    address
                  }
                }
              }
            `
          }
        }));
        return;
      }

      if (msg.type === 'next' && msg.payload?.data?.onLaunchpadTokenEventBatch) {
        const events = msg.payload.data.onLaunchpadTokenEventBatch;

        for (const ev of events) {
          const mint = ev.address || ev.token?.address;
          if (!mint || processed.has(mint) || activePosition || isBuying) continue;

          const mc = parseFloat(ev.marketCap || 0);
          const buyCount = ev.buyCount1 || 0;
          const name = ev.token?.name || 'Unknown';

          log(`Codex: ${name} | ${mint.slice(0, 8)} | MC $${Math.round(mc)} | Buys ${buyCount}`);

          // Strong momentum entry
          if (mc >= MIN_MC && mc <= MAX_MC && buyCount >= MIN_BUY_COUNT) {
            processed.add(mint);

            const amount = Math.min(await getBalance(), MAX_BUY_SOL);
            if (amount < 0.06) continue;

            isBuying = true;
            log(`🚀 CODEX SIGNAL → Buying ${amount} SOL`);

            const tx = await swap(mint, amount, 'buy');
            isBuying = false;

            if (tx) {
              activePosition = {
                mint,
                entryMc: mc,
                entryTime: Date.now()
              };

              await sendTelegram(
                `🚀 <b>CODEX ENTRY</b>\n` +
                `Name: ${name}\n` +
                `Mint: <code>${mint}</code>\n` +
                `Spent: <b>${amount} SOL</b>\n` +
                `MC: $${Math.round(mc)}\n` +
                `Buys: ${buyCount}\n` +
                `<a href="https://solscan.io/tx/${tx}">Tx</a>`
              );
            }
          }
        }
      }
    } catch (err) {
      log(`Codex error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    log('Codex closed – reconnecting in 5s');
    setTimeout(startCodex, 5000);
  });

  ws.on('error', (err) => log(`Codex WS error: ${err.message}`));
}

// ====================== PUMPPORTAL (Backup) ======================
function startPumpPortal() {
  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : `wss://pumpportal.fun/api/data`;

  const ws = new WebSocket(url);

  ws.on('open', () => {
    log('🟢 PumpPortal connected (backup)');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (!event.mint) return;

      const mint = event.mint;
      const isNew = !!(event.name || event.symbol || event.initialBuy);

      // Exit monitoring
      if (activePosition && mint === activePosition.mint) {
        let mc = 0;
        if (event.marketCapSol) mc = event.marketCapSol * solPrice;
        else if (event.marketCapUsd) mc = event.marketCapUsd;

        if (mc > 0) {
          const pnl = ((mc - activePosition.entryMc) / activePosition.entryMc) * 100;
          const held = Date.now() - activePosition.entryTime;

          if (pnl <= STOP_LOSS || pnl >= TAKE_PROFIT || held > MAX_HOLD_MS) {
            const reason = pnl <= STOP_LOSS ? `SL ${pnl.toFixed(1)}%` : pnl >= TAKE_PROFIT ? `TP +${pnl.toFixed(1)}%` : 'Max hold';
            log(`🔴 EXIT ${mint.slice(0, 8)} | ${reason}`);
            const old = activePosition.mint;
            activePosition = null;
            await swap(old, 0, 'sell');
            await sendTelegram(`🔴 Closed <code>${old.slice(0, 8)}</code>\n${reason}`);
          }
        }
        return;
      }

      if (!isNew || processed.has(mint) || activePosition || isBuying) return;

      let mc = 0;
      if (event.marketCapSol) mc = event.marketCapSol * solPrice;
      else if (event.marketCapUsd) mc = event.marketCapUsd;

      let initialBuy = 0;
      if (event.initialBuy) initialBuy = event.initialBuy > 1e6 ? event.initialBuy / 1e9 : event.initialBuy;

      if (mc >= MIN_MC && mc <= MAX_MC && initialBuy >= 0.25) {
        processed.add(mint);
        const amount = Math.min(await getBalance(), MAX_BUY_SOL);
        if (amount < 0.06) return;

        isBuying = true;
        log(`🚀 PUMPPORTAL SIGNAL → Buying ${amount} SOL`);
        const tx = await swap(mint, amount, 'buy');
        isBuying = false;

        if (tx) {
          activePosition = { mint, entryMc: mc, entryTime: Date.now() };
          await sendTelegram(`🚀 <b>PUMPPORTAL ENTRY</b>\nMint: <code>${mint}</code>\nSpent: ${amount} SOL\nMC: $${Math.round(mc)}`);
        }
      }
    } catch (err) {
      log(`PumpPortal error: ${err.message}`);
    }
  });

  ws.on('close', () => setTimeout(startPumpPortal, 5000));
}

// ====================== MAIN ======================
async function main() {
  log(`Wallet: ${wallet.publicKey.toString()}`);
  log(`Codex API: ${CODEX_API_KEY ? 'Loaded' : 'MISSING'}`);
  log(`PumpPortal API: ${PUMPPORTAL_API_KEY ? 'Loaded' : 'MISSING'}`);

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    if (d?.solana?.usd) solPrice = d.solana.usd;
  } catch {}

  // Safety force close
  setInterval(async () => {
    if (activePosition && Date.now() - activePosition.entryTime > MAX_HOLD_MS) {
      log('Force closing position');
      const mint = activePosition.mint;
      activePosition = null;
      await swap(mint, 0, 'sell');
    }
  }, 10000);

  await sendTelegram(`⚡ <b>Hybrid Bot Started</b>\nCodex + PumpPortal\nReady for green candles`);

  startCodex();
  startPumpPortal();
}

main();
