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
  console.log(`🔑 [Wallet] Active Elite Sniper: ${wallet.publicKey.toString()}`);
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

// Position Manager with 8% trailing profit lock
async function monitorAndExit(tokenMint, buyAmountUnits) {
  console.log(`👀 [Position Manager] Tracking price action for ${tokenMint.slice(0, 8)}...`);
  
  let peakValue = 0;
  const startTime = Date.now();
  const maxHoldTimeMs = 3 * 60 * 1000; // 3-minute max limit

  const checkInterval = setInterval(async () => {
    try {
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${buyAmountUnits}&slippageBps=500`
      );
      const quote = await quoteRes.json();
      if (!quote || quote.error) return;

      const currentValueSol = parseInt(quote.outAmount) / 1e9;
      if (currentValueSol > peakValue) peakValue = currentValueSol;

      console.log(`📈 [Price Check] Current Value: ${currentValueSol.toFixed(4)} SOL (Peak: ${peakValue.toFixed(4)} SOL)`);

      const pulledBackFromPeak = peakValue > 0.005 && currentValueSol < peakValue * 0.92;
      const timedOut = Date.now() - startTime > maxHoldTimeMs;

      if (pulledBackFromPeak || timedOut) {
        clearInterval(checkInterval);
        console.log(`🚨 [Exit Triggered] Selling token (8% pullback or timeout reached)...`);
        
        const sellTxid = await executeSwap(tokenMint, SOL_MINT, buyAmountUnits);
        console.log(`✅ [SOLD!] Solscan: https://solscan.io/tx/${sellTxid}`);
        isTrading = false;
      }
    } catch (e) {}
  }, 5000);
}

async function handleSnipe(signature) {
  try {
    const balanceLamports = await connection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1e9;
    
    if (balanceSol < 0.015) {
      console.log(`⚠️ Balance too low (${balanceSol.toFixed(4)} SOL).`);
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

    // --- STRICT SOCIAL & METADATA FILTER ---
    try {
      const coinRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (coinRes.ok) {
        const coinData = await coinRes.json();
        
        // Check description length
        if (!coinData.description || coinData.description.length < 5) {
          console.log(`🚫 [Safety Filter] Skipped: Description too short or missing.`);
          isTrading = false;
          return;
        }

        // Require at least Twitter (X) or Telegram link to avoid blank low-effort spam rugs
        const hasTwitter = coinData.twitter && coinData.twitter.trim().length > 0;
        const hasTelegram = coinData.telegram && coinData.telegram.trim().length > 0;

        if (!hasTwitter && !hasTelegram) {
          console.log(`🚫 [Social Filter] Skipped: Token lacks both Twitter and Telegram links.`);
          isTrading = false;
          return;
        }

        console.log(`✅ [Social Filter Passed] Found Socials -> Twitter: ${hasTwitter ? 'Yes' : 'No'}, Telegram: ${hasTelegram ? 'Yes' : 'No'}`);
      }
    } catch (e) {
      console.log(`⚠️ Metadata verification warning, continuing with caution...`);
    }

    // --- 15-SECOND LAUNCH DELAY ---
    console.log(`⏳ [Launch Delay] Waiting 15s for ${newMint.slice(0, 8)} to survive initial dump...`);
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Re-verify bonding curve hasn't completed or crashed after the delay
    try {
      const checkRes = await fetch(`https://frontend-api.pump.fun/coins/${newMint}`);
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.complete) {
          console.log(`🚫 [Delay Filter] Token already completed bonding curve. Skipping.`);
          isTrading = false;
          return;
        }
      }
    } catch (e) {}

    // 20% Position Sizing
    const ALLOCATION_PERCENTAGE = 0.20; 
    const solToAllocate = Math.max(0.005, (balanceSol - 0.005) * ALLOCATION_PERCENTAGE);
    const amountLamports = Math.floor(solToAllocate * 1e9);

    console.log(`🎯 [Target Passed All Elite Filters] Token Mint: ${newMint}`);
    console.log(`🚀 [Snipe Buying] Spending 20% (${solToAllocate.toFixed(4)} SOL)...`);

    const txid = await executeSwap(SOL_MINT, newMint, amountLamports);
    console.log(`✅ [SNIPE EXECUTED!] Solscan: https://solscan.io/tx/${txid}`);

    setTimeout(async () => {
      try {
        const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: newMint });
        const tokenUnits = tokenAccountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (tokenUnits) {
          monitorAndExit(newMint, tokenUnits);
        } else {
          console.log(`⚠️ Could not verify token units. Resetting trading lock.`);
          isTrading = false;
        }
      } catch (err) {
        isTrading = false;
      }
    }, 5000);

  } catch (err) {
    console.error(`❌ Snipe Execution Error: ${err.message}`);
    isTrading = false;
  }
}

function startListener() {
  console.log("⚡ [Elite Sniper Engine] Connecting...");
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log("🟢 [Connected] Scanning with Social Checks, 15s Delay, and 8% Trailing Exits...");
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
        console.log(`\n🚨 [NEW LAUNCH DETECTED] Signature: ${signature.slice(0, 8)}...`);
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
