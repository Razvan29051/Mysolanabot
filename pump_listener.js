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
  console.log(`🔑 [Wallet] Single-Shot Wave Rider Active: ${wallet.publicKey.toString()}`);
} catch (err) {
  console.error("❌ Private Key Error:", err.message);
  process.exit(1);
}

// Global lock: When true, the bot completely ignores all other launches until the trade is fully closed
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

// Position Manager: Rides the green wave with uncapped upside, locking profit on peak pullback
async function monitorAndRideSinglePosition(tokenMint, buyAmountUnits, initialSolSpent) {
  console.log(`👀 [Single-Position Manager] Riding green wave for ${tokenMint.slice(0, 8)}...`);
  
  let peakValue = initialSolSpent;
  const startTime = Date.now();
  const maxHoldTimeMs = 4 * 60 * 1000; // 4-minute maximum duration

  const checkInterval = setInterval(async () => {
    try {
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${buyAmountUnits}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      
      // Dynamically track the highest green peak
      if (currentValueSol > peakValue) {
        peakValue = currentValueSol;
      }

      console.log(`📈 [Wave Check] Current: ${currentValueSol.toFixed(4)} SOL | Peak: ${peakValue.toFixed(4)} SOL (Spent: ${initialSolSpent.toFixed(4)})`);

      // Exit triggers:
      // 1. Trailing pullback from peak (e.g., drops 10% after hitting a higher peak)
      const pulledBackFromPeak = peakValue > (initialSolSpent * 1.02) && currentValueSol < peakValue * 0.90;
      // 2. Strict stop-loss (-8%) to safeguard your wallet balance if it dumps immediately
      const hitStopLoss = currentValueSol <= initialSolSpent * 0.92;
      // 3. Time limit reached
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pulledBackFromPeak || hitStopLoss || timedOut) {
        clearInterval(checkInterval);
        
        if (pulledBackFromPeak) {
          console.log(`🟢 [Green Wave Peak Secured] Selling to lock in profits...`);
        } else if (hitStopLoss) {
          console.log(`🚨 [Stop Loss Triggered] Protecting wallet from further downside...`);
        } else {
          console.log(`⏰ [Timeout Reached] Closing position...`);
        }
        
        const sellTxid = await executeSwap(tokenMint, SOL_MINT, buyAmountUnits);
        console.log(`✅ [POSITION CLOSED IN SOL] Solscan: https://solscan.io/tx/${sellTxid}`);
        
        // Unlock trading state so the bot can search for the next clean coin
        isTrading = false;
        console.log(`🔄 [Status] Bot is ready to scan for the next clean setup.`);
      }
    } catch (e) {}
  }, 4000);
}

async function handleSnipe(signature) {
  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    
    // Leave a small 0.005 SOL buffer for gas fees
    if (balanceSol < 0.015) {
      console.log(`⚠️ Balance too low to safely trade.`);
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

    // --- STEP 1: METADATA & SOCIAL REQUIREMENTS ---
    try {
      const coinRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (coinRes.ok) {
        const coinData = await coinRes.json();
        const hasTwitter = coinData.twitter && coinData.twitter.trim().length > 0;
        const hasTelegram = coinData.telegram && coinData.telegram.trim().length > 0;

        if (!coinData.description || coinData.description.length < 5 || (!hasTwitter && !hasTelegram)) {
          console.log(`🚫 [Filter] Skipped: Lacks proper description or social links.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {
      isTrading = false;
      return;
    }

    // Capture baseline metrics before the delay
    let initialReserves = 0;
    try {
      const initRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (initRes.ok) {
        const initData = await initRes.json();
        initialReserves = initData.virtual_sol_reserves || 0;
      }
    } catch (e) {}

    // --- STEP 2: 15-SECOND HEALTH & ACCELERATION CHECK ---
    console.log(`⏳ [Deep Verification] Waiting 15s to validate volume growth for ${newMint.slice(0, 8)}...`);
    await new Promise(resolve => setTimeout(resolve, 15000));

    try {
      const checkRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.complete) {
          console.log(`🚫 [Filter] Token completed bonding curve during check. Skipping.`);
          isTrading = false;
          return;
        }

        const currentReserves = checkData.virtual_sol_reserves || 0;
        // Verify that real buyers actually grew the reserves during the wait window
        if (currentReserves <= initialReserves) {
          console.log(`🚫 [Volume Validation Failed] Reserves did not grow. Skipping token.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {
      isTrading = false;
      return;
    }

    // --- STEP 3: SINGLE-WALLET ALLOCATION (90% of available balance for maximum wave impact) ---
    const solToAllocate = Math.max(0.005, balanceSol - 0.005);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    console.log(`🎯 [Verified Green Wave Found] Token Mint: ${newMint}`);
    console.log(`🚀 [Full Wallet Entry] Deploying ${solToAllocate.4f || solToAllocate.toFixed(4)} SOL into single trade...`);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [ENTRY SUCCESSFUL] Solscan: https://solscan.io/tx/${txid}`);

    // Fetch token balance units and launch position management loop
    setTimeout(async () => {
      try {
        const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: newMint });
        const tokenUnits = tokenAccountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (tokenUnits) {
          monitorAndRideSinglePosition(newMint, tokenUnits, solToAllocate);
        } else {
          console.log(`⚠️ Token units unverified. Resetting trading lock.`);
          isTrading = false;
        }
      } catch (err) {
        isTrading = false;
      }
    }, 4000);

  } catch (err) {
    console.error(`❌ Execution Error: ${err.message}`);
    isTrading = false;
  }
}

function startListener() {
  console.log("🌊 [Single-Shot Wave Rider Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Ready for single-position high-conviction trades...");
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
      if (isTrading) return; // STRICT RULE: Ignore all new launches if we are currently in a trade

      const payload = JSON.parse(data.toString());
      if (!payload.params || !payload.params.result) return;

      const logs = payload.params.result.value.logs || [];
      const signature = payload.params.result.value.signature;

      if (logs.some(log => log.includes("Instruction: Create"))) {
        isTrading = true; // Lock out everything else
        await handleSnipe(signature);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log("🔴 Stream closed. Reconnecting in 3s...");
    setTimeout(startListener, 3000);
  });

  ws.on('error', (err) => {});
}

startListener();
