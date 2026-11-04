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
  console.log(`🔑 [Wallet] Volume Velocity Rider Active: ${wallet.publicKey.toString()}`);
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

// Position Manager: Rides the green wave with trailing profit lock and stop-loss
async function monitorAndRideSinglePosition(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 [Position Manager] Tracking green wave for ${tokenMint.slice(0, 8)}...`);
  
  let peakValue = initialSolSpent;
  const startTime = Date.now();
  const maxHoldTimeMs = 4 * 60 * 1000;

  const checkInterval = setInterval(async () => {
    try {
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${buyAmountUnits}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      
      if (currentValueSol > peakValue) {
        peakValue = currentValueSol;
      }

      console.log(`📈 [Wave Check] Current: ${currentValueSol.toFixed(4)} SOL | Peak: ${peakValue.toFixed(4)} SOL`);

      const pulledBackFromPeak = peakValue > (initialSolSpent * 1.02) && currentValueSol < peakValue * 0.90;
      const hitStopLoss = currentValueSol <= initialSolSpent * 0.92;
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pulledBackFromPeak || hitStopLoss || timedOut) {
        clearInterval(checkInterval);
        console.log(pulledBackFromPeak ? `🟢 [Peak Secured] Selling for profit...` : `🚨 [Stop-Loss/Timeout] Closing position...`);
        
        const sellTxid = await executeSwap(tokenMint, SOL_MINT, buyAmountUnits);
        console.log(`✅ [POSITION CLOSED] Solscan: https://solscan.io/tx/${sellTxid}`);
        
        isTrading = false;
        console.log(`🔄 [Status] Bot unlocked and ready for the next clean coin.`);
      }
    } catch (e) {}
  }, 4000);
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

    // --- STEP 1: METADATA & SOCIAL CHECK ---
    try {
      const coinRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (coinRes.ok) {
        const coinData = await coinRes.json();
        const hasTwitter = coinData.twitter && coinData.twitter.trim().length > 0;
        const hasTelegram = coinData.telegram && coinData.telegram.trim().length > 0;

        if (!coinData.description || coinData.description.length < 5 || (!hasTwitter && !hasTelegram)) {
          console.log(`🚫 [Filter] Skipped token lacking description/socials.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {
      isTrading = false;
      return;
    }

    // --- STEP 2: EXPONENTIAL VOLUME VELOCITY CHECK (T0 -> T5 -> T15) ---
    console.log(`⏳ [Volume Engine] Sampling velocity for ${newMint.slice(0, 8)}...`);

    let solAtT0 = 0;
    let solAtT5 = 0;
    let solAtT15 = 0;

    try {
      const res0 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res0.ok) solAtT0 = (await res0.json()).virtual_sol_reserves || 0;
    } catch (e) {}

    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const res5 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res5.ok) solAtT5 = (await res5.json()).virtual_sol_reserves || 0;
    } catch (e) {}

    await new Promise(resolve => setTimeout(resolve, 10000));
    try {
      const res15 = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (res15.ok) {
        const data15 = await res15.json();
        solAtT15 = data15.virtual_sol_reserves || 0;
        
        if (data15.complete) {
          console.log(`🚫 [Volume Filter] Curve completed during check. Skipping.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    const initialGrowthSol = (solAtT5 - solAtT0) / 1e9;
    const secondaryGrowthSol = (solAtT15 - solAtT5) / 1e9;
    const totalGrowthSol = (solAtT15 - solAtT0) / 1e9;

    console.log(`📊 [Volume Stats] T0->T5: +${initialGrowthSol.toFixed(2)} SOL | T5->T15: +${secondaryGrowthSol.toFixed(2)} SOL | Total: +${totalGrowthSol.toFixed(2)} SOL`);

    const MIN_REQUIRED_GROWTH = 2.0; // Lowered slightly to ensure catches while filtering out dead tokens
    const isAccelerating = secondaryGrowthSol >= (initialGrowthSol * 0.8);

    if (totalGrowthSol < MIN_REQUIRED_GROWTH || !isAccelerating) {
      console.log(`🚫 [Velocity Failed] Insufficient growth or momentum slowing down. Skipping.`);
      isTrading = false;
      return;
    }

    // --- STEP 3: SINGLE-WALLET ALLOCATION ---
    const solToAllocate = Math.max(0.005, balanceSol - 0.005);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    console.log(`🎯 [Green Wave Confirmed] Deploying ${solToAllocate.toFixed(4)} SOL into ${newMint.slice(0, 8)}...`);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [ENTRY EXECUTED] Solscan: https://solscan.io/tx/${txid}`);

    setTimeout(async () => {
      try {
        const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: newMint });
        const tokenUnits = tokenAccountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (tokenUnits) {
          monitorAndRideSinglePosition(newMint, tokenUnits, solToAllocate);
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
  console.log("🌊 [Volume Velocity Rider Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Scanning for accelerating volume waves...");
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
      if (isTrading) return;

      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      if (logs.some(log => log.includes("Instruction: Create"))) {
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
