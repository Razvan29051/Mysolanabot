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
  console.log(`🔑 [Wallet] Green Wave Rider Active: ${wallet.publicKey.toString()}`);
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

// Wave Rider Position Manager: Rides massive green pumps with a trailing exit
async function monitorAndRideWave(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 [Wave Rider] Tracking green momentum. Ready to ride high...`);
  
  let peakValue = initialSolSpent;
  const startTime = Date.now();
  const maxHoldTimeMs = 4 * 60 * 1000; // Allow up to 4 minutes to catch a massive wave

  const checkInterval = setInterval(async () => {
    try {
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${buyAmountUnits}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      
      // Update peak value dynamically as the token pumps higher and higher
      if (currentValueSol > peakValue) {
        peakValue = currentValueSol;
      }

      console.log(`📈 [Wave Monitor] Current: ${currentValueSol.toFixed(4)} SOL | Peak Reached: ${peakValue.toFixed(4)} SOL`);

      // Exit Triggers:
      // 1. Trailing Pullback: If it drops 10% from its highest peak green value, lock in profits
      const pulledBackFromPeak = peakValue > (initialSolSpent * 1.03) && currentValueSol < peakValue * 0.90;
      // 2. Stop-Loss: If it instantly dumps straight down past -10% without ever pumping, cut losses
      const hitStopLoss = currentValueSol <= initialSolSpent * 0.90;
      // 3. Time limit reached
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pulledBackFromPeak || hitStopLoss || timedOut) {
        clearInterval(checkInterval);
        
        if (pulledBackFromPeak) {
          console.log(`🟢 [Wave Peak Reached] Pullback detected from peak. Securing monster profits...`);
        } else if (hitStopLoss) {
          console.log(`🚨 [Stop Loss] Cutting position to protect wallet...`);
        } else {
          console.log(`⏰ [Timeout] Max hold duration reached. Exiting...`);
        }
        
        const sellTxid = await executeSwap(tokenMint, SOL_MINT, buyAmountUnits);
        console.log(`✅ [SOLD & SECURED!] Solscan: https://solscan.io/tx/${sellTxid}`);
        isTrading = false;
      }
    } catch (e) {}
  }, 4000); // Check every 4 seconds to track price action closely
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

    // --- METADATA & SOCIAL VERIFICATION ---
    try {
      const coinRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (coinRes.ok) {
        const coinData = await coinRes.json();
        const hasTwitter = coinData.twitter && coinData.twitter.trim().length > 0;
        const hasTelegram = coinData.telegram && coinData.telegram.trim().length > 0;

        if (!coinData.description || coinData.description.length < 5 || (!hasTwitter && !hasTelegram)) {
          console.log(`🚫 [Filter] Skipped token lacking description or social links.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    // --- 15-SECOND LAUNCH DELAY ---
    console.log(`⏳ [Delay Window] Waiting 15s to let initial sniper chaos clear for ${newMint.slice(0, 8)}...`);
    await new Promise(resolve => setTimeout(resolve, 15000));

    // --- VOLUME SURVIVAL CHECK ---
    try {
      const checkRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.complete || (checkData.virtual_sol_reserves || 0) < 3200000000) {
          console.log(`🚫 [Volume Filter] Token went flat or graduated during delay. Skipping.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    // Safe 15% position allocation
    const ALLOCATION_PERCENTAGE = 0.15; 
    const solToAllocate = Math.max(0.003, (balanceSol - 0.005) * ALLOCATION_PERCENTAGE);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    console.log(`🎯 [Wave Entry Approved] Buying with ${solToAllocate.toFixed(4)} SOL...`);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [ENTRY EXECUTED] Solscan: https://solscan.io/tx/${txid}`);

    setTimeout(async () => {
      try {
        const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: newMint });
        const tokenUnits = tokenAccountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (tokenUnits) {
          monitorAndRideWave(newMint, tokenUnits, solToAllocate);
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
  console.log("🌊 [Green Wave Rider Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Scanning for high-potential wave runners...");
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
