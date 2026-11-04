import WebSocket from 'ws';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';

const WS_URL = process.env.WS_URL;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC_URL, 'confirmed');

let wallet;
try {
  let raw = process.env.BOT_PRIVATE_KEY ? process.env.BOT_PRIVATE_KEY.trim() : "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  wallet = Keypair.fromSecretKey(raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  console.log(`🔑 [Wallet] Quick Scalper Active: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ Private Key Error:", err.message);
  process.exit(1);
}

let isTrading = false;

async function executeSwap(inputMint, outputMint, amountUnits) {
  const quoteRes = await fetch(
    `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountUnits}&slippageBps=500`
  );
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote Error: ${quote.error}`);

  const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
    })
  });
  
  const swapData = await swapRes.json();
  if (!swapData.swapTransaction) throw new Error("Failed to generate swap transaction.");

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  transaction.sign([wallet]);

  return await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
}

// Quick Scalper Position Manager: Exits at the first sign of green above gas costs
async function monitorAndExitQuick(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 [Quick Scalper] Monitoring entry for instant green exit...`);
  
  const startTime = Date.now();
  const maxHoldTimeMs = 90 * 1000; // Quick 90-second max timeout for fast scalps

  const checkInterval = setInterval(async () => {
    try {
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${buyAmountUnits}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      console.log(`📈 [Scalp Check] Spent: ${initialSolSpent.toFixed(4)} SOL | Current Value: ${currentValueSol.toFixed(4)} SOL`);

      // Target: Exit immediately if current value exceeds initial cost by at least 2.5% (covers double swap gas + net profit)
      const targetProfitValue = initialSolSpent * 1.025;
      const isGreen = currentValueSol >= targetProfitValue;
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      // Also include a tight stop-loss safeguard (-10%) so a dump doesn't anchor your bag
      const isStopLoss = currentValueSol <= initialSolSpent * 0.90;

      if (isGreen || isStopLoss || timedOut) {
        clearInterval(checkInterval);
        console.log(isGreen ? `🟢 [Instant Green Target Hit!] Selling for profit...` : `🚨 [Exit Triggered] Cut loss/Timeout reached...`);
        
        const sellTxid = await executeSwap(tokenMint, SOL_MINT, buyAmountUnits);
        console.log(`✅ [SOLD!] Solscan: https://solscan.io/tx/${sellTxid}`);
        isTrading = false;
      }
    } catch (e) {}
  }, 3000); // Polls every 3 seconds for lightning-fast reaction times
}

async function handleSnipe(signature) {
  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    
    if (balanceSol < 0.015) {
      isTrading = false;
      return;
    }

    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 });
    if (!tx || !tx.meta) {
      isTrading = false;
      return;
    }

    const postTokenBalances = tx.meta.postTokenBalances || [];
    const newMint = postTokenBalances.find(b => b.mint !== SOL_MINT)?.mint;
    if (!newMint) {
      isTrading = false;
      return;
    }

    // Metadata & Social Check
    try {
      const coinRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (coinRes.ok) {
        const coinData = await coinRes.json();
        const hasTwitter = coinData.twitter && coinData.twitter.trim().length > 0;
        const hasTelegram = coinData.telegram && coinData.telegram.trim().length > 0;

        if (!coinData.description || coinData.description.length < 5 || (!hasTwitter && !hasTelegram)) {
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    // Short 10-second delay to clear initial spam
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Position Sizing (20%)
    const ALLOCATION_PERCENTAGE = 0.20; 
    const solToAllocate = Math.max(0.005, (balanceSol - 0.005) * ALLOCATION_PERCENTAGE);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    console.log(`🚀 [Scalp Buying] Entering token ${newMint.slice(0, 8)} with ${solToAllocate.toFixed(4)} SOL...`);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [BUY EXECUTED] Solscan: https://solscan.io/tx/${txid}`);

    setTimeout(async () => {
      try {
        const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: newMint });
        const tokenUnits = tokenAccountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (tokenUnits) {
          monitorAndExitQuick(newMint, tokenUnits, solToAllocate);
        } else {
          isTrading = false;
        }
      } catch (err) {
        isTrading = false;
      }
    }, 4000);

  } catch (err) {
    isTrading = false;
  }
}

function startListener() {
  console.log("⚡ [Quick Scalper Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Scanning for instant green scalps...");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID] },
        { commitment: "processed" }
      ]
    }));
  });

  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      if (logs.some(log => log.includes("Instruction: Create")) && !isTrading) {
        isTrading = true;
        await handleSnipe(signature);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => {});
}

startListener();
